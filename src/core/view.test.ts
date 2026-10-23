// 클릭 해석·하이라이트·화면 방향·선후공 선택의 계약. 솔로와 멀티 화면이 같은 함수를 쓰므로 여기서 한 번만 지킨다.
import { describe, expect, it } from 'vitest';
import { CELL_COUNT, COL_OF, JA, KINDS, KIND_DIRS, ROWS, ROW_OF, SANG, STEPS } from './board';
import { DROP, applyMove, createInitialState, legalMoves, moveKey, type GameState, type Move } from './gameState';
import { makeState } from './testkit';
import {
  SEAT_PREFS,
  SEAT_PREF_LABEL,
  SIDE_LABEL,
  boardView,
  cellLabel,
  displayToIndex,
  entryCell,
  handTileLabel,
  indexToDisplay,
  isUpsideDown,
  moveLabel,
  nextFocusCell,
  phaseLabel,
  resolveClick,
  resolveSeat,
  toSeatPref,
  tryPendingSide,
  turnHint,
  type SeatPref,
} from './view';

const cell = (c: number) => ({ kind: 'cell' as const, cell: c });
const handP = { kind: 'hand' as const, piece: JA as 4 };
const find = (s: GameState, key: string): Move => legalMoves(s).find((m) => moveKey(m) === key)!;
/** 녹 王 이 적 진영(b4)에 막 들어가 한 턴을 버티는 중인 국면. */
const entered = applyMove(
  makeState({ board: '... .K. ..k ...', hand: ['RBP', 'RBP'] }),
  { from: 4, to: 1, piece: 1, promote: false },
);

describe('resolveClick — 판 위 이동', () => {
  it('내 말을 고르고 갈 칸을 누르면 그 합법 수가 나온다', () => {
    const s = createInitialState();
    expect(resolveClick(s, 1, null, cell(7))).toEqual({ kind: 'select', selection: cell(7) });
    expect(resolveClick(s, 1, cell(7), cell(4))).toEqual({ kind: 'move', move: find(s, '7-4') });
  });

  it('고른 말을 다시 누르면 선택이 풀리고, 다른 내 말을 누르면 그 말로 바뀐다', () => {
    const s = createInitialState();
    expect(resolveClick(s, 1, cell(7), cell(7))).toEqual({ kind: 'select', selection: null });
    expect(resolveClick(s, 1, cell(7), cell(10))).toEqual({ kind: 'select', selection: cell(10) });
  });

  it('움직일 수 없는 내 말·빈칸·갈 수 없는 칸은 아무 일도 없다', () => {
    const s = createInitialState();
    expect(resolveClick(s, 1, null, cell(9))).toBeNull(); // 相 은 막혀 있다
    expect(resolveClick(s, 1, null, cell(5))).toBeNull();
    expect(resolveClick(s, 1, cell(7), cell(3))).toBeNull();
  });

  it('내 차례가 아니거나 끝난 판이면 무시한다', () => {
    const s = createInitialState();
    expect(resolveClick(s, 2, null, cell(4))).toBeNull();
    const over = { ...s, phase: 'over' as const };
    expect(resolveClick(over, 1, null, cell(7))).toBeNull();
  });

  it('승격 칸으로 가는 수는 승격 플래그가 켜진 채로 나온다', () => {
    const s = makeState({ board: '.rb P.. ..k BKR', hand: ['', 'P'] });
    const r = resolveClick(s, 1, cell(3), cell(0));
    expect(r?.kind === 'move' && r.move.promote).toBe(true);
  });
});

describe('resolveClick — 손패 투입', () => {
  const s = makeState({ board: 'r.b .k. .P. BKR', hand: ['P', ''] });

  it('손패를 고르고 빈칸을 누르면 투입', () => {
    expect(resolveClick(s, 1, null, handP)).toEqual({ kind: 'select', selection: handP });
    expect(resolveClick(s, 1, handP, cell(3))).toEqual({
      kind: 'move',
      move: { from: DROP, to: 3, piece: JA, promote: false },
    });
  });

  it('상대 진영 행의 빈칸에는 놓을 수 없다', () => {
    expect(resolveClick(s, 1, handP, cell(1))).toBeNull();
  });

  it('없는 손패는 고를 수 없고, 같은 손패를 다시 누르면 선택이 풀린다', () => {
    expect(resolveClick(s, 1, null, { kind: 'hand', piece: 2 })).toBeNull();
    expect(resolveClick(s, 1, handP, handP)).toEqual({ kind: 'select', selection: null });
  });

  it('손패를 고른 채 내 말을 누르면 그 말로 선택이 바뀐다', () => {
    expect(resolveClick(s, 1, handP, cell(7))).toEqual({ kind: 'select', selection: cell(7) });
  });
});

