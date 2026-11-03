// desktop/lib/layout.cjs 시험 — 트레이 창의 레이아웃 키와 콘텐츠 크기(설계 §5.1).
// 크기는 지금 셋 모두 340×400 자리표시다 — #24 · #25 가 실측으로 바꾸면 아래 '자리표시' 시험 한 곳만 함께 고친다.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { LAYOUT_KEYS, LAYOUTS, layoutSize, normalizeLayout } = require('./layout.cjs') as typeof import('./layout.cjs');

describe('LAYOUT_KEYS · LAYOUTS', () => {
  it('키는 solo · online · online-chat 순서이고 얼려 있다', () => {
    expect(LAYOUT_KEYS).toStrictEqual(['solo', 'online', 'online-chat']);
    expect(Object.isFrozen(LAYOUT_KEYS)).toBe(true);
  });

  it('LAYOUTS 는 같은 키를 같은 순서로 갖고, 표와 그 값이 모두 얼려 있다', () => {
    expect(Object.keys(LAYOUTS)).toStrictEqual([...LAYOUT_KEYS]);
    expect(Object.isFrozen(LAYOUTS)).toBe(true);
    for (const key of LAYOUT_KEYS) expect(Object.isFrozen(LAYOUTS[key]), key).toBe(true);
  });

  it.each(LAYOUT_KEYS)('%s 의 크기는 폭 · 높이만 갖는 양의 정수다', (key) => {
    const { width, height } = LAYOUTS[key];
    expect(Object.keys(LAYOUTS[key])).toStrictEqual(['width', 'height']);
    expect(Number.isInteger(width) && width > 0, `width ${width}`).toBe(true);
    expect(Number.isInteger(height) && height > 0, `height ${height}`).toBe(true);
  });

  it('자리표시 — 셋 모두 340×400 이다(#24 · #25 가 실측으로 바꾼다)', () => {
    for (const key of LAYOUT_KEYS) expect(LAYOUTS[key], key).toStrictEqual({ width: 340, height: 400 });
  });
});

describe('normalizeLayout', () => {
  it.each(LAYOUT_KEYS)('%s → 그대로', (key) => {
    expect(normalizeLayout(key)).toBe(key);
  });

  it.each([
    'Solo', // 대소문자 그대로 본다
    'SOLO',
    'Online-Chat',
    'solo ',
    ' solo',
    'online_chat',
    'online-chat-extra',
    'chat',
    '',
    '__proto__', // 표의 프로토타입 이름은 키가 아니다
    'constructor',
    'toString',
    'hasOwnProperty',
  ])('모르는 키 %j → null', (key) => {
    expect(normalizeLayout(key)).toBeNull();
  });

  it('문자열이 아니면 null — 배열 · 문자열로 바뀌는 객체도 통과하지 못한다', () => {
    for (const value of [undefined, null, 5, 0, true, {}, ['solo'], { toString: () => 'solo' }, Symbol('solo')]) {
      expect(normalizeLayout(value), String(typeof value)).toBeNull();
    }
  });
});

describe('layoutSize', () => {
  it.each(LAYOUT_KEYS)('%s → 표와 같은 폭 · 높이', (key) => {
    expect(layoutSize(key)).toStrictEqual(LAYOUTS[key]);
  });

  it('호출마다 새 복사본이다 — 고쳐도 표와 다음 호출은 그대로다', () => {
    const first = layoutSize('solo');
    expect(first).not.toBe(LAYOUTS.solo);
    expect(layoutSize('solo')).not.toBe(first);
    first.width = 1;
    first.height = 2;
    expect(layoutSize('solo')).toStrictEqual({ width: 340, height: 400 });
    expect(LAYOUTS.solo).toStrictEqual({ width: 340, height: 400 });
  });

  it('값은 양의 정수 340×400 이다', () => {
    const { width, height } = layoutSize('solo');
    expect(Number.isInteger(width) && width > 0).toBe(true);
    expect(Number.isInteger(height) && height > 0).toBe(true);
    expect([width, height]).toStrictEqual([340, 400]);
  });

  it('모르는 키는 크기를 지어내지 않고 던진다 — 먼저 normalizeLayout 으로 거른다', () => {
    for (const key of ['Solo', '', '__proto__', 'constructor', undefined, 5]) {
      expect(() => layoutSize(key as unknown as 'solo'), String(key)).toThrow(RangeError);
    }
  });
});
