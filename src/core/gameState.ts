// 십이장기 규칙 엔진(순수). UI·네트워크·AI 가 모두 이 한 벌만 쓴다. 룰 요약과 판정 순서는 rules.ts 머리말.
//
// 표현 원칙:
//  · 수는 한 모양(Move)이다 — 판 위 이동(from ≥ 0)과 손패 투입(from = DROP)을 같은 필드로 나타내고,
//    승격은 그 수에 붙는 플래그(promote)다. UI 클릭 · 서버 RPC(tj_play) · 탐색이 같은 표현을 공유한다.
//  · 규칙 코드는 applyMoveInPlace 한 곳에만 있다. 불변 버전(applyMove)은 clone 후 이를 호출하고,
//    엔진은 make/unmake(applyMoveInPlace/undoMove)로 같은 함수를 쓴다 → 규칙이 두 벌로 갈라질 여지가 없다.
//  · 해시가 둘이다. hash(zobrist, 32비트 증분)는 전치표용, key(충돌 없는 정확한 정수)는 반복 판정용 —
//    반복 무승부가 해시 충돌 때문에 서버(정확한 텍스트 키)와 어긋나는 일이 없게 하려는 것.

import {
  CELL_COUNT,
  HAND_KINDS,
  HU,
  INITIAL_BOARD,
  JA,
  JANG,
  KING,
  KIND_LETTER,
  ROW_OF,
  STEPS,
  farRow,
  type HandKind,
  type Kind,
  type Side,
} from './board';
import { DEFAULT_RULES, type RuleConfig } from './rules';
import { HAND_MAX, ZOB } from './zobrist';

export type Player = Side;
export type Phase = 'playing' | 'over';

/** 손패 투입을 뜻하는 Move.from 값. 서버 tj_play 의 p_from 도 같은 값을 쓴다. */
export const DROP = -1;

export interface Move {
  /** 출발 칸. 손패 투입이면 DROP(-1). */
  from: number;
  to: number;
  /** 움직이는(투입이면 놓는) 말의 종류 — 승격 전 기준. (`.kind` 는 결과·클릭의 문자열 태그 이름이라 피한다) */
  piece: Kind;
  /** 이 수로 子 가 侯 가 되는가. 합법 수 생성이 정하는 강제 플래그다(고르는 값이 아님). */
  promote: boolean;
}

export type WinReason = 'capture' | 'try' | 'blocked' | 'resign' | 'timeout';
export type DrawReason = 'repetition';

export type GameResult =
  | { kind: 'win'; winner: Player; reason: WinReason }
  | { kind: 'draw'; reason: DrawReason };

export interface GameState {
  /** 12칸 부호 코드: +k 녹 / −k 적 / 0 빈칸 (board.ts). */
  board: Int8Array;
  /** 손패 개수 [녹 將·相·子, 적 將·相·子] — handIndex 로 접근. */
  hand: Int8Array;
  turn: Player;
  phase: Phase;
  result: GameResult | null;
  /** zobrist 해시(전치표용). */
  hash: number;
  /** 정확한 국면 키(반복 판정용). */
  key: number;
  /** 지나온 국면의 key — 시작 국면 포함, 되돌리기 시 pop. */
  history: number[];
  /** key → 등장 횟수(반복 무승부). */
  reps: Map<number, number>;
  ply: number;
  rules: RuleConfig;
}

export interface Undo {
  move: Move;
  /** from 칸에 있던 값(투입이면 0). 승격된 말도 원래 모양으로 되돌린다. */
  moved: number;
  /** to 칸에 있던 값 — 잡힌 말. 부호 코드 그대로라 侯/子 가 구분된다. */
  captured: number;
  prevPhase: Phase;
  prevResult: GameResult | null;
  prevHash: number;
  prevKey: number;
}

/* ── 말·손패 도우미 ──────────────────────────────────────────────────── */

export const other = (p: Player): Player => (p === 1 ? 2 : 1);

/** 셀 값의 주인(빈칸이 아니라는 전제). */
export function sideOf(v: number): Player {
  return v > 0 ? 1 : 2;
}

/** 셀 값의 종류(빈칸이 아니라는 전제). */
export function kindOf(v: number): Kind {
  return (v < 0 ? -v : v) as Kind;
}

export function pieceCode(side: Player, kind: Kind): number {
  return side === 1 ? kind : -kind;
}

/** hand 배열 위치. */
export function handIndex(side: Player, kind: HandKind): number {
  return (side - 1) * 3 + (kind - JANG);
}

export function handCount(s: GameState, side: Player, kind: HandKind): number {
  return s.hand[handIndex(side, kind)];
}

