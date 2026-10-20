// 전술 정합성 — "이 국면에서 이 수를 찾아야 한다"는 최소 보증 + 탐색 자체의 정확성.
// 노드 예산(maxNodes)과 무제한 시간(Infinity)으로 돌려 CPU 부하와 무관하게 재현한다.
import { describe, expect, it } from 'vitest';
import {
  DROP,
  applyMove,
  applyMoveInPlace,
  createInitialState,
  fromTransfer,
  isLegal,
  legalMoves,
  moveKey,
  toTransfer,
  undoMove,
  type GameState,
  type Move,
} from '../core/gameState';
import { mulberry32 } from '../core/rng';
import { makeState } from '../core/testkit';
import { DIFFICULTIES, bestMove, chooseMove, type Difficulty } from './ai';
import { FULL_WEIGHTS, SIMPLE_WEIGHTS, WIN_SCORE, evaluate, type Weights } from './evaluate';
import { MATE_BOUND, search, tacticalScore } from './search';

const NODES = 200_000;
const hint = (s: GameState) => bestMove(s, Infinity, NODES);
const key = (m: Move | null) => (m ? moveKey(m) : null);
/** 어려움은 무작위를 쓰지 않아야 한다 — 쓰면 바로 터진다. */
const noRng = () => {
  throw new Error('어려움은 rng 를 쓰면 안 된다');
};

/** m 을 두면 곧바로 지거나(상대 승리로 끝남) 상대에게 확정 승리(王 잡기·안전한 입성)가 생기는가. */
function handsOpponentWin(s: GameState, m: Move): boolean {
  const me = s.turn;
  const u = applyMoveInPlace(s, m);
  const r = s.result;
  const lost = r ? r.kind === 'win' && r.winner !== me : (tacticalScore(s, 0) ?? 0) >= MATE_BOUND;
  undoMove(s, u);
  return lost;
}

describe('확정 승패를 바로 알아본다', () => {
  it('한 수로 王 을 잡는다 — 점수는 1 ply 승리', () => {
    const s = makeState({ board: '.k. .R. ... .K.', hand: ['RBP', 'BP'] });
    const r = hint(s);
    expect(key(r.move)).toBe('4-1');
    expect(r.score).toBe(WIN_SCORE - 1);
  });

  it('안전한 입성 칸이 있으면 들어간다 — 점수는 2 ply 승리', () => {
    // 녹 王(3)은 적 진영 0·1 로 갈 수 있고, 적 王(8)은 그 칸들을 노리지 못한다.
    const s = makeState({ board: '... K.. ..k ...', hand: ['RBP', 'RBP'] });
    const r = hint(s);
    expect(r.move?.piece).toBe(1);
    expect([0, 1]).toContain(r.move?.to);
    expect(r.score).toBe(WIN_SCORE - 2);
  });

  it('상대 王 이 내 진영에서 버티는데 못 잡으면 진 국면으로 본다', () => {
    // 적 王 이 녹 진영(10)에 들어와 있고, 녹 王(3)은 닿지 않는다.
    const s = makeState({ board: '... K.. ... .k.', turn: 1, hand: ['RBP', 'RBP'] });
    expect(tacticalScore(s, 0)).toBe(-(WIN_SCORE - 1));
  });

  it('전술 판정은 王 잡기를 입성보다 먼저 본다', () => {
    // 녹 王 이 적 王 옆에 있고 동시에 입성 칸도 있다 → 잡기(1 ply)가 우선.
    const s = makeState({ board: '.k. K.. ... ...', hand: ['RBP', 'RBP'] });
    expect(tacticalScore(s, 0)).toBe(WIN_SCORE - 1);
  });

  it('한 수로 이기는 수는 모든 난이도가 둔다(쉬움의 실수 확률과 무관)', () => {
    const s = makeState({ board: '.k. .R. ... .K.', hand: ['RBP', 'BP'] });
    const rng = mulberry32(42);
    for (const d of DIFFICULTIES) {
      for (let i = 0; i < 40; i++) {
        expect(key(chooseMove(s, d, { rng, timeBudgetMs: Infinity, maxNodes: 20_000 }))).toBe('4-1');
      }
    }
  });

  it('내 진영에서 버티는 상대 王 은 모든 난이도가 잡는다', () => {
    // 적 王(10)이 녹 진영에 들어와 있다. 녹 王(7)이 잡지 않으면 나머지 수는 전부 즉시 패배.
    const s = makeState({ board: 'r.b .p. .K. .k.', hand: ['RBP', ''] });
    const winning = legalMoves(s).filter((m) => !handsOpponentWin(s, m));
    expect(winning.map(moveKey)).toEqual(['7-10']);
    const rng = mulberry32(12345);
    for (const d of DIFFICULTIES) {
      for (let i = 0; i < 40; i++) {
        expect(key(chooseMove(s, d, { rng, timeBudgetMs: Infinity, maxNodes: 20_000 }))).toBe('7-10');
      }
    }
  });
});

