// 서버 권위 온라인 대전 상태(읽기 전용 모델 + RPC 래퍼 + Realtime 구독).
//
// 클라이언트는 테이블에 직접 쓰지 않는다 — 합법성·판정은 전부 tj_* RPC 가 한다(supabase/schema.sql).
// 화면은 서버 스냅샷을 core 의 GameState 로 되살려 솔로와 같은 Board·클릭 규칙(view.resolveClick)으로 그린다.
//
// 동기화 원칙:
//  · 방 행의 version(UPDATE 마다 +1)이 지금보다 낮은 스냅샷은 버린다 — 재조회 응답이 실시간 이벤트보다 늦게
//    도착해도 새 상태를 옛 상태로 덮지 않는다.
//  · 구독이 (다시) 붙을 때·탭이 다시 보일 때·수를 보낸 직후 방을 다시 읽는다. 끊긴 동안의 변경은 재생되지 않는다.
//    구독이 끊겨 있는 동안에는 몇 초마다 다시 읽는다.
//  · Realtime DELETE 에는 필터가 걸리지 않아 다른 방이 정리될 때도 온다 — payload.old.id 가 내 방일 때만 처리한다.
//
// Supabase 클라이언트(수백 kB)는 첫 화면 번들에 넣지 않는다 — 서버를 실제로 쓰는 순간 lib/supabase 를 동적 import 한다.

import { create } from 'zustand';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { INITIAL_BOARD, type HandKind } from '../core/board';
import {
  DROP,
  other,
  pieceCode,
  stateFromSnapshot,
  type GameState,
  type Move,
  type Player,
  type DrawReason,
  type WinReason,
} from '../core/gameState';
import { resolveClick, type Selection } from '../core/view';
import { CHAT_COLUMNS, CHAT_KEEP, mergeMessages, sanitizeChatText, toChatMessage, type ChatMessage } from '../lib/chat';

/**
 * Supabase 클라이언트를 불러온다. 청크를 못 받으면(오프라인·배포 뒤 남은 옛 탭) 브라우저마다 다른 영문 오류 대신
 * 정해 둔 문구로 바꿀 수 있게 표시를 단다 — 실패한 동적 import 는 브라우저가 기억해서 새로고침해야 풀린다.
 */
/**
 * Supabase 클라이언트 모듈(동적 import — 첫 화면 번들에서 뺀다). 약속을 하나만 만들어 나눠 쓴다: 동시에 여러 번
 * import 하면 vitest 의 모듈 mock 이 그중 하나에 진짜 모듈을 돌려주어 단위 테스트가 실서버로 나간 일이 있었다(#11).
 * 불러오지 못하면 비워 두어 다음 호출이 다시 시도한다.
 */
let supabaseModule: Promise<typeof import('../lib/supabase')> | null = null;
const loadSupabase = () =>
  (supabaseModule ??= import('../lib/supabase').catch(() => {
    supabaseModule = null;
    throw new Error('client load failed');
  }));

export type MpStatus = 'lobby' | 'playing' | 'finished' | 'abandoned';

/** 서버가 기록한 직전 수 — core 의 Move 에 잡힌 말(부호 코드, 없으면 0)을 더한 것. */
export interface MpLastMove extends Move {
  captured: number;
}

export interface MpRoom {
  id: string;
  code: string;
  status: MpStatus;
  hostId: string;
  /** 녹(선공)을 맡은 좌석. 시작 전에는 null. */
  greenSeat: number | null;
  /** 지금 둘 진영. 시작 전에는 null. */
  turn: Player | null;
  board: number[];
  /** [녹 將·相·子, 적 將·相·子] — core GameState.hand 와 같은 순서. */
  hand: number[];
  moveCount: number;
  lastMove: MpLastMove | null;
  winnerSeat: number | null;
  winReason: WinReason | null;
  isDraw: boolean;
  drawReason: DrawReason | null;
  turnStartedAt: string | null;
  /** 행이 바뀔 때마다 오르는 값 — 늦게 도착한 스냅샷을 거르는 데 쓴다. */
  version: number;
}

export interface MpPlayer {
  id: string;
  userId: string;
  seat: number;
  displayName: string;
  isHost: boolean;
  connected: boolean;
}