/** 잡힌 말이 손패로 들어갈 때의 종류. 侯 는 子 로 돌아가고, 王 은 손패가 되지 않는다(null). */
export function capturedToHand(kind: Kind): HandKind | null {
  if (kind === KING) return null;
  return kind === HU ? JA : (kind as HandKind);
}

/** side 의 kind 말이 to 로 움직이면 승격하는가(이동 전용 — 투입은 승격하지 않는다). */
export function isPromotion(side: Player, kind: Kind, to: number): boolean {
  return kind === JA && ROW_OF[to] === farRow(side);
}

/** side 의 王 이 있는 칸. 없으면(잡힌 뒤) −1. */
export function findKing(board: Int8Array, side: Player): number {
  const code = pieceCode(side, KING);
  for (let i = 0; i < CELL_COUNT; i++) if (board[i] === code) return i;
  return -1;
}

/* ── 합법 수 ─────────────────────────────────────────────────────────── */

export function legalMoves(s: GameState): Move[] {
  if (s.phase === 'over') return [];
  const me = s.turn;
  const out: Move[] = [];

  for (let from = 0; from < CELL_COUNT; from++) {
    const v = s.board[from];
    if (v === 0 || sideOf(v) !== me) continue;
    const kind = kindOf(v);
    for (const to of STEPS[me][kind][from]) {
      const t = s.board[to];
      if (t !== 0 && sideOf(t) === me) continue;
      out.push({ from, to, piece: kind, promote: isPromotion(me, kind, to) });
    }
  }

  const far = farRow(me);
  for (const kind of HAND_KINDS) {
    if (s.hand[handIndex(me, kind)] === 0) continue;
    for (let to = 0; to < CELL_COUNT; to++) {
      if (s.board[to] === 0 && ROW_OF[to] !== far) out.push({ from: DROP, to, piece: kind, promote: false });
    }
  }
  return out;
}

/**
 * 합법 수가 하나라도 있는지만 확인(legalMoves 전체 생성 없이). blocked 판정에 쓴다.
 * 참고: 판 위 말이 전부 막히는 배치는 비왕 말 6개를 모두 써야 해서(전수 확인), 실전 국면에서는 손패가 있으면
 * 판 위 수도 반드시 있다 — 아래 투입 분기는 방어용이다. 서버 tj_has_move 도 같은 구조를 따른다.
 */
export function hasLegalMove(s: GameState): boolean {
  if (s.phase === 'over') return false;
  const me = s.turn;
  for (let from = 0; from < CELL_COUNT; from++) {
    const v = s.board[from];
    if (v === 0 || sideOf(v) !== me) continue;
    for (const to of STEPS[me][kindOf(v)][from]) {
      const t = s.board[to];
      if (t === 0 || sideOf(t) !== me) return true;
    }
  }
  const base = handIndex(me, JANG);
  if (s.hand[base] + s.hand[base + 1] + s.hand[base + 2] === 0) return false;
  const far = farRow(me);
  for (let to = 0; to < CELL_COUNT; to++) if (s.board[to] === 0 && ROW_OF[to] !== far) return true;
  return false;
}

export function sameMove(a: Move, b: Move): boolean {
  return a.from === b.from && a.to === b.to && a.piece === b.piece && a.promote === b.promote;
}

export function isLegal(s: GameState, m: Move): boolean {
  return legalMoves(s).some((x) => sameMove(x, m));
}

/** 수의 짧은 문자열 키(히스토리 휴리스틱·테스트 비교용). 투입 'P*7', 이동 '7-4', 승격 '3-0+'. */
export function moveKey(m: Move): string {
  if (m.from === DROP) return `${KIND_LETTER[m.piece]}*${m.to}`;
  return `${m.from}-${m.to}${m.promote ? '+' : ''}`;
}

/* ── 해시 · 국면 키 ──────────────────────────────────────────────────── */

const zPiece = (side: Player, kind: Kind, cell: number): number =>
  ZOB.piece[side - 1][(kind - 1) * CELL_COUNT + cell];

const zHand = (side: Player, kind: HandKind, count: number): number =>
  ZOB.hand[side - 1][(kind - JANG) * (HAND_MAX + 1) + count];

export function computeHash(s: Pick<GameState, 'board' | 'hand' | 'turn'>): number {
  let h = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    const v = s.board[i];
    if (v !== 0) h ^= zPiece(sideOf(v), kindOf(v), i);
  }
  for (const side of [1, 2] as const) {
    for (const kind of HAND_KINDS) h ^= zHand(side, kind, s.hand[handIndex(side, kind)]);
  }
  if (s.turn === 2) h ^= ZOB.turn;
  return h | 0;
}

/**
 * 정확한 국면 키 — 차례(2) × 손패(3^6) × 판(11^12) 의 혼합 진법 정수.
 * 최댓값 2·3^6·11^12 ≈ 4.6e15 < 2^53 이라 double 로 정확하다.
 */
