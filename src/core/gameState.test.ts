// 룰 v1 의 규칙 계약. UI·AI·서버가 전부 이 동작을 전제로 만들어진다.
import { describe, expect, it } from 'vitest';
import { HU, JA, JANG, KING, KINDS, SANG } from './board';
import {
  DROP,
  applyMove,
  applyMoveInPlace,
  applyResign,
  computeHash,
  computeKey,
  createInitialState,
  fromTransfer,
  handCount,
  hasLegalMove,
  isLegal,
  kindOf,
  legalMoves,
  moveKey,
  stateFromSnapshot,
  toSnapshot,
  toTransfer,
  undoMove,
  type GameState,
  type Move,
  type Undo,
} from './gameState';
import { mulberry32 } from './rng';
import { formatBoard, makeState } from './testkit';

const keys = (ms: Move[]) => ms.map(moveKey).sort();
const boardKeys = (s: GameState, from: number) =>
  legalMoves(s)
    .filter((m) => m.from === from)
    .map((m) => m.to)
    .sort((a, b) => a - b);
const mv = (s: GameState, key: string): Move => {
  const m = legalMoves(s).find((x) => moveKey(x) === key);
  if (!m) throw new Error(`합법 수가 아님: ${key} @ ${formatBoard(s)}`);
  return m;
};
const play = (s: GameState, ...ks: string[]) => ks.reduce((cur, k) => applyMove(cur, mv(cur, k)), s);

