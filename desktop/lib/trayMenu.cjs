'use strict';
// 트레이 우클릭 메뉴 템플릿 — electron 없이 객체 배열만 만든다(설계 §5.1 trayMenu.cjs). Menu.buildFromTemplate 는 main 이 부른다.
// 체크박스 click 은 item.checked 를 '원하는 값' 으로 쓴다: Electron 은 click 전에 checked 를 이미 뒤집어 두므로 그 값이
// 사용자가 본 상자를 누른 결과다. 메뉴를 그린 뒤 상태가 바뀌었어도 사용자가 본 것과 반대로 가지 않는다.

/** 메뉴 라벨 한 표. */
const TRAY_LABELS = Object.freeze({
  open: '열기',
  solo: '혼자 하기',
  online: '온라인 대전',
  autostart: '자동 실행',
  light: '라이트 모드',
  pin: '창 고정',
  reset: '위치 초기화',
  web: '웹에서 열기',
  feedback: '의견 보내기',
  quit: '종료',
});

/**
 * 맨 위 버전 줄.
 * @param {string} version
 * @returns {string}
 */
function titleLabel(version) {
  return `십이장기 ${version}`;
}

/**
 * @typedef {object} TrayMenuState
 * @property {string} platform process.platform 값
 * @property {string} version
 * @property {{ checked: boolean, enabled: boolean }} autostart enabled = 로그인 항목을 관리할 수 있다
 * @property {boolean} light
 * @property {boolean} pinned
 * @property {boolean} hasCustomPosition
 *
 * @typedef {object} TrayMenuActions
 * @property {() => void} open
 * @property {() => void} solo
 * @property {() => void} online
 * @property {(on: boolean) => void} setAutostart
 * @property {(on: boolean) => void} setLight
 * @property {(on: boolean) => void} setPinned
 * @property {() => void} resetPosition
 * @property {() => void} openWeb
 * @property {() => void} sendFeedback
 * @property {() => void} quit
 */

/**
 * 메뉴 템플릿. Windows 는 '열기' 가 없다(아이콘 클릭이 열기다). macOS · linux 는 버전 줄 바로 아래에 '열기'.
 * @param {TrayMenuState} state
 * @param {TrayMenuActions} actions
 * @returns {Array<Record<string, unknown>>}
 */
function buildTrayMenuTemplate(state, actions) {
  /** @type {Array<Record<string, unknown>>} */
  const template = [{ label: titleLabel(state.version), enabled: false }];
  if (state.platform !== 'win32') template.push({ label: TRAY_LABELS.open, click: () => actions.open() });
  template.push(
    { type: 'separator' },
    { label: TRAY_LABELS.solo, click: () => actions.solo() },
    { label: TRAY_LABELS.online, click: () => actions.online() },
    { type: 'separator' },
    {
      label: TRAY_LABELS.autostart,
      type: 'checkbox',
      checked: state.autostart.checked,
      enabled: state.autostart.enabled,
      click: (/** @type {{ checked: boolean }} */ item) => actions.setAutostart(item.checked),
    },
    {
      label: TRAY_LABELS.light,
      type: 'checkbox',
      checked: state.light,
      click: (/** @type {{ checked: boolean }} */ item) => actions.setLight(item.checked),
    },
    {
      label: TRAY_LABELS.pin,
      type: 'checkbox',
      checked: state.pinned,
      click: (/** @type {{ checked: boolean }} */ item) => actions.setPinned(item.checked),
    },
    { label: TRAY_LABELS.reset, enabled: state.hasCustomPosition, click: () => actions.resetPosition() },
    { type: 'separator' },
    { label: TRAY_LABELS.web, click: () => actions.openWeb() },
    { label: TRAY_LABELS.feedback, click: () => actions.sendFeedback() },
    { type: 'separator' },
    { label: TRAY_LABELS.quit, click: () => actions.quit() },
  );
  return template;
}

module.exports = { TRAY_LABELS, titleLabel, buildTrayMenuTemplate };
