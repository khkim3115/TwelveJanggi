'use strict';
// 트레이 창의 webPreferences 공장(설계 §5.5) — main.js 의 실제 창과 스모크가 이 함수 하나에서만 만든다. 그래서 둘이 바이트까지 같다.
// 인자는 preload 경로 하나뿐이다: 스모크 모드를 가르는 입력이 없다. additionalArguments 는 쓰지 않는다 — 비어 있지 않으면
// 44.x/45 의 spare renderer 를 쓸 수 없어 스모크만 다른 시작 경로를 탄다. 이 파일은 electron 을 require 하지 않는다.

/**
 * 트레이 창의 webPreferences. 호출마다 새 객체를 낸다.
 * @param {string} preloadPath preload 스크립트의 절대 경로(path.join(__dirname, 'preload.js'))
 * @returns {{ preload: string, contextIsolation: true, sandbox: true, nodeIntegration: false }}
 */
function trayWindowPreferences(preloadPath) {
  return { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false };
}

module.exports = { trayWindowPreferences };
