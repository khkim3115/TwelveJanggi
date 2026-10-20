// 선후공 편차 실측 벤치 — vitest 밖에서 돈다(정밀 측정에 수백 판이 필요해서).
//
//   npm run -s bench:seats -- --a hard --b hard --depth 4 --shard 0/8 --out .tmp/bench/hh-0.json
//   npm run -s bench:seats -- --a hard --b normal --nodes 350000,20000 --depth 4 --out .tmp/bench/hn.json
//   npm run -s bench:seats -- --merge .tmp/bench/hh-*.json        ← 샤드 결과 합치기 + 리포트
//
// 설계(통계가 판 수를 부풀리지 않게):
//  · 시작 국면은 처음부터 depth ply(짝수 — 양쪽이 같은 수만큼)를 "王 을 바로 내주지 않는 수"로 전부 펼쳐
//    서로 다른 국면만 남기고, 평가값이 ±balance 안인 것만 쓴다. 표본 단위는 판이 아니라 시작 국면이다.
//  · a·b 가 같은 설정이면(자가대국) 시작 국면마다 선공(녹)의 승점을 잰다. 결정론적인 어려움은 한 판이면
//    충분하고(같은 국면이면 같은 판), 잡음이 있는 난이도는 --repeat 번 둔다.
//  · a·b 가 다르면 시작 국면마다 a 가 녹으로 한 판·적으로 한 판(짝지은 비교)을 두어 a 의 좌석별 승점과
//    그 차이를 잰다.
//  · 신뢰구간은 시작 국면별 평균의 표준오차로 낸다(무승부 0.5 포함한 실제 분산).

import { readFileSync, writeFileSync } from 'node:fs';
import {
  applyMoveInPlace,
  createInitialState,
  legalMoves,
  stateFrom,
  undoMove,
  type GameResult,
  type GameState,
} from '../src/core/gameState';
import { mulberry32 } from '../src/core/rng';
import { DIFFICULTIES, PRESETS, chooseMove, type Difficulty } from '../src/engine/ai';
import { FULL_WEIGHTS, evaluate } from '../src/engine/evaluate';
import { MATE_BOUND, tacticalScore } from '../src/engine/search';

interface OpeningRecord {
  key: number;
  /** 자가대국: 판마다 선공(녹)의 승점. */
  first: number[];
  /** 짝지은 비교: a 가 녹일 때 / 적일 때 a 의 승점. */
  aAs1: number[];
  aAs2: number[];
}

interface BenchFile {
  a: string;
  b: string;
  mode: 'self' | 'paired';
  depth: number;
  balance: number;
  /** 시작 국면 표본 시드·개수(0 = 전부)·국면당 반복 — 합칠 때 설정이 같은지 확인한다. */
  seed: number;
  openings: number;
  repeat: number;
  records: OpeningRecord[];
  games: number;
  plies: number;
  reasons: Record<string, number>;
}

const PLY_CAP = 300;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** 둔 즉시 지거나 상대에게 확정 승리를 넘기는 수인가. */
function losesAtOnce(s: GameState, i: number): boolean {
  const me = s.turn;
  const m = legalMoves(s)[i];
  const u = applyMoveInPlace(s, m);
  const r = s.result;
  const lost = r ? r.kind === 'win' && r.winner !== me : (tacticalScore(s, 0) ?? 0) >= MATE_BOUND;
  undoMove(s, u);
  return lost;
}

/** depth ply 까지 안전한 수로 펼친 서로 다른 시작 국면(평가 ±balance 안). 순서는 결정론적이다. */
function openings(depth: number, balance: number): GameState[] {
  const seen = new Set<number>();
  const out: GameState[] = [];
  const walk = (s: GameState, left: number) => {
    if (s.result) return;
    if (left === 0) {
      if (seen.has(s.key)) return;
      seen.add(s.key);
      if (Math.abs(evaluate(s, s.turn, FULL_WEIGHTS)) <= balance) out.push(stateFrom(s.board, s.hand, s.turn));
      return;
    }
    const ms = legalMoves(s);
    for (let i = 0; i < ms.length; i++) {
      if (losesAtOnce(s, i)) continue;
      const u = applyMoveInPlace(s, ms[i]);
      walk(s, left - 1);
      undoMove(s, u);
    }
  };
  walk(createInitialState(), depth);
  return out;
}

