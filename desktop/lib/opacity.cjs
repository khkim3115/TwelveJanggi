'use strict';
// 창 투명도 범위와 정규화(설계 §5.1 opacity.cjs) — 순수 모듈이다. 슬라이더 값(IPC)과 저장된 설정이 같은 말로 거른다.

/** 이보다 투명하면 창이 보이지 않아 되돌릴 수 없다. */
const MIN_OPACITY = 30;
const MAX_OPACITY = 100;
const DEFAULT_OPACITY = 100;

/**
 * 투명도를 거른다 — 유한한 숫자만 받아 반올림한 뒤 30–100 으로 자른다. 그 밖(문자열 · NaN · ±Infinity · null …)은 null 이다.
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeOpacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round(value)));
}

module.exports = { MIN_OPACITY, MAX_OPACITY, DEFAULT_OPACITY, normalizeOpacity };
