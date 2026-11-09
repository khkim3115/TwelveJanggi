'use strict';
// 트레이 팝업을 언제 숨기고, 트레이 클릭을 어떻게 받을지 정하는 순수 정책(설계 §5.1 windowPolicy) — main.js 는 창 · 트레이 이벤트를
// 이 함수들에 연결만 한다. 시각(now · shownAt · lastBlurHideAt)은 main 이 단조 시계(performance.now())로 재서 넘긴다
// — 이 파일은 시계를 읽지 않는다. electron 을 require 하지 않는다.
// - blur: 보인 직후 300ms 안의 blur 는 숨김 사유로 보지 않는다(창이 막 뜰 때 따라오는 blur — 실행 직후가 대표적이다). 삼킨 blur
//   뒤에는 blur 가 다시 오지 않으므로, main 이 유예가 끝난 때 deferredBlurAction 으로 한 번 더 본다.
// - 트레이 클릭: 열린 팝업의 아이콘을 누르면 blur 로 팝업이 먼저 숨고 곧이어 click 이 온다. 그 click 이 팝업을 다시 열지 않게,
//   바깥 클릭(blur)으로 숨긴 뒤 250ms 안의 클릭은 무시한다. 이 가드는 트레이 좌클릭에만 건다.
//   250ms 는 'blur 와 click 이 모두 버튼을 누를 때 온다' 는 소스 추론에 기댄다 — 실제 순서는 손 확인이다(설계 §8).
// - 트레이 더블클릭: 직전 좌클릭이 창을 보였을 때만 다시 보인다 — 둘째 누름의 blur 가 막 연 창을 숨기지 않게(trayDoubleClickAction).

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

/**
 * 트레이 더블클릭이 창을 다시 보여야 하는가. 직전 좌클릭이 창을 보였을 때('show')만 'show' 이고, 그 밖은 'none' 이다.
 * Windows 의 실제 사건 순서(손 확인 기록)가 근거다. 둘째 누름에는 click 이 오지 않고 double-click 만 온다.
 * - 숨긴 팝업: click(보임) → 둘째 누름에 작업표시줄이 활성화를 가져가 blur → 5–7ms 뒤 double-click. 그 blur 는 유예 안이면 미룬 확인으로,
 *   유예 밖이면 곧바로 창을 숨긴다. 그래서 double-click 이 다시 보여 포커스를 되찾는다.
 * - 열린 팝업: click(토글로 숨김 'hide', 또는 blur 가 먼저 숨겨 무시 'ignore') → double-click. 닫힌 채 둔다.
 * 시간 임계값을 두지 않는다 — Windows 는 더블클릭 시간 안에서만 double-click 을 내므로 직전 좌클릭은 늘 그 더블클릭의 첫 누름이다. '유예
 * 300ms 안' 으로 좁히면 300ms 를 넘는 느린 더블클릭에 같은 증상이 남는다.
 * @param {{ lastClickAction: 'hide' | 'show' | 'ignore' | null }} state lastClickAction 은 직전 좌클릭의 trayClickAction 결과 — 없으면 null
 * @returns {'show' | 'none'}
 */
function trayDoubleClickAction({ lastClickAction }) {
  return lastClickAction === 'show' ? 'show' : 'none';
}

module.exports = { BLUR_GRACE_MS, CLICK_RACE_MS, shouldHideOnBlur, deferredBlurAction, trayClickAction, trayDoubleClickAction };
