// 온라인 대전 채팅 — 순수 헬퍼. 메시지는 서버 tj_chat 테이블에 있다(supabase/schema.sql '채팅 (#11)'):
// 보내기는 tj_send_chat RPC(보낸 사람 · 이름은 서버가 채운다), 읽기는 회원만(RLS select · Realtime INSERT).
// 받은 행은 그래도 모양을 확인한 뒤에만 그린다 — 화면이 죽지 않게.

/** 한 메시지 최대 길이(전송 전 잘라냄) — 서버 tj_send_chat 의 200자와 같다. */
export const CHAT_MAX_LEN = 200;
/** 메모리에 유지할 최근 메시지 수(무한 증가 방지). 방에 들어올 때 · 다시 붙을 때도 이만큼 읽어 온다. */
export const CHAT_KEEP = 50;
/** 표시 이름 최대 길이 — 서버 tj_room_players.display_name 과 같다. */
export const CHAT_NAME_MAX = 24;
/** tj_chat 에서 읽어 올 열. */
export const CHAT_COLUMNS = 'id,user_id,display_name,body,created_at';

/** 그릴 수 있는 채팅 메시지. */
export interface ChatMessage {
  /** tj_chat.id — 순서이자 중복 제거 열쇠. */
  id: number;
  userId: string;
  displayName: string;
  text: string;
  /** 서버 시각 epoch ms. */
  ts: number;
}

/**
 * 전송 전 정리: 앞뒤 공백 제거 → 비어 있으면 null(전송 안 함) → CHAT_MAX_LEN 으로 절단.
 */
export function sanitizeChatText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, CHAT_MAX_LEN);
}

/** 서버 시각 문자열 → epoch ms. 시간대가 없으면 UTC 로 본다 — 그대로 두면 기기 시간대로 읽혀 몇 시간 어긋난다. */
function parseServerTs(s: string): number {
  return Date.parse(/(?:[zZ]|[+-]\d\d(?::?\d\d)?)$/.test(s) ? s : `${s}Z`);
}

/**
 * tj_chat 행(select 결과 · Realtime INSERT 의 new)을 그릴 수 있는 메시지로. 모양이 다르면 null(버린다) —
 * 문자열이 아닌 본문을 그대로 그리면 React 가 렌더링 중에 죽는다. 길이는 서버 규칙과 같게 다시 자른다.
 */
export function toChatMessage(row: unknown): ChatMessage | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'number' || !Number.isFinite(r.id)) return null;
  if (typeof r.user_id !== 'string' || typeof r.display_name !== 'string' || typeof r.body !== 'string') return null;
  if (typeof r.created_at !== 'string') return null;
  const ts = parseServerTs(r.created_at);
  if (!Number.isFinite(ts)) return null;
  const text = sanitizeChatText(r.body);
  if (!text) return null;
  return {
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name.trim().slice(0, CHAT_NAME_MAX) || '익명',
    text,
    ts,
  };
}

/**
 * 불변 합치기: id 로 중복을 없애고 id 순으로 정렬해 최근 cap 개만 남긴다.
 * added = 결과에 새로 들어온 메시지 수 — 상한 밖으로 밀려난 옛 메시지는 보이지 않으므로 세지 않는다(안 읽음 수에 쓴다).
 */
export function mergeMessages(
  list: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
  cap = CHAT_KEEP,
): { messages: ChatMessage[]; added: number } {
  const byId = new Map<number, ChatMessage>();
  for (const m of list) byId.set(m.id, m);
  const before = new Set(byId.keys());
  for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, m);
  const messages = [...byId.values()].sort((a, b) => a.id - b.id).slice(-cap);
  return { messages, added: messages.filter((m) => !before.has(m.id)).length };
}