interface Side {
  d: Difficulty;
  nodes: number;
}

function play(start: GameState, green: Side, red: Side, rng: () => number) {
  const s = stateFrom(start.board, start.hand, start.turn);
  while (!s.result && s.ply < PLY_CAP) {
    const p = s.turn === 1 ? green : red;
    const m = chooseMove(s, p.d, { rng, timeBudgetMs: Infinity, maxNodes: p.nodes });
    if (!m) break;
    applyMoveInPlace(s, m);
  }
  const result: GameResult = s.result ?? { kind: 'draw', reason: 'repetition' };
  const firstPts = result.kind === 'draw' ? 0.5 : result.winner === 1 ? 1 : 0;
  return { firstPts, plies: s.ply, reason: s.result ? result.reason : 'cap' };
}

function bench(): BenchFile {
  const a = arg('a', 'hard') as Difficulty;
  const b = arg('b', 'hard') as Difficulty;
  if (!DIFFICULTIES.includes(a) || !DIFFICULTIES.includes(b)) throw new Error('--a/--b 는 easy|normal|hard');
  const [na, nb] = (arg('nodes') ?? `${PRESETS[a].maxNodes},${PRESETS[b].maxNodes}`).split(',').map(Number);
  const depth = Number(arg('depth', '4'));
  if (!Number.isInteger(depth) || depth < 0 || depth % 2 !== 0) {
    throw new Error('--depth 는 0 이상의 짝수만(양쪽이 같은 수만큼 둔 시작 국면)');
  }
  const balance = Number(arg('balance', '200'));
  const limit = Number(arg('openings', '0')); // 0 이면 전부
  const seed = Number(arg('seed', '1'));
  const [shard, shards] = (arg('shard', '0/1') ?? '0/1').split('/').map(Number);
  const self = a === b && na === nb;
  // 양쪽 다 결정론적이면(어려움끼리) 같은 시작 국면에서는 같은 판이 나오므로 한 번이면 충분하다.
  const fixed = (d: Difficulty) => PRESETS[d].noise === 0 && PRESETS[d].blunderRate === 0;
  const repeat = Number(arg('repeat', fixed(a) && fixed(b) ? '1' : '2'));

  let pool = openings(depth, balance);
  if (limit > 0 && limit < pool.length) {
    // 시드 고정 셔플 후 앞에서 limit 개.
    const r = mulberry32(seed);
    pool = pool
      .map((s) => ({ s, k: r() }))
      .sort((x, y) => x.k - y.k)
      .slice(0, limit)
      .map((x) => x.s);
  }

  const out: BenchFile = {
    a: `${a}@${na}`,
    b: `${b}@${nb}`,
    mode: self ? 'self' : 'paired',
    depth,
    balance,
    seed,
    openings: limit,
    repeat,
    records: [],
    games: 0,
    plies: 0,
    reasons: {},
  };
  const A: Side = { d: a, nodes: na };
  const B: Side = { d: b, nodes: nb };
  pool.forEach((start, idx) => {
    if (idx % shards !== shard) return;
    const rec: OpeningRecord = { key: start.key, first: [], aAs1: [], aAs2: [] };
    for (let k = 0; k < repeat; k++) {
      const rng = mulberry32((start.key % 1_000_003) * 31 + k * 7 + seed);
      const tally = (g: ReturnType<typeof play>) => {
        out.games += 1;
        out.plies += g.plies;
        out.reasons[g.reason] = (out.reasons[g.reason] ?? 0) + 1;
      };
      if (self) {
        const g = play(start, A, B, rng);
        rec.first.push(g.firstPts);
        tally(g);
      } else {
        const g1 = play(start, A, B, rng);
        rec.aAs1.push(g1.firstPts);
        rec.first.push(g1.firstPts);
        tally(g1);
        const g2 = play(start, B, A, rng);
        rec.aAs2.push(1 - g2.firstPts);
        rec.first.push(g2.firstPts);
        tally(g2);
      }
    }
    out.records.push(rec);
  });
  return out;
}

