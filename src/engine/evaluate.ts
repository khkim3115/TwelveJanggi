// 국면 평가(정적)와 공격 판정. 탐색이 리프에서 부르는 유일한 점수 함수.
//
// 3×4 판의 말은 모두 한 칸씩만 움직인다(멀리 가는 말이 없음). 그래서 "어느 칸을 누가 공격하는가"가 정확하고,
// 평가는 다음 한 수에 일어날 일에 가깝게 잡는다:
// 재료(판·손패 가치 분리) · 지금 둘 쪽이 얻을 수 있는 잡기(걸린 말) · 王 전진과 안전한 입성 칸 ·
// 王 주변을 상대가 노리는 칸 · 이동성 · 子 전진.

import { CELL_COUNT, HAND_KINDS, JA, KING, ROW_OF, STEPS, canStep, farRow } from '../core/board';
import { findKing, handIndex, kindOf, other, sideOf, type GameState, type Player } from '../core/gameState';

export interface Weights {
  /** 판 위 말 가치 [_, 王, 將, 相, 子, 侯]. 王 은 0 — 잡히면 탐색이 승패로 처리한다. */
  board: readonly number[];
  /** 손패 가치 [_, _, 將, 相, 子]. 빈칸 어디든 놓을 수 있어 판 위보다 약간 높게 친다. */
  hand: readonly number[];
  /** 지금 둘 쪽이 바로 얻을 수 있는 최선의 잡기 이득에 곱하는 비율(0..1). 0 이면 걸린 말을 못 본다. */
  hanging: number;
  /** 王 이 한 줄 나아갈 때마다. */
  kingAdvance: number;
  /**
   * 王 이 한 걸음에 들어갈 수 있는 "상대가 지키지 않는" 상대 진영 칸 하나당(입성 위협).
   * 탐색 리프에서는 둘 차례인 쪽의 안전한 입성이 전술 판정(승리)으로 먼저 걸러지므로,
   * 사실상 "차례가 아닌 쪽이 다음 수에 노리는 입성"을 재는 항이다.
   */
  tryThreat: number;
  /** 王 주변 칸 중 상대가 공격하는 칸 하나당(감점). */
  kingDanger: number;
  /** 판 위 말이 갈 수 있는 칸 1개당. */
  mobility: number;
  /** 子 가 한 줄 나아갈 때마다(승격에 가까울수록). */
  jaAdvance: number;
}

/** 어려움 난이도 — 모든 지표를 본다. */
export const FULL_WEIGHTS: Weights = {
  board: [0, 0, 400, 300, 100, 450],
  hand: [0, 0, 420, 320, 120],
  hanging: 0.7,
  kingAdvance: 15,
  tryThreat: 150,
  kingDanger: 20,
  mobility: 5,
  jaAdvance: 10,
};

/** 쉬움·보통 난이도 — 재료와 전진만 본다(걸린 말·입성 위협·王 주변 위험을 못 본다). */
export const SIMPLE_WEIGHTS: Weights = {
  board: [0, 0, 400, 300, 100, 450],
  hand: [0, 0, 400, 300, 100],
  hanging: 0,
  kingAdvance: 10,
  tryThreat: 0,
  kingDanger: 0,
  mobility: 0,
  jaAdvance: 5,
};

/** 승리 점수. 탐색은 승패가 난 ply 만큼 빼서 "더 빠른 승리 · 더 늦은 패배"를 고른다. */
export const WIN_SCORE = 100000;

/* ── 공격 ────────────────────────────────────────────────────────────── */

/** side 의 말 중 cell 을 공격하는 것이 있는가(점유 여부 무관). */
export function isAttacked(board: Int8Array, side: Player, cell: number): boolean {
  for (let from = 0; from < CELL_COUNT; from++) {
    const v = board[from];
    if (v === 0 || sideOf(v) !== side) continue;
    const tos = STEPS[side][kindOf(v)][from];
    for (let i = 0; i < tos.length; i++) if (tos[i] === cell) return true;
  }
  return false;
}