describe('boardView', () => {
  it('고른 말의 목적지·잡기 칸을 표시한다', () => {
    const v = boardView(createInitialState(), 1, cell(7));
    expect([...v.movable].sort((a, b) => a - b)).toEqual([7, 10, 11]);
    expect([...v.targets]).toEqual([4]);
    expect([...v.captures]).toEqual([4]);
    expect(v.droppable.size).toBe(0);
  });

  it('손패를 고르면 투입 가능한 칸이 목적지다', () => {
    const s = makeState({ board: 'r.b .k. .P. BKR', hand: ['P', ''] });
    const v = boardView(s, 1, handP);
    expect([...v.droppable]).toEqual([JA]);
    expect([...v.targets].sort((a, b) => a - b)).toEqual([3, 5, 6, 8]);
    expect(v.captures.size).toBe(0);
  });

  it('승격 칸을 따로 표시한다', () => {
    const s = makeState({ board: '.rb P.. ..k BKR', hand: ['', 'P'] });
    expect([...boardView(s, 1, cell(3)).promotions]).toEqual([0]);
  });

  it('내 차례가 아니면 하이라이트가 없다', () => {
    const v = boardView(createInitialState(), 2, cell(7));
    expect(v.movable.size + v.targets.size + v.droppable.size).toBe(0);
  });
});

describe('王 입성 표시', () => {
  it('들어간 쪽이 입성 대기로 표시된다', () => {
    expect(tryPendingSide(entered)).toBe(1);
    expect(boardView(entered, 2, null).tryPending).toBe(1);
    expect(phaseLabel(entered)).toBe('王 입성');
    expect(tryPendingSide(createInitialState())).toBeNull();
  });

  it('막아야 하는 쪽과 들어간 쪽에게 다른 문구를 보여 준다', () => {
    expect(turnHint(entered, 2)).toContain('잡지 못하면 집니다');
    expect(turnHint(entered, 1)).toContain('승리');
  });

  it('끝난 판에는 입성 대기가 없다(王 을 잡으며 들어간 경우 포함)', () => {
    const done = applyMove(
      makeState({ board: '.k. .K. ... ...', hand: ['RBP', 'RBP'] }),
      { from: 4, to: 1, piece: 1, promote: false },
    );
    expect(done.result?.reason).toBe('capture');
    expect(tryPendingSide(done)).toBeNull();
    expect(boardView(done, 2, null).tryPending).toBeNull();
  });
});

describe('차례 문구', () => {
  it('차례인 쪽에게 손패가 있을 때만 손패를 언급한다', () => {
    expect(turnHint(makeState({ board: 'r.b .k. .P. BKR', hand: ['P', ''] }), 1)).toContain('손패');
    expect(turnHint(makeState({ board: 'r.b .k. .P. BKR', turn: 2, hand: ['P', ''] }), 2)).not.toContain('손패');
  });
});

describe('화면 방향', () => {
  it('녹으로 보면 그대로, 적으로 보면 180° 돌아간다', () => {
    for (let i = 0; i < CELL_COUNT; i++) {
      expect(indexToDisplay(i, 1)).toBe(i);
      expect(displayToIndex(indexToDisplay(i, 2), 2)).toBe(i);
    }
  });

  it('보는 사람의 자기 진영이 항상 화면 아래 줄이다', () => {
    const bottomRow = (viewer: 1 | 2) =>
      [9, 10, 11].map((d) => ROW_OF[displayToIndex(d, viewer)]);
    expect(bottomRow(1)).toEqual([ROWS - 1, ROWS - 1, ROWS - 1]); // 녹 진영 = 행 3
    expect(bottomRow(2)).toEqual([0, 0, 0]); // 적 진영 = 행 0
  });

  it('방향 눈금(KIND_DIRS)은 보는 사람과 다른 진영의 말만 뒤집으면 화면 위 실제 이동과 맞는다', () => {
    const rc = (d: number) => [ROW_OF[d], COL_OF[d]] as const;
    for (const viewer of [1, 2] as const) {
      for (const side of [1, 2] as const) {
        const flip = isUpsideDown(side, viewer) ? -1 : 1;
        for (const kind of KINDS) {
          const marks = KIND_DIRS[kind].map(([dr, dc]) => `${dr * flip},${dc * flip}`);
          for (let from = 0; from < CELL_COUNT; from++) {
            const [fr, fc] = rc(indexToDisplay(from, viewer));
            for (const to of STEPS[side][kind][from]) {
              const [tr, tc] = rc(indexToDisplay(to, viewer));
              expect(marks).toContain(`${tr - fr},${tc - fc}`);
            }
          }
        }
      }
    }
  });
});

