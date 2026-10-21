// 온라인 대전 채팅 — 순수 헬퍼. 테이블 없이 Realtime broadcast 만 쓴다:
// 채널 `tj:<roomId>`, 이벤트 'chat', payload = { userId, displayName, text, ts }.
// 채널은 아직 공개라(비공개 전환은 #11) 받은 payload 는 믿지 않고 toChatMessage 로 모양을 확인한 뒤에만 그린다.

/** 한 메시지 최대 길이(전송 전 잘라냄). */
export const CHAT_MAX_LEN = 200;
/** 메모리에 유지할 최근 메시지 수(무한 증가 방지). */
export const CHAT_KEEP = 50;
/** 표시 이름 최대 길이 — 서버 tj_room_players.display_name 과 같다. */
export const CHAT_NAME_MAX = 24;

/** broadcast payload = 채팅 메시지. */
export interface ChatMessage {
  userId: string;
  displayName: string;
  text: string;
  /** Date.now() epoch ms. */
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

/**
 * 받은 payload 를 그릴 수 있는 메시지로. 모양이 다르면 null(버린다) — 문자열이 아닌 text 를 그대로 그리면
 * React 가 렌더링 중에 죽는다. 길이는 보낸 쪽 규칙과 같게 다시 자른다.
 */
export function toChatMessage(payload: unknown): ChatMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.userId !== 'string' || typeof p.displayName !== 'string' || typeof p.text !== 'string') return null;
  if (typeof p.ts !== 'number' || !Number.isFinite(p.ts)) return null;
  const text = sanitizeChatText(p.text);
  if (!text) return null;
  return {
    userId: p.userId,
    displayName: p.displayName.trim().slice(0, CHAT_NAME_MAX) || '익명',
    text,
    ts: p.ts,
  };
}

/**
 * 불변 추가: 새 배열을 반환하며 최근 cap 개만 유지한다.
 */
export function appendCapped<T>(list: readonly T[], item: T, cap = CHAT_KEEP): T[] {
  return [...list, item].slice(-cap);
}