export function computeKey(s: Pick<GameState, 'board' | 'hand' | 'turn'>): number {
  let k = s.turn - 1;
  for (let i = 0; i < 6; i++) k = k * (HAND_MAX + 1) + s.hand[i];
  for (let c = 0; c < CELL_COUNT; c++) k = k * 11 + (s.board[c] + 5);
  return k;
}

/* ── 상태 생성 · 복제 ────────────────────────────────────────────────── */

/** board·hand·turn 으로 새 국면을 만든다(이력은 이 국면 1회). */
function freshState(board: Int8Array, hand: Int8Array, turn: Player, rules: RuleConfig): GameState {
  const s: GameState = {
    board,
    hand,
    turn,
    phase: 'playing',
    result: null,
    hash: 0,
    key: 0,
    history: [],
    reps: new Map(),
    ply: 0,
    rules,
  };
  s.hash = computeHash(s);
  s.key = computeKey(s);
  s.history.push(s.key);
  s.reps.set(s.key, 1);
  return s;
}

/** 시작 국면. 녹(1P)이 먼저 둔다. 시작 국면도 반복 횟수 1회로 센다. */
export function createInitialState(rules: RuleConfig = DEFAULT_RULES): GameState {
  return freshState(Int8Array.from(INITIAL_BOARD), new Int8Array(6), 1, rules);
}

/** 테스트 빌더·스냅샷 복원용 — 임의 국면(검증은 호출자 책임). */
export function stateFrom(
  board: ArrayLike<number>,
  hand: ArrayLike<number>,
  turn: Player,
  rules: RuleConfig = DEFAULT_RULES,
): GameState {
  return freshState(Int8Array.from(board), Int8Array.from(hand), turn, rules);
}

export function cloneState(s: GameState): GameState {
  return {
    board: new Int8Array(s.board),
    hand: new Int8Array(s.hand),
    turn: s.turn,
    phase: s.phase,
    result: s.result,
    hash: s.hash,
    key: s.key,
    history: s.history.slice(),
    reps: new Map(s.reps),
    ply: s.ply,
    rules: s.rules,
  };
}

/* ── 착수 적용 ───────────────────────────────────────────────────────── */

/** 제자리 적용(엔진 핫패스). 합법 수만 넘길 것. 되돌리려면 반환한 Undo 를 undoMove 에 넘긴다. */
export function applyMoveInPlace(s: GameState, m: Move): Undo {
  const me = s.turn;
  const opp = other(me);
  const undo: Undo = {
    move: m,
    moved: 0,
    captured: 0,
    prevPhase: s.phase,
    prevResult: s.result,
    prevHash: s.hash,
    prevKey: s.key,
  };

  let h = s.hash;
  if (m.from === DROP) {
    const kind = m.piece as HandKind;
    const hi = handIndex(me, kind);
    h ^= zHand(me, kind, s.hand[hi]);
    s.hand[hi] -= 1;
    h ^= zHand(me, kind, s.hand[hi]);
    s.board[m.to] = pieceCode(me, kind);
    h ^= zPiece(me, kind, m.to);
  } else {
    const moved = s.board[m.from];
    const kind = kindOf(moved);
    const target = s.board[m.to];
    undo.moved = moved;
    undo.captured = target;

    if (target !== 0) {
      const tk = kindOf(target);
      h ^= zPiece(opp, tk, m.to);
      const toHand = capturedToHand(tk);
      if (toHand !== null) {
        const hi = handIndex(me, toHand);
        h ^= zHand(me, toHand, s.hand[hi]);
        s.hand[hi] += 1;
        h ^= zHand(me, toHand, s.hand[hi]);
      }
    }

    // 승격은 이 자리에서 결정한다 — m.promote 는 합법 수 생성이 같은 isPromotion 으로 채운 표시일 뿐.
    const landed: Kind = isPromotion(me, kind, m.to) ? HU : kind;
    s.board[m.from] = 0;
    h ^= zPiece(me, kind, m.from);
    s.board[m.to] = pieceCode(me, landed);
    h ^= zPiece(me, landed, m.to);
  }

  s.turn = opp;
  h ^= ZOB.turn;
  s.hash = h | 0;
  s.key = computeKey(s);
  s.ply += 1;
  s.history.push(s.key);
  s.reps.set(s.key, (s.reps.get(s.key) ?? 0) + 1);

  s.result = detectResult(s, undo.captured);
  if (s.result) s.phase = 'over';
  return undo;
}