describe('상대의 위협을 막는다', () => {
  it('王 을 공격받는 칸으로 옮기지 않는다(모든 난이도)', { timeout: 30_000 }, () => {
    // 적 將(4)이 7 을 지킨다. 녹 王 이 7 로 가면 바로 잡힌다.
    const s = makeState({ board: 'k.. .r. ... .K.', hand: ['RBBPP', ''] });
    const hard = chooseMove(s, 'hard', { rng: noRng, timeBudgetMs: Infinity, maxNodes: 20_000 })!;
    expect(handsOpponentWin(s, hard)).toBe(false);
    const rng = mulberry32(7);
    for (const d of ['easy', 'normal'] as Difficulty[]) {
      for (let i = 0; i < 30; i++) {
        const m = chooseMove(s, d, { rng, timeBudgetMs: Infinity, maxNodes: 20_000 })!;
        expect(handsOpponentWin(s, m)).toBe(false);
      }
    }
  });

  it('상대의 입성을 막는 유일한 수를 찾는다', () => {
    // 적 王(8)이 10·11 로 들어오려 한다. 막는 수는 相 3→7 하나뿐.
    const s = makeState({ board: '.RR B.. B.k K..', hand: ['PP', ''] });
    const safe = legalMoves(s).filter((m) => !handsOpponentWin(s, m));
    expect(safe.map(moveKey)).toEqual(['3-7']);
    expect(key(hint(s).move)).toBe('3-7');
    for (const d of ['normal', 'hard'] as Difficulty[]) {
      expect(key(chooseMove(s, d, { rng: mulberry32(1), timeBudgetMs: Infinity }))).toBe('3-7');
    }
  });

  it('투입으로만 막을 수 있으면 투입한다', () => {
    // 적 王(6)의 입성 칸 9 를 지킬 수단은 손패의 相 을 7 에 놓는 것뿐.
    const s = makeState({ board: 'H.. r.. k.. ..K', hand: ['BB', 'RP'] });
    const safe = legalMoves(s).filter((m) => !handsOpponentWin(s, m));
    expect(safe.map(moveKey)).toEqual(['B*7']);
    const r = hint(s);
    expect(r.move?.from).toBe(DROP);
    expect(key(r.move)).toBe('B*7');
    expect(r.score).toBeGreaterThan(-MATE_BOUND);
  });
});

