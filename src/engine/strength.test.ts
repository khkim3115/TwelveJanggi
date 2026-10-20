// 난이도 강도 회귀. 이 저장소의 핵심 sanity check — 평가함수나 탐색을 건드리면 여기가 먼저 무너진다.
//
// 선후공 편차가 있는 게임이라 판마다 좌석을 번갈아 두고, 승점 비율(승 1 · 무 0.5)로 본다.
// 시간이 아니라 노드 예산으로 돌려 CPU 부하(병렬 테스트)와 무관하게 같은 결과가 나온다.
// 좌석별 편차의 정밀 측정은 수백 판이 필요해 여기서 하지 않고 `npm run bench:seats` 로 따로 돌린다.

import { describe, expect, it } from 'vitest';
import { applyMoveInPlace, createInitialState, type GameResult, type Player } from '../core/gameState';
import { mulberry32 } from '../core/rng';
import { chooseMove, type Difficulty } from './ai';

/** 테스트용 노드 예산 — 실제 앱보다 훨씬 작게 준다(강도 차이는 깊이·평가가 만든다). */
const NODES: Record<Difficulty, number> = { easy: 2_000, normal: 15_000, hard: 30_000 };
/** 이만큼 두고도 안 끝나면 무승부로 센다. */
const PLY_CAP = 200;

/** 한 판. 녹(1P)은 first, 적(2P)은 second 난이도로 둔다. */
function playGame(first: Difficulty, second: Difficulty, rng: () => number): GameResult {
  const s = createInitialState();
  for (let ply = 0; ply < PLY_CAP && !s.result; ply++) {
    const d = s.turn === 1 ? first : second;
    const m = chooseMove(s, d, { rng, timeBudgetMs: Infinity, maxNodes: NODES[d] });
    if (!m) break;
    applyMoveInPlace(s, m);
  }
  return s.result ?? { kind: 'draw', reason: 'repetition' };
}

/** games 판을 선후공 번갈아 두고 strong 쪽 승점 비율을 돌려준다. */
function scoreRate(strong: Difficulty, weak: Difficulty, games: number, seed: number): number {
  const rng = mulberry32(seed);
  let points = 0;
  for (let i = 0; i < games; i++) {
    const strongIsFirst = i % 2 === 0;
    const r = playGame(strongIsFirst ? strong : weak, strongIsFirst ? weak : strong, rng);
    if (r.kind === 'draw') {
      points += 0.5;
      continue;
    }
    const strongSeat: Player = strongIsFirst ? 1 : 2;
    if (r.winner === strongSeat) points += 1;
  }
  return points / games;
}

describe('난이도 강도', () => {
  it('어려움이 보통보다 확실히 강하다(12판 중 1패까지)', { timeout: 300_000 }, () => {
    const rate = scoreRate('hard', 'normal', 12, 11);
    // eslint-disable-next-line no-console
    console.log(`hard vs normal 승점 비율: ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });

  it('보통이 쉬움보다 확실히 강하다', { timeout: 300_000 }, () => {
    const rate = scoreRate('normal', 'easy', 16, 22);
    // eslint-disable-next-line no-console
    console.log(`normal vs easy 승점 비율: ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.85);
  });

  it('어려움은 쉬움에게 거의 지지 않는다', { timeout: 300_000 }, () => {
    const rate = scoreRate('hard', 'easy', 10, 33);
    // eslint-disable-next-line no-console
    console.log(`hard vs easy 승점 비율: ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.95);
  });
});