export function undoMove(s: GameState, u: Undo): void {
  const k = s.history.pop();
  if (k !== undefined) {
    const c = s.reps.get(k) ?? 0;
    if (c <= 1) s.reps.delete(k);
    else s.reps.set(k, c - 1);
  }
  s.ply -= 1;

  const me = other(s.turn);
  const m = u.move;
  if (m.from === DROP) {
    s.board[m.to] = 0;
    s.hand[handIndex(me, m.piece as HandKind)] += 1;
  } else {
    s.board[m.from] = u.moved;
    s.board[m.to] = u.captured;
    if (u.captured !== 0) {
      const toHand = capturedToHand(kindOf(u.captured));
      if (toHand !== null) s.hand[handIndex(me, toHand)] -= 1;
    }
  }

  s.turn = me;
  s.phase = u.prevPhase;
  s.result = u.prevResult;
  s.hash = u.prevHash;
  s.key = u.prevKey;
}

/** 불변 적용(UI·테스트용). 규칙 코드는 applyMoveInPlace 한 곳뿐이다. */
export function applyMove(s: GameState, m: Move): GameState {
  const next = cloneState(s);
  applyMoveInPlace(next, m);
  return next;
}

/** 기권 — 규칙 밖의 종료(솔로 포기·멀티 나가기). 이미 끝난 판은 결과를 바꾸지 않는다. */
export function applyResign(s: GameState, quitter: Player): GameState {
  const next = cloneState(s);
  if (s.phase === 'over') return next;
  next.result = { kind: 'win', winner: other(quitter), reason: 'resign' };
  next.phase = 'over';
  return next;
}

/* ── 종료 판정 ───────────────────────────────────────────────────────── */

/** 방금 한 수를 둔 직후의 판정. 순서는 rules.ts 머리말과 서버 tj__advance 가 공유한다. */
function detectResult(s: GameState, captured: number): GameResult | null {
  const mover = other(s.turn);
  if (captured !== 0 && kindOf(captured) === KING) {
    return { kind: 'win', winner: mover, reason: 'capture' };
  }
  // 차례가 돌아온 쪽의 王 이 상대 진영에 있다 = 들어간 뒤 상대의 한 수를 버텼다.
  const king = findKing(s.board, s.turn);
  if (king >= 0 && ROW_OF[king] === farRow(s.turn)) {
    return { kind: 'win', winner: s.turn, reason: 'try' };
  }
  if ((s.reps.get(s.key) ?? 0) >= s.rules.repetitionLimit) {
    return { kind: 'draw', reason: 'repetition' };
  }
  if (!hasLegalMove(s)) {
    return { kind: 'win', winner: mover, reason: 'blocked' };
  }
  return null;
}

/* ── 스냅샷(서버 동기화용) ───────────────────────────────────────────── */

export interface Snapshot {
  board: number[];
  /** [녹 將·相·子, 적 將·相·子] — 서버 tj_rooms.hand 와 같은 이름·순서. */
  hand: number[];
  turn: Player;
}

export function toSnapshot(s: GameState): Snapshot {
  return { board: Array.from(s.board), hand: Array.from(s.hand), turn: s.turn };
}

/**
 * 서버가 보내준 국면을 그릴 수 있는 GameState 로 되살린다.
 * 반복 이력은 서버가 관리하므로 여기서는 이 국면 1회만 둔다(무승부 판정은 서버 권위).
 */
export function stateFromSnapshot(snap: Snapshot, rules: RuleConfig = DEFAULT_RULES): GameState {
  return stateFrom(snap.board, snap.hand, snap.turn, rules);
}

/**
 * Worker 로 넘기기 위한 직렬화형. 스냅샷과 달리 반복 이력까지 들고 가서
 * AI 가 "무승부로 몰리는 수"를 알아볼 수 있게 한다. 진행 중인 국면 전용이다 — 결과(phase·result)와
 * 룰 설정은 싣지 않는다(AI 는 끝난 판에 불리지 않고, 룰은 v1 고정).
 */
export interface StateTransfer extends Snapshot {
  history: number[];
  ply: number;
}

export function toTransfer(s: GameState): StateTransfer {
  return { ...toSnapshot(s), history: s.history.slice(), ply: s.ply };
}

export function fromTransfer(t: StateTransfer, rules: RuleConfig = DEFAULT_RULES): GameState {
  const s = stateFromSnapshot(t, rules);
  s.ply = t.ply;
  const hist = t.history.length > 0 ? t.history.slice() : [s.key];
  // 마지막 항목은 현재 국면이어야 한다. 어긋나면(직렬화 불일치) 현재 키로 보정.
  if (hist[hist.length - 1] !== s.key) hist.push(s.key);
  s.history = hist;
  s.reps = new Map();
  for (const k of hist) s.reps.set(k, (s.reps.get(k) ?? 0) + 1);
  return s;
}
