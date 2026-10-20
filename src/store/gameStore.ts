// 솔로 게임 상태 + 설정(난이도·선공·테마). 엔진과 UI 사이의 유일한 접착제.
//
// AI 차례는 여기서 스스로 돈다: 사람이 두면 곧바로 runAi() 가 걸린다. 새 게임·되돌리기·기권은
// generation 을 올려 늦게 도착한 워커 응답을 버린다.

import { create } from 'zustand';
import type { HandKind } from '../core/board';
import {
  applyMove,
  applyResign,
  createInitialState,
  legalMoves,
  type GameState,
  type Move,
  type Player,
} from '../core/gameState';
import { SEAT_PREFS, resolveClick, resolveSeat, toSeatPref, type SeatPref, type Selection } from '../core/view';
import { cancelPendingAi, requestAiMove, requestHint } from '../engine/aiClient';
import type { Difficulty } from '../engine/ai';

export type Theme = 'dark' | 'light';

const DIFFICULTY_KEY = 'tj_difficulty';
/** 값은 '1'|'2'|'random'. */
const SEAT_KEY = 'tj_seat';
const THEME_KEY = 'tj_theme';

/** AI 가 "생각하는 척" 최소한 이 정도는 끌어야 사람 눈에 자연스럽다. */
const MIN_THINK_MS = 260;

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장 불가(사생활 모드 등) — 이번 세션에만 적용.
  }
}

/** 테마 적용. index.html 의 인라인 스크립트가 첫 페인트 전에 같은 일을 한 번 해 둔다(깜빡임 방지). */
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  // 모바일 주소창 색도 따라간다.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f6f8' : '#0d1117');
}

/**
 * 되감을 자리(사람이 다시 둘 수 있는 국면)의 인덱스. 없으면 -1.
 * 내가 적이면 AI 가 먼저 둔 국면이 스택 바닥에 남아 되감을 곳이 없을 수 있다 —
 * 그래서 "기록이 있다" 와 "되돌릴 수 있다" 는 같은 말이 아니다.
 */
function undoTargetIndex(past: GameState[], humanSeat: Player): number {
  for (let i = past.length - 1; i >= 0; i--) {
    const st = past[i];
    if (st.turn === humanSeat && st.phase !== 'over') return i;
  }
  return -1;
}

interface GameStore {
  state: GameState;
  /** 되돌리기용 이전 국면 스택(사람·AI 수 모두 쌓인다). */
  past: GameState[];
  /** 고른 난이도. 진행 중인 판이 아니라 다음 판에 적용된다. */
  difficulty: Difficulty;
  /** 이번 판의 난이도. startGame 이 difficulty 를 확정한 값 — AI·배너·결과 화면이 이것을 쓴다. */
  gameDifficulty: Difficulty;
  /** 고른 선후공(랜덤 포함). 진행 중인 판이 아니라 다음 판에 적용된다. */
  seatPref: SeatPref;
  /** 이번 판에서 사람이 실제로 맡은 진영. startGame 이 seatPref 를 확정한 값. */
  humanSeat: Player;
  theme: Theme;

  /** 고른 내 말(칸) 또는 손패 종류. */
  selection: Selection | null;
  /** AI 가 계산 중. 이 동안 보드는 클릭을 무시한다. */
  thinking: boolean;
  /** 방금 둔 수(보드에 잔상 표시). */
  lastMove: Move | null;

  hint: Move | null;
  hintLoading: boolean;
  /** 이 판에서 힌트를 한 번이라도 썼는가(결과 화면·피드백 메타 표기용). */
  hintUsedThisGame: boolean;

  /** 늦게 온 AI 응답을 버리기 위한 세대 번호. */
  generation: number;

  newGame: (opts?: { difficulty?: Difficulty; seatPref?: SeatPref }) => void;
  clickCell: (cell: number) => void;
  clickHand: (piece: HandKind) => void;
  undo: () => void;
  resign: () => void;
  askHint: () => void;
  setDifficulty: (d: Difficulty) => void;
  setSeatPref: (p: SeatPref) => void;
  toggleTheme: () => void;
}

const initialTheme = readStored<Theme>(THEME_KEY, ['dark', 'light'], 'dark');
applyTheme(initialTheme);

