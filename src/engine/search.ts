// 알파베타 negamax + 반복심화 + 전치표 + 무브 오더링.
//
// 깊이는 ply 로 센다(한 수마다 차례가 바뀌므로 부호도 매번 뒤집는다).
// 나인 멘스 모리스 엔진에서 가져오며 이 게임에 맞게 바꾼 점:
//  · 노드마다 정확한 전술 판정 — 멀리 가는 말이 없어 공격 집합이 정확하므로
//    "王 을 잡을 수 있다 / 상대 王 이 내 진영에서 버티고 있다 / 내 王 이 안전하게 입성할 수 있다"를
//    수 생성 없이 바로 승패 점수로 돌려준다. 깊이 1 탐색도 王 을 내주는 수를 두지 않게 된다.
//    (잡기만 보는 정지 탐색은 투입을 못 보고, 王 이 위험할 때 stand-pat 이 틀리므로 쓰지 않는다.)
//  · 승패 점수는 전치표에 "그 노드 기준"으로 저장했다가 꺼낼 때 현재 ply 로 되돌린다 —
//    안 그러면 다른 깊이에서 재사용된 승리 거리가 어긋나 이긴 판을 반복으로 흘릴 수 있다.
//  · 탐색 중 이미 나온 국면(대국 이력 포함)에 다시 오면 무승부(0)로 본다. 전술 판정 다음, 전치표 조회 전에 본다.
//  · 노드 예산(maxNodes) — 테스트와 난이도 보정은 노드 수로 재현 가능하게, 시간은 상한으로만 쓴다.
//
// 참고: 전치표는 더 깊이 읽어 둔 항목도 재사용하므로(hit.depth >= depth), 깊이 6 이상에서는 보고 점수가
// "정확히 그 깊이의 미니맥스 값"과 드물게 다를 수 있다(더 깊은 정보가 섞인 값 — 흔한 엔진 동작).
// 깊이 1–5 는 완전 탐색과 정확히 같다(search.test.ts 가 1–4 를 지킨다).

import { KING, ROW_OF, STEPS, farRow } from '../core/board';
import {
  DROP,
  applyMoveInPlace,
  findKing,
  kindOf,
  legalMoves,
  moveKey,
  other,
  sameMove,
  sideOf,
  undoMove,
  type GameState,
  type Move,
} from '../core/gameState';
import { WIN_SCORE, evaluate, isAttacked, type Weights } from './evaluate';

export interface SearchOptions {
  /** 최대 탐색 깊이(ply). */
  maxDepth: number;
  weights: Weights;
  /** performance.now() 기준 마감 시각. 넘으면 그때까지 끝난 깊이의 결과를 쓴다. */
  deadline?: number;
  /** 노드 예산. 넘으면 마감과 같이 그때까지 끝난 깊이의 결과를 쓴다. */
  maxNodes?: number;
  /** 동점·근소차 무작위 선택용. 없으면 결정론적으로 첫 최선수를 고른다. */
  rng?: () => number;
  /** 루트 후보 점수에 섞는 잡음 폭(쉬움·보통 난이도가 실수하도록). */
  noise?: number;
}

export interface SearchResult {
  move: Move | null;
  score: number;
  /** 실제로 완주한 깊이. */
  depth: number;
  nodes: number;
  /** 마감·노드 예산 때문에 중간에 끊겼는가. */
  timedOut: boolean;
}

/** 이 이상이면 "확정된 승패" 점수다(승리 거리만큼 깎인 값 포함). */
export const MATE_BOUND = WIN_SCORE - 1000;

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const TT_MAX_ENTRIES = 1 << 18;

interface TTEntry {
  depth: number;
  /** 승패 점수는 이 노드 기준(ply 를 뺀 값)으로 저장한다. */
  score: number;
  flag: number;
  move: Move | null;
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** ply 기준 점수 → 노드 기준(저장용). */
function toTT(score: number, ply: number): number {
  if (score >= MATE_BOUND) return score + ply;
  if (score <= -MATE_BOUND) return score - ply;
  return score;
}

/** 노드 기준 점수 → ply 기준(조회용). */
function fromTT(score: number, ply: number): number {
  if (score >= MATE_BOUND) return score - ply;
  if (score <= -MATE_BOUND) return score + ply;
  return score;
}

class Searcher {
  private tt = new Map<number, TTEntry>();
  private history = new Map<string, number>();
  private nodes = 0;
  private aborted = false;

  constructor(private readonly opts: SearchOptions) {}