/** 상대가 이 시간(초) 넘게 두지 않으면 시간초과 승리를 요청할 수 있다 — 서버 tj_claim_timeout 의 상수와 같다. */
export const TIMEOUT_SECONDS = 120;

/** 구독이 끊겨 있는 동안 방을 다시 읽는 간격(ms). */
const POLL_MS = 4000;

const NAME_KEY = 'tj_mp_name';
const CODE_KEY = 'tj_mp_code';

/** 방을 읽을 때 가져오는 열(화면이 쓰지 않는 created_at·updated_at 은 뺀다). */
const ROOM_COLUMNS =
  'id, code, status, host_id, green_seat, turn, board, hand, move_count, last_move, ' +
  'winner_seat, win_reason, is_draw, draw_reason, turn_started_at, version';

/* ── 서버 행 → 모델 ──────────────────────────────────────────────────── */

export interface RoomRow {
  id: string;
  code: string;
  status: MpStatus;
  host_id: string;
  green_seat: number | null;
  turn: Player | null;
  board: number[] | null;
  hand: number[] | null;
  move_count: number | null;
  last_move: unknown;
  winner_seat: number | null;
  win_reason: WinReason | null;
  is_draw: boolean | null;
  draw_reason: DrawReason | null;
  turn_started_at: string | null;
  version: number | null;
}

export interface PlayerRow {
  id: string;
  room_id: string;
  user_id: string;
  seat: number;
  display_name: string;
  is_host: boolean | null;
  connected: boolean | null;
}

function toLastMove(v: unknown): MpLastMove | null {
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  if (typeof m.from !== 'number' || typeof m.to !== 'number' || typeof m.piece !== 'number') return null;
  return {
    from: m.from,
    to: m.to,
    piece: m.piece as Move['piece'],
    promote: m.promote === true,
    captured: typeof m.captured === 'number' ? m.captured : 0,
  };
}

export function mapRoom(r: RoomRow): MpRoom {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    hostId: r.host_id,
    greenSeat: r.green_seat ?? null,
    turn: r.turn ?? null,
    board: Array.isArray(r.board) ? r.board : [...INITIAL_BOARD],
    hand: Array.isArray(r.hand) ? r.hand : [0, 0, 0, 0, 0, 0],
    moveCount: r.move_count ?? 0,
    lastMove: toLastMove(r.last_move),
    winnerSeat: r.winner_seat ?? null,
    winReason: r.win_reason ?? null,
    isDraw: !!r.is_draw,
    drawReason: r.draw_reason ?? null,
    turnStartedAt: r.turn_started_at ?? null,
    version: r.version ?? 0,
  };
}

export function mapPlayer(p: PlayerRow): MpPlayer {
  return {
    id: p.id,
    userId: p.user_id,
    seat: p.seat,
    displayName: p.display_name,
    isHost: !!p.is_host,
    connected: !!p.connected,
  };
}

/* ── 파생 ────────────────────────────────────────────────────────────── */

/** 좌석 → 진영. 녹은 greenSeat 좌석이 잡는다(시작 전 greenSeat 가 null 이면 의미 없다). */
export function sideOfSeat(seat: number, greenSeat: number | null): Player {
  return seat === greenSeat ? 1 : 2;
}

/** 서버 스냅샷을 그릴 수 있는 GameState 로. 시작 전이면 null, 끝난 방이면 결과까지 채운다. */
export function mpGameState(room: MpRoom | null): GameState | null {
  if (!room || room.turn === null || room.greenSeat === null) return null;
  const s = stateFromSnapshot({ board: room.board, hand: room.hand, turn: room.turn });
  // 반복 이력은 서버가 관리한다(무승부 판정은 서버 권위). 수 번호만 맞춰 둔다.
  s.ply = room.moveCount;
  if (room.status === 'finished') {
    s.phase = 'over';
    if (room.isDraw) {
      s.result = { kind: 'draw', reason: room.drawReason ?? 'repetition' };
    } else if (room.winnerSeat !== null && room.winReason) {
      s.result = { kind: 'win', winner: sideOfSeat(room.winnerSeat, room.greenSeat), reason: room.winReason };
    }
  }
  return s;
}

/** next 로 바꿔도 되는가 — 같은 방의 더 낮은 version 은 늦게 도착한 옛 스냅샷이다. */
export function isNewerRoom(cur: MpRoom | null, next: MpRoom): boolean {
  return cur === null || cur.id !== next.id || next.version >= cur.version;
}

