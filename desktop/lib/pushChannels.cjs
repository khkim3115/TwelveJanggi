'use strict';
// main→렌더러로 미는 채널과 getState() 스냅샷의 필드를 한 표로 묶는다(설계 §5.1 pushChannels.cjs).
// 규칙: 미는 채널은 모두 스냅샷에 필드가 있다. 구독보다 먼저 온 send 는 사라지므로(Electron) 늦게 붙은 렌더러도 스냅샷으로 같은 상태를 얻는다.

/** 채널 → 스냅샷 필드. */
const PUSH_CHANNELS = Object.freeze({
  'tj-theme': 'theme',
  'tj-opacity': 'opacity',
  'tj-mode': 'mode',
  'tj-shown': 'visible',
  'tj-hidden': 'visible',
});

/**
 * getState() 가 돌려줄 스냅샷 — main 메모리의 값이다(창 getter 가 아니다). visible 은 main 의 shownIntent 다.
 * @param {{ settings: import('./settings.cjs').Settings, mode: string, visible: boolean }} input
 * @returns {{ theme: string, opacity: number, mode: string, visible: boolean }}
 */
function buildSnapshot({ settings, mode, visible }) {
  return { theme: settings.theme, opacity: settings.opacity, mode, visible };
}

module.exports = { PUSH_CHANNELS, buildSnapshot };
