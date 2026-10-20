// AI 공개 API. UI·테스트·벤치는 여기만 부른다.
//
// 난이도 차이는 세 축으로 만든다:
//   1) 탐색 깊이·노드 예산  2) 평가함수 정밀도(단순/전체)  3) 실수 확률과 점수 잡음.
// 노드 예산이 강도를 정하고 시간 예산은 느린 기기에서 화면이 오래 멈추지 않게 하는 상한일 뿐이다 —
// 그래야 같은 난이도가 PC·폰에서 비슷한 세기로 둔다(테스트도 노드 예산으로 재현한다).
// 王 을 바로 내주는 수·한 수 만에 이기는 수는 난이도와 무관하게 탐색의 전술 판정이 알아본다.

import { applyMoveInPlace, legalMoves, undoMove, type GameState, type Move } from '../core/gameState';
import { FULL_WEIGHTS, SIMPLE_WEIGHTS, type Weights } from './evaluate';
import { MATE_BOUND, search, tacticalScore, type SearchResult } from './search';

export type Difficulty = 'easy' | 'normal' | 'hard';

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '쉬움',
  normal: '보통',
  hard: '어려움',
};

export const DIFFICULTY_DESC: Record<Difficulty, string> = {
  easy: '한 수 앞만 봅니다. 王 은 지키고 이기는 수는 놓치지 않지만 말을 자주 흘립니다.',
  normal: '네 수 앞까지 읽습니다. 말 득실은 챙기지만 입성 위협은 늦게 봅니다.',
  hard: '깊이 읽습니다. 걸린 말·王 주변 위험·입성 위협까지 계산합니다.',
};

export interface DifficultyPreset {
  maxDepth: number;
  /** 강도를 정하는 노드 예산. */
  maxNodes: number;
  /** 화면이 오래 멈추지 않게 하는 시간 상한(ms). */
  timeBudgetMs: number;
  weights: Weights;
  /** 루트 후보 점수에 섞는 잡음 폭. */
  noise: number;
  /** 이 확률로 최선수 대신 아무 수(王 을 내주는 수는 빼고)나 둔다. */
  blunderRate: number;
}

// 쉬움·보통의 세기는 깊이·잡음·실수 확률이 정한다(깊이 4 는 수천 노드면 끝나 노드 예산은 안전망일 뿐).
// 어려움은 노드 예산이 세기를 정한다 — 350k 노드 ≈ 데스크톱 0.6–1.1초. 시간 상한은 느린 폰에서만 걸리도록 넉넉히.
//
// 선후공은 보정하지 않는다(어느 좌석이든 같은 세기). 실측 근거 — scripts/bench-seats.ts, 4 ply 균형 시작 국면 200여 개:
//  · 같은 난이도끼리 선공(녹) 승점: 쉬움 50% · 보통 59% · 어려움 71% — 강할수록 선공이 유리하다
//    (비슷한 3×4 변형의 완전해석은 후공 필승이지만, 이 깊이의 실전에서는 반대로 나타난다).
//  · 어려움을 상대한 보통 수준의 승점: 선공일 때 12% · 후공일 때 3%.
// 즉 어려움은 선공 사용자에게 가혹하지 않다. 후공을 고른 사용자가 더 어렵다는 점은 좌석 선택 화면에서 알린다.
export const PRESETS: Record<Difficulty, DifficultyPreset> = {
  easy: { maxDepth: 1, maxNodes: 5_000, timeBudgetMs: 100, weights: SIMPLE_WEIGHTS, noise: 150, blunderRate: 0.2 },
  normal: { maxDepth: 4, maxNodes: 20_000, timeBudgetMs: 600, weights: SIMPLE_WEIGHTS, noise: 30, blunderRate: 0.03 },
  hard: { maxDepth: 30, maxNodes: 350_000, timeBudgetMs: 2500, weights: FULL_WEIGHTS, noise: 0, blunderRate: 0 },
};

export interface ChooseOptions {
  /** 기본 Math.random. 테스트는 시드 PRNG 를 넣어 재현한다. */
  rng?: () => number;
  /** 프리셋 시간 상한을 덮어쓴다. 테스트는 Infinity 를 줘서 노드 예산만으로 결정론을 얻는다. */
  timeBudgetMs?: number;
  /** 프리셋 노드 예산을 덮어쓴다. */
  maxNodes?: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * 둔 즉시 지지 않는 수인가 — 쉬움의 "실수"도 이 안에서 고른다.
 * 지는 경우는 둘: 수를 두자마자 상대 승리로 끝나거나(내 진영에서 버티던 상대 王 의 try 등),
 * 상대에게 확정 승리(王 잡기·안전한 입성)를 넘겨준다.
 */
function keepsKing(s: GameState, m: Move): boolean {
  const me = s.turn;
  const u = applyMoveInPlace(s, m);
  const r = s.result;
  const lost = r ? r.kind === 'win' && r.winner !== me : (tacticalScore(s, 0) ?? 0) >= MATE_BOUND;
  undoMove(s, u);
  return !lost;
}

/** 난이도에 맞는 한 수. 둘 수 없으면 null. state 는 건드리지 않는다(탐색 중 make/unmake 후 원상복구). */
export function chooseMove(state: GameState, difficulty: Difficulty, opts: ChooseOptions = {}): Move | null {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  const preset = PRESETS[difficulty];
  const rng = opts.rng ?? Math.random;

  // 승패가 이미 확정된 국면(王 을 잡을 수 있음 · 상대 王 이 버티는 중 · 안전한 입성)에서는 실수하지 않는다 —
  // 한 수 만에 이기는 수는 난이도와 무관하게 둔다는 약속을 지키려는 것.
  if (preset.blunderRate > 0 && tacticalScore(state, 0) === null && rng() < preset.blunderRate) {
    const safe = moves.filter((m) => keepsKing(state, m));
    const pool = safe.length > 0 ? safe : moves;
    return pool[Math.floor(rng() * pool.length)];
  }

  const result = search(state, {
    maxDepth: preset.maxDepth,
    maxNodes: opts.maxNodes ?? preset.maxNodes,
    weights: preset.weights,
    deadline: now() + (opts.timeBudgetMs ?? preset.timeBudgetMs),
    // 어려움은 잡음도 무작위 동점 선택도 없다 — 같은 국면이면 항상 같은 수.
    rng: preset.noise > 0 ? rng : undefined,
    noise: preset.noise,
  });
  return result.move ?? moves[0];
}

/**
 * 힌트용 최선수. 난이도·좌석과 무관하게 항상 어려움과 같은 예산(노드·시간 상한)으로 읽는다 —
 * 시간 상한을 더 짧게 주면 느린 기기에서 힌트가 어려움 AI 보다 얕게 읽게 된다.
 */
export function bestMove(
  state: GameState,
  timeBudgetMs = PRESETS.hard.timeBudgetMs,
  maxNodes = PRESETS.hard.maxNodes,
): SearchResult {
  return search(state, {
    maxDepth: PRESETS.hard.maxDepth,
    maxNodes,
    weights: FULL_WEIGHTS,
    deadline: now() + timeBudgetMs,
  });
}