  /** 반복심화. 깊이를 하나씩 올리며 예산 안에서 완주한 마지막 결과를 돌려준다. */
  run(root: GameState): SearchResult {
    let best: SearchResult = { move: null, score: 0, depth: 0, nodes: 0, timedOut: false };

    for (let depth = 1; depth <= this.opts.maxDepth; depth++) {
      this.aborted = false;
      const r = this.searchRoot(root, depth);
      if (this.aborted) {
        // 첫 깊이조차 못 끝냈으면 그때까지 본 최선이라도 쓴다(완주한 깊이는 0).
        best = best.move
          ? { ...best, nodes: this.nodes, timedOut: true }
          : { ...r, depth: 0, nodes: this.nodes, timedOut: true };
        if (!Number.isFinite(best.score)) best.score = 0;
        break;
      }
      best = { ...r, nodes: this.nodes, timedOut: false };
      // 확실한 승패를 찾았으면 더 파도 의미 없다.
      if (Math.abs(best.score) >= MATE_BOUND) break;
    }
    if (!best.move) {
      const ms = legalMoves(root);
      best.move = ms.length ? ms[0] : null;
    }
    return best;
  }

  private searchRoot(s: GameState, depth: number): SearchResult {
    const moves = this.order(s, this.tt.get(s.hash)?.move ?? null);
    const rng = this.opts.rng;
    const noise = this.opts.noise ?? 0;
    // 잡음이나 무작위 동점 선택을 쓸 때는 루트에서 알파 가지치기를 끈다 — 안 그러면 컷된 수의 점수가
    // 상한값일 뿐이라(알파와 같은 값으로 돌아와 동점처럼 보이기도 한다) 실제로 얼마나 나쁜 수인지 알 수 없다.
    const prune = noise === 0 && !rng;

    let alpha = -Infinity;
    let bestMove: Move | null = null;
    let bestTrue = -Infinity;
    let bestRanked = -Infinity;
    let ties = 0;

    for (const m of moves) {
      const score = this.child(s, m, depth, prune ? alpha : -Infinity, Infinity, 0);
      if (this.aborted) {
        return { move: bestMove, score: bestTrue, depth, nodes: this.nodes, timedOut: true };
      }
      // 확정 승패에는 잡음을 섞지 않는다 — 쉬움도 한 수 만에 끝나는 수·지는 수는 알아본다.
      const jitter = noise > 0 && rng && Math.abs(score) < MATE_BOUND ? (rng() * 2 - 1) * noise : 0;
      const ranked = score + jitter;
      if (bestMove === null || ranked > bestRanked) {
        bestRanked = ranked;
        bestTrue = score;
        bestMove = m;
        ties = 1;
        if (score > alpha) alpha = score;
      } else if (ranked === bestRanked) {
        // 동점은 무작위로 고른다(reservoir) — rng 가 없으면 결정론적으로 첫 수 유지.
        ties += 1;
        if (rng && rng() < 1 / ties) {
          bestTrue = score;
          bestMove = m;
        }
      }
    }
    if (bestMove) {
      this.tt.set(s.hash, { depth, score: toTT(bestTrue, 0), flag: TT_EXACT, move: bestMove });
    }
    return { move: bestMove, score: bestTrue, depth, nodes: this.nodes, timedOut: false };
  }

  /** 한 수를 두고 자식을 평가한다. 한 수마다 차례가 바뀌므로 항상 부호를 뒤집는다. */
  private child(s: GameState, m: Move, depth: number, alpha: number, beta: number, ply: number): number {
    const u = applyMoveInPlace(s, m);
    const score = -this.negamax(s, depth - 1, -beta, -alpha, ply + 1);
    undoMove(s, u);
    return score;
  }

