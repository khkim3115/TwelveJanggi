import { describe, expect, it } from 'vitest';
import { CHAT_COLUMNS, CHAT_KEEP, CHAT_MAX_LEN, mergeMessages, sanitizeChatText, toChatMessage } from './chat';
import type { ChatMessage } from './chat';

describe('sanitizeChatText (전송 전 정리/검증)', () => {
  it('빈 문자열은 null', () => {
    expect(sanitizeChatText('')).toBeNull();
  });

  it('공백뿐인 문자열은 null', () => {
    expect(sanitizeChatText('   \t\n  ')).toBeNull();
  });

  it('앞뒤 공백을 제거한다', () => {
    expect(sanitizeChatText('  안녕  ')).toBe('안녕');
  });

  it(`${CHAT_MAX_LEN}자를 초과하면 잘라낸다`, () => {
    const long = 'x'.repeat(CHAT_MAX_LEN + 50);
    expect(sanitizeChatText(long)).toBe('x'.repeat(CHAT_MAX_LEN));
  });

  it('정상 메시지는 그대로 반환한다', () => {
    expect(sanitizeChatText('gg 잘했어요')).toBe('gg 잘했어요');
  });
});

describe('toChatMessage (tj_chat 행 검증)', () => {
  const row = { id: 7, room_id: 'r1', user_id: 'u1', display_name: '녹', body: '안녕', created_at: '2026-10-22T05:00:00.123456+00:00' };

  it('CHAT_COLUMNS 는 읽어 올 열 목록이다', () => {
    expect(CHAT_COLUMNS).toBe('id,user_id,display_name,body,created_at');
  });

  it('toChatMessage 는 tj_chat 행을 메시지로 바꾼다', () => {
    expect(toChatMessage(row)).toEqual({ id: 7, userId: 'u1', displayName: '녹', text: '안녕', ts: Date.UTC(2026, 9, 22, 5, 0, 0, 123) });
  });

  it('시간대가 없는 created_at 은 UTC 로 읽는다 — 기기 시간대로 읽으면 몇 시간 어긋난다', () => {
    expect(toChatMessage({ ...row, created_at: '2026-10-22T05:00:00.123456' })?.ts).toBe(Date.UTC(2026, 9, 22, 5, 0, 0, 123));
  });

  it('모양이 틀린 행은 버린다 — 문자열이 아닌 본문을 그리면 화면이 죽는다', () => {
    expect(toChatMessage(null)).toBeNull();
    expect(toChatMessage('hi')).toBeNull();
    expect(toChatMessage({ ...row, id: '7' })).toBeNull();
    expect(toChatMessage({ ...row, id: Number.NaN })).toBeNull();
    expect(toChatMessage({ ...row, user_id: 3 })).toBeNull();
    expect(toChatMessage({ ...row, body: { evil: true } })).toBeNull();
    expect(toChatMessage({ ...row, created_at: 'x' })).toBeNull();
    expect(toChatMessage({ ...row, body: '   ' })).toBeNull();
  });

  it('길이는 다시 자른다(서버 규칙과 같다)', () => {
    const m = toChatMessage({ ...row, display_name: '가'.repeat(40), body: 'x'.repeat(CHAT_MAX_LEN + 1) });
    expect(m?.displayName).toHaveLength(24);
    expect(m?.text).toHaveLength(CHAT_MAX_LEN);
  });

  it('빈 이름은 익명', () => {
    expect(toChatMessage({ ...row, display_name: '  ' })?.displayName).toBe('익명');
  });
});

describe('mergeMessages (id 로 합치기 · 메모리 상한)', () => {
  const msg = (id: number): ChatMessage => ({ id, userId: 'u', displayName: 'n', text: `m${id}`, ts: id });
  const ids = (list: readonly ChatMessage[]) => list.map((m) => m.id);

  it('mergeMessages 는 id 로 중복을 없애고 순서를 맞춘다', () => {
    const r = mergeMessages([msg(3), msg(1)], [msg(2), msg(3)]);
    expect(ids(r.messages)).toEqual([1, 2, 3]);
    expect(r.added).toBe(1);
  });

  it('이미 있는 id 는 다시 세지 않는다 — 보낸 뒤 재조회와 실시간 INSERT 가 겹쳐도 한 번', () => {
    const once = mergeMessages([], [msg(5)]);
    const twice = mergeMessages(once.messages, [msg(5)]);
    expect(ids(twice.messages)).toEqual([5]);
    expect(twice.added).toBe(0);
  });

  it(`cap 을 넘으면 오래된 것부터 버린다(기본 ${CHAT_KEEP}개)`, () => {
    const start = Array.from({ length: CHAT_KEEP }, (_, i) => msg(i + 1));
    const r = mergeMessages(start, [msg(CHAT_KEEP + 1), msg(CHAT_KEEP + 2)]);
    expect(r.messages).toHaveLength(CHAT_KEEP);
    expect(r.messages[0].id).toBe(3);
    expect(r.messages[CHAT_KEEP - 1].id).toBe(CHAT_KEEP + 2);
    expect(r.added).toBe(2);
  });

  it('added 는 남은 새 메시지만 센다 — 상한 밖으로 밀려난 옛 메시지는 안 읽음이 될 수 없다', () => {
    const r = mergeMessages([msg(10), msg(11)], [msg(1), msg(2), msg(12)], 3);
    expect(ids(r.messages)).toEqual([10, 11, 12]);
    expect(r.added).toBe(1);
  });

  it('입력 배열을 바꾸지 않는다(불변)', () => {
    const list = [msg(1)];
    const incoming = [msg(2)];
    mergeMessages(list, incoming);
    expect(ids(list)).toEqual([1]);
    expect(ids(incoming)).toEqual([2]);
  });
});
