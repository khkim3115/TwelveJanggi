// Zobrist 해시 키. 엔진 전치표가 쓴다(반복 판정은 충돌 없는 정확한 국면 키 — gameState.computeKey).
// 고정 시드 PRNG 라 실행마다 값이 같다(테스트·저장 국면 재현 가능).

import { CELL_COUNT } from './board';
import { mulberry32 } from './rng';

const rnd = mulberry32(0x9e3779b9);
const key = () => (rnd() * 4294967296) | 0;
const table = (n: number) => Array.from({ length: n }, key);

/** 한 진영이 손패로 들 수 있는 같은 종류의 최대 개수(將·相·子 는 각각 판 전체에 2개뿐). */
export const HAND_MAX = 2;

export const ZOB = {
  /** [진영-1][(종류-1) * 12 + 칸] — 보드 위 말. */
  piece: [table(5 * CELL_COUNT), table(5 * CELL_COUNT)] as const,
  /** [진영-1][(손패 종류-2) * 3 + 개수] — 손패. 개수 0..HAND_MAX 를 모두 커버한다. */
  hand: [table(3 * (HAND_MAX + 1)), table(3 * (HAND_MAX + 1))] as const,
  /** 차례가 적(2P)일 때 XOR. */
  turn: key(),
} as const;
