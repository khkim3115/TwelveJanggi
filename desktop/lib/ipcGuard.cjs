'use strict';
// IPC 발신자 검증(설계 §5.7 · 체크리스트 17) — 신뢰하는 것은 트레이 창의 메인 프레임에서 온 메시지뿐이다.
// 모든 IPC 처리기는 createGuardedIpc 의 handle/on 으로만 등록한다(main.js 에 ipcMain.handle/on 을 직접 쓰지 않는다 — main.js 시험이 본다).
// - 거부하는 쪽으로 기운다: 읽다가 던져도(파괴된 프레임의 url · origin 을 읽으면 던진다) 신뢰하지 않는다. isTrustedSender 는 던지지 않는다
//   — on 처리기가 던지면 메인 프로세스의 uncaughtException 이 된다.
// - 출처는 프로토콜 · 호스트 문자열(frame.origin === APP_ORIGIN)로 비교한다. Node 의 URL.origin 은 app: 에서 'null' 이라 쓰지 않는다.
// 이 파일은 electron 을 require 하지 않는다. 아래 @typedef 는 Electron 타입의 구조적 부분집합이다 — JSDoc 이 electron 의 타입을
// 직접 가리키면 desktop/node_modules 가 있을 때 루트 검사가 진짜 Electron 타입을 끌어와 시험의 가짜 객체가 타입 검사를 넘지 못한다.

const { APP_ORIGIN, isAppUrl } = require('./appProtocol.cjs');

/**
 * WebFrameMain 중 이 모듈이 읽는 부분(구조 타입).
 * @typedef {object} FrameLike
 * @property {boolean} detached 프레임 트리에서 떨어졌다(unload 처리기가 도는 동안 새 페이지가 그 자리를 차지했을 때)
 * @property {string} url 프레임이 마지막으로 불러온 URL
 * @property {string} origin RFC 6454 로 직렬화한 출처 — 표준 스킴 app 은 'app://twelvejanggi', 출처가 없는(불투명) 문서는 'null'
 */
/**
 * WebContents 중 이 모듈이 읽는 부분(구조 타입).
 * @typedef {object} WebContentsLike
 * @property {FrameLike} mainFrame 최상위 프레임
 */
/**
 * IpcMainEvent · IpcMainInvokeEvent 중 이 모듈이 읽는 부분(구조 타입).
 * @typedef {object} IpcEventLike
 * @property {FrameLike | null} senderFrame 보낸 프레임. 탐색 · 파괴 뒤에 읽으면 null 이거나 바뀌어 있을 수 있다
 * @property {WebContentsLike} sender 보낸 webContents
 */
/**
 * ipcMain 중 이 모듈이 쓰는 두 등록 함수(구조 타입).
 * @typedef {object} IpcMainLike
 * @property {(channel: string, listener: (event: IpcEventLike, ...args: any[]) => unknown) => unknown} handle
 * @property {(channel: string, listener: (event: IpcEventLike, ...args: any[]) => void) => unknown} on
 */
/**
 * createGuardedIpc 가 돌려주는 등록 창구.
 * @typedef {object} GuardedIpc
 * @property {(channel: string, fn: (event: IpcEventLike, ...args: any[]) => unknown) => void} handle invoke 처리기 — 거부하면 던진다
 * @property {(channel: string, fn: (event: IpcEventLike, ...args: any[]) => void) => void} on send 처리기 — 거부하면 무시한다
 */

/**
 * 이 메시지의 보낸 이를 신뢰하는가. 던지지 않는다.
 * senderFrame 은 한 번만 읽어 그 지역 변수로 모두 판정한다(읽을 때마다 바뀌거나 null 이 될 수 있다).
 * 거부: senderFrame 이 null · detached / 신뢰할 창이 없거나 event.sender 가 그 창이 아님 / 서브프레임(그 창의 메인 프레임이 아님) /
 * 출처가 APP_ORIGIN 이 아님('null' 포함) / url 이 app://twelvejanggi 의 주소가 아님.
 * @param {IpcEventLike} event
 * @param {WebContentsLike | null | undefined} trustedWebContents 트레이 창의 webContents. 아직 없으면(창을 만들기 전) undefined
 * @returns {boolean}
 */
function isTrustedSender(event, trustedWebContents) {
  try {
    const frame = event.senderFrame;
    if (!frame || frame.detached) return false;
    const sender = event.sender;
    // 신뢰할 창이 없으면(창을 만들기 전 · 닫은 뒤) 곧바로 거부한다 — sender 도 없을 때 undefined === undefined 로 통과하지 않는다.
    if (!trustedWebContents || sender !== trustedWebContents) return false;
    if (frame !== sender.mainFrame) return false;
    return frame.origin === APP_ORIGIN && isAppUrl(frame.url);
  } catch {
    return false;
  }
}

/**
 * ipcMain 위에 발신자 검증을 얹은 등록 창구. 신뢰할 창은 등록 때가 아니라 메시지마다 getTrustedWebContents() 로 다시 묻는다
 * — 처리기는 loadURL 전에 등록하고 트레이 창은 그 사이에 만들어지거나 닫힐 수 있다.
 * 결정(신뢰 여부)을 먼저 내고, 신뢰할 때만 fn 을 부른다.
 * @param {IpcMainLike} ipcMain
 * @param {() => WebContentsLike | null | undefined} getTrustedWebContents
 * @returns {GuardedIpc}
 */
function createGuardedIpc(ipcMain, getTrustedWebContents) {
  /**
   * @param {IpcEventLike} event
   * @returns {boolean}
   */
  const isTrusted = (event) => {
    try {
      return isTrustedSender(event, getTrustedWebContents());
    } catch {
      return false; // 신뢰할 창을 얻다가 던져도 거부다
    }
  };
  return {
    handle(channel, fn) {
      ipcMain.handle(channel, (event, ...args) => {
        // 던지면 렌더러의 invoke 가 거부된다(Electron 은 message 만 넘긴다).
        if (!isTrusted(event)) throw new Error('허용되지 않은 IPC 발신자');
        return fn(event, ...args);
      });
    },
    on(channel, fn) {
      ipcMain.on(channel, (event, ...args) => {
        if (!isTrusted(event)) return; // 조용히 무시한다 — 던지면 메인 프로세스의 uncaughtException 이 된다
        fn(event, ...args);
      });
    },
  };
}

module.exports = { isTrustedSender, createGuardedIpc };