describe('시작 국면', () => {
  it('녹이 먼저 두고 손패는 비어 있으며, 첫 수는 넷뿐이다', () => {
    const s = createInitialState();
    expect(formatBoard(s)).toBe('rkb .p. .P. BKR');
    expect(s.turn).toBe(1);
    expect(Array.from(s.hand)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(s.phase).toBe('playing');
    // 子 가 마주 선 子 를 잡기 · 王 의 좌우 앞 대각 · 將 전진. 相 은 자기 子 에 막혀 있다.
    expect(keys(legalMoves(s))).toEqual(['10-6', '10-8', '11-8', '7-4']);
  });

  it('해시·국면 키는 전체 계산과 같고, 시작 국면이 이력에 1회 들어 있다', () => {
    const s = createInitialState();
    expect(s.hash).toBe(computeHash(s));
    expect(s.key).toBe(computeKey(s));
    expect(s.history).toEqual([s.key]);
    expect(s.reps.get(s.key)).toBe(1);
  });
});

describe('말별 이동', () => {
  // 나머지 말은 손패에 둬서 판을 비운다(손패 투입 수는 from = DROP 이라 걸러진다).
  it('王 은 8방향', () => {
    const s = makeState({ board: 'k.. ... .K. ...', hand: ['RRBBPP', ''] });
    expect(boardKeys(s, 7)).toEqual([3, 4, 5, 6, 8, 9, 10, 11]);
  });

  it('將 은 상하좌우', () => {
    const s = makeState({ board: 'k.. .R. ... .K.', hand: ['RBBPP', ''] });
    expect(boardKeys(s, 4)).toEqual([1, 3, 5, 7]);
  });

  it('相 은 대각 — 상대 王 이 있는 칸도 목적지(잡기)', () => {
    const s = makeState({ board: 'k.. .B. ... .K.', hand: ['RRBPP', ''] });
    expect(boardKeys(s, 4)).toEqual([0, 2, 6, 8]);
  });

  it('子 는 앞 한 칸', () => {
    const s = makeState({ board: 'k.. ... .P. .K.', hand: ['RRBBP', ''] });
    expect(boardKeys(s, 7)).toEqual([4]);
  });

  it('侯 는 뒤쪽 대각을 뺀 6방향', () => {
    const s = makeState({ board: 'k.. .H. ... .K.', hand: ['RRBBP', ''] });
    expect(boardKeys(s, 4)).toEqual([0, 1, 2, 3, 5, 7]);
  });

  it('적의 子 · 侯 는 아래쪽이 앞이다', () => {
    const p = makeState({ board: 'k.. .p. ... .K.', turn: 2, hand: ['', 'RRBBP'] });
    expect(boardKeys(p, 4)).toEqual([7]);
    const h = makeState({ board: 'k.. ... .h. .K.', turn: 2, hand: ['', 'RRBBP'] });
    expect(boardKeys(h, 7)).toEqual([4, 6, 8, 9, 10, 11]);
  });

  it('내 말이 있는 칸으로는 못 간다', () => {
    const s = createInitialState();
    expect(boardKeys(s, 9)).toEqual([]); // 相 a1 → b2 는 내 子
    expect(boardKeys(s, 10)).toEqual([6, 8]);
  });
});

describe('잡기와 손패', () => {
  it('잡은 말은 내 손패가 되고 차례가 넘어간다', () => {
    const s = play(createInitialState(), '7-4');
    expect(formatBoard(s)).toBe('rkb .P. ... BKR');
    expect(handCount(s, 1, JA)).toBe(1);
    expect(s.turn).toBe(2);
    expect(s.hash).toBe(computeHash(s));
  });

  it('侯 를 잡으면 子 로 돌아와 손패에 들어간다', () => {
    const s = makeState({ board: 'k.. .h. .R. .K.', hand: ['RBB', 'P'] });
    const next = play(s, '7-4');
    expect(next.board[4]).toBe(JANG);
    expect(handCount(next, 1, JA)).toBe(1);
    expect(Array.from(next.hand)).toEqual([1, 2, 1, 0, 0, 1]);
  });

  it('王 을 잡아도 손패에는 들어가지 않는다', () => {
    const s = makeState({ board: '.k. .R. ... .K.', hand: ['RBP', 'BP'] });
    const next = play(s, '4-1');
    expect(Array.from(next.hand)).toEqual(Array.from(s.hand));
    expect(next.result).toEqual({ kind: 'win', winner: 1, reason: 'capture' });
    expect(next.phase).toBe('over');
    expect(legalMoves(next)).toEqual([]);
  });

  it('적이 녹 王 을 잡아도 마찬가지다', () => {
    const s = makeState({ board: '..k .K. ... ...', turn: 2, hand: ['RBP', 'RBP'] });
    const next = play(s, '2-4');
    expect(Array.from(next.hand)).toEqual(Array.from(s.hand));
    expect(next.result).toEqual({ kind: 'win', winner: 2, reason: 'capture' });
  });
});

describe('투입', () => {
  it('빈칸에만, 상대 진영 행에는 놓을 수 없다', () => {
    // 적 진영(행 0)의 1 이 비어 있지만 투입 대상이 아니다.
    const s = makeState({ board: 'r.b .k. .P. BKR', hand: ['P', ''] });
    const drops = legalMoves(s).filter((m) => m.from === DROP);
    expect(keys(drops)).toEqual(['P*3', 'P*5', 'P*6', 'P*8']);
    expect(isLegal(s, { from: DROP, to: 1, piece: JA, promote: false })).toBe(false);
  });

  it('將·相 도 상대 진영 행에는 못 놓는다', () => {
    const s = makeState({ board: 'k.. ... .K. ...', hand: ['RRBBPP', ''] });
    const drops = legalMoves(s).filter((m) => m.from === DROP);
    expect(new Set(drops.map((m) => m.piece))).toEqual(new Set([JANG, SANG, JA]));
    expect(drops.filter((m) => m.to <= 2)).toEqual([]);
  });

  it('적도 상대 진영(행 3)에는 못 놓는다', () => {
    const s = makeState({ board: 'rkb .p. .K. B.R', turn: 2, hand: ['', 'P'] });
    expect(keys(legalMoves(s).filter((m) => m.from === DROP))).toEqual(['P*3', 'P*5', 'P*6', 'P*8']);
    expect(isLegal(s, { from: DROP, to: 10, piece: JA, promote: false })).toBe(false);
  });

  it('자기 진영의 빈칸에는 놓을 수 있다', () => {
    const s = makeState({ board: 'r.b .k. .P. BK.', hand: ['RP', ''] });
    expect(keys(legalMoves(s).filter((m) => m.from === DROP && m.piece === JA))).toEqual([
      'P*11',
      'P*3',
      'P*5',
      'P*6',
      'P*8',
    ]);
  });

  it('같은 종류가 2개여도 칸마다 수는 하나다', () => {
    const s = makeState({ board: 'r.b .k. ... BKR', hand: ['PP', ''] });
    expect(keys(legalMoves(s).filter((m) => m.from === DROP))).toEqual(['P*3', 'P*5', 'P*6', 'P*7', 'P*8']);
  });

  it('투입은 손패를 하나 쓰고 승격하지 않는다', () => {
    const s = makeState({ board: 'r.b .k. ... BKR', hand: ['PP', ''] });
    const next = play(s, 'P*3');
    expect(next.board[3]).toBe(JA);
    expect(handCount(next, 1, JA)).toBe(1);
    expect(next.hash).toBe(computeHash(next));
  });

  it('손패에 없는 종류는 놓을 수 없다', () => {
    const s = makeState({ board: 'r.b .k. ... BKR', hand: ['PP', ''] });
    expect(isLegal(s, { from: DROP, to: 3, piece: SANG, promote: false })).toBe(false);
    expect(isLegal(s, { from: DROP, to: 3, piece: KING, promote: false })).toBe(false);
  });
});

describe('승격', () => {
  // 子 가 상대 진영(행 0)으로 들어가는 국면들. 적 王 은 멀리(8) 있다.
  it('子 가 이동으로 상대 진영에 들어가면 강제로 侯 가 된다', () => {
    const s = makeState({ board: '.rb P.. ..k BKR', hand: ['', 'P'] });
    const fromThree = legalMoves(s).filter((m) => m.from === 3);
    expect(fromThree.map(moveKey)).toEqual(['3-0+']); // 승격하지 않는 선택지는 없다
    const next = play(s, '3-0+');
    expect(next.board[0]).toBe(HU);
    expect(next.hash).toBe(computeHash(next));
  });

  it('잡으면서 들어가도 승격하고, 잡은 말은 손패로', () => {
    const s = makeState({ board: '.rb .P. ..k BKR', hand: ['', 'P'] });
    const next = play(s, '4-1+');
    expect(next.board[1]).toBe(HU);
    expect(handCount(next, 1, JANG)).toBe(1);
    expect(next.hash).toBe(computeHash(next));
  });

  it('적 子 는 행 3 에 들어가면 侯 가 된다', () => {
    const s = makeState({ board: 'rkb K.. ..p BR.', turn: 2, hand: ['P', ''] });
    expect(legalMoves(s).filter((m) => m.from === 8).map(moveKey)).toEqual(['8-11+']);
    expect(play(s, '8-11+').board[11]).toBe(-HU);
  });

  it('이미 侯 인 말은 상대 진영에 들어가도 승격 표시가 없다', () => {
    const s = makeState({ board: 'k.. .H. ... .K.', hand: ['RRBBP', ''] });
    const m = mv(s, '4-1');
    expect(m.promote).toBe(false);
    expect(play(s, '4-1').board[1]).toBe(HU);
  });

  it('투입한 子 는 다음 이동으로 들어갈 때 승격한다', () => {
    const s = makeState({ board: 'r.b .k. ... BKR', hand: ['PP', ''] });
    const next = play(s, 'P*3', '4-8', '3-0+');
    expect(next.board[0]).toBe(HU);
  });
});

describe('승패 판정', () => {
  it('王 이 상대 진영에 들어가 한 턴을 버티면 이긴다(try)', () => {
    const s = makeState({ board: '... .K. ..k ...', hand: ['RBP', 'RBP'] });
    const entered = play(s, '4-1');
    expect(entered.result).toBeNull(); // 들어간 순간은 아직 아니다
    const done = play(entered, 'R*6');
    expect(done.result).toEqual({ kind: 'win', winner: 1, reason: 'try' });
  });

  it('들어간 王 을 상대가 잡으면 잡은 쪽이 이긴다', () => {
    const s = makeState({ board: '..k .K. ... ...', hand: ['RBP', 'RBP'] });
    const done = play(s, '4-1', '2-1');
    expect(done.result).toEqual({ kind: 'win', winner: 2, reason: 'capture' });
  });

  it('양쪽 王 이 다 들어가면 먼저 들어가 버틴 쪽이 이긴다', () => {
    const s = makeState({ board: '... .K. .k. ...', hand: ['RBP', 'RBP'] });
    const done = play(s, '4-0', '7-10');
    expect(done.result).toEqual({ kind: 'win', winner: 1, reason: 'try' });
  });

  it('王 을 잡으며 들어가면 capture 다', () => {
    const s = makeState({ board: '.k. .K. ... ...', hand: ['RBP', 'RBP'] });
    expect(play(s, '4-1').result).toEqual({ kind: 'win', winner: 1, reason: 'capture' });
  });

  it('둘 수가 하나도 없으면 진다(blocked)', () => {
    // 녹 말 7개가 서로를 막고 있고 손패도 없다.
    const stuck = makeState({ board: 'RB. KRB PPk ...', turn: 1 });
    expect(legalMoves(stuck)).toEqual([]);
    expect(hasLegalMove(stuck)).toBe(false);
    // 적 王 이 8→10 으로 비켜서는 순간 녹이 막힌다.
    const done = play(makeState({ board: 'RB. KRB PPk ...', turn: 2 }), '8-10');
    expect(done.result).toEqual({ kind: 'win', winner: 2, reason: 'blocked' });
  });

  it('잡는 수만 남아도 blocked 가 아니다', () => {
    const after = play(makeState({ board: 'kR. B.. .P. .K.', hand: ['RBP', ''] }), '7-4');
    const ms = legalMoves(after);
    expect(ms).toHaveLength(3);
    expect(ms.every((m) => m.from !== DROP && after.board[m.to] !== 0)).toBe(true);
    expect(after.result).toBeNull();
  });

  // 아래 세 개는 판정 순서(서버 tj__advance 와 공유)를 고정하는 인위적 국면이다. 실전에서는 겹치지 않는다 —
  // 입성한 王 은 방금 떠난 칸으로 돌아가거나 그 칸에 들어온 말을 잡을 수 있어 막히지 않고,
  // try·blocked 국면은 처음 나온 순간 끝나 반복 횟수가 쌓이지 않는다. 반복은 이력을 주입해 만든다.
  it('try 와 blocked 가 겹치면 try 가 먼저다', () => {
    // 녹 王 은 이미 적 진영(0)에 있고, 적 王 이 相 을 잡은 뒤 녹은 둘 수가 없다.
    const s = makeState({ board: 'KRB RP. P.k ..B', turn: 2 });
    const done = play(s, '8-11');
    expect(done.result).toEqual({ kind: 'win', winner: 1, reason: 'try' });
    expect(hasLegalMove(stateFromSnapshot(toSnapshot(done)))).toBe(false);
  });

  it('try 와 반복이 겹치면 try 가 먼저다', () => {
    const s = makeState({ board: 'K.. .k. ... ...', turn: 2, hand: ['RBP', 'RBP'] });
    const m = mv(s, 'R*8');
    const after = applyMove(s, m);
    expect(after.result?.reason).toBe('try');
    const seeded = fromTransfer({ ...toTransfer(s), history: [after.key, after.key, s.key] });
    expect(applyMove(seeded, m).result).toEqual({ kind: 'win', winner: 1, reason: 'try' });
  });

  it('반복과 blocked 가 겹치면 반복이 먼저다', () => {
    const s = makeState({ board: 'RB. KRB PPk ...', turn: 2 });
    const m = mv(s, '8-10');
    const after = applyMove(s, m);
    expect(after.result?.reason).toBe('blocked');
    const seeded = fromTransfer({ ...toTransfer(s), history: [after.key, after.key, s.key] });
    expect(applyMove(seeded, m).result).toEqual({ kind: 'draw', reason: 'repetition' });
  });

  it('같은 국면이 3번 나오면 무승부 — 시작 국면도 1회로 센다', () => {
    const shuttle = ['10-6', '1-5', '6-10', '5-1'];
    const twice = play(createInitialState(), ...shuttle);
    expect(twice.result).toBeNull();
    expect(twice.reps.get(twice.key)).toBe(2);
    const thrice = play(twice, ...shuttle);
    expect(thrice.result).toEqual({ kind: 'draw', reason: 'repetition' });
    expect(thrice.ply).toBe(8);
  });

  it('손패가 다르면 같은 판이라도 다른 국면이다', () => {
    const a = makeState({ board: 'r.b .k. ... BKR', hand: ['PP', ''] });
    const b = makeState({ board: 'r.b .k. ... BKR', hand: ['P', 'P'] });
    expect(a.key).not.toBe(b.key);
    expect(a.hash).not.toBe(b.hash);
  });

  it('차례만 다른 두 국면은 key·hash 가 다르다', () => {
    const g = makeState({ board: 'rkb .p. .P. BKR', turn: 1 });
    const r = makeState({ board: 'rkb .p. .P. BKR', turn: 2 });
    expect(r.key).not.toBe(g.key);
    expect(r.hash).not.toBe(g.hash);
  });

  it('국면 키는 말 배치·손패 배분이 다르면 반드시 다르다(진법 자릿수 계약)', () => {
    // 자릿수 진법을 줄이면 충돌하는 쌍들 — 칸 값 11가지, 손패 개수 3가지.
    const a = makeState({ board: 'k.. .hH ... .K.', hand: ['RB', 'RB'] });
    const b = makeState({ board: 'k.. .ph ... .K.', hand: ['RB', 'RB'] });
    expect(a.key).not.toBe(b.key);
    const c = makeState({ board: 'kr. ... .B. RK.', hand: ['B', 'PP'] });
    const d = makeState({ board: 'kr. ... .B. RK.', hand: ['PP', 'B'] });
    expect(c.key).not.toBe(d.key);
  });

  it('zobrist: 말 하나(진영·종류·칸 120가지)의 해시 기여는 0 이 아니고 서로 다르다', () => {
    const blank = { board: new Int8Array(12), hand: new Int8Array(6), turn: 1 as const };
    const empty = computeHash(blank);
    const seen = new Set<number>();
    for (const side of [1, 2] as const) {
      for (const kind of KINDS) {
        for (let c = 0; c < 12; c++) {
          const board = new Int8Array(12);
          board[c] = side === 1 ? kind : -kind;
          const h = computeHash({ ...blank, board }) ^ empty;
          expect(h).not.toBe(0);
          seen.add(h);
        }
      }
    }
    expect(seen.size).toBe(120);
  });

  it('기권하면 상대가 이긴다', () => {
    const s = applyResign(createInitialState(), 1);
    expect(s.result).toEqual({ kind: 'win', winner: 2, reason: 'resign' });
    expect(s.phase).toBe('over');
  });

  it('이미 끝난 판에서 기권해도 결과는 그대로다', () => {
    const done = play(makeState({ board: '.k. .K. ... ...', hand: ['RBP', 'RBP'] }), '4-1');
    expect(applyResign(done, 1).result).toEqual({ kind: 'win', winner: 1, reason: 'capture' });
  });
});

describe('수 표현', () => {
  it('승격 플래그·종류까지 같아야 같은 수다', () => {
    const s = makeState({ board: '.rb P.. ..k BKR', hand: ['', 'P'] });
    expect(isLegal(s, { from: 3, to: 0, piece: JA, promote: true })).toBe(true);
    expect(isLegal(s, { from: 3, to: 0, piece: JA, promote: false })).toBe(false);
    expect(isLegal(s, { from: 3, to: 0, piece: JANG, promote: true })).toBe(false);
  });
});

describe('상태 관리', () => {
  it('applyMove 는 원본을 건드리지 않는다', () => {
    const s = createInitialState();
    const before = snapshotOf(s);
    applyMove(s, mv(s, '7-4'));
    expect(snapshotOf(s)).toEqual(before);
  });

  it('무작위 대국: 증분 해시 = 전체 재계산, 국면 키 = 전체 재계산', () => {
    const seen = playRandomGames(30, (s) => {
      expect(s.hash).toBe(computeHash(s));
      expect(s.key).toBe(computeKey(s));
    });
    // 잡기·투입·승격·侯 잡기가 모두 실제로 지나갔는지(커버리지 보증).
    expect(seen.capture).toBeGreaterThan(0);
    expect(seen.drop).toBeGreaterThan(0);
    expect(seen.promote).toBeGreaterThan(0);
    expect(seen.huCaptured).toBeGreaterThan(0);
  });

  it('undo 로 한 수씩 되돌리면 매 단계가 그때의 국면과 완전히 같다', () => {
    const rng = mulberry32(20261020);
    for (let game = 0; game < 20; game++) {
      const s = createInitialState();
      const trail: ReturnType<typeof snapshotOf>[] = [snapshotOf(s)];
      const undos: Undo[] = [];
      for (let i = 0; i < 200 && s.phase !== 'over'; i++) {
        const ms = legalMoves(s);
        undos.push(applyMoveInPlace(s, ms[Math.floor(rng() * ms.length)]));
        trail.push(snapshotOf(s));
      }
      while (undos.length) {
        undoMove(s, undos.pop()!);
        trail.pop();
        expect(snapshotOf(s)).toEqual(trail[trail.length - 1]);
      }
    }
  });

  it('스냅샷·전송형 왕복', () => {
    const s = play(createInitialState(), '7-4', '1-4', '10-6');
    const back = stateFromSnapshot(toSnapshot(s));
    expect(formatBoard(back)).toBe(formatBoard(s));
    expect(Array.from(back.hand)).toEqual(Array.from(s.hand));
    expect(back.key).toBe(s.key);
    expect(back.hash).toBe(s.hash);
    const t = fromTransfer(toTransfer(s));
    expect(snapshotOf(t)).toEqual(snapshotOf(s));
  });

  it('전송형 이력의 끝이 현재 국면이 아니면 현재 키를 붙여 보정한다', () => {
    const start = createInitialState();
    const s = play(start, '7-4');
    const t = fromTransfer({ ...toTransfer(s), history: [start.key] });
    expect(t.history).toEqual([start.key, s.key]);
    expect(t.reps.get(s.key)).toBe(1);
  });
});

/**
 * 무작위 합법 수로 여러 판을 두며 매 ply 마다 check 를 부른다. 지나간 수의 종류를 센다.
 * 완전 무작위면 王 잡기로 금방 끝나 판이 짧으므로, 판이 끝나는 수는 몇 번까지 다시 뽑아 대국을 길게 끈다.
 */
function playRandomGames(games: number, check: (s: GameState) => void) {
  const rng = mulberry32(12);
  const seen = { capture: 0, drop: 0, promote: 0, huCaptured: 0 };
  for (let g = 0; g < games; g++) {
    const s = createInitialState();
    for (let i = 0; i < 300 && s.phase !== 'over'; i++) {
      const ms = legalMoves(s);
      let m = ms[Math.floor(rng() * ms.length)];
      for (let retry = 0; retry < 4 && applyMove(s, m).result; retry++) {
        m = ms[Math.floor(rng() * ms.length)];
      }
      if (m.from === DROP) seen.drop += 1;
      else if (s.board[m.to] !== 0) {
        seen.capture += 1;
        if (kindOf(s.board[m.to]) === HU) seen.huCaptured += 1;
      }
      if (m.promote) seen.promote += 1;
      applyMoveInPlace(s, m);
      check(s);
    }
  }
  return seen;
}

function snapshotOf(s: GameState) {
  return {
    board: Array.from(s.board),
    hand: Array.from(s.hand),
    turn: s.turn,
    phase: s.phase,
    result: s.result,
    hash: s.hash,
    key: s.key,
    history: [...s.history],
    reps: [...s.reps.entries()].sort((a, b) => a[0] - b[0]),
    ply: s.ply,
  };
}
