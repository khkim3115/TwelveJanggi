// 좌석·힌트·되돌리기·클릭 흐름의 계약. 설정(seatPref)과 이번 판의 좌석(humanSeat)은 따로 논다 —
// 둘을 섞으면 (a) 'random' 이 조용히 녹이 되고 (b) 판 도중 진영이 바뀌어 보드가 잠긴다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JA, KING } from '../core/board';
import { DROP, type Move } from '../core/gameState';

// 워커는 이 테스트의 관심사가 아니다 — AI 가 두지 않아도 좌석 계약은 성립해야 한다.
vi.mock('../engine/aiClient', () => ({
  cancelPendingAi: vi.fn(),
  requestAiMove: vi.fn(async () => ({ move: null })),
  requestHint: vi.fn(async () => ({ move: null })),
}));

const { canUndo, useGameStore } = await import('./gameStore');
const { requestAiMove, requestHint } = await import('../engine/aiClient');

const store = () => useGameStore.getState();
const mv = (from: number, to: number, piece: Move['piece'], promote = false): Move => ({ from, to, piece, promote });

/** 사람이 from → to 로 둔다(말 고르기 → 갈 칸 찍기 2클릭). */
function play(from: number, to: number) {
  store().clickCell(from);
  store().clickCell(to);
}

