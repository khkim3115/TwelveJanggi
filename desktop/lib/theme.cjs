'use strict';
// 테마 이름과 창 배경색(설계 §5.1 theme.cjs) — 순수 모듈이다. main 은 창을 만들 때 THEME_BACKGROUND 로 첫 페인트 전 배경을 칠하고,
// IPC 로 받은 값은 normalizeTheme 로 거른다. 배경색은 src/index.css 의 --bg 와 같아야 한다(theme.test.ts 가 대조한다).

/** 받는 테마 이름. */
const THEMES = Object.freeze(['dark', 'light']);

/** 테마별 창 배경색 — src/index.css 의 `:root --bg` · `:root[data-theme='light'] --bg` 와 같다. */
const THEME_BACKGROUND = Object.freeze({ dark: '#0d1117', light: '#f5f6f8' });

/**
 * 테마 이름을 거른다. null 은 '받지 않는다' 는 뜻이다 — IPC 는 무시하고 설정은 기본값을 쓴다.
 * @param {unknown} value
 * @returns {'dark' | 'light' | null}
 */
function normalizeTheme(value) {
  return value === 'dark' || value === 'light' ? value : null;
}

module.exports = { THEMES, THEME_BACKGROUND, normalizeTheme };
