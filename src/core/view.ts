// 보드 클릭 의미와 하이라이트 계산. 순수 함수라 솔로·멀티 화면이 같은 것을 쓴다.
//
// 클릭 규칙은 한 곳(resolveClick)에만 있다 — 화면마다 다르게 동작할 여지를 없앤다.
// 판 칸 클릭과 손패 클릭을 같은 함수가 받고, 착수는 항상 legalMoves 가 만든 Move 객체를 그대로 돌려준다
// (승격 플래그 같은 파생값을 화면이 다시 계산하지 않게).

import { CELL_LABEL, ROW_OF, farRow, rotate, type HandKind } from './board';
import {
  DROP,
  findKing,
  legalMoves,
  other,
  sideOf,
  type GameState,
  type Move,
  type Player,
} from './gameState';

/** 지금 고른 것 — 판 위의 내 말 한 칸, 또는 손패 한 종류. 클릭 대상도 같은 모양이다. */
export type Selection = { kind: 'cell'; cell: number } | { kind: 'hand'; piece: HandKind };

export interface BoardView {
  /** 골라서 움직일 수 있는 내 말이 있는 칸. */
  movable: Set<number>;
  /** 투입할 수 있는 손패 종류. */
  droppable: Set<HandKind>;
  /** 지금 선택으로 둘 수 있는 목적지. */
  targets: Set<number>;
  /** targets 중 상대 말을 잡는 칸. */
  captures: Set<number>;
  /** targets 중 子 가 侯 로 승격하는 칸. */
  promotions: Set<number>;
  /** 王 이 상대 진영에 들어가 한 턴을 버티는 중인 진영(차례가 다시 오면 승리). */
  tryPending: Player | null;
}

function selects(sel: Selection | null, m: Move): boolean {
  if (sel === null) return false;
  if (sel.kind === 'cell') return m.from === sel.cell;
  return m.from === DROP && m.kind === sel.piece;
}

/**
 * 입성 대기 중인 진영. 방금 둔 쪽의 王 만 해당될 수 있다 —
 * 차례가 된 쪽의 王 이 상대 진영에 있었다면 이미 try 승리로 끝났다.
 */
export function tryPendingSide(s: GameState): Player | null {
  if (s.phase === 'over') return null;
  const mover = other(s.turn);
  const k = findKing(s.board, mover);
  return k >= 0 && ROW_OF[k] === farRow(mover) ? mover : null;
}

/**
 * me 가 지금 둘 차례라는 전제로 하이라이트를 계산한다.
 * 내 차례가 아니거나 me 가 null(관전)이면 입성 표시 외에는 비어 있다.
 */
export function boardView(s: GameState, me: Player | null, sel: Selection | null): BoardView {
  const view: BoardView = {
    movable: new Set(),
    droppable: new Set(),
    targets: new Set(),
    captures: new Set(),
    promotions: new Set(),
    tryPending: tryPendingSide(s),
  };
  if (me === null || s.phase === 'over' || s.turn !== me) return view;

  for (const m of legalMoves(s)) {
    if (m.from === DROP) view.droppable.add(m.kind as HandKind);
    else view.movable.add(m.from);
    if (!selects(sel, m)) continue;
    view.targets.add(m.to);
    if (m.from !== DROP && s.board[m.to] !== 0) view.captures.add(m.to);
    if (m.promote) view.promotions.add(m.to);
  }
  return view;
}

export type ClickResult =
  /** 실제 착수 — legalMoves 의 객체 그대로. */
  | { kind: 'move'; move: Move }
  /** 선택만 바뀜(null 이면 선택 해제). */
  | { kind: 'select'; selection: Selection | null };

/**
 * 칸 또는 손패 클릭을 해석한다. 아무 의미 없는 클릭이면 null.
 * "말(또는 손패) 고르기 → 갈 칸 찍기" 2단계이고, 고른 것을 다시 누르면 선택이 풀린다.
 * 움직일 수 없는 내 말·투입할 수 없는 손패는 고를 수 없다.
 */
export function resolveClick(
  s: GameState,
  me: Player,
  sel: Selection | null,
  target: Selection,
): ClickResult | null {
  if (s.phase === 'over' || s.turn !== me) return null;
  const moves = legalMoves(s);

  if (target.kind === 'hand') {
    if (!moves.some((m) => m.from === DROP && m.kind === target.piece)) return null;
    const same = sel?.kind === 'hand' && sel.piece === target.piece;
    return { kind: 'select', selection: same ? null : target };
  }

  const cell = target.cell;
  // 고른 것으로 이 칸에 둘 수 있으면 착수. 내 말이 있는 칸은 목적지가 될 수 없어 아래 선택 전환과 겹치지 않는다.
  if (sel !== null) {
    const m = moves.find((x) => selects(sel, x) && x.to === cell);
    if (m) return { kind: 'move', move: m };
  }
  const v = s.board[cell];
  if (v !== 0 && sideOf(v) === me) {
    if (!moves.some((m) => m.from === cell)) return null;
    const same = sel?.kind === 'cell' && sel.cell === cell;
    return { kind: 'select', selection: same ? null : { kind: 'cell', cell } };
  }
  return null;
}