describe('탐색의 정확성', () => {
  // 가지치기·전치표·순서 없이 같은 리프 규칙으로 읽는 기준 구현.
  function brute(s: GameState, depth: number, ply: number, w: Weights): number {
    if (s.result) {
      if (s.result.kind === 'draw') return 0;
      return s.result.winner === s.turn ? WIN_SCORE - ply : -(WIN_SCORE - ply);
    }
    if (ply > 0) {
      const t = tacticalScore(s, ply);
      if (t !== null) return t;
      if ((s.reps.get(s.key) ?? 0) >= 2) return 0;
    }
    if (depth <= 0) return evaluate(s, s.turn, w);
    let best = -Infinity;
    for (const m of legalMoves(s)) {
      const u = applyMoveInPlace(s, m);
      const v = -brute(s, depth - 1, ply + 1, w);
      undoMove(s, u);
      if (v > best) best = v;
    }
    return best;
  }

  function moveValue(s: GameState, m: Move, depth: number, w: Weights): number {
    const u = applyMoveInPlace(s, m);
    const v = -brute(s, depth - 1, 1, w);
    undoMove(s, u);
    return v;
  }

  it('알파베타·전치표·승패 점수 보정이 깊이 1–4 완전 탐색과 같은 값을 낸다', () => {
    const rng = mulberry32(2026);
    let checked = 0;
    for (let g = 0; g < 40; g++) {
      const s = createInitialState();
      for (let i = 0; i < 40 && !s.result; i++) {
        const ms = legalMoves(s);
        applyMoveInPlace(s, ms[Math.floor(rng() * ms.length)]);
        if (s.result || i % 4 !== 3) continue;
        const w = g % 2 ? FULL_WEIGHTS : SIMPLE_WEIGHTS;
        for (let d = 1; d <= 4; d++) {
          const r = search(s, { maxDepth: d, weights: w });
          if (Math.abs(r.score) < MATE_BOUND && r.depth < d) continue; // 확정 승패면 일찍 멈춘다
          expect(r.score).toBe(brute(s, r.depth, 0, w));
          expect(moveValue(s, r.move!, r.depth, w)).toBe(r.score);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('rng 를 주고 잡음이 0 이어도 고른 수가 보고한 점수를 실제로 낸다', () => {
    const s = makeState({ board: 'rHb .Pk K.. B.R', turn: 1 });
    for (let seed = 1; seed <= 40; seed++) {
      const r = search(s, { maxDepth: 2, weights: FULL_WEIGHTS, rng: mulberry32(seed) });
      expect(moveValue(s, r.move!, 2, FULL_WEIGHTS)).toBe(r.score);
    }
  });
});

describe('결정론과 합법성', () => {
  it('어려움은 무작위를 쓰지 않고 같은 국면에서 늘 같은 수를 둔다', () => {
    const s = createInitialState();
    const a = chooseMove(s, 'hard', { rng: noRng, timeBudgetMs: Infinity, maxNodes: 30_000 });
    const b = chooseMove(s, 'hard', { rng: noRng, timeBudgetMs: Infinity, maxNodes: 30_000 });
    expect(key(a)).toBe(key(b));
  });

  it('탐색은 국면을 원래대로 돌려놓는다', () => {
    const s = makeState({ board: 'r.b .k. .P. BKR', hand: ['P', ''] });
    const snap = () => ({ t: toTransfer(s), reps: [...s.reps], phase: s.phase, result: s.result, hash: s.hash });
    const before = snap();
    hint(s);
    chooseMove(s, 'easy', { rng: mulberry32(3), timeBudgetMs: Infinity });
    expect(snap()).toEqual(before);
  });

  it('실제 대국 도중 어떤 국면에서도 합법 수만 낸다(모든 난이도)', () => {
    const rng = mulberry32(20261020);
    for (const d of DIFFICULTIES) {
      const s = createInitialState();
      for (let i = 0; i < 80 && !s.result; i++) {
        const m = chooseMove(s, d, { rng, timeBudgetMs: Infinity, maxNodes: 8_000 });
        expect(m).not.toBeNull();
        expect(isLegal(s, m!)).toBe(true);
        applyMoveInPlace(s, m!);
      }
    }
  });

  it('둘 수 없는 국면에서는 null 을 낸다', () => {
    const stuck = makeState({ board: 'RB. KRB PPk ...', turn: 1 });
    expect(legalMoves(stuck)).toHaveLength(0);
    expect(chooseMove(stuck, 'hard', { timeBudgetMs: Infinity })).toBeNull();
  });

  it('예산이 첫 깊이도 못 채워도 합법 수를 내고, 완주한 깊이는 0 으로 보고한다', () => {
    const s = createInitialState();
    const r = bestMove(s, Infinity, 3);
    expect(r.move && isLegal(s, r.move)).toBe(true);
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.depth).toBe(0);
    expect(r.timedOut).toBe(true);
  });

  it('반복 이력을 알면 이기는 쪽은 무승부가 되는 수를 피한다', () => {
    // 손패에 子 두 개를 더 쥔 녹이 유리하다. 녹이 평소 두는 수의 결과 국면을 "이미 두 번 나온 국면"으로
    // 이력에 넣으면, 그 수는 세 번째 반복(무승부)이 되므로 다른 수를 골라야 한다.
    const s = makeState({ board: 'r.b .k. ... BKR', hand: ['PP', ''] });
    const r = hint(s);
    expect(r.score).toBeGreaterThan(0);
    const after = applyMove(s, r.move!);
    const seeded = fromTransfer({ ...toTransfer(s), history: [after.key, after.key, s.key] });
    expect(applyMove(seeded, r.move!).result).toEqual({ kind: 'draw', reason: 'repetition' });
    const r2 = hint(seeded);
    expect(key(r2.move)).not.toBe(key(r.move));
    expect(applyMove(seeded, r2.move!).result?.kind).not.toBe('draw');
  });
});
