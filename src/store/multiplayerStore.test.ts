// 온라인 대전 스토어의 계약 — 서버 스냅샷 해석, 늦게 온 스냅샷 거르기, 다른 방 DELETE 무시, 클릭 → tj_play 인자.
// Supabase 는 가짜로 바꿔 끼우고 Realtime 이벤트를 직접 흘려 넣는다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_BOARD, JA, JANG, KING } from '../core/board';
import { DROP } from '../core/gameState';

type Handler = (payload: unknown) => void;

const h = vi.hoisted(() => {
  const fake = {
    rooms: new Map<string, unknown>(),
    players: [] as { room_id: string }[],
    handlers: [] as { type: string; filter: { event?: string; table?: string; filter?: string }; cb: Handler }[],
    subscribeCb: null as null | ((status: string) => void),
    channelNames: [] as string[],
    sent: [] as unknown[],
    removed: 0,
    rpcResult: { data: null as unknown, error: null as null | { message: string } },
    /** tj_rooms 를 읽은 횟수(재조회·폴링 확인용). */
    roomReads: 0,
    /** 설정하면 좌석 읽기 응답이 이 약속이 풀릴 때까지 늦게 온다(읽는 시점의 목록은 그대로). */
    playersGate: null as Promise<void> | null,
    /** 설정하면 익명 세션 준비가 이 약속이 풀릴 때까지 걸린다(첫 사용의 느린 구간). */
    sessionGate: null as Promise<void> | null,
    /** 서버 tj_chat 행(읽을 때 room_id 로 거르고 최근 것부터 limit 개). */
    chat: [] as { id: number; room_id: string; [k: string]: unknown }[],
    /** 설정하면 채팅 읽기 응답이 이 약속이 풀릴 때까지 늦게 온다(읽는 시점의 행은 그대로). */
    chatGate: null as Promise<void> | null,
  };
  const rpc = vi.fn(async (_fn: string, _args?: Record<string, unknown>) => fake.rpcResult);
  const supabase = {
    rpc,
    from(table: string) {
      let eqVal = '';
      const players = async () => {
        const snapshot = fake.players.filter((p) => p.room_id === eqVal);
        if (fake.playersGate) await fake.playersGate;
        return { data: snapshot, error: null };
      };
      const q = {
        select: () => q,
        eq: (_col: string, val: string) => {
          eqVal = val;
          return q;
        },
        // tj_chat 은 .order(...).limit(n) 으로 이어지고, 좌석은 .order('seat') 에서 끝난다.
        order: (..._args: unknown[]) => (table === 'tj_chat' ? q : players()),
        limit: async (n: number) => {
          const snapshot = fake.chat.filter((m) => m.room_id === eqVal).sort((a, b) => b.id - a.id).slice(0, n);
          if (fake.chatGate) await fake.chatGate;
          return { data: snapshot, error: null };
        },
        maybeSingle: async () => {
          if (table === 'tj_rooms') fake.roomReads++;
          return { data: fake.rooms.get(eqVal) ?? null, error: null };
        },
      };
      return q;
    },
    channel: (name: string) => {
      fake.channelNames.push(name);
      const ch = {
        on: (type: string, filter: { event?: string; table?: string }, cb: Handler) => {
          fake.handlers.push({ type, filter, cb });
          return ch;
        },
        subscribe: (cb: (status: string) => void) => {
          fake.subscribeCb = cb;
          return ch;
        },
        send: async (msg: unknown) => {
          fake.sent.push(msg);
          return 'ok';
        },
      };
      return ch;
    },
    // realtime-js 처럼 지우는 즉시 구독 콜백을 CLOSED 로 부른다.
    removeChannel: async () => {
      fake.removed++;
      fake.subscribeCb?.('CLOSED');
      return 'ok';
    },
  };
  return { fake, supabase, rpc };
});

vi.mock('../lib/supabase', () => ({
  supabase: h.supabase,
  ensureAnonSession: async () => {
    if (h.fake.sessionGate) await h.fake.sessionGate;
    return 'me';
  },
  isSupabaseConfigured: true,
}));

// node 에는 localStorage 가 없다 — 방 코드 저장을 확인하려고 메모리 저장소를 끼운다.
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
});