  private negamax(s: GameState, depth: number, alphaIn: number, betaIn: number, ply: number): number {
    this.nodes += 1;
    if (this.opts.maxNodes !== undefined && this.nodes >= this.opts.maxNodes) {
      this.aborted = true;
      return 0;
    }
    if ((this.nodes & 0x3ff) === 0 && this.opts.deadline !== undefined && now() >= this.opts.deadline) {
      this.aborted = true;
      return 0;
    }

    if (s.result) {
      if (s.result.kind === 'draw') return 0;
      return s.result.winner === s.turn ? WIN_SCORE - ply : -(WIN_SCORE - ply);
    }
    const forced = tactics(s, ply);
    if (forced !== null) return forced;
    // 이미 나온 국면으로 돌아왔다 — 반복은 무승부로 본다(실제 무승부는 3회지만 탐색에서는 순환을 끊는다).
    if ((s.reps.get(s.key) ?? 0) >= 2) return 0;
    if (depth <= 0) return evaluate(s, s.turn, this.opts.weights);

    let alpha = alphaIn;
    let beta = betaIn;
    const hit = this.tt.get(s.hash);
    if (hit && hit.depth >= depth) {
      const score = fromTT(hit.score, ply);
      if (hit.flag === TT_EXACT) return score;
      if (hit.flag === TT_LOWER && score > alpha) alpha = score;
      else if (hit.flag === TT_UPPER && score < beta) beta = score;
      if (alpha >= beta) return score;
    }

    const moves = this.order(s, hit?.move ?? null);
    if (moves.length === 0) return evaluate(s, s.turn, this.opts.weights);

    let best = -Infinity;
    let bestMove: Move | null = null;
    for (const m of moves) {
      const score = this.child(s, m, depth, alpha, beta, ply);
      if (this.aborted) return best === -Infinity ? 0 : best;
      if (score > best) {
        best = score;
        bestMove = m;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        const key = moveKey(m);
        this.history.set(key, (this.history.get(key) ?? 0) + depth * depth);
        break;
      }
    }

    if (this.tt.size >= TT_MAX_ENTRIES) this.tt.clear();
    this.tt.set(s.hash, {
      depth,
      score: toTT(best, ply),
      flag: best <= alphaIn ? TT_UPPER : best >= betaIn ? TT_LOWER : TT_EXACT,
      move: bestMove,
    });
    return best;
  }

  /** 무브 오더링: 전치표 수 → 잡기(비싼 말을 싼 말로) → 승격 → 상대 진영으로 가는 王 → 히스토리. */
  private order(s: GameState, ttMove: Move | null): Move[] {
    const moves = legalMoves(s);
    if (moves.length <= 1) return moves;
    const scored = moves.map((m) => ({ m, v: this.moveScore(s, m, ttMove) }));
    scored.sort((a, b) => b.v - a.v);
    return scored.map((x) => x.m);
  }

  private moveScore(s: GameState, m: Move, ttMove: Move | null): number {
    if (ttMove && sameMove(m, ttMove)) return 1 << 24;
    let v = this.history.get(moveKey(m)) ?? 0;
    if (m.from === DROP) return v;
    const target = s.board[m.to];
    if (target !== 0) v += (1 << 20) + ORDER_VALUE[kindOf(target)] * 16 - ORDER_VALUE[m.piece];
    if (m.promote) v += 1 << 18;
    if (m.piece === KING && ROW_OF[m.to] === farRow(s.turn)) v += 1 << 17;
    return v;
  }
}

/** 오더링 전용 대략 가치(MVV-LVA). 王 잡기가 맨 앞. */
const ORDER_VALUE: readonly number[] = [0, 100, 4, 3, 1, 5];

/**
 * 수 생성 없이 확정되는 승패. 지금 둘 쪽(me) 기준 점수, 확정이 아니면 null.
 *  1. me 가 상대 王 을 공격 중        → 다음 수에 잡아 이긴다            WIN − (ply+1)
 *  2. 상대 王 이 내 진영에서 버티는 중 → 무엇을 둬도 상대 차례에 진다      −(WIN − (ply+1))
 *  3. 내 王 이 상대가 노리지 않는 상대 진영 칸으로 갈 수 있다
 *                                      → 들어간 뒤 한 턴을 버텨 이긴다    WIN − (ply+2)
 * 2 가 아니면 상대는 내 王 이 들어간 직후 이길 방법이 없다(王 을 잡거나 자기 입성이 먼저 성립해야 하는데 둘 다 불가).
 */
function tactics(s: GameState, ply: number): number | null {
  const me = s.turn;
  const opp = other(me);
  const theirKing = findKing(s.board, opp);
  if (isAttacked(s.board, me, theirKing)) return WIN_SCORE - (ply + 1);
  if (ROW_OF[theirKing] === farRow(opp)) return -(WIN_SCORE - (ply + 1));
  const myKing = findKing(s.board, me);
  const far = farRow(me);
  for (const n of STEPS[me][KING][myKing]) {
    if (ROW_OF[n] !== far) continue;
    const t = s.board[n];
    if (t !== 0 && sideOf(t) === me) continue;
    if (!isAttacked(s.board, opp, n)) return WIN_SCORE - (ply + 2);
  }
  return null;
}

export function search(state: GameState, opts: SearchOptions): SearchResult {
  return new Searcher(opts).run(state);
}

/** 전술 판정만 따로(테스트·디버깅용). */
export { tactics as tacticalScore };
