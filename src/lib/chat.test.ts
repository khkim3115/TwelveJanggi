import { describe, expect, it } from 'vitest';
import { CHAT_KEEP, CHAT_MAX_LEN, appendCapped, sanitizeChatText, toChatMessage } from './chat';
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

describe('toChatMessage (받은 payload 검증)', () => {
  const good = { userId: 'u1', displayName: '녹', text: '안녕', ts: 1 };

  it('정상 payload 는 그대로', () => {
    expect(toChatMessage(good)).toEqual(good);
  });

  it('모양이 다르면 버린다 — 문자열이 아닌 text 를 그리면 화면이 죽는다', () => {
    expect(toChatMessage(null)).toBeNull();
    expect(toChatMessage('hi')).toBeNull();
    expect(toChatMessage({ ...good, text: { evil: true } })).toBeNull();
    expect(toChatMessage({ ...good, userId: 3 })).toBeNull();
    expect(toChatMessage({ ...good, ts: 'now' })).toBeNull();
    expect(toChatMessage({ ...good, ts: Number.NaN })).toBeNull();
    expect(toChatMessage({ ...good, text: '   ' })).toBeNull();
  });

  it('보낸 쪽이 규칙을 어겨도 길이는 다시 자른다', () => {
    const m = toChatMessage({ ...good, displayName: '가'.repeat(40), text: 'x'.repeat(CHAT_MAX_LEN + 1) });
    expect(m?.displayName).toHaveLength(24);
    expect(m?.text).toHaveLength(CHAT_MAX_LEN);
  });

  it('빈 이름은 익명', () => {
    expect(toChatMessage({ ...good, displayName: '  ' })?.displayName).toBe('익명');
  });
});

describe('appendCapped (메모리 무한 증가 방지)', () => {
  const msg = (i: number): ChatMessage => ({
    userId: 'u',
    displayName: 'n',
    text: `m${i}`,
    ts: i,
  });

  it('항목을 끝에 추가한다', () => {
    const out = appendCapped([msg(1)], msg(2));
    expect(out.map((m) => m.text)).toEqual(['m1', 'm2']);
  });

  it('원본 배열을 변형하지 않는다(불변)', () => {
    const base = [msg(1)];
    appendCapped(base, msg(2));
    expect(base).toHaveLength(1);
  });

  it(`기본으로 최근 ${CHAT_KEEP}개만 유지한다`, () => {
    let list: ChatMessage[] = [];
    for (let i = 0; i < CHAT_KEEP + 20; i++) list = appendCapped(list, msg(i));
    expect(list).toHaveLength(CHAT_KEEP);
    // 가장 오래된 것이 버려지고 최신이 끝에 남는다.
    expect(list[0].ts).toBe(20);
    expect(list[CHAT_KEEP - 1].ts).toBe(CHAT_KEEP + 19);
  });

  it('cap 을 직접 지정할 수 있다', () => {
    const out = appendCapped([msg(1), msg(2), msg(3)], msg(4), 2);
    expect(out.map((m) => m.text)).toEqual(['m3', 'm4']);
  });
});
