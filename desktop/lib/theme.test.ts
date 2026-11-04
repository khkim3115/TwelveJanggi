// desktop/lib/theme.cjs 시험 — 테마 이름 정규화와 창 배경색(설계 §5.1 theme.cjs).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { THEMES, THEME_BACKGROUND, normalizeTheme } = require('./theme.cjs') as typeof import('./theme.cjs');

describe('normalizeTheme', () => {
  it("'dark' · 'light' 는 그대로 돌려준다", () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('light')).toBe('light');
  });

  it.each(['Dark', 'LIGHT', '', ' dark', 'purple', null, undefined, 1, true, {}, [], ['dark']])('%j 는 받지 않는다(null)', (v) => {
    expect(normalizeTheme(v)).toBeNull();
  });
});

describe('THEMES · THEME_BACKGROUND', () => {
  it('값이 고정이고 얼려 있다', () => {
    expect(THEMES).toStrictEqual(['dark', 'light']);
    expect(THEME_BACKGROUND).toStrictEqual({ dark: '#0d1117', light: '#f5f6f8' });
    expect(Object.isFrozen(THEMES)).toBe(true);
    expect(Object.isFrozen(THEME_BACKGROUND)).toBe(true);
  });

  // src/index.css 의 두 --bg 와 같아야 첫 페인트 전 창 배경과 화면이 어긋나지 않는다.
  it("src/index.css 의 :root --bg · :root[data-theme='light'] --bg 와 같다", () => {
    const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const bgOf = (selectorSource: string): string | undefined =>
      new RegExp(`(?:^|\\})\\s*${selectorSource}\\s*\\{([^}]*)\\}`).exec(css)?.[1]?.match(/--bg:\s*([^;\s]+)\s*;/)?.[1];
    expect(bgOf(':root')).toBe(THEME_BACKGROUND.dark);
    expect(bgOf(String.raw`:root\[data-theme='light'\]`)).toBe(THEME_BACKGROUND.light);
  });
});