/**
 * 직전 수를 두기 전의 판 — TurnBanner 가 잡기(×)를 표시하는 데 쓴다. 서버가 잡힌 말을 직전 수에 실어 보내므로
 * 이전 스냅샷이 없어도(새로고침·재접속) 되살릴 수 있다. 직전 수를 둔 쪽은 늘 지금 차례의 상대다
 * (기권·시간초과는 차례를 바꾸지 않는다).
 */
export function boardBeforeLastMove(room: MpRoom): Int8Array | undefined {
  const m = room.lastMove;
  if (!m || room.turn === null) return undefined;
  const b = Int8Array.from(room.board);
  b[m.to] = m.captured;
  if (m.from !== DROP) b[m.from] = pieceCode(other(room.turn), m.piece);
  return b;
}

/* ── 오류 문구 ───────────────────────────────────────────────────────── */

/** 서버 예외 문구(supabase/schema.sql 의 raise exception) → 화면 문구. */
const ERROR_KO: Record<string, string> = {
  'client load failed': '온라인 기능을 불러오지 못했습니다. 연결을 확인한 뒤 새로고침해 주세요.',
  'not authenticated': '서버 세션을 만들지 못했습니다. 새로고침한 뒤 다시 시도하세요.',
  'display name required': '닉네임을 입력하세요.',
  'too many rooms': '방을 너무 자주 만들었습니다. 잠시 뒤에 다시 만들어 주세요.',
  'could not allocate room code': '방 코드를 만들지 못했습니다. 다시 시도하세요.',
  'room not found': '방을 찾을 수 없습니다. 코드를 확인하세요.',
  'room closed': '이미 끝난 방입니다.',
  'game already started': '이미 대국이 시작된 방입니다.',
  'room is full': '방이 가득 찼습니다.',
  'only host can start': '방장만 시작할 수 있습니다.',
  'not in lobby': '이미 시작했거나 끝난 방입니다.',
  'need 2 players': '2명이 모여야 시작할 수 있습니다.',
  'not playing': '진행 중인 대국이 아닙니다.',
  'not a member': '이 방의 참가자가 아닙니다.',
  'not your turn': '상대 차례입니다.',
  'illegal move': '둘 수 없는 수입니다. 판을 다시 불러왔어요.',
  'your turn': '지금은 내 차례입니다.',
  'not timed out yet': '아직 상대의 제한 시간이 남았습니다.',
  'empty message': '빈 메시지는 보낼 수 없습니다.',
  'too many messages': '메시지를 너무 빨리 보내고 있어요. 잠시 뒤에 다시 보내 주세요.',
};

export function humanError(e: unknown): string {
  const msg = String((e as { message?: unknown } | null)?.message ?? e).trim();
  if (ERROR_KO[msg]) return ERROR_KO[msg];
  if (msg.includes('Anonymous sign-ins are disabled')) return '익명 로그인이 꺼져 있어 온라인 대전을 쓸 수 없습니다.';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return '서버에 연결하지 못했습니다. 네트워크를 확인하세요.';
  }
  return msg;
}

/* ── 저장값 ──────────────────────────────────────────────────────────── */

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 저장 불가(사생활 모드 등) — 입력창 기본값만 못 채운다.
  }
}

/** 마지막으로 쓴 닉네임(입력창 기본값). */
export function rememberedName(): string {
  return readStored(NAME_KEY);
}

/** 나가기 전에 있던 방 코드 — 새로고침으로 튕긴 대국에 바로 다시 들어가게 참가 칸을 채운다. */
export function rememberedCode(): string {
  return readStored(CODE_KEY);
}

/* ── 서버 시계 ───────────────────────────────────────────────────────── */
//
// 시간초과는 서버 시계(turn_started_at 과 now())로 판정한다. 기기 시계가 몇십 초 틀어져 있으면 남은 시간과
// 시간초과 버튼이 서버 판정과 어긋나므로, 실시간 이벤트의 commit_timestamp(서버 시각)로 차이를 잰다.
// 전송 지연만큼 차이가 크게 잡히므로 최근 값들 중 최솟값을 쓴다.

let skewSamples: number[] = [];

function noteServerTime(commitTimestamp: unknown) {
  const t = typeof commitTimestamp === 'string' ? Date.parse(commitTimestamp) : Number.NaN;
  if (Number.isFinite(t)) skewSamples = [...skewSamples.slice(-9), Date.now() - t];
}

