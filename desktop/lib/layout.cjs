'use strict';
// 트레이 창의 레이아웃 키와 콘텐츠 크기(설계 §5.1 layout) — main.js 가 창을 만들 때(solo)와 렌더러가 레이아웃을 바꿀 때
// (tj-set-layout) 같은 표를 쓴다. 크기는 콘텐츠 크기다(useContentSize). electron 을 require 하지 않는다.
// 값은 지금 셋 모두 자리표시 340×400 이다 — #24 · #25 가 실측으로 바꾼다(그때 layout.test.ts 의 '자리표시' 시험도 함께 고친다).

/** @typedef {import('./position.cjs').Size} Size */
/** @typedef {'solo' | 'online' | 'online-chat'} LayoutKey */

/**
 * 레이아웃 키 — 이 순서가 계약이다. 표(LAYOUTS)와 IPC 가 받는 값의 목록이 모두 이것이다.
 * @type {readonly LayoutKey[]}
 */
const LAYOUT_KEYS = Object.freeze(['solo', 'online', 'online-chat']);

/**
 * 키별 콘텐츠 크기. 표도 값도 얼려 있다.
 * @type {Readonly<Record<LayoutKey, Readonly<Size>>>}
 */
const LAYOUTS = Object.freeze({
  solo: Object.freeze({ width: 340, height: 400 }),
  online: Object.freeze({ width: 340, height: 400 }),
  'online-chat': Object.freeze({ width: 340, height: 400 }),
});

/**
 * 받아도 되는 레이아웃 키면 그 키를, 아니면 null(IPC 는 무시한다). 대소문자 그대로 보고, 문자열이 아닌 값은 모두 null 이다
 * — 목록과 === 로만 견주므로 표의 프로토타입 이름('constructor' 등)도 키가 아니다.
 * @param {unknown} key
 * @returns {LayoutKey | null}
 */
function normalizeLayout(key) {
  return LAYOUT_KEYS.find((candidate) => candidate === key) ?? null;
}

/**
 * 레이아웃의 콘텐츠 크기 — 호출마다 새 복사본이다(고쳐도 표는 그대로). 모르는 키는 크기를 지어내지 않고 던진다:
 * 바깥에서 온 값은 먼저 normalizeLayout 으로 거른다.
 * @param {LayoutKey} key
 * @returns {Size}
 * @throws {RangeError} 모르는 키
 */
function layoutSize(key) {
  const layout = normalizeLayout(key);
  if (layout === null) throw new RangeError(`모르는 레이아웃 키: ${String(key)}`);
  const { width, height } = LAYOUTS[layout];
  return { width, height };
}

module.exports = { LAYOUT_KEYS, LAYOUTS, normalizeLayout, layoutSize };