describe('판 키보드 이동', () => {
  it('녹으로 보면 방향키가 한 칸씩, 판 밖으로는 나가지 않는다', () => {
    expect(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map((k) => nextFocusCell(4, 1, k))).toEqual([1, 7, 3, 5]);
    expect([
      nextFocusCell(0, 1, 'ArrowUp'),
      nextFocusCell(0, 1, 'ArrowLeft'),
      nextFocusCell(11, 1, 'ArrowDown'),
      nextFocusCell(11, 1, 'ArrowRight'),
    ]).toEqual([0, 0, 11, 11]);
    expect(nextFocusCell(3, 1, 'ArrowLeft')).toBe(3); // 윗줄 끝으로 감기지 않는다
  });

  it('적으로 보면 방향키는 화면 방향이다', () => {
    // 적 화면에서 b3(4)는 아래에서 둘째 줄 가운데 — 화면 위는 b2(7), 아래는 b4(1), 왼쪽은 c3(5), 오른쪽은 a3(3)
    expect(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map((k) => nextFocusCell(4, 2, k))).toEqual([7, 1, 5, 3]);
    expect(nextFocusCell(11, 2, 'ArrowUp')).toBe(11); // c1 은 적 화면의 왼쪽 위
  });

  it('Home·End 는 그 줄 끝, Ctrl 과 함께면 판 끝', () => {
    expect([
      nextFocusCell(4, 1, 'Home'),
      nextFocusCell(4, 1, 'End'),
      nextFocusCell(4, 1, 'Home', true),
      nextFocusCell(4, 1, 'End', true),
    ]).toEqual([3, 5, 0, 11]);
    expect([nextFocusCell(4, 2, 'Home', true), nextFocusCell(4, 2, 'End', true)]).toEqual([11, 0]);
  });

  it('다루지 않는 키는 null', () => {
    expect(['Enter', ' ', 'Tab', 'a'].map((k) => nextFocusCell(4, 1, k))).toEqual([null, null, null, null]);
  });

  it('처음 들어오면 고른 칸, 없으면 내 王, 王 이 없으면 화면 아래 가운데', () => {
    const s = createInitialState();
    expect([entryCell(s, 1, null), entryCell(s, 2, null)]).toEqual([10, 1]);
    expect(entryCell(s, 1, cell(7))).toBe(7);
    expect(entryCell(s, 1, handP)).toBe(10);
    // 녹 王 이 잡혀 끝난 판 — 남은 적 王(7)이 아니라 녹 화면 아래 가운데(10)
    const done = applyMove(makeState({ board: '... .k. .K. ...', turn: 2, hand: ['RBP', 'RBP'] }), {
      from: 4,
      to: 7,
      piece: 1,
      promote: false,
    });
    expect(entryCell(done, 1, null)).toBe(10);
  });
});