/* ── 화면 방향 ───────────────────────────────────────────────────────── */
//
// 화면은 항상 "보는 사람의 진영이 아래"다. 적으로 두면 판을 180° 돌려 그린다.
// 표시 칸 번호 d(0 = 화면 왼쪽 위)와 보드 인덱스 i 의 변환은 서로의 역함수이며 둘 다 rotate 다.

/** 보드 인덱스 → 화면 칸 번호. */
export function indexToDisplay(cell: number, viewer: Player): number {
  return viewer === 2 ? rotate(cell) : cell;
}

/** 화면 칸 번호 → 보드 인덱스. */
export function displayToIndex(display: number, viewer: Player): number {
  return viewer === 2 ? rotate(display) : display;
}

/* ── 말 이름 ─────────────────────────────────────────────────────────── */

export const KIND_HANJA: readonly string[] = ['', '王', '將', '相', '子', '侯'];
export const KIND_NAME: readonly string[] = ['', '왕', '장', '상', '자', '후'];

/** 수 한 줄 표기(로그·접근성·힌트 문구). board 를 주면 잡기를 × 로 표시한다. */
export function moveLabel(m: Move, board?: Int8Array): string {
  const piece = KIND_HANJA[m.kind];
  if (m.from === DROP) return `${piece} ${CELL_LABEL[m.to]} 투입`;
  const sep = board && board[m.to] !== 0 ? '×' : '→';
  return `${piece} ${CELL_LABEL[m.from]}${sep}${CELL_LABEL[m.to]}${m.promote ? ' 侯 승격' : ''}`;
}

/* ── 상태 문구(솔로·멀티가 같은 말을 쓰도록 여기서 만든다) ───────────── */

export const SIDE_LABEL: Record<Player, string> = { 1: '녹', 2: '적' };

/* ── 선후공 선택 ─────────────────────────────────────────────────────── */
//
// 설정값(SeatPref)과 이번 판의 좌석(Player)은 다른 것이다 — 섞으면 'random' 이
// 좌석 자리로 새어들어 조용히 녹이 된다. 고르는 건 SeatPref, 판에 쓰는 건 Player.

/** 사용자가 고른 선후공. 녹이 언제나 선공이므로 색 = 선후공이다. */
export type SeatPref = '1' | '2' | 'random';

export const SEAT_PREFS: readonly SeatPref[] = ['1', '2', 'random'];

export const SEAT_PREF_LABEL: Record<SeatPref, string> = {
  '1': '녹',
  '2': '적',
  random: '랜덤',
};

export const SEAT_PREF_DESC: Record<SeatPref, string> = {
  '1': '내가 먼저',
  '2': 'AI 가 먼저',
  random: '판마다 무작위',
};

/** 저장값 → SeatPref. 모르는 값은 녹. */
export function toSeatPref(v: string | null | undefined): SeatPref {
  return v === '2' || v === 'random' ? v : '1';
}

/**
 * 선택을 이번 판의 좌석으로 확정한다. 'random' 은 새 판을 시작할 때 딱 한 번만 뽑는다 —
 * 되돌리기·힌트·기권이 모두 좌석을 기준으로 돌기 때문에 판 도중 다시 뽑으면 국면이 깨진다.
 *
 * 시드 PRNG(rng.ts) 가 아니라 Math.random 을 쓴다: 재현 가능한 난수는 zobrist·AI 잡음의
 * 요구사항이고, 색 추첨은 반대로 예측할 수 없어야 한다. 테스트는 rand 를 주입한다.
 */
export function resolveSeat(pref: SeatPref, rand: number = Math.random()): Player {
  if (pref === '1') return 1;
  if (pref === '2') return 2;
  return rand < 0.5 ? 1 : 2;
}

/** 지금 둘 사람이 해야 할 일. me 가 null 이면 관전 시점의 서술. */
export function turnHint(s: GameState, me: Player | null): string {
  if (s.phase === 'over') return '게임이 끝났습니다.';
  const mine = me !== null && s.turn === me;
  const pending = tryPendingSide(s);
  if (pending !== null) {
    if (mine) return '상대 王 이 내 진영에 들어왔습니다 — 이번 수에 잡지 못하면 집니다.';
    if (me === pending) return '王 입성! 상대가 이번 수에 잡지 못하면 승리합니다.';
    return `${SIDE_LABEL[pending]} 王 입성 — ${SIDE_LABEL[s.turn]}이 잡지 못하면 ${SIDE_LABEL[pending]} 승리`;
  }
  if (!mine) return `${SIDE_LABEL[s.turn]} 차례 — 수를 고르는 중`;
  const base = (s.turn - 1) * 3;
  const hasHand = s.hand[base] + s.hand[base + 1] + s.hand[base + 2] > 0;
  return hasHand
    ? '움직일 말이나 손패를 고른 뒤 갈 칸을 누르세요.'
    : '움직일 말을 고른 뒤 갈 칸을 누르세요.';
}

/** 진행 상태 이름(진행/王 입성/종료). */
export function phaseLabel(s: GameState): string {
  if (s.phase === 'over') return '종료';
  return tryPendingSide(s) !== null ? '王 입성' : '진행';
}