/**
 * 칸별 공격 수와 "그 칸을 노리는 가장 싼 말의 가치". out 은 길이 4*12:
 * [녹 공격 수 12 | 적 공격 수 12 | 녹 최저 공격자 가치 12 | 적 최저 공격자 가치 12].
 */
function fillAttacks(board: Int8Array, w: Weights, out: Int32Array): void {
  out.fill(0);
  for (let c = 0; c < CELL_COUNT; c++) {
    out[2 * CELL_COUNT + c] = 1 << 20;
    out[3 * CELL_COUNT + c] = 1 << 20;
  }
  for (let from = 0; from < CELL_COUNT; from++) {
    const v = board[from];
    if (v === 0) continue;
    const side = sideOf(v);
    const kind = kindOf(v);
    const value = kind === KING ? 1 << 19 : w.board[kind];
    const base = (side - 1) * CELL_COUNT;
    for (const to of STEPS[side][kind][from]) {
      out[base + to] += 1;
      const cheap = (side + 1) * CELL_COUNT + to;
      if (value < out[cheap]) out[cheap] = value;
    }
  }
}

const scratch = new Int32Array(4 * CELL_COUNT);

/** side 가 앞으로 나아간 줄 수(자기 진영 = 0, 상대 진영 = 3). */
function advanced(side: Player, cell: number): number {
  return side === 1 ? 3 - ROW_OF[cell] : ROW_OF[cell];
}

/** me 관점의 점수. 클수록 me 에게 좋다. 王 잡기·입성 같은 확정 승패는 탐색(search.ts)이 먼저 걸러 낸다. */
export function evaluate(s: GameState, me: Player, w: Weights): number {
  const att = scratch;
  fillAttacks(s.board, w, att);
  const turn = s.turn;
  let score = 0;
  let bestGain = 0; // 지금 둘 쪽(turn)이 한 수로 얻을 수 있는 최선의 잡기 이득
  // 지금 둘 쪽의 王 이 공격받는 중이면 그 수는 王 을 지키는 데 써야 한다 — 장군을 건 말을 잡는 이득만 인정한다.
  const moverKing = findKing(s.board, turn);
  const moverInCheck = moverKing >= 0 && att[(other(turn) - 1) * CELL_COUNT + moverKing] > 0;

  for (let c = 0; c < CELL_COUNT; c++) {
    const v = s.board[c];
    if (v === 0) continue;
    const side = sideOf(v);
    const opp = other(side);
    const kind = kindOf(v);
    const sign = side === me ? 1 : -1;
    const mine = (side - 1) * CELL_COUNT;
    const theirs = (opp - 1) * CELL_COUNT;

    if (kind === KING) {
      score += sign * w.kingAdvance * advanced(side, c);
      for (const n of STEPS[side][KING][c]) {
        if (att[theirs + n] > 0) score -= sign * w.kingDanger;
        const t = s.board[n];
        if (ROW_OF[n] === farRow(side) && (t === 0 || sideOf(t) !== side) && att[theirs + n] === 0) {
          score += sign * w.tryThreat;
        }
      }
      continue;
    }

    const value = w.board[kind];
    score += sign * value;
    if (kind === JA) score += sign * w.jaAdvance * advanced(side, c);

    let free = 0;
    for (const n of STEPS[side][kind][c]) {
      const t = s.board[n];
      if (t === 0 || sideOf(t) !== side) free += 1;
    }
    score += sign * w.mobility * free;

    // 지금 둘 쪽이 이 말을 잡으면 얼마를 버는가: 안 지켜지면 말 값 전부, 지켜지면 싼 말로 바꾸는 차익.
    if (side !== turn && att[theirs + c] > 0 && (!moverInCheck || canStep(side, kind, c, moverKing))) {
      const attacker = att[(opp + 1) * CELL_COUNT + c];
      const gain = att[mine + c] === 0 ? value : value - attacker;
      if (gain > bestGain) bestGain = gain;
    }
  }
  score += (turn === me ? 1 : -1) * w.hanging * bestGain;

  for (const side of [1, 2] as const) {
    const sign = side === me ? 1 : -1;
    for (const kind of HAND_KINDS) score += sign * w.hand[kind] * s.hand[handIndex(side, kind)];
  }
  return Math.round(score);
}