function readBench(file: string): BenchFile {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  return JSON.parse(text) as BenchFile;
}

function merge(files: string[]): BenchFile {
  const all = files.map(readBench);
  const head = all[0];
  const config = (f: BenchFile) => [f.a, f.b, f.mode, f.depth, f.balance, f.seed, f.openings, f.repeat].join('|');
  for (const f of all) {
    if (config(f) !== config(head)) {
      throw new Error(`설정이 다른 결과는 합칠 수 없습니다: ${config(f)} ≠ ${config(head)}`);
    }
  }
  // 샤드는 시작 국면을 나눠 맡으므로 겹치면 안 된다 — 같은 파일을 두 번 넘기는 실수를 막는다.
  const byKey = new Map<number, OpeningRecord>();
  for (const f of all) {
    for (const r of f.records) {
      if (byKey.has(r.key)) throw new Error(`시작 국면 ${r.key} 가 두 파일에 있습니다 — 겹치는 결과는 합치지 않습니다`);
      byKey.set(r.key, r);
    }
  }
  const reasons: Record<string, number> = {};
  for (const f of all) for (const [k, v] of Object.entries(f.reasons)) reasons[k] = (reasons[k] ?? 0) + v;
  return {
    ...head,
    records: [...byKey.values()],
    games: all.reduce((n, f) => n + f.games, 0),
    plies: all.reduce((n, f) => n + f.plies, 0),
    reasons,
  };
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** 시작 국면별 값의 평균과 95% 구간 반폭(표준오차 × 1.96). */
function summarize(xs: number[]): { mean: number; half: number; n: number } {
  const n = xs.length;
  const m = mean(xs);
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : 0;
  return { mean: m, half: (1.96 * sd) / Math.sqrt(Math.max(n, 1)), n };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function report(f: BenchFile): void {
  console.log(`${f.a} vs ${f.b} — 시작 국면 ${f.records.length}개(${f.depth} ply, 평가 ±${f.balance}), ` +
    `${f.games}판, 평균 ${(f.plies / Math.max(f.games, 1)).toFixed(1)} ply`);
  const first = summarize(f.records.map((r) => mean(r.first)));
  console.log(`  선공(녹) 승점   ${pct(first.mean)} ±${pct(first.half)}  → 선공 우위 ${pct(2 * first.mean - 1)} ±${pct(2 * first.half)}`);
  if (f.mode === 'paired') {
    const s1 = summarize(f.records.map((r) => mean(r.aAs1)));
    const s2 = summarize(f.records.map((r) => mean(r.aAs2)));
    const diff = summarize(f.records.map((r) => mean(r.aAs1) - mean(r.aAs2)));
    console.log(`  ${f.a} 가 녹(선공)  ${pct(s1.mean)} ±${pct(s1.half)}`);
    console.log(`  ${f.a} 가 적(후공)  ${pct(s2.mean)} ±${pct(s2.half)}`);
    console.log(`  좌석 차(녹−적)    ${pct(diff.mean)} ±${pct(diff.half)} (짝지은 비교)`);
  }
  console.log(`  끝난 방식        ${JSON.stringify(f.reasons)}`);
}

const mergeAt = process.argv.indexOf('--merge');
if (mergeAt >= 0) {
  report(merge(process.argv.slice(mergeAt + 1)));
} else {
  const f = bench();
  const outFile = arg('out');
  if (outFile) writeFileSync(outFile, JSON.stringify(f));
  else report(f);
}
