// 웹 · 트레이 공용 테마 도우미 계약 — 저장 키 · 색 · 읽기/쓰기/적용이 던지지 않고, 읽힐 때 부작용이 없다.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_COLOR, THEME_KEY, THEMES, applyTheme, isTheme, readStoredTheme, storeTheme } from './theme';

const require = createRequire(import.meta.url);
const { THEME_BACKGROUND } = require('../../desktop/lib/theme.cjs') as { THEME_BACKGROUND: Record<string, string> };

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('상수', () => {
  it('THEME_COLOR 는 index.css 다크 · 라이트 --bg 이고 desktop THEME_BACKGROUND 와 같다', () => {
    const css = read('../index.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const dark = /:root\s*\{[^}]*?--bg:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1];
    const light = /:root\[data-theme='light'\]\s*\{[^}]*?--bg:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1];
    expect(THEME_COLOR).toEqual({ dark, light });
    expect(THEME_COLOR).toEqual(THEME_BACKGROUND);
  });

  it('키와 목록', () => {
    expect(THEME_KEY).toBe('tj_theme');
    expect([...THEMES]).toEqual(['dark', 'light']);
    expect(isTheme('light')).toBe(true);
    expect(isTheme('x')).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it("index.html 인라인 스크립트는 'tj_theme' 을 읽고 light · dark 만 받고 라이트 색을 쓴다", () => {
    const html = read('../../index.html');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script).toContain("'tj_theme'");
    expect(script).toContain("'light'");
    expect(script).toContain("'dark'");
    expect(script).toContain(THEME_COLOR.light);
  });
});

describe('readStoredTheme', () => {
  it('저장값을 읽고 틀리면 dark', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'tj_theme' ? 'light' : null) });
    expect(readStoredTheme()).toBe('light');
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'tj_theme' ? 'x' : 'light') });
    expect(readStoredTheme()).toBe('dark');
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(readStoredTheme()).toBe('dark');
  });

  it('getItem 이 던지거나 localStorage 가 없어도 dark', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readStoredTheme()).toBe('dark');
    vi.unstubAllGlobals();
    expect(typeof localStorage).toBe('undefined');
    expect(readStoredTheme()).toBe('dark');
  });
});

describe('storeTheme', () => {
  it('키로 저장한다', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    storeTheme('light');
    expect(setItem).toHaveBeenCalledWith('tj_theme', 'light');
  });

  it('setItem 이 던져도 던지지 않는다', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => storeTheme('light')).not.toThrow();
  });
});

describe('applyTheme', () => {
  it('document 가 없으면 아무것도 하지 않는다', () => {
    expect(typeof document).toBe('undefined');
    expect(() => applyTheme('light')).not.toThrow();
  });

  it('document 가 있으면 dataset.theme 과 meta theme-color 를 바꾼다', () => {
    const meta = { setAttribute: vi.fn() };
    const dataset: Record<string, string> = {};
    vi.stubGlobal('document', {
      documentElement: { dataset },
      querySelector: (sel: string) => (sel === 'meta[name="theme-color"]' ? meta : null),
    });
    applyTheme('light');
    expect(dataset.theme).toBe('light');
    expect(meta.setAttribute).toHaveBeenLastCalledWith('content', '#f5f6f8');
    applyTheme('dark');
    expect(dataset.theme).toBe('dark');
    expect(meta.setAttribute).toHaveBeenLastCalledWith('content', '#0d1117');
  });

  it('meta 가 없어도 던지지 않는다', () => {
    const dataset: Record<string, string> = {};
    vi.stubGlobal('document', { documentElement: { dataset }, querySelector: () => null });
    expect(() => applyTheme('light')).not.toThrow();
    expect(dataset.theme).toBe('light');
  });
});

describe('최상위 부작용', () => {
  it('가져오기만으로 document · localStorage 를 건드리지 않는다', async () => {
    let docReads = 0;
    let lsReads = 0;
    vi.stubGlobal('document', {
      get documentElement() {
        docReads++;
        return { dataset: {} };
      },
      get body() {
        docReads++;
        return {};
      },
      querySelector() {
        docReads++;
        return null;
      },
    });
    vi.stubGlobal('localStorage', {
      get getItem() {
        lsReads++;
        return () => null;
      },
      get setItem() {
        lsReads++;
        return () => undefined;
      },
    });
    vi.resetModules();
    await import('./theme');
    expect(docReads).toBe(0);
    expect(lsReads).toBe(0);
  });
});