/** 서버 기준 지금(ms). 아직 이벤트를 하나도 못 받았으면 기기 시계. */
export function serverNow(): number {
  return Date.now() - (skewSamples.length > 0 ? Math.min(...skewSamples) : 0);
}

/* ── 스토어 ──────────────────────────────────────────────────────────── */

interface MpState {
  room: MpRoom | null;
  players: MpPlayer[];
  myUserId: string | null;
  /** 고른 내 말(칸) 또는 손패 — 로컬 UI 전용. */
  selection: Selection | null;
  /** 방 만들기·참가·시작 요청 중(로비 버튼 잠금). */
  busy: boolean;
  /** 수·기권·시간초과 요청이 서버에 가 있는 동안 — 판을 잠가 같은 수가 두 번 나가지 않게. */
  sending: boolean;
  /** Realtime 구독이 붙어 있는가. 끊겨 있으면 화면에 알리고 몇 초마다 다시 읽는다. */
  live: boolean;
  error: string | null;
  /** 최근 메시지(CHAT_KEEP 개까지). */
  messages: ChatMessage[];
  /** 이 방에서 받은 메시지 수(줄지 않는다) — messages 는 잘려서 길이로는 안 읽은 수를 셀 수 없다. */
  chatCount: number;
  /**
   * 채팅 창을 마지막으로 본 때까지 받은 수. 화면(대기실 → 대국)이 바뀌면 채팅 창이 새로 그려지므로
   * 창이 아니라 여기에 둔다 — 대기실에서 읽은 메시지가 대국 화면에서 다시 '새 메시지'로 뜨지 않게.
   */
  chatSeen: number;

  createRoom: (name: string) => Promise<boolean>;
  joinRoom: (code: string, name: string) => Promise<boolean>;
  startGame: () => Promise<void>;
  /** 칸·손패 클릭 → 솔로와 같은 resolveClick 으로 해석해 수가 되면 tj_play 를 부른다. */
  clickCell: (cell: number) => void;
  clickHand: (piece: HandKind) => void;
  resign: () => Promise<void>;
  claimTimeout: () => Promise<void>;
  leave: () => Promise<void>;
  /** 보냈으면 true. 실시간 연결이 끊겨 있으면 보내지 않는다(입력은 남겨 둔다). */
  sendChat: (text: string) => boolean;
  markChatSeen: () => void;
  clearError: () => void;
}

const NO_CHAT = { messages: [], chatCount: 0, chatSeen: 0 };

// 구독 자원은 화면 상태가 아니라 모듈에 둔다(바뀌어도 다시 그릴 일이 없다).
let channel: RealtimeChannel | null = null;
let channelClient: SupabaseClient | null = null;
/** 지금 붙어 있는 방. 늦게 끝난 요청·이벤트가 떠난 방의 상태를 되살리지 않게 비교한다. */
let currentRoomId: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let onVisible: (() => void) | null = null;
/** 방 들어가기 세대 — leave() 가 올린다. 그 사이에 끝난 enter() 는 방금 잡은 자리를 돌려주고 물러난다. */
let session = 0;
/** 좌석 이벤트 수 — 재조회가 도는 사이 좌석 이벤트가 왔으면 재조회의 좌석 목록이 더 낡았다(좌석에는 version 이 없다). */
let playersEpoch = 0;
/** enter() 가 서버 응답(또는 나간 뒤의 자리 반납)을 기다리는 중 — 그동안은 leave() 도 잠금을 풀지 않는다. */
let entering = false;
/** 채팅을 한 번이라도 읽어 온 방. 처음 읽은 지난 메시지는 '새 메시지'로 세지 않고, 그 뒤 따라잡은 것은 센다. */
let chatLoadedFor: string | null = null;

