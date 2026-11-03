'use strict';
// 트레이 팝업을 언제 숨기고, 트레이 클릭을 어떻게 받을지 정하는 순수 정책(설계 §5.1 windowPolicy) — main.js 는 창 · 트레이 이벤트를
// 이 함수들에 연결만 한다. 시각(now · shownAt · lastBlurHideAt)은 main 이 단조 시계(performance.now())로 재서 넘긴다
// — 이 파일은 시계를 읽지 않는다. electron 을 require 하지 않는다.
// - blur: 보인 직후 300ms 안의 blur 는 숨김 사유로 보지 않는다(창이 막 뜰 때 따라오는 blur — 실행 직후가 대표적이다). 삼킨 blur
//   뒤에는 blur 가 다시 오지 않으므로, main 이 유예가 끝난 때 deferredBlurAction 으로 한 번 더 본다.
// - 트레이 클릭: 열린 팝업의 아이콘을 누르면 blur 로 팝업이 먼저 숨고 곧이어 click 이 온다. 그 click 이 팝업을 다시 열지 않게,
//   바깥 클릭(blur)으로 숨긴 뒤 250ms 안의 클릭은 무시한다. 이 가드는 트레이 좌클릭에만 건다.
//   250ms 는 'blur 와 click 이 모두 버튼을 누를 때 온다' 는 소스 추론에 기댄다 — 실제 순서는 손 확인이다(설계 §8).

/** 보인 직후 이 시간(ms) 안에 온 blur 는 숨기지 않는다. */
const BLUR_GRACE_MS = 300;
/** blur 로 숨긴 뒤 이 시간(ms) 안의 트레이 클릭은 무시한다. */
const CLICK_RACE_MS = 250;

/**
 * blur 가 왔을 때 팝업을 숨겨야 하는가. 다음이면 숨기지 않는다: 이미 안 보임(숨김이 일으킨 blur) · 고정 · DevTools 열림 ·
 * 보인 지 300ms 이하(경계 포함 — 300 까지가 유예 안이고 그보다 크면 숨긴다).
 * @param {{ now: number, shownAt: number, pinned: boolean, devToolsOpen: boolean, visible: boolean }} state
 *   now 는 지금, shownAt 은 마지막으로 보인 때(같은 시계, ms)
 * @returns {boolean}
 */
function shouldHideOnBlur({ now, shownAt, pinned, devToolsOpen, visible }) {
  if (!visible || pinned || devToolsOpen) return false;
  return now - shownAt > BLUR_GRACE_MS;
}

/**
 * 유예 안의 blur 를 삼킨 뒤, 유예가 끝난 때 팝업을 숨겨야 하는가. 그 뒤에도 보이고 · 포커스가 없고 · 고정이 아니고 ·
 * DevTools 가 닫혀 있으면 'hide' 다. 삼킨 blur 뒤에는 blur 가 다시 오지 않아서, 이것이 없으면 바깥 클릭으로 숨지 않고
 * Esc 도 닿지 않는 팝업이 남는다.
 * @param {{ visible: boolean, focused: boolean, pinned: boolean, devToolsOpen: boolean }} state
 * @returns {'hide' | 'none'}
 */
function deferredBlurAction({ visible, focused, pinned, devToolsOpen }) {
  return visible && !focused && !pinned && !devToolsOpen ? 'hide' : 'none';
}

/**
 * 트레이 좌클릭이 무엇을 해야 하는가. 보이면 'hide'(토글), 바깥 클릭(blur)으로 숨긴 지 250ms 안이면 'ignore'(같은 클릭이 낳은
 * click 이다), 그 밖은 'show' 다. lastBlurHideAt 은 blur 로 숨긴 때만 기록한다 — Esc · ✕ · 토글 · 메뉴로 숨긴 것은 기록하지
 * 않아서, 그 직후의 아이콘 클릭은 삼켜지지 않는다. 기록이 없으면 -Infinity 다.
 * @param {{ now: number, visible: boolean, lastBlurHideAt: number }} state
 * @returns {'hide' | 'show' | 'ignore'}
 */
function trayClickAction({ now, visible, lastBlurHideAt }) {
  if (visible) return 'hide';
  if (now - lastBlurHideAt < CLICK_RACE_MS) return 'ignore';
  return 'show';
}

module.exports = { BLUR_GRACE_MS, CLICK_RACE_MS, shouldHideOnBlur, deferredBlurAction, trayClickAction };