const {
  boardBeforeLastMove,
  humanError,
  isNewerRoom,
  mapRoom,
  mpGameState,
  rememberedCode,
  serverNow,
  sideOfSeat,
  useMultiplayerStore,
} = await import('./multiplayerStore');
type RoomRow = import('./multiplayerStore').RoomRow;

const store = () => useMultiplayerStore.getState();

const row = (over: Partial<RoomRow> = {}): RoomRow => ({
  id: 'r1',
  code: 'ABCDEF',
  status: 'playing',
  host_id: 'me',
  green_seat: 0,
  turn: 1,
  board: [...INITIAL_BOARD],
  hand: [0, 0, 0, 0, 0, 0],
  move_count: 0,
  last_move: null,
  winner_seat: null,
  win_reason: null,
  is_draw: false,
  draw_reason: null,
  turn_started_at: '2026-10-21T00:00:00Z',
  version: 1,
  ...over,
});

const PLAYERS = [
  { id: 'p0', room_id: 'r1', user_id: 'me', seat: 0, display_name: '나', is_host: true, connected: true },
  { id: 'p1', room_id: 'r1', user_id: 'you', seat: 1, display_name: '너', is_host: false, connected: true },
];

function emit(table: 'tj_rooms' | 'tj_room_players' | 'tj_chat', payload: unknown) {
  const handler = h.fake.handlers.find((x) => x.type === 'postgres_changes' && x.filter.table === table);
  if (!handler) throw new Error('구독 없음: ' + table);
  handler.cb(payload);
}

/** 서버 tj_chat 행 — 기본은 상대가 r1 에 보낸 것. */
const chatRow = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  room_id: 'r1',
  user_id: 'you',
  display_name: '너',
  body: `m${id}`,
  created_at: '2026-10-22T05:00:00+00:00',
  ...over,
});
const unread = () => store().chatCount - store().chatSeen;

const rpcCalls = (fn: string) => h.rpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1]);

/** 방에 들어간 상태로 만든다(서버가 돌려줄 방·좌석을 먼저 심어 둔다). */
async function enterRoom(over: Partial<RoomRow> = {}, players = PLAYERS) {
  h.fake.rooms.set('r1', row(over));
  h.fake.players = players.map((p) => ({ ...p }));
  h.fake.rpcResult = { data: { room_id: 'r1', code: 'ABCDEF', seat: 0 }, error: null };
  expect(await store().createRoom('나')).toBe(true);
  h.fake.rpcResult = { data: null, error: null };
  h.rpc.mockClear();
}

async function settled() {
  await vi.waitFor(() => expect(store().sending).toBe(false));
}