export const useMultiplayerStore = create<MpState>((set, get) => {
  function applyRoom(next: MpRoom) {
    const cur = get().room;
    if (!isNewerRoom(cur, next)) return;
    // 판이 바뀌었으면 고른 것을 푼다 — 낡은 선택으로 엉뚱한 수를 두지 않게.
    const same = cur !== null && cur.id === next.id && cur.version === next.version;
    set({ room: next, selection: same ? get().selection : null });
  }

  function unsubscribe() {
    // 순서가 중요하다: removeChannel 은 구독 콜백을 곧바로 CLOSED 로 부른다 — 방 표시와 폴링을 먼저 거둬야
    // 떠난 방의 폴링이 다시 걸리지 않는다.
    currentRoomId = null;
    chatLoadedFor = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    onVisible = null;
    if (channel && channelClient) void channelClient.removeChannel(channel);
    channel = null;
    channelClient = null;
  }

  /** 방이 사라졌다(정리됨·회원이 아님). 화면은 로비로 돌아간다. */
  function closeRoom(message: string) {
    unsubscribe();
    writeStored(CODE_KEY, null);
    set({ room: null, players: [], selection: null, sending: false, live: false, ...NO_CHAT, error: message });
  }

  /** 채팅을 id 로 합친다. countAsNew 가 아니면(처음 읽은 지난 메시지) 읽은 것으로 친다. */
  function addChat(incoming: ChatMessage[], countAsNew: boolean) {
    set((s) => {
      const { messages, added } = mergeMessages(s.messages, incoming);
      if (added === 0) return s;
      return { messages, chatCount: s.chatCount + added, chatSeen: countAsNew ? s.chatSeen : s.chatSeen + added };
    });
  }

  /** 최근 채팅을 읽어 합친다 — 끊긴 동안 놓친 메시지도 이 길로 따라잡는다. 그 사이 방을 떠났으면 버린다. */
  async function loadChat(roomId: string): Promise<void> {
    const token = session;
    try {
      const { supabase } = await loadSupabase();
      const { data, error } = await supabase
        .from('tj_chat')
        .select(CHAT_COLUMNS)
        .eq('room_id', roomId)
        .order('id', { ascending: false })
        .limit(CHAT_KEEP);
      if (token !== session || currentRoomId !== roomId || error || !data) return;
      const msgs = (data as unknown[]).map(toChatMessage).filter((m): m is ChatMessage => m !== null);
      addChat(msgs, chatLoadedFor === roomId);
      chatLoadedFor = roomId;
    } catch {
      // 네트워크 오류 — 다음 재조회에서 다시 읽는다.
    }
  }

  /** 방과 좌석(과 채팅)을 다시 읽는다. 그 사이 방을 떠났으면 버린다. */
  async function refetch(roomId: string): Promise<void> {
    const epoch = playersEpoch;
    const chat = loadChat(roomId);
    try {
      const { supabase } = await loadSupabase();
      const [roomRes, playersRes] = await Promise.all([
        supabase.from('tj_rooms').select(ROOM_COLUMNS).eq('id', roomId).maybeSingle(),
        supabase.from('tj_room_players').select('*').eq('room_id', roomId).order('seat'),
      ]);
      if (currentRoomId !== roomId || roomRes.error || playersRes.error) return;
      if (!roomRes.data) {
        closeRoom('방이 닫혔습니다.');
        return;
      }
      applyRoom(mapRoom(roomRes.data as unknown as RoomRow));
      if (playersEpoch === epoch) set({ players: (playersRes.data as PlayerRow[]).map(mapPlayer) });
    } catch {
      // 네트워크 오류 — 구독이 다시 붙을 때·다음 폴링에서 다시 읽는다.
    } finally {
      await chat;
    }
  }

  function setLive(roomId: string, live: boolean) {
    if (currentRoomId !== roomId) return;
    set({ live });
    if (live) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      // 구독 직후·재연결 뒤 — 끊긴 동안 놓친 변경을 따라잡는다.
      void refetch(roomId);
    } else if (!pollTimer) {
      pollTimer = setInterval(() => void refetch(roomId), POLL_MS);
    }
  }

  function subscribe(supabase: SupabaseClient, roomId: string) {
    unsubscribe();
    currentRoomId = roomId;
    set({ ...NO_CHAT, live: false });
    channelClient = supabase;
    channel = supabase
      .channel(`tj:${roomId}`)
      // 채팅은 tj_chat INSERT 로 받는다 — 서버가 RLS 로 회원에게만 보낸다(보낸 사람도 서버가 채운 값).
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'tj_chat', filter: `room_id=eq.${roomId}` },
        (payload) => {
          if (currentRoomId !== roomId) return;
          const row = payload.new as { room_id?: unknown } | null;
          if (row?.room_id !== roomId) return;
          const msg = toChatMessage(row);
          if (msg) addChat([msg], true);
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tj_rooms', filter: `id=eq.${roomId}` },
        (payload) => {
          if (currentRoomId !== roomId) return;
          noteServerTime(payload.commit_timestamp);
          if (payload.eventType === 'DELETE') {
            if ((payload.old as { id?: string } | null)?.id === roomId) closeRoom('방이 닫혔습니다.');
            return;
          }
          applyRoom(mapRoom(payload.new as RoomRow));
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tj_room_players', filter: `room_id=eq.${roomId}` },
        (payload) => {
          if (currentRoomId !== roomId) return;
          noteServerTime(payload.commit_timestamp);
          if (payload.eventType === 'DELETE') {
            // DELETE 에는 필터가 걸리지 않는다 — 다른 방 좌석이 지워질 때도 오므로 내 방 좌석일 때만.
            const oldId = (payload.old as { id?: string } | null)?.id;
            if (!get().players.some((p) => p.id === oldId)) return;
            playersEpoch++;
            set((s) => ({ players: s.players.filter((p) => p.id !== oldId) }));
            return;
          }
          const row = payload.new as PlayerRow;
          if (row.room_id !== roomId) return;
          playersEpoch++;
          const np = mapPlayer(row);
          set((s) => ({
            players: [...s.players.filter((p) => p.id !== np.id), np].sort((a, b) => a.seat - b.seat),
          }));
        },
      )
      .subscribe((status) => setLive(roomId, status === 'SUBSCRIBED'));
    if (typeof document !== 'undefined') {
      onVisible = () => {
        if (document.visibilityState === 'visible') void refetch(roomId);
      };
      document.addEventListener('visibilitychange', onVisible);
    }
  }

  /**
   * 방 만들기·참가 공통: 익명 세션 → RPC → 구독 → 첫 읽기.
   * 기다리는 사이 나가면(leave 가 session 을 올린다) 단계마다 확인해 물러난다. RPC 가 이미 자리를 잡았으면
   * 그 자리를 돌려준 뒤에야 잠금(busy)을 푼다 — 같은 코드로 곧바로 다시 참가했을 때 늦게 도착한 반납이
   * 새 자리를 지우지 않게, 반납이 언제나 다음 참가보다 먼저 서버에 닿도록 줄을 세우는 것이다.
   */
  async function enter(fn: 'tj_create_room' | 'tj_join_room', args: Record<string, string>, name: string) {
    if (get().busy) return false;
    const token = ++session;
    entering = true;
    set({ busy: true, error: null });
    try {
      const { supabase, ensureAnonSession } = await loadSupabase();
      if (token !== session) return false;
      const uid = await ensureAnonSession();
      if (token !== session) return false;
      if (!uid) throw new Error('not authenticated');
      const { data, error } = await supabase.rpc(fn, args);
      if (error) throw error;
      const res = data as { room_id: string; code: string; server_now?: string };
      noteServerTime(res.server_now);
      if (token !== session) {
        await supabase.rpc('tj_leave_room', { p_room: res.room_id }).then(undefined, () => {});
        return false;
      }
      writeStored(NAME_KEY, name);
      writeStored(CODE_KEY, res.code);
      set({ myUserId: uid, room: null, players: [], selection: null });
      subscribe(supabase, res.room_id);
      await refetch(res.room_id);
      return true;
    } catch (e) {
      if (token === session) set({ error: humanError(e) });
      return false;
    } finally {
      // 나간 뒤라도 여기서 푼다 — 잠금이 걸려 있는 동안은 새 enter() 가 시작되지 않으므로 이 enter 가 마지막이다.
      entering = false;
      set({ busy: false });
    }
  }

  /** 방 하나에 대한 RPC(시작·기권·시간초과·수). 끝나면 성공이든 실패든 방을 다시 읽는다. */
  async function act(lock: 'busy' | 'sending', fn: string, args: Record<string, unknown> = {}) {
    const room = get().room;
    if (!room || get()[lock]) return;
    set(lock === 'busy' ? { busy: true, error: null } : { sending: true, error: null });
    try {
      const { supabase } = await loadSupabase();
      const { error } = await supabase.rpc(fn, { p_room: room.id, ...args });
      if (error) throw error;
    } catch (e) {
      set({ error: humanError(e) });
    } finally {
      // 성공이면 실시간 이벤트를 기다리지 않고, 실패면 낡았을 모델을 바로잡으려고 다시 읽는다 —
      // 다 읽을 때까지 잠가 두어 옛 판을 보고 한 번 더 두지 않게 한다.
      await refetch(room.id);
      set(lock === 'busy' ? { busy: false } : { sending: false });
    }
  }

  function click(target: Selection) {
    const { room, players, myUserId, selection, sending } = get();
    if (!room || room.status !== 'playing' || sending) return;
    const me = players.find((p) => p.userId === myUserId);
    const state = mpGameState(room);
    if (!me || !state) return;
    const r = resolveClick(state, sideOfSeat(me.seat, room.greenSeat), selection, target);
    if (!r) return;
    if (r.kind === 'select') {
      set({ selection: r.selection });
      return;
    }
    const m = r.move;
    set({ selection: null });
    void act('sending', 'tj_play', { p_from: m.from, p_to: m.to, p_piece: m.piece });
  }

  return {
    room: null,
    players: [],
    myUserId: null,
    selection: null,
    busy: false,
    sending: false,
    live: false,
    error: null,
    ...NO_CHAT,

    createRoom: (name) => enter('tj_create_room', { p_display_name: name }, name),
    joinRoom: (code, name) =>
      enter('tj_join_room', { p_code: code.trim().toUpperCase(), p_display_name: name }, name),
    startGame: () => act('busy', 'tj_start_game'),

    clickCell: (cell) => click({ kind: 'cell', cell }),
    clickHand: (piece) => click({ kind: 'hand', piece }),

    resign: () => act('sending', 'tj_resign'),
    claimTimeout: () => act('sending', 'tj_claim_timeout'),

    leave: async () => {
      session++;
      const room = get().room;
      const roomId = room?.id ?? currentRoomId;
      unsubscribe();
      // 대국 중에 나가면 코드를 남겨 둔다 — 로비 참가 칸이 채워져 있어 바로 돌아올 수 있다(좌석은 서버가 지킨다).
      // 방 없이 부른 나가기(로비 첫 화면의 🏠 등)는 남겨 둔 코드를 지우지 않는다.
      if (room && room.status !== 'playing') writeStored(CODE_KEY, null);
      set({ room: null, players: [], selection: null, busy: entering, sending: false, live: false, error: null, ...NO_CHAT });
      if (!roomId) return;
      try {
        const { supabase } = await loadSupabase();
        await supabase.rpc('tj_leave_room', { p_room: roomId });
      } catch {
        // 나가기 실패는 무시 — 대기실이면 정리가, 대국이면 시간초과가 마무리한다.
      }
    },

    // 채팅은 tj_send_chat 하나로 보낸다 — 보낸 사람 · 이름은 서버가 채운다. 내 메시지도 실시간 INSERT 로 돌아오고,
    // 보낸 뒤 한 번 다시 읽어 실시간이 늦어도 보이게 한다(id 로 합치므로 두 길로 와도 한 번).
    // 연결이 끊겨 있으면 보내지 않는다 — 창이 '연결되면 보낼 수 있어요'를 보이고 입력을 남겨 둔다.
    sendChat: (text) => {
      const clean = sanitizeChatText(text);
      const roomId = currentRoomId;
      if (!clean || !roomId || !get().live) return false;
      const token = session;
      void (async () => {
        try {
          const { supabase } = await loadSupabase();
          const { error } = await supabase.rpc('tj_send_chat', { p_room: roomId, p_body: clean });
          if (error) throw error;
          await loadChat(roomId);
        } catch (e) {
          if (token === session && currentRoomId === roomId) set({ error: humanError(e) });
        }
      })();
      return true;
    },

    markChatSeen: () => set((s) => (s.chatSeen === s.chatCount ? s : { chatSeen: s.chatCount })),
    clearError: () => set({ error: null }),
  };
});

/** 파생: 내 좌석 / 상대. */
export function selectMe(s: Pick<MpState, 'players' | 'myUserId'>): MpPlayer | null {
  return s.players.find((p) => p.userId === s.myUserId) ?? null;
}

export function selectOpponent(s: Pick<MpState, 'players' | 'myUserId'>): MpPlayer | null {
  return s.players.find((p) => p.userId !== s.myUserId) ?? null;
}
