'use strict';
// 권한 · 다운로드 · 클라이언트 인증서(설계 §5.7 체크리스트 5). Electron 은 처리기가 없으면 권한을 모두 허락하고 다운로드를 받는다
// — 그래서 허용은 목록으로, 나머지는 거부로 둔다. 권한은 app://twelvejanggi 의 notifications · clipboard-sanitized-write 만 허용한다.
// request 처리기와 check 처리기가 같은 isPermissionAllowed 를 쓴다:
// - request 는 details.requestingUrl(전체 URL — 'app://twelvejanggi/tray.html')을 준다.
// - check 는 webContents 가 null 일 수 있고, requestingOrigin(끝에 '/' 가 붙은 출처 — 'app://twelvejanggi/')만 줄 수 있다.
// 어느 쪽이든 isAppUrl 이 출처를 정확히 가른다(app://twelvejanggi.evil · 대문자 호스트는 거부). 판정은 순수 함수가 먼저 내고,
// 처리기는 그 결과를 callback 에 넘긴 뒤에 기록한다. denyDownload · selectNoCertificate 는 결정(preventDefault)을 먼저 내고
// 그 뒤에 callback 을 부른다.
// 이 파일은 electron 을 require 하지 않는다. 아래 @typedef 는 Electron 타입의 구조적 부분집합이다.

const { isAppUrl } = require('./appProtocol.cjs');

/**
 * 앱이 쓸 수 있는 권한 — 알림, 그리고 새니타이즈된 클립보드 쓰기. 그 밖은 요청해도 · 확인해도 거부다.
 * @type {readonly string[]}
 */
const ALLOWED_PERMISSIONS = Object.freeze(['notifications', 'clipboard-sanitized-write']);

/**
 * Electron Event 중 이 모듈이 쓰는 부분(구조 타입).
 * @typedef {object} CancelableEventLike
 * @property {() => void} preventDefault
 */
/**
 * 권한 질의. 요청한 쪽을 가리키는 값(requestingUrl · requestingOrigin)은 주어진 것이 모두 앱이어야 한다.
 * @typedef {object} PermissionQuery
 * @property {string} permission 권한 이름('notifications' 등)
 * @property {string} [requestingUrl] request 처리기의 details.requestingUrl — 요청한 프레임이 마지막으로 불러온 URL
 * @property {string} [requestingOrigin] check 처리기의 requestingOrigin — 끝에 '/' 가 붙은 출처
 */

/**
 * 이 권한을 이 요청자에게 허락해도 되는가. 허용 목록의 권한이고, 요청자가 app://twelvejanggi 일 때만 true 다.
 * 요청자를 가리키는 값이 하나도 없거나, 하나라도 앱이 아니면(서로 어긋나는 경우 포함) 거부한다.
 * @param {PermissionQuery} query
 * @returns {boolean}
 */
function isPermissionAllowed({ permission, requestingUrl, requestingOrigin }) {
  if (typeof permission !== 'string' || !ALLOWED_PERMISSIONS.includes(permission)) return false;
  /** @type {unknown[]} */
  const claims = [];
  if (requestingUrl !== undefined) claims.push(requestingUrl);
  if (requestingOrigin !== undefined) claims.push(requestingOrigin);
  return claims.length > 0 && claims.every((claim) => typeof claim === 'string' && isAppUrl(claim));
}

/**
 * session 'will-download' 처리기 — 트레이는 다운로드하지 않는다. 뒤따르는 인자(item · webContents · frame)는 쓰지 않는다.
 * @param {CancelableEventLike} event
 * @returns {void}
 */
function denyDownload(event) {
  event.preventDefault();
}

/**
 * app 'select-client-certificate' 처리기 — 인증서 없이 진행한다. preventDefault 로 '저장소의 첫 인증서 자동 선택'을 막고,
 * 마지막 인자 callback 을 인자 없이 불러 선택하지 않은 채 연결을 잇는다. 결정(preventDefault)이 callback 보다 먼저다.
 * 리스너 인자는 (event, webContents, url, certificateList, callback) 이다.
 * @param {CancelableEventLike} event
 * @param {...unknown} rest
 * @returns {void}
 */
function selectNoCertificate(event, ...rest) {
  event.preventDefault();
  const callback = rest[rest.length - 1];
  if (typeof callback === 'function') callback();
}

module.exports = { ALLOWED_PERMISSIONS, isPermissionAllowed, denyDownload, selectNoCertificate };