describe('낭독 문구', () => {
  const none = { selected: false, hint: null };

  it('칸 이름과 말, 빈칸', () => {
    const s = createInitialState();
    const v = boardView(s, 1, null);
    expect([cellLabel(s, 10, v, none), cellLabel(s, 1, v, none), cellLabel(s, 5, v, none)]).toEqual([
      'b1 녹 왕',
      'b4 적 왕',
      'c3 빈칸',
    ]);
  });

  it('선택·잡기·둘 수 있음·승격·입성', () => {
    const s = createInitialState();
    const v = boardView(s, 1, cell(7));
    expect(cellLabel(s, 7, v, { selected: true, hint: null })).toBe('b2 녹 자 — 선택됨');
    expect(cellLabel(s, 4, v, none)).toBe('b3 적 자 — 잡을 수 있음');
    const d = makeState({ board: 'r.b .k. .P. BKR', hand: ['P', ''] });
    expect(cellLabel(d, 3, boardView(d, 1, handP), none)).toBe('a3 빈칸 — 여기로 둘 수 있음');
    const p = makeState({ board: '.rb P.. ..k BKR', hand: ['', 'P'] });
    expect(cellLabel(p, 0, boardView(p, 1, cell(3)), none)).toBe('a4 빈칸 — 여기로 둘 수 있음 — 侯 승격');
    expect(cellLabel(entered, 1, boardView(entered, 2, null), none)).toBe('b4 녹 왕 — 입성 중');
  });

  it('추천 수 — 이동은 출발·도착, 투입은 놓을 칸에 손패 이름', () => {
    const s = createInitialState();
    const v = boardView(s, 1, null);
    const hint: Move = { from: 7, to: 4, piece: JA, promote: false };
    expect([cellLabel(s, 7, v, { selected: false, hint }), cellLabel(s, 4, v, { selected: false, hint })]).toEqual([
      'b2 녹 자 — 추천 수 출발',
      'b3 적 자 — 추천 수 도착',
    ]);
    const d = makeState({ board: 'r.b .k. .P. BKR', hand: ['P', ''] });
    const drop: Move = { from: DROP, to: 5, piece: JA, promote: false };
    expect(cellLabel(d, 5, boardView(d, 1, null), { selected: false, hint: drop })).toBe('c3 빈칸 — 추천 수: 손패 자 놓기');
  });

  it('손패 타일', () => {
    expect(handTileLabel('내 손패', JA, 1)).toBe('내 손패 자');
    expect(handTileLabel('내 손패', JA, 2, { can: true })).toBe('내 손패 자 2개 — 눌러서 놓을 칸 고르기');
    expect(handTileLabel('내 손패', JA, 2, { can: true, hinted: true })).toBe(
      '내 손패 자 2개 — 추천 수 — 눌러서 놓을 칸 고르기',
    );
    expect(handTileLabel('AI (보통) 손패', SANG, 1)).toBe('AI (보통) 손패 상');
  });
});

describe('수 표기', () => {
  it('이동·잡기·승격·투입', () => {
    const s = createInitialState();
    expect(moveLabel(find(s, '10-6'))).toBe('王 b1→a2');
    expect(moveLabel(find(s, '7-4'), s.board)).toBe('子 b2×b3');
    expect(moveLabel({ from: 3, to: 0, piece: JA, promote: true })).toBe('子 a3→a4 侯 승격');
    expect(moveLabel({ from: DROP, to: 6, piece: 2, promote: false })).toBe('將 a2에 놓기');
  });
});

describe('선후공 선택', () => {
  it('저장값 1·2·random 을 받아들이고 모르는 값은 녹으로 떨어진다', () => {
    expect(toSeatPref('1')).toBe('1');
    expect(toSeatPref('2')).toBe('2');
    expect(toSeatPref('random')).toBe('random');
    for (const v of [null, undefined, '', '3', 'red']) expect(toSeatPref(v)).toBe('1');
    for (const p of SEAT_PREFS) expect(toSeatPref(p)).toBe(p);
  });

  it('고정 선택은 난수와 무관하고, 랜덤은 0.5 를 경계로 반씩 가른다', () => {
    for (const rand of [0, 0.25, 0.5, 0.999]) {
      expect(resolveSeat('1', rand)).toBe(1);
      expect(resolveSeat('2', rand)).toBe(2);
    }
    expect(resolveSeat('random', 0.49)).toBe(1);
    expect(resolveSeat('random', 0.5)).toBe(2);
  });

  it('어떤 선택이든 결과는 좌석(1|2) 이다 — random 이 새어나오지 않는다', () => {
    for (const p of SEAT_PREFS) for (const rand of [0, 0.5, 0.999]) expect([1, 2]).toContain(resolveSeat(p, rand));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(resolveSeat('random'));
    expect(seen).toEqual(new Set([1, 2]));
  });

  it('고정 선택의 라벨은 그 좌석의 진영 이름과 같다', () => {
    expect(SEAT_PREF_LABEL['1' as SeatPref]).toBe(SIDE_LABEL[1]);
    expect(SEAT_PREF_LABEL['2' as SeatPref]).toBe(SIDE_LABEL[2]);
  });
});