/** runAi 는 최소 생각 시간만큼 끌기 때문에, thinking 이 내려앉을 때까지 기다린다. */
async function settle() {
  for (let i = 0; i < 100 && store().thinking; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 힌트 응답의 then 이 돌 때까지 기다린다. */
async function flushHint() {
  for (let i = 0; i < 50 && store().hintLoading; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 원할 때 응답시킬 수 있는 힌트 요청 하나를 걸어 둔다. */
function deferHint(): (move: Move | null) => void {
  let resolve!: (r: { move: Move | null }) => void;
  vi.mocked(requestHint).mockImplementationOnce(
    () => new Promise((r) => { resolve = r; }),
  );
  return (move) => resolve({ move });
}

describe('newGame 이 좌석을 확정한다', () => {
  beforeEach(() => store().newGame({ seatPref: '1' }));

  it('녹을 고르면 내가 선공이다', () => {
    store().newGame({ seatPref: '1' });
    expect(store().humanSeat).toBe(1);
    expect(store().state.turn).toBe(1);
  });

  it('적을 고르면 좌석이 2다 — 첫 차례는 녹(AI)에게 있다', () => {
    store().newGame({ seatPref: '2' });
    expect(store().humanSeat).toBe(2);
    expect(store().state.turn).toBe(1);
  });

  it('랜덤이어도 humanSeat 에는 언제나 좌석(1|2)만 들어간다', () => {
    for (let i = 0; i < 50; i++) {
      store().newGame({ seatPref: 'random' });
      expect([1, 2]).toContain(store().humanSeat);
      expect(store().seatPref).toBe('random');
    }
  });

  it('랜덤은 판마다 다시 뽑는다', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      store().newGame({ seatPref: 'random' });
      seen.add(store().humanSeat);
    }
    expect(seen).toEqual(new Set([1, 2]));
  });

  it('인자를 주지 않으면 저장된 선택을 쓴다', () => {
    store().setSeatPref('2');
    store().newGame();
    expect(store().humanSeat).toBe(2);
    store().setSeatPref('1');
  });
});

describe('클릭 흐름', () => {
  beforeEach(() => store().newGame({ seatPref: '1' }));

  it('말을 고르고 갈 칸을 누르면 한 수가 되고 선택이 풀린다', async () => {
    store().clickCell(7);
    expect(store().selection).toEqual({ kind: 'cell', cell: 7 });
    store().clickCell(4);
    expect(store().state.ply).toBe(1);
    expect(store().state.board[4]).toBe(JA); // 녹 子 가 적 子 를 잡았다
    expect(store().selection).toBeNull();
    expect(store().lastMove).toEqual(mv(7, 4, JA));
    await settle();
  });

  it('AI 가 생각하는 동안에는 클릭을 무시한다', async () => {
    play(7, 4);
    expect(store().thinking).toBe(true);
    store().clickCell(10);
    expect(store().selection).toBeNull();
    await settle();
  });

  it('손패를 고르고 빈칸을 누르면 놓인다', async () => {
    play(7, 4); // 子 를 잡아 손패에 子 1개
    await settle(); // 모의 AI 는 수를 내지 않으므로 스토어가 첫 합법 수(將 a4→a3)로 대신 둔다
    expect(store().state.turn).toBe(1);
    store().clickHand(JA);
    expect(store().selection).toEqual({ kind: 'hand', piece: JA });
    store().clickCell(6);
    expect(store().lastMove).toEqual(mv(DROP, 6, JA));
    expect(store().state.board[6]).toBe(JA);
    await settle();
  });
});

describe('AI 차례가 멈추지 않는다', () => {
  it('엔진이 수를 내지 못해도 첫 합법 수로 대신 둔다', async () => {
    store().newGame({ seatPref: '1' });
    play(7, 4);
    await settle();
    expect(store().state.ply).toBe(2);
    expect(store().state.turn).toBe(1);
    expect(store().thinking).toBe(false);
  });

  it('힌트를 기다리는 중에 두면 힌트 요청을 취소해 AI 가 줄을 서지 않는다', async () => {
    const { cancelPendingAi } = await import('../engine/aiClient');
    store().newGame({ seatPref: '1' });
    deferHint();
    store().askHint();
    const before = vi.mocked(cancelPendingAi).mock.calls.length;
    play(7, 4);
    expect(vi.mocked(cancelPendingAi).mock.calls.length).toBe(before + 1);
    await settle();
  });
});

describe('난이도는 다음 판부터', () => {
  it('판 도중 난이도를 바꿔도 이번 판의 AI 는 처음 난이도로 둔다', async () => {
    store().setDifficulty('hard');
    store().newGame({ seatPref: '1' });
    store().setDifficulty('easy');
    expect(store().gameDifficulty).toBe('hard');
    vi.mocked(requestAiMove).mockClear();
    play(7, 4);
    await settle();
    expect(vi.mocked(requestAiMove).mock.calls[0][1]).toBe('hard');

    store().newGame();
    expect(store().gameDifficulty).toBe('easy');
    await settle();
    store().setDifficulty('normal');
  });
});

describe('setSeatPref 는 진행 중인 판을 건드리지 않는다', () => {
  it('판 도중 진영을 바꿔도 이번 판의 좌석은 그대로다', async () => {
    store().newGame({ seatPref: '1' });
    play(7, 4);
    const before = store().humanSeat;
    const turn = store().state.turn;

    store().setSeatPref('2');

    expect(store().seatPref).toBe('2');
    expect(store().humanSeat).toBe(before);
    expect(store().state.turn).toBe(turn);
    await settle();
    store().setSeatPref('1');
  });

  it('바꾼 선택은 다음 판부터 적용된다', () => {
    store().newGame({ seatPref: '1' });
    store().setSeatPref('2');
    expect(store().humanSeat).toBe(1);

    store().newGame();
    expect(store().humanSeat).toBe(2);
    store().setSeatPref('1');
  });

  it('랜덤으로 바꿔도 진행 중인 판의 좌석은 좌석으로 남는다', () => {
    store().newGame({ seatPref: '2' });
    store().setSeatPref('random');
    expect(store().humanSeat).toBe(2);
    expect(store().seatPref).toBe('random');
    store().setSeatPref('1');
  });
});

describe('힌트는 계산을 시킨 그 국면에만 붙는다', () => {
  // generation 은 착수로 오르지 않는다. 그래서 "💡 를 누르고 응답 전에 두면"
  // 지나간 국면 기준의 힌트가 새 보드 위에 그려지고 AI 응수를 넘어 다음 차례까지 남을 수 있다.
  it('국면이 그대로면 힌트가 들어온다', async () => {
    store().newGame({ seatPref: '1' });
    const answer = deferHint();
    store().askHint();
    expect(store().hintLoading).toBe(true);

    answer(mv(7, 4, JA));
    await flushHint();

    expect(store().hint).toEqual(mv(7, 4, JA));
    expect(store().hintLoading).toBe(false);
    expect(store().hintUsedThisGame).toBe(true);
  });

  it('기다리는 동안 착수했으면 뒤늦게 온 힌트를 버린다', async () => {
    store().newGame({ seatPref: '1' });
    const answer = deferHint();
    store().askHint();

    play(7, 4); // 힌트가 오기 전에 두어 버린다
    answer(mv(10, 6, KING)); // 지나간 국면 기준의 수가 뒤늦게 도착

    await settle();
    await flushHint();

    expect(store().hint).toBeNull();
    expect(store().hintLoading).toBe(false);
  });

  it('새 게임이 끼어들었으면 힌트가 새 판으로 새지 않는다', async () => {
    store().newGame({ seatPref: '1' });
    const answer = deferHint();
    store().askHint();

    store().newGame({ seatPref: '1' });
    answer(mv(7, 4, JA));

    await flushHint();

    expect(store().hint).toBeNull();
    expect(store().hintLoading).toBe(false);
    expect(store().hintUsedThisGame).toBe(false);
  });

  it('기권하면 기다리던 힌트 로딩이 풀린다', () => {
    store().newGame({ seatPref: '1' });
    deferHint();
    store().askHint();
    expect(store().hintLoading).toBe(true);
    store().resign();
    expect(store().hintLoading).toBe(false);
    expect(store().state.result).toEqual({ kind: 'win', winner: 2, reason: 'resign' });
  });

  it('AI 가 두고 나면 힌트가 화면에 남지 않는다', async () => {
    store().newGame({ seatPref: '1' });
    vi.mocked(requestHint).mockImplementationOnce(async () => ({ move: mv(7, 4, JA) }));
    store().askHint();
    await flushHint();
    expect(store().hint).not.toBeNull();

    // AI 가 실제로 한 수 두는 경로를 태운다 — 녹 子 가 잡은 자리를 적 王 이 되잡는다.
    vi.mocked(requestAiMove).mockImplementationOnce(async () => ({ move: mv(1, 4, KING) }));
    play(7, 4);
    await settle();

    expect(store().state.board[4]).toBe(-KING);
    expect(store().hint).toBeNull();
  });
});

describe('되돌리기는 좌석을 따른다', () => {
  it('한 수도 두지 않았으면 되돌릴 수 없다', () => {
    store().newGame({ seatPref: '1' });
    expect(canUndo(store())).toBe(false);
  });

  it('AI 가 생각하는 동안에는 되돌릴 수 없다', async () => {
    store().newGame({ seatPref: '1' });
    play(7, 4);
    expect(store().thinking).toBe(true);
    expect(canUndo(store())).toBe(false);
    await settle();
  });

  it('내가 둔 뒤에는 그 수 직전으로 돌아간다(AI 수까지 함께)', async () => {
    store().newGame({ seatPref: '1' });
    vi.mocked(requestAiMove).mockImplementationOnce(async () => ({ move: mv(1, 4, KING) }));
    play(7, 4);
    await settle();
    expect(store().state.ply).toBe(2);
    expect(canUndo(store())).toBe(true);

    store().undo();
    expect(store().state.ply).toBe(0);
    expect(store().state.turn).toBe(1);
    expect(canUndo(store())).toBe(false);
  });

  it('기권한 뒤 되돌리면 기권한 그 국면(내 차례)으로 돌아간다', async () => {
    store().newGame({ seatPref: '1' });
    play(7, 4);
    await settle();
    expect(store().state.ply).toBe(2);
    store().resign();
    expect(store().state.phase).toBe('over');
    expect(canUndo(store())).toBe(true);
    store().undo();
    expect(store().state.ply).toBe(2);
    expect(store().state.result).toBeNull();
  });

  it('적일 때 AI 만 둔 국면은 되돌릴 자리가 아니다 — 기록이 있어도 되돌릴 수 없다', async () => {
    store().newGame({ seatPref: '2' });
    await settle(); // AI(녹)가 첫 수를 두었다 — 기록에는 AI 차례였던 시작 국면 하나뿐
    const past = store().past;

    expect(past.length).toBe(1);
    expect(past[0].turn).toBe(1);
    expect(store().state.turn).toBe(2);
    expect(canUndo(store())).toBe(false);

    store().undo();
    expect(store().past).toBe(past); // 기록이 날아가지 않는다
  });
});
