// desktop/lib/consoleLine.cjs 시험 — 개발 콘솔 중계 줄(설계 §5.1 consoleLine.cjs). 터미널을 건드리는 제어 문자는 날것으로 나가지 않는다.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { consoleLine } = require('./consoleLine.cjs') as typeof import('./consoleLine.cjs');

const line = (over: Record<string, unknown> = {}) =>
  consoleLine({ level: 'info', message: 'm', sourceId: 's', lineNumber: 1, ...over } as Parameters<typeof consoleLine>[0]);
/** 탭을 뺀 C0 · DEL · C1 이 하나라도 있으면 true */
const hasRawControl = (s: string) => /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(s);

describe('정상', () => {
  it('형식', () => {
    expect(
      consoleLine({ level: 'error', message: 'x', sourceId: 'app://twelvejanggi/assets/a.js', lineNumber: 12 }),
    ).toBe('[tray:error] x (app://twelvejanggi/assets/a.js:12)');
  });
  it('탭은 그대로 둔다', () => {
    expect(line({ message: 'a\tb' })).toBe('[tray:info] a\tb (s:1)');
  });
});

describe('제어 문자', () => {
  it.each([
    ['ESC[2J', '\u001b[2J', '\\u001b[2J'],
    ['OSC 52', '\u001b]52;c;eA==\u0007', '\\u001b]52;c;eA==\\u0007'],
    ['CR', '\r', '\\u000d'],
    ['LF 뒤 가짜 줄', '\n[tj] x', '\\u000a[tj] x'],
    ['C1 CSI', '\u009b', '\\u009b'],
    ['DEL', '\u007f', '\\u007f'],
  ])('%s 는 \\uXXXX 로', (_name, raw, escaped) => {
    const out = line({ message: raw });
    expect(hasRawControl(out)).toBe(false);
    expect(out).toBe(`[tray:info] ${escaped} (s:1)`);
  });
  it('sourceId 의 제어 문자도 바꾼다', () => {
    const out = line({ sourceId: 'a\u001b]52;c;x\u0007\nb' });
    expect(hasRawControl(out)).toBe(false);
    expect(out).not.toContain('\n');
  });
  it('level 에 제어 문자가 있어도 info 가 된다', () => {
    expect(line({ level: 'error\n[tj]' })).toBe('[tray:info] m (s:1)');
  });
});

describe('level', () => {
  it.each(['info', 'warning', 'error', 'debug'])('%s 는 그대로', (level) => {
    expect(line({ level })).toBe(`[tray:${level}] m (s:1)`);
  });
  it.each(['verbose', '', 'ERROR', undefined, 3, null])('모르는 값 %j → info', (level) => {
    expect(line({ level })).toBe('[tray:info] m (s:1)');
  });
});

describe('자르기', () => {
  it('message 500자는 그대로, 501자는 500자 + …', () => {
    expect(line({ message: 'a'.repeat(500) })).toBe(`[tray:info] ${'a'.repeat(500)} (s:1)`);
    expect(line({ message: 'a'.repeat(501) })).toBe(`[tray:info] ${'a'.repeat(500)}… (s:1)`);
  });
  it('sourceId 200자는 그대로, 201자는 200자 + …', () => {
    expect(line({ sourceId: 's'.repeat(200) })).toBe(`[tray:info] m (${'s'.repeat(200)}:1)`);
    expect(line({ sourceId: 's'.repeat(201) })).toBe(`[tray:info] m (${'s'.repeat(200)}…:1)`);
  });
});

describe('믿을 수 없는 입력', () => {
  it('글자가 아닌 message · sourceId · lineNumber 도 던지지 않고 한 줄을 낸다', () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol('x')]) {
      const out = line({ message: bad, sourceId: bad, lineNumber: bad });
      expect(out.startsWith('[tray:info] ')).toBe(true);
      expect(hasRawControl(out)).toBe(false);
    }
  });
  it('lineNumber 가 글자여도 제어 문자는 나가지 않는다', () => {
    expect(hasRawControl(line({ lineNumber: '\u001b[2J' }))).toBe(false);
  });
});
