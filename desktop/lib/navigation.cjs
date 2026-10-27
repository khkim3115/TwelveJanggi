'use strict';
// 탐색 · 새 창 · webview 가드(설계 §5.7 체크리스트 13 · 14 · 15). main.js 가 'web-contents-created' 에서 모든 webContents 에 건다.
// 규칙은 하나다: app://twelvejanggi 밖으로 가는 탐색은 막고, 허용 목록(links.cjs) 주소만 시스템 브라우저로 연다.
// - will-frame-navigate 가 먼저 막으면 will-navigate 는 오지 않아 한 번만 열린다. 새 창(setWindowOpenHandler)은 늘 deny 이고,
//   허용 목록 주소는 setImmediate 뒤에 연다. will-attach-webview 는 늘 막는다.
// - open 은 주입받는다. 실제는 shell.openExternal(href).catch(), 스모크는 기록기다. record 는 선택이고 결정마다 한 번 불린다.
// - fail-closed 순서: 막는 결정(preventDefault · deny)을 먼저 내고 그 뒤에 record · open 을 부른다. 콜백이 던져도 차단은 이미
//   걸려 있고, 던진 오류는 다음 tick 에 다시 던져 묻히지 않게 한다. 던진 setWindowOpenHandler 가 deny 로 이어진다는 보장이 없어서
//   windowOpen 은 콜백이 던져도 · 이상한 details 가 와도 던지지 않고 deny 를 돌려준다.
// 이 파일은 electron 을 require 하지 않는다. 아래 @typedef 는 Electron 타입의 구조적 부분집합이다.

const { isAppUrl } = require('./appProtocol.cjs');
const { externalHref } = require('./links.cjs');

/**
 * Electron Event 중 이 모듈이 쓰는 부분(구조 타입).
 * @typedef {object} CancelableEventLike
 * @property {() => void} preventDefault
 */
/**
 * will-navigate · will-frame-navigate · will-redirect 가 주는 Event(구조 타입). 위치 인자(url 등)는 deprecated 라 쓰지 않는다.
 * @typedef {CancelableEventLike & { url: string }} NavigationEventLike
 */
/**
 * setWindowOpenHandler 가 받는 HandlerDetails 중 쓰는 부분(구조 타입).
 * @typedef {object} WindowOpenDetailsLike
 * @property {string} url 창 열기 요청이 가리키는 주소(해석된 절대 URL)
 */
/**
 * 결정 기록 한 건 — record 가 결정마다 한 번 받는다(스모크가 읽는다).
 * @typedef {object} NavigationRecord
 * @property {'will-navigate' | 'will-frame-navigate' | 'will-redirect' | 'window-open' | 'will-attach-webview'} kind 어느 처리기의 결정인가
 * @property {string} url 대상 주소(문자열이 아니면 ''). will-attach-webview 는 params.src
 * @property {boolean} blocked 막았다 — 탐색은 preventDefault, 새 창 · webview 는 deny. 앱 안(app://twelvejanggi) 탐색만 false
 * @property {string | null} href 시스템 브라우저로 여는 값(허용 목록을 통과한 정규화 href). 열지 않는 결정은 null
 */

/**
 * 콜백을 부른다. 던지면 다음 tick 에 다시 던진다 — 호출한 처리기는 이미 낸 결정을 그대로 끝낸다.
 * @template T
 * @param {(arg: T) => unknown} callback
 * @param {T} arg
 * @returns {void}
 */
function settle(callback, arg) {
  try {
    callback(arg);
  } catch (err) {
    setImmediate(() => {
      throw err;
    });
  }
}

/**
 * 탐색 가드 한 벌. 처리기는 this 를 쓰지 않으므로 contents.on('will-navigate', guards.willNavigate) 처럼 떼어 써도 된다.
 * @param {{ open: (href: string) => unknown, record?: (entry: NavigationRecord) => unknown }} hooks
 *   open 은 허용 목록 주소를 시스템 브라우저로 여는 함수, record 는 결정 기록기(없어도 된다)
 */
function createNavigationGuards({ open, record }) {
  /** @param {NavigationRecord} entry */
  const note = (entry) => {
    if (typeof record === 'function') settle(record, entry);
  };

  /**
   * will-navigate · will-frame-navigate · will-redirect 는 같은 규칙이다. 앱 안이면 두고, 밖이면 막은 뒤 허용 목록이면 연다.
   * @param {'will-navigate' | 'will-frame-navigate' | 'will-redirect'} kind
   * @returns {(e: NavigationEventLike) => void}
   */
  const navigationGuard = (kind) => (e) => {
    const url = typeof e.url === 'string' ? e.url : '';
    if (isAppUrl(url)) {
      note({ kind, url, blocked: false, href: null });
      return;
    }
    e.preventDefault(); // 결정을 먼저 — 아래 record · open 이 던져도 차단은 걸려 있다
    const href = externalHref(url);
    note({ kind, url, blocked: true, href });
    if (href !== null) settle(open, href);
  };

  /**
   * setWindowOpenHandler 처리기 — 새 창은 늘 만들지 않는다(앱 주소도). 허용 목록 주소는 다음 tick 에 시스템 브라우저로 연다.
   * @param {WindowOpenDetailsLike} details
   * @returns {{ action: 'deny' }}
   */
  function windowOpen(details) {
    const url = typeof details?.url === 'string' ? details.url : '';
    const href = externalHref(url);
    if (href !== null) setImmediate(() => open(href));
    note({ kind: 'window-open', url, blocked: true, href });
    return { action: 'deny' };
  }

  /**
   * will-attach-webview 처리기 — webview 는 쓰지 않으므로 늘 막는다(guest 페이지가 파괴된다). 열지도 않는다.
   * Electron 은 (event, webPreferences, params) 로 부른다. params.src 는 기록에만 쓴다.
   * @param {CancelableEventLike} e
   * @param {unknown} [_webPreferences]
   * @param {Record<string, string>} [params]
   * @returns {void}
   */
  function willAttachWebview(e, _webPreferences, params) {
    e.preventDefault();
    const src = params?.src;
    note({ kind: 'will-attach-webview', url: typeof src === 'string' ? src : '', blocked: true, href: null });
  }

  return {
    willNavigate: navigationGuard('will-navigate'),
    willFrameNavigate: navigationGuard('will-frame-navigate'),
    willRedirect: navigationGuard('will-redirect'),
    windowOpen,
    willAttachWebview,
  };
}

module.exports = { createNavigationGuards };
