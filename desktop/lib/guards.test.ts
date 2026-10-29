// desktop/lib/guards.cjs 시험 — 믿을 수 없는 입력(result.json · 위반 이벤트 · tray-build.json)을 읽는 모듈들이 같이 쓰는 값 가드.
// 세 함수가 한 곳에 있어야 판정기(smokeResult)와 평가기(smokeChecks)와 파서(trayBuildInfo)가 '객체' · '비어 있지 않은 문자열' ·
// '표시할 수 있는 값' 을 같은 말로 정한다 — 복사본이 어긋나면 한쪽은 통과시키고 한쪽은 막는 틈이 생긴다.
// 그 모듈들은 각자의 시험으로 행동을 본다. 여기는 도우미 자체의 계약(경계값 · 던지지 않음)을 본다. electron 은 import 하지 않는다.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isNonEmptyString, isRecord, repr } = require('./guards.cjs') as typeof import('./guards.cjs');

describe('isRecord', () => {
  it('객체이면 참이다 — 빈 객체 · 키가 있는 객체 · 프로토타입이 없는 객체 · 클래스 인스턴스', () => {
    class Point {
      x = 1;
    }
    for (const value of [{}, { a: 1 }, Object.create(null), new Point()]) expect(isRecord(value)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['빈 배열', []],
    ['객체가 든 배열', [{ a: 1 }]],
    ['문자열', 'object'],
    ['숫자', 1],
    ['true', true],
    ['함수', () => ({})],
    ['심볼', Symbol('x')],
    ['BigInt', 1n],
  ])('객체가 아니면 거짓이다: %s', (_name, value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe('isNonEmptyString', () => {
  it('길이가 1 이상인 문자열이면 참이다 — 공백뿐인 글 · "0" · "false" 도 비어 있지 않다', () => {
    for (const value of ['a', ' ', '\n', '0', 'false']) expect(isNonEmptyString(value)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['빈 문자열', ''],
    ['undefined', undefined],
    ['null', null],
    ['숫자 0', 0],
    ['숫자 1', 1],
    ['false', false],
    ['String 객체', new String('a')],
    ['글자 배열', ['a']],
    ['빈 객체', {}],
  ])('아니면 거짓이다: %s', (_name, value) => {
    expect(isNonEmptyString(value)).toBe(false);
  });
});

describe('repr', () => {
  it('JSON 으로 쓴다 — 문자열은 따옴표가 붙어 "0" 과 0, "true" 와 true 가 구별된다', () => {
    expect(repr('0', 100)).toBe('"0"');
    expect(repr(0, 100)).toBe('0');
    expect(repr('true', 100)).toBe('"true"');
    expect(repr(true, 100)).toBe('true');
    expect(repr(null, 100)).toBe('null');
    expect(repr('', 100)).toBe('""');
    expect(repr([], 100)).toBe('[]');
    expect(repr({}, 100)).toBe('{}');
    expect(repr({ a: [1, 'x'], b: null }, 100)).toBe('{"a":[1,"x"],"b":null}');
  });

  it('JSON 이 되지 못하는 값은 String() 으로 쓴다 — undefined · 함수 · 심볼 · BigInt · 순환 객체 · toJSON 이 던지는 객체', () => {
    expect(repr(undefined, 100)).toBe('undefined');
    const fn = (): number => 1;
    expect(repr(fn, 100)).toBe(String(fn)); // 함수 글은 변환기가 다듬을 수 있어 String() 의 결과와 견준다
    expect(repr(Symbol('s'), 100)).toBe('Symbol(s)');
    expect(repr(10n, 100)).toBe('10');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(repr(loop, 100)).toBe('[object Object]');
    expect(
      repr(
        {
          toJSON() {
            throw new Error('toJSON 이 던진다');
          },
        },
        100,
      ),
    ).toBe('[object Object]');
  });

  it('JSON 도 String() 도 못 하는 값은 자리 표시 문구를 낸다 — 프로토타입 없는 순환 객체 · 던지는 Proxy · 닫힌 Proxy · toString 이 던지는 객체', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.self = bare; // 순환이라 JSON 이 못 하고, toString 이 없어 String() 도 못 한다
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('읽을 수 없다');
        },
      },
    );
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const hostile = {
      toJSON() {
        throw new Error('toJSON 이 던진다');
      },
      toString() {
        throw new Error('toString 이 던진다');
      },
    };
    for (const value of [bare, throwing, revocable.proxy, hostile]) expect(repr(value, 100)).toBe('(표시할 수 없는 값)');
  });

  it('어떤 값에도 던지지 않고 문자열을 돌려준다', () => {
    const values: unknown[] = [undefined, null, 0, -0, NaN, Infinity, '', 'x', true, [], {}];
    values.push(() => 1, Symbol('s'), 10n, new Date(0), /re/u, new Error('e'));
    for (const value of values) {
      let text: unknown;
      expect(() => {
        text = repr(value, 50);
      }).not.toThrow();
      expect(typeof text).toBe('string');
    }
  });

  it('maxChars 를 넘으면 그 글자 수까지만 남기고 … 를 붙인다 — 경계: 같으면 그대로, 하나 넘으면 줄인다', () => {
    // 문자열은 JSON 이라 따옴표 두 글자가 붙는다 — 'a' 8개는 10자다.
    expect(repr('a'.repeat(8), 10)).toBe(`"${'a'.repeat(8)}"`);
    expect(repr('a'.repeat(9), 10)).toBe(`"${'a'.repeat(9)}…`);
    // 숫자 · 배열도 JSON 글 길이로 잰다.
    expect(repr([1, 2, 3], 7)).toBe('[1,2,3]');
    expect(repr([1, 2, 3], 6)).toBe('[1,2,3…');
  });

  it('상한은 부르는 쪽이 정한다 — 같은 값도 상한에 따라 다르게 줄어든다', () => {
    const long = 'x'.repeat(500);
    expect(repr(long, 120)).toHaveLength(121); // 120자 + …
    expect(repr(long, 200)).toHaveLength(201); // 200자 + …
    expect(repr(long, 600)).toBe(JSON.stringify(long)); // 상한 안이면 그대로
  });

  it('JSON 이 못 한 값을 String() 으로 쓴 글도 줄인다', () => {
    const digits = '9'.repeat(300);
    expect(repr(BigInt(digits), 100)).toBe(`${'9'.repeat(100)}…`);
  });

  it('상한과 같거나 짧은 값은 줄이지 않는다 — JSON 글도 String() 글도 같다', () => {
    expect(repr(null, 4)).toBe('null'); // JSON 글 4자
    expect(repr(undefined, 9)).toBe('undefined'); // String() 글 9자
  });
});
