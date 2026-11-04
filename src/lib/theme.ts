// 웹 · 트레이 화면이 함께 쓰는 테마 도우미. 최상위 부작용이 없다 — 불러오기만으로 document · localStorage 를 건드리지 않는다.
// 호출하는 쪽(gameStore 의 모듈 로드 등)이 읽기와 적용을 부른다.

export type Theme = 'dark' | 'light';

/** 받는 테마 이름. */
export const THEMES: readonly Theme[] = ['dark', 'light'];

/** localStorage 키. index.html 의 인라인 스크립트도 같은 키를 읽는다. */
export const THEME_KEY = 'tj_theme';

/** 테마별 배경색 — src/index.css 의 `--bg` · 모바일 주소창(meta theme-color) · desktop/lib/theme.cjs 의 THEME_BACKGROUND 와 같다. */
export const THEME_COLOR: Readonly<Record<Theme, string>> = { dark: '#0d1117', light: '#f5f6f8' };

export function isTheme(v: unknown): v is Theme {
  return v === 'dark' || v === 'light';
}

/** 저장된 테마. 없거나 틀리거나 저장소를 못 읽으면 'dark'. */
export function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : 'dark';
  } catch {
    return 'dark';
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 저장 불가(사생활 모드 등) — 이번 세션에만 적용.
  }
}

/** 테마 적용. index.html 의 인라인 스크립트가 첫 페인트 전에 같은 일을 한 번 해 둔다(깜빡임 방지). */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  // 모바일 주소창 색도 따라간다.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}
