'use strict';
// 로그인 항목(자동 실행) 인자 · 판별 — 플랫폼 갈래를 값으로 받는 순수 모듈(설계 §5.1 autostart.cjs 표).
// main.js 가 app.setLoginItemSettings / getLoginItemSettings 에 넘길 인자를 여기서 만들고, 읽은 결과의 해석도 여기서 한다.
// - Windows 의 openAtLogin 은 AUMID 이름의 값과 명령줄(args)이 글자까지 같을 때만 true 다 → 읽을 때도 같은 args 로 묻는다(loginItemQuery).
// - enabled: true 로 set 하면 작업 관리자에서 끈 것을 되살린다 → 사용자가 메뉴에서 켤 때와 첫 실행 기본값 때만 set 한다(main 의 몫).
// 이 모듈은 electron 을 require 하지 않는다. 시각 · 플랫폼 · 경로는 모두 인자다.

const path = require('node:path');

/** AUMID 와 같은 값 — main.js 의 setAppUserModelId 도 이 상수를 쓴다. */
const AUTOSTART_NAME = 'com.khkim.twelvejanggi';
/** 로그인으로 시작했을 때 창 없이 트레이에만 뜨게 하는 인자. */
const HIDDEN_ARG = '--hidden';

/**
 * argv 에 정확히 '--hidden' 인 원소가 있는가. '--hidden=1' · '--HIDDEN' 은 아니다.
 * 패키지가 아니어도 판별한다 — 개발 실행 `-- --hidden` 으로 숨긴 채 시작하는 경로를 확인하려는 것이다(로그인 항목은 건드리지 않는다).
 * @param {readonly string[]} argv
 * @returns {boolean}
 */
function hasHiddenArg(argv) {
  return argv.includes(HIDDEN_ARG);
}

/**
 * app.getLoginItemSettings 에 넘길 질의. Windows 는 등록 때와 같은 args 로 물어야 true 가 나온다.
 * @param {string} platform process.platform 값
 * @returns {{ args?: string[] }}
 */
function loginItemQuery(platform) {
  return platform === 'win32' ? { args: [HIDDEN_ARG] } : {};
}

/**
 * app.setLoginItemSettings 에 넘길 인자. linux · 그 밖은 부르지 않으므로 null 이다.
 * @param {string} platform
 * @param {boolean} on
 * @returns {{ openAtLogin: boolean, name?: string, args?: string[], enabled?: boolean } | null}
 */
function loginItemSettings(platform, on) {
  if (platform === 'win32') return { openAtLogin: on, name: AUTOSTART_NAME, args: [HIDDEN_ARG], enabled: true };
  if (platform === 'darwin') return { openAtLogin: on };
  return null;
}

/**
 * 메뉴의 '자동 실행' 체크 상태. Windows 는 OS 가 원본(실행 파일 경로 + StartupApproved), macOS 는 설정에 적어 둔 값이다.
 * @param {{ platform: string, loginItem: { executableWillLaunchAtLogin?: boolean }, settings: { autostart: boolean } }} input
 * @returns {boolean}
 */
function autostartChecked({ platform, loginItem, settings }) {
  if (platform === 'win32') return loginItem.executableWillLaunchAtLogin === true;
  if (platform === 'darwin') return settings.autostart === true; // macOS 미확인
  return false;
}

/**
 * 로그인으로 시작됐는가(창을 숨긴 채 뜰지 정하는 근거).
 * @param {{ platform: string, argv: readonly string[], loginItem: { wasOpenedAtLogin?: boolean } }} input
 * @returns {boolean}
 */
function launchedAtLogin({ platform, argv, loginItem }) {
  if (platform === 'win32') return hasHiddenArg(argv);
  if (platform === 'darwin') return loginItem.wasOpenedAtLogin === true; // macOS 미확인
  return false;
}

/**
 * 첫 실행에 자동 실행을 기본으로 켜는가 — Windows 만.
 * @param {string} platform
 * @returns {boolean}
 */
function firstRunAutostart(platform) {
  return platform === 'win32';
}

/**
 * 이 실행이 로그인 항목을 관리해도 되는가 — 패키지된 앱이고, 스모크가 아니고, win32 · darwin 이고,
 * 실행 파일이 electron 개발 바이너리가 아닐 때만. ELECTRON_FORCE_IS_PACKAGED 로 개발 바이너리를 패키지로 속여도 쓰지 않는다.
 * 실행 파일 이름은 path.win32 로 자른다 — '\' 와 '/' 를 모두 자르므로 호스트(ubuntu CI)와 무관하게 같은 결과다.
 * @param {{ isPackaged: boolean, smoke: boolean, platform: string, execPath: string }} input
 * @returns {boolean}
 */
function canManageLoginItems({ isPackaged, smoke, platform, execPath }) {
  if (!isPackaged || smoke) return false;
  if (platform !== 'win32' && platform !== 'darwin') return false;
  const exe = path.win32.basename(execPath).toLowerCase();
  return exe !== 'electron' && exe !== 'electron.exe';
}

module.exports = {
  AUTOSTART_NAME,
  HIDDEN_ARG,
  hasHiddenArg,
  loginItemQuery,
  loginItemSettings,
  autostartChecked,
  launchedAtLogin,
  firstRunAutostart,
  canManageLoginItems,
};