export const useGameStore = create<GameStore>((set, get) => {
  /** 한 수 적용 + 파생 상태 정리. AI 차례가 되면 이어서 돈다. */
  function commit(move: Move) {
    const { state, past, hintLoading } = get();
    // 계산 중인 힌트는 이제 지나간 국면의 것이다. 워커가 하나라 그대로 두면 AI 요청이 힌트 탐색 뒤에 줄을 선다 —
    // 취소하면 힌트 요청은 null 로 끝나고, askHint 의 국면 대조가 로딩을 푼다.
    if (hintLoading) cancelPendingAi();
    const next = applyMove(state, move);
    set({
      state: next,
      past: [...past, state],
      selection: null,
      lastMove: move,
      hint: null,
    });
    void runAi();
  }

  /** AI 차례면 한 수 둔다. */
  async function runAi(): Promise<void> {
    const { state, humanSeat, gameDifficulty, generation } = get();
    if (state.phase === 'over' || state.turn === humanSeat) return;

    set({ thinking: true });
    const started = Date.now();
    const answer = await requestAiMove(state, gameDifficulty);
    const wait = MIN_THINK_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    // 그 사이 새 게임·되돌리기·기권이 있었으면 이 결과는 버린다.
    if (get().generation !== generation) return;
    const cur = get().state;
    // 세대가 그대로인데 수가 없다면 엔진 고장이다(둘 수가 없는 국면은 이미 blocked 로 끝났다) —
    // AI 차례에서 판이 멈추지 않도록 아무 합법 수나 둔다.
    const move = answer.move ?? legalMoves(cur)[0] ?? null;
    if (!move) {
      set({ thinking: false });
      return;
    }
    const next = applyMove(cur, move);
    // 불변식: AI 가 두고 나면 화면에 힌트가 남지 않는다. 지우는 책임을 commit 한 곳에만 두면
    // 나중에 다른 경로가 생겼을 때 지나간 국면의 힌트가 새 보드 위에 남는다.
    set({ state: next, past: [...get().past, cur], lastMove: move, thinking: false, hint: null });
    if (next.turn !== humanSeat && next.phase !== 'over') void runAi();
  }

  function startGame(difficulty: Difficulty, seatPref: SeatPref) {
    cancelPendingAi();
    // 랜덤이면 여기서 딱 한 번 뽑는다. 판이 끝날 때까지 이 좌석은 바뀌지 않는다.
    const humanSeat = resolveSeat(seatPref);
    set((s) => ({
      state: createInitialState(),
      past: [],
      difficulty,
      gameDifficulty: difficulty,
      seatPref,
      humanSeat,
      selection: null,
      thinking: false,
      lastMove: null,
      hint: null,
      hintLoading: false,
      hintUsedThisGame: false,
      generation: s.generation + 1,
    }));
    // 사람이 적(후공)이면 AI 가 먼저 둔다.
    if (humanSeat !== 1) void runAi();
  }

  /** 칸·손패 클릭을 core/view 의 resolveClick 으로 해석한다(멀티 화면과 같은 규칙). */
  function click(target: Selection) {
    const { state, humanSeat, selection, thinking } = get();
    if (thinking) return;
    const r = resolveClick(state, humanSeat, selection, target);
    if (!r) return;
    if (r.kind === 'select') {
      set({ selection: r.selection });
      return;
    }
    commit(r.move);
  }

  const storedDifficulty = readStored<Difficulty>(DIFFICULTY_KEY, ['easy', 'normal', 'hard'], 'normal');

  return {
    state: createInitialState(),
    past: [],
    difficulty: storedDifficulty,
    gameDifficulty: storedDifficulty,
    seatPref: toSeatPref(readStored<SeatPref>(SEAT_KEY, SEAT_PREFS, '1')),
    // 아직 판이 시작되지 않은 자리표시자. 솔로 화면은 홈을 거쳐야 하므로 startGame 이 먼저 돈다.
    humanSeat: 1,
    theme: initialTheme,

    selection: null,
    thinking: false,
    lastMove: null,
    hint: null,
    hintLoading: false,
    hintUsedThisGame: false,
    generation: 0,

    newGame: (opts) => {
      const difficulty = opts?.difficulty ?? get().difficulty;
      const seatPref = opts?.seatPref ?? get().seatPref;
      startGame(difficulty, seatPref);
    },

    clickCell: (cell) => click({ kind: 'cell', cell }),
    clickHand: (piece) => click({ kind: 'hand', piece }),

    undo: () => {
      const { past, humanSeat, generation, thinking } = get();
      if (thinking) return;
      const at = undoTargetIndex(past, humanSeat);
      if (at < 0) return;
      cancelPendingAi();
      set({
        state: past[at],
        past: past.slice(0, at),
        selection: null,
        thinking: false,
        lastMove: null,
        hint: null,
        hintLoading: false,
        generation: generation + 1,
      });
    },

    resign: () => {
      const { state, past, humanSeat, generation } = get();
      if (state.phase === 'over') return;
      cancelPendingAi();
      set({
        state: applyResign(state, humanSeat),
        // 기권한 국면도 기록에 남긴다 — 그래야 되돌리기가 기권 직전(내 차례)으로 정확히 돌아간다.
        past: [...past, state],
        thinking: false,
        selection: null,
        hint: null,
        hintLoading: false,
        generation: generation + 1,
      });
    },

    askHint: () => {
      const { state, humanSeat, thinking, hintLoading, generation } = get();
      if (thinking || hintLoading) return;
      if (state.phase === 'over' || state.turn !== humanSeat) return;
      set({ hintLoading: true, hintUsedThisGame: true });
      void requestHint(state).then(({ move }) => {
        // 새 게임·되돌리기·기권이 있었으면 그쪽이 이미 정리했다. 여기서는 손대지 않는다.
        if (get().generation !== generation) return;
        // 기다리는 동안 국면이 움직였으면(사람 착수 → AI 응수) 이 힌트는 지나간 국면의 수다 —
        // generation 은 착수로 오르지 않으므로 국면 자체를 대조해야 한다. 버리되 로딩은 푼다.
        set({ hint: get().state === state ? move : null, hintLoading: false });
      });
    },

    // 진행 중인 판의 gameDifficulty 는 건드리지 않는다 — 선후공과 같은 원칙(다음 판부터 적용).
    setDifficulty: (d) => {
      persist(DIFFICULTY_KEY, d);
      set({ difficulty: d });
    },

    // 진행 중인 판의 humanSeat 은 절대 건드리지 않는다 — 좌석이 판 도중 바뀌면
    // 보드·runAi·되돌리기가 서로 다른 진영을 보게 되어 판이 그대로 멈춘다.
    setSeatPref: (p) => {
      persist(SEAT_KEY, p);
      set({ seatPref: p });
    },

    toggleTheme: () => {
      const theme: Theme = get().theme === 'dark' ? 'light' : 'dark';
      persist(THEME_KEY, theme);
      applyTheme(theme);
      set({ theme });
    },
  };
});

/** 파생: 지금 되돌릴 수 있는가(기록이 있어도 되감을 자리가 없을 수 있다). */
export function canUndo(s: { past: GameState[]; humanSeat: Player; thinking: boolean }): boolean {
  return !s.thinking && undoTargetIndex(s.past, s.humanSeat) >= 0;
}