/** 대기 중인 약속·마이크로태스크를 흘려보낸다. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  await store().leave();
  h.fake.handlers = [];
  h.fake.channelNames = [];
  h.fake.sent = [];
  h.fake.rooms.clear();
  h.fake.players = [];
  h.fake.rpcResult = { data: null, error: null };
  h.fake.playersGate = null;
  h.fake.sessionGate = null;
  h.fake.chat = [];
  h.fake.chatGate = null;
  h.fake.subscribeCb = null;
  h.rpc.mockClear();
  memory.clear();
});

describe('서버 행 해석', () => {
  it('시작 전 방은 그릴 국면이 없다', () => {
    expect(mpGameState(mapRoom(row({ status: 'lobby', turn: null, green_seat: null })))).toBeNull();
  });

  it('진행 중 방 → 서버 판·손패·차례 그대로, 수 번호는 move_count', () => {
    const s = mpGameState(mapRoom(row({ hand: [1, 0, 0, 0, 0, 2], turn: 2, move_count: 7 })))!;
    expect(Array.from(s.board)).toEqual([...INITIAL_BOARD]);
    expect(Array.from(s.hand)).toEqual([1, 0, 0, 0, 0, 2]);
    expect(s.turn).toBe(2);
    expect(s.ply).toBe(7);
    expect(s.phase).toBe('playing');
  });

  it('끝난 방 → 승자 좌석을 진영으로 바꿔 결과를 채운다', () => {
    // 좌석 1 이 녹이면 좌석 1 의 승리는 녹(1)의 승리다.
    const win = mpGameState(mapRoom(row({ status: 'finished', green_seat: 1, winner_seat: 1, win_reason: 'try' })))!;
    expect(win.phase).toBe('over');
    expect(win.result).toEqual({ kind: 'win', winner: 1, reason: 'try' });
    const draw = mpGameState(mapRoom(row({ status: 'finished', is_draw: true, draw_reason: 'repetition' })))!;
    expect(draw.result).toEqual({ kind: 'draw', reason: 'repetition' });
  });

  it('좌석 → 진영', () => {
    expect(sideOfSeat(0, 0)).toBe(1);
    expect(sideOfSeat(1, 0)).toBe(2);
    expect(sideOfSeat(1, 1)).toBe(1);
  });

  it('직전 수가 이상한 모양이면 없는 것으로 본다', () => {
    expect(mapRoom(row({ last_move: { from: 'x' } })).lastMove).toBeNull();
    expect(mapRoom(row({ last_move: { from: 7, to: 4, piece: JA, promote: false, captured: -JA } })).lastMove).toEqual({
      from: 7,
      to: 4,
      piece: JA,
      promote: false,
      captured: -JA,
    });
  });

  it('직전 수를 두기 전의 판 — 잡힌 말과 옮긴 말을 되돌린다', () => {
    const after = [...INITIAL_BOARD];
    after[7] = 0;
    after[4] = JA; // 녹 子 가 7→4 로 적 子 를 잡았다
    const room = mapRoom(row({ board: after, turn: 2, last_move: { from: 7, to: 4, piece: JA, promote: false, captured: -JA } }));
    expect(Array.from(boardBeforeLastMove(room)!)).toEqual([...INITIAL_BOARD]);
    // 놓기는 도착 칸만 비운다.
    const dropped = [...INITIAL_BOARD];
    dropped[3] = -JANG;
    const drop = mapRoom(row({ board: dropped, turn: 1, last_move: { from: DROP, to: 3, piece: JANG, promote: false, captured: 0 } }));
    expect(boardBeforeLastMove(drop)![3]).toBe(0);
    expect(boardBeforeLastMove(mapRoom(row()))).toBeUndefined();
  });

  it('같은 방의 낮은 version 은 늦게 온 옛 스냅샷이다', () => {
    const cur = mapRoom(row({ version: 5 }));
    expect(isNewerRoom(cur, mapRoom(row({ version: 4 })))).toBe(false);
    expect(isNewerRoom(cur, mapRoom(row({ version: 5 })))).toBe(true);
    expect(isNewerRoom(cur, mapRoom(row({ version: 6 })))).toBe(true);
    expect(isNewerRoom(cur, mapRoom(row({ id: 'r2', version: 0 })))).toBe(true);
    expect(isNewerRoom(null, cur)).toBe(true);
  });

  it('서버 오류 문구 → 화면 문구(정확히 같은 문구만, 비슷한 문구와 섞이지 않게)', () => {
    expect(humanError({ message: 'not your turn' })).toBe('상대 차례입니다.');
    expect(humanError({ message: 'your turn' })).toBe('지금은 내 차례입니다.');
    expect(humanError(new TypeError('Failed to fetch'))).toContain('네트워크');
    expect(humanError({ message: 'something else' })).toBe('something else');
  });
});

describe('방 들어가기 · 구독', () => {
  it('방을 만들면 tj:<방> 채널을 구독하고 방·좌석을 읽어 온다', async () => {
    await enterRoom({ status: 'lobby', turn: null, green_seat: null });
    expect(h.fake.channelNames).toEqual(['tj:r1']);
    expect(store().room?.code).toBe('ABCDEF');
    expect(store().players.map((p) => p.displayName)).toEqual(['나', '너']);
    expect(store().myUserId).toBe('me');
  });

  it('늦게 도착한 옛 스냅샷은 버리고, 새 스냅샷은 받는다', async () => {
    await enterRoom({ version: 3 });
    emit('tj_rooms', { eventType: 'UPDATE', new: row({ version: 2, move_count: 9 }), old: {} });
    expect(store().room?.moveCount).toBe(0);
    emit('tj_rooms', { eventType: 'UPDATE', new: row({ version: 4, move_count: 1, turn: 2 }), old: {} });
    expect(store().room?.moveCount).toBe(1);
  });

  it('다른 방의 DELETE 는 무시하고(필터가 안 걸린다), 내 방의 DELETE 면 방을 닫는다', async () => {
    await enterRoom();
    emit('tj_rooms', { eventType: 'DELETE', new: {}, old: { id: 'other-room' } });
    expect(store().room?.id).toBe('r1');
    emit('tj_rooms', { eventType: 'DELETE', new: {}, old: { id: 'r1' } });
    expect(store().room).toBeNull();
    expect(store().error).toBe('방이 닫혔습니다.');
  });

  it('좌석 DELETE 는 id 로 빼고, 다른 방 좌석 이벤트는 무시한다', async () => {
    await enterRoom({ status: 'lobby', turn: null, green_seat: null });
    emit('tj_room_players', { eventType: 'DELETE', new: {}, old: { id: 'zzz' } });
    expect(store().players).toHaveLength(2);
    emit('tj_room_players', { eventType: 'INSERT', new: { ...PLAYERS[1], id: 'q', room_id: 'r9' }, old: {} });
    expect(store().players).toHaveLength(2);
    emit('tj_room_players', { eventType: 'DELETE', new: {}, old: { id: 'p1' } });
    expect(store().players.map((p) => p.id)).toEqual(['p0']);
  });

  it('구독이 끊기면 live 가 내려가고 몇 초마다 다시 읽으며, 다시 붙으면 폴링을 멈춘다', async () => {
    vi.useFakeTimers();
    try {
      await enterRoom();
      h.fake.subscribeCb!('SUBSCRIBED');
      expect(store().live).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      h.fake.subscribeCb!('CHANNEL_ERROR');
      expect(store().live).toBe(false);
      const before = h.fake.roomReads;
      await vi.advanceTimersByTimeAsync(4000);
      expect(h.fake.roomReads).toBe(before + 1);
      h.fake.subscribeCb!('SUBSCRIBED'); // 다시 붙으면 한 번 따라잡아 읽고 폴링을 멈춘다
      await vi.advanceTimersByTimeAsync(0);
      const after = h.fake.roomReads;
      expect(after).toBe(before + 2);
      await vi.advanceTimersByTimeAsync(12000);
      expect(h.fake.roomReads).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('나가면 폴링도 멈춘다 — 채널을 지울 때 오는 CLOSED 가 떠난 방의 폴링을 다시 걸지 않는다', async () => {
    vi.useFakeTimers();
    try {
      await enterRoom();
      h.fake.subscribeCb!('CHANNEL_ERROR');
      await store().leave();
      const n = h.fake.roomReads;
      await vi.advanceTimersByTimeAsync(20000);
      expect(h.fake.roomReads).toBe(n);
      expect(store().live).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('참가 요청이 도는 사이 나가면, 늦게 잡힌 자리를 돌려주고 구독하지 않는다', async () => {
    h.fake.rooms.set('r1', row({ status: 'lobby', turn: null, green_seat: null }));
    h.fake.players = PLAYERS.map((p) => ({ ...p }));
    let release: (() => void) | undefined;
    h.rpc.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ data: { room_id: 'r1', code: 'ABCDEF', seat: 1 }, error: null }))),
    );
    const pending = store().joinRoom('ABCDEF', '나');
    await vi.waitFor(() => expect(release).toBeDefined());
    await store().leave();
    release!();
    expect(await pending).toBe(false);
    expect(h.fake.channelNames).toEqual([]);
    expect(store().room).toBeNull();
    expect(store().busy).toBe(false);
    expect(rememberedCode()).toBe('');
    await vi.waitFor(() => expect(rpcCalls('tj_leave_room')).toEqual([{ p_room: 'r1' }]));
  });

  it('나간 뒤 같은 코드로 곧바로 다시 참가해도, 늦게 도착한 자리 반납이 새 자리를 지우지 않는다', async () => {
    h.fake.rooms.set('r1', row({ status: 'lobby', turn: null, green_seat: null }));
    h.fake.players = PLAYERS.map((p) => ({ ...p }));
    let release: (() => void) | undefined;
    let releaseGiveBack: (() => void) | undefined;
    h.rpc
      .mockImplementationOnce(
        () => new Promise((r) => (release = () => r({ data: { room_id: 'r1', code: 'ABCDEF', seat: 1 }, error: null }))),
      )
      .mockImplementationOnce(() => new Promise((r) => (releaseGiveBack = () => r({ data: null, error: null }))));
    const first = store().joinRoom('ABCDEF', '나');
    await vi.waitFor(() => expect(release).toBeDefined());
    await store().leave();
    // 참가 응답도, 그 뒤의 자리 반납도 끝나기 전에는 잠금이 풀리지 않는다 — 다시 참가해도 요청을 보내지 않는다.
    expect(store().busy).toBe(true);
    expect(await store().joinRoom('ABCDEF', '나')).toBe(false);
    release!();
    await vi.waitFor(() => expect(releaseGiveBack).toBeDefined());
    expect(store().busy).toBe(true);
    expect(await store().joinRoom('ABCDEF', '나')).toBe(false);
    expect(rpcCalls('tj_join_room')).toHaveLength(1);
    releaseGiveBack!();
    expect(await first).toBe(false);
    expect(store().busy).toBe(false);
    // 반납은 이미 서버에 닿았다. 이제 다시 참가하면 그 뒤로 줄을 선다.
    h.fake.rpcResult = { data: { room_id: 'r1', code: 'ABCDEF', seat: 1 }, error: null };
    expect(await store().joinRoom('ABCDEF', '나')).toBe(true);
    const order = h.rpc.mock.calls.map((c) => c[0]);
    expect(order).toEqual(['tj_join_room', 'tj_leave_room', 'tj_join_room']);
    expect(store().room?.id).toBe('r1');
  });

  it('세션을 준비하는 사이 나가면 참가 요청을 아예 보내지 않는다', async () => {
    let open!: () => void;
    h.fake.sessionGate = new Promise<void>((r) => (open = r));
    const pending = store().joinRoom('ABCDEF', '나');
    await flush();
    await store().leave();
    open();
    expect(await pending).toBe(false);
    expect(h.rpc.mock.calls).toHaveLength(0);
    expect(store().busy).toBe(false);
  });

  it('들어갈 때 서버가 준 server_now 로 시계 차이를 바로 잡는다(새로고침 뒤 첫 차례)', async () => {
    h.fake.rooms.set('r1', row());
    h.fake.players = PLAYERS.map((p) => ({ ...p }));
    const ahead = -45_000; // 서버가 기기보다 45초 느리다
    h.fake.rpcResult = {
      data: { room_id: 'r1', code: 'ABCDEF', seat: 0, server_now: new Date(Date.now() + ahead).toISOString() },
      error: null,
    };
    expect(await store().joinRoom('ABCDEF', '나')).toBe(true);
    expect(Math.abs(serverNow() - (Date.now() + ahead))).toBeLessThan(200);
  });

  it('재조회가 도는 사이 들어온 좌석 이벤트를, 늦게 도착한 재조회가 지우지 않는다', async () => {
    await enterRoom({ status: 'lobby', turn: null, green_seat: null }, [PLAYERS[0]]);
    let open!: () => void;
    h.fake.playersGate = new Promise<void>((r) => (open = r));
    h.fake.subscribeCb!('SUBSCRIBED'); // 재조회 시작 — 좌석은 [방장] 으로 읽힌 채 응답이 늦는다
    await flush();
    emit('tj_room_players', { eventType: 'INSERT', new: { ...PLAYERS[1] }, old: {} });
    expect(store().players.map((p) => p.id)).toEqual(['p0', 'p1']);
    open();
    h.fake.playersGate = null;
    await flush();
    expect(store().players.map((p) => p.id)).toEqual(['p0', 'p1']);
  });

  it('대국 중에 나가면 방 코드를 남기고, 대기실에서 나가면 지운다. 방 없이 부른 나가기는 손대지 않는다', async () => {
    await enterRoom();
    expect(rememberedCode()).toBe('ABCDEF');
    await store().leave();
    expect(rememberedCode()).toBe('ABCDEF');
    await store().leave(); // 로비 첫 화면의 🏠 — 방 없음
    expect(rememberedCode()).toBe('ABCDEF');
    await enterRoom({ status: 'lobby', turn: null, green_seat: null });
    await store().leave();
    expect(rememberedCode()).toBe('');
  });

  it('실시간 이벤트의 commit_timestamp 로 기기 시계 차이를 잰다 — 지연이 섞인 값 중 가장 작은 차이', async () => {
    await enterRoom();
    const ahead = 60_000; // 서버가 기기보다 1분 빠르다
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    emit('tj_rooms', { eventType: 'UPDATE', new: row({ version: 2 }), old: {}, commit_timestamp: at(ahead) });
    emit('tj_rooms', { eventType: 'UPDATE', new: row({ version: 3 }), old: {}, commit_timestamp: at(ahead - 900) });
    expect(Math.abs(serverNow() - (Date.now() + ahead))).toBeLessThan(200);
  });

  it('나가면 tj_leave_room 을 부르고, 그 뒤 도착한 이벤트로 방이 되살아나지 않는다', async () => {
    await enterRoom();
    const roomHandler = h.fake.handlers.find((x) => x.filter.table === 'tj_rooms')!;
    await store().leave();
    expect(rpcCalls('tj_leave_room')).toEqual([{ p_room: 'r1' }]);
    roomHandler.cb({ eventType: 'UPDATE', new: row({ version: 99 }), old: {} });
    expect(store().room).toBeNull();
  });
});

describe('착수', () => {
  it('말 고르기 → 갈 칸: tj_play 에 legalMoves 의 수를 그대로 보낸다', async () => {
    await enterRoom(); // 나 = 좌석 0 = 녹, 녹 차례
    store().clickCell(7);
    expect(store().selection).toEqual({ kind: 'cell', cell: 7 });
    store().clickCell(4);
    await settled();
    expect(rpcCalls('tj_play')).toEqual([{ p_room: 'r1', p_from: 7, p_to: 4, p_piece: JA }]);
    expect(store().selection).toBeNull();
  });

  it('손패 놓기는 p_from = -1 과 놓을 종류를 보낸다', async () => {
    await enterRoom({ hand: [0, 0, 1, 0, 0, 0] }); // 녹 손패 子 1
    store().clickHand(JA);
    store().clickCell(3);
    await settled();
    expect(rpcCalls('tj_play')).toEqual([{ p_room: 'r1', p_from: DROP, p_to: 3, p_piece: JA }]);
  });

  it('보내는 동안에는 판이 잠겨 같은 수가 두 번 나가지 않는다', async () => {
    await enterRoom();
    let release: (() => void) | undefined;
    h.rpc.mockImplementationOnce(() => new Promise((r) => (release = () => r({ data: null, error: null }))));
    store().clickCell(10);
    store().clickCell(6); // 王 10→6
    expect(store().sending).toBe(true);
    store().clickCell(10);
    store().clickCell(6);
    // 스토어는 Supabase 모듈을 동적 import 한 뒤에 RPC 를 부른다 — 요청이 실제로 나간 다음에 응답시킨다.
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await settled();
    expect(rpcCalls('tj_play')).toHaveLength(1);
    expect(rpcCalls('tj_play')[0]).toMatchObject({ p_from: 10, p_to: 6, p_piece: KING });
  });

  it('내 차례가 아니면 아무것도 보내지 않는다', async () => {
    await enterRoom({ turn: 2 });
    store().clickCell(7);
    store().clickCell(4);
    expect(store().selection).toBeNull();
    expect(rpcCalls('tj_play')).toHaveLength(0);
  });

  it('서버가 거절하면 문구를 보여 주고 방을 다시 읽는다', async () => {
    await enterRoom();
    h.fake.rpcResult = { data: null, error: { message: 'illegal move' } };
    h.fake.rooms.set('r1', row({ version: 2, turn: 2 })); // 서버는 이미 상대 차례
    store().clickCell(7);
    store().clickCell(4);
    await settled();
    expect(store().error).toContain('둘 수 없는 수');
    expect(store().room?.turn).toBe(2);
  });

  it('판이 바뀌면(version 이 오르면) 고른 말을 푼다', async () => {
    await enterRoom();
    store().clickCell(7);
    emit('tj_rooms', { eventType: 'UPDATE', new: row({ version: 2 }), old: {} });
    expect(store().selection).toBeNull();
  });
});

describe('채팅', () => {
  it('들어오면 최근 메시지를 읽되 새 메시지로 세지 않는다', async () => {
    h.fake.chat = [chatRow(1), chatRow(2), chatRow(3), chatRow(9, { room_id: 'r2' })];
    await enterRoom();
    h.fake.subscribeCb!('SUBSCRIBED');
    await flush();
    expect(store().messages.map((m) => m.text)).toEqual(['m1', 'm2', 'm3']);
    expect(unread()).toBe(0);
  });

  it('실시간 INSERT 는 새 메시지로 센다 — 이 방 · tj_chat INSERT 만 구독한다', async () => {
    await enterRoom();
    h.fake.subscribeCb!('SUBSCRIBED');
    await flush();
    expect(h.fake.handlers.find((x) => x.filter.table === 'tj_chat')?.filter).toMatchObject({ event: 'INSERT', filter: 'room_id=eq.r1' });
    expect(h.fake.handlers.some((x) => x.type === 'broadcast')).toBe(false);
    emit('tj_chat', { eventType: 'INSERT', new: chatRow(4, { body: '안녕' }) });
    expect(store().messages.map((m) => m.text)).toEqual(['안녕']);
    expect(unread()).toBe(1);
  });

  it('모양이 틀린 행 · 다른 방 행은 버린다', async () => {
    await enterRoom();
    emit('tj_chat', { eventType: 'INSERT', new: chatRow(5, { body: { bad: true } }) });
    emit('tj_chat', { eventType: 'INSERT', new: chatRow(6, { room_id: 'r2' }) });
    expect(store().messages).toHaveLength(0);
    expect(store().chatCount).toBe(0);
  });

  it('재연결하면 놓친 메시지를 따라잡고 새 메시지로 센다', async () => {
    h.fake.chat = [chatRow(1)];
    await enterRoom();
    h.fake.subscribeCb!('SUBSCRIBED');
    await flush();
    h.fake.subscribeCb!('CLOSED');
    h.fake.chat.push(chatRow(2), chatRow(3));
    h.fake.subscribeCb!('SUBSCRIBED');
    await flush();
    expect(store().messages.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(unread()).toBe(2);
  });

  it('보낸 뒤 재조회와 실시간 INSERT 가 겹쳐도 한 번만', async () => {
    await enterRoom();
    h.fake.subscribeCb!('SUBSCRIBED');
    await flush();
    expect(store().sendChat('   ')).toBe(false);
    h.fake.chat.push(chatRow(10, { user_id: 'me', display_name: '나', body: 'gg' }));
    expect(store().sendChat('  gg  ')).toBe(true);
    await flush();
    emit('tj_chat', { eventType: 'INSERT', new: chatRow(10, { user_id: 'me', display_name: '나', body: 'gg' }) });
    expect(rpcCalls('tj_send_chat')).toEqual([{ p_room: 'r1', p_body: 'gg' }]);
    expect(store().messages.map((m) => [m.id, m.text])).toEqual([[10, 'gg']]);
    expect(store().chatCount).toBe(1);
  });

  it('방을 나간 뒤 도착한 채팅 읽기는 버린다', async () => {
    await enterRoom();
    h.fake.subscribeCb!('SUBSCRIBED');
    await flush();
    h.fake.chat.push(chatRow(1));
    let release!: () => void;
    h.fake.chatGate = new Promise<void>((r) => (release = r));
    h.fake.subscribeCb!('SUBSCRIBED');
    await store().leave();
    release();
    await flush();
    expect(store().messages).toHaveLength(0);
    expect(store().chatCount).toBe(0);
  });

  it('도배 제한 오류는 오류 줄에 보인다', async () => {
    await enterRoom();
    h.fake.subscribeCb!('SUBSCRIBED');
    await flush();
    h.fake.rpcResult = { data: null, error: { message: 'too many messages' } };
    expect(store().sendChat('gg')).toBe(true);
    await flush();
    expect(store().error).toBe(humanError({ message: 'too many messages' }));
    expect(store().error).toContain('너무 빨리');
  });

  it('연결이 끊겨 있으면 보내지 않는다(입력은 남겨 둔다)', async () => {
    await enterRoom();
    expect(store().sendChat('gg')).toBe(false);
    expect(rpcCalls('tj_send_chat')).toHaveLength(0);
  });

  it('읽은 수는 스토어에 둔다 — 창을 다시 그려도 읽은 메시지가 새 메시지로 돌아오지 않고, 방을 나가면 0', async () => {
    await enterRoom();
    emit('tj_chat', { eventType: 'INSERT', new: chatRow(1) });
    emit('tj_chat', { eventType: 'INSERT', new: chatRow(2) });
    store().markChatSeen();
    emit('tj_chat', { eventType: 'INSERT', new: chatRow(3) });
    expect(unread()).toBe(1);
    await store().leave();
    expect([store().chatCount, store().chatSeen]).toEqual([0, 0]);
  });
});
