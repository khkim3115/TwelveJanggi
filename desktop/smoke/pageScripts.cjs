'use strict';
// 스모크가 페이지에서 돌리는 코드(설계 §5.10) — 실행기(run.cjs)와 능동 검사(active.cjs)가 executeJavaScript(main world)로 보내고, preload 의
// 격리 world 는 executeJavaScriptInIsolatedWorld 로 읽는다. 코드는 글이라 타입 검사 밖이다 — 작게 두고, 밖에서 넣는 값은 JSON 으로만 넣는다.
// main world 코드는 모두 태그 주석(/* tj-smoke:<이름> <인자 JSON> */)으로 시작한다. 페이지는 주석을 무시하고, 단위 시험의 가짜 페이지
// (desktop/lib/smokeRig.ts)는 이 주석으로 코드를 가르고 인자를 읽는다 — 코드 본문을 해석하지 않는다.
// 페이지 쪽 실패(fetch 거부 · 권한 API 의 예외)는 던지지 않고 값으로 돌려준다 — 판정은 실행기가 한다.
// electron 을 require 하지 않는다.

const { POLL_MS, WAIT_MS } = require('./support.cjs');

/**
 * 태그 주석을 붙인 페이지 코드. 인자는 주석에 JSON 으로 싣는다(코드 본문에는 따로 넣는다). 주석을 닫는 글이 들면 던진다.
 * @param {string} name
 * @param {string} code
 * @param {unknown} [arg]
 * @returns {string}
 */
function tagged(name, code, arg) {
  const json = arg === undefined ? '' : ` ${JSON.stringify(arg)}`;
  if (json.includes('*/')) throw new Error(`페이지 코드 ${name} 의 인자에 주석을 닫는 글이 있다`);
  return `/* tj-smoke:${name}${json} */ ${code}`;
}

/**
 * 장벽의 페이지 쪽 — 브리지로 getAppInfo 를 왕복한 뒤 표식을 콘솔에 찍고 AppInfo 를 돌려준다.
 * @param {string} marker
 * @returns {string}
 */
function barrierScript(marker) {
  return tagged('barrier', `window.tjDesktop.getAppInfo().then((info) => { console.info(${JSON.stringify(marker)}); return info; })`, marker);
}

/**
 * boot 의 페이지 쪽 사실 — 제목 줄의 버전은 getAppInfo 가 풀린 뒤 React 가 그리므로, 기대한 버전이 보일 때까지 WAIT_MS 까지 기다린 뒤 읽는다.
 * @param {string | null} version getAppInfo().version
 * @returns {string}
 */
function bootScript(version) {
  return tagged(
    'boot',
    `(async () => {
    const expected = ${JSON.stringify(version)};
    const shown = () => document.querySelector('.tapp-version')?.textContent ?? null;
    const deadline = Date.now() + ${WAIT_MS};
    while (shown() !== expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, ${POLL_MS}));
    const root = document.getElementById('root');
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      rootChildren: root === null ? -1 : root.childElementCount,
      title: document.querySelector('.tapp-title')?.textContent ?? null,
      version: shown(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bgToken: rootStyle.getPropertyValue('--bg').trim(),
      colorScheme: rootStyle.colorScheme,
    };
  })()`,
    version,
  );
}

/** main world 에서 보이면 안 되는 것 — preload 의 격리 world 전역 둘과 Node 의 require · process. */
const MAIN_WORLD_SCRIPT = tagged(
  'main-world',
  `({
  isoProbe: typeof globalThis.__tjIsoProbe,
  cspBuffer: typeof globalThis.__tjCspBuffer,
  require: typeof globalThis.require,
  process: typeof globalThis.process,
})`,
);
/** 페이지가 보안 경고를 스스로 끄지 않았는가(main world). */
const DISABLE_WARNINGS_SCRIPT = tagged('disable-warnings', 'Boolean(window.ELECTRON_DISABLE_SECURITY_WARNINGS)');
/** 브리지의 키와 계약 상수(src/tray/smoke.ts 의 bridge()). */
const BRIDGE_SCRIPT = tagged('bridge', 'window.__tjTraySmoke.bridge()');
/** 화면이 두 프레임을 그릴 때까지(최대 1초) 기다린다 — 창을 보인 직후의 capturePage 가 빈 화면을 받지 않게. 그렸으면 true. */
const FRAMES_SCRIPT = tagged(
  'frames',
  `new Promise((resolve) => {
  setTimeout(() => resolve(false), 1000);
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
})`,
);

/**
 * 테마 한 단계의 페이지 쪽(창 검사 theme) — theme 이 있으면 브리지로 setTheme(theme) 을 보내고(값은 고치지 않는다 — 'purple' 도. 거르는
 * 것은 main 이다), null 이면(메뉴를 누른 뒤) 보내지 않는다. 그다음 getState() 를 왕복한다 — 순서 장벽이다(앞의 send 와 main 이 민 tj-theme 가
 * 응답보다 먼저 처리된다). 장벽 뒤의 스냅샷 · <html data-theme> · --bg 토큰 · body 배경(계산값) · 저장값(localStorage.tj_theme)을 돌려준다.
 * @param {string | null} theme
 * @returns {string}
 */
function themeScript(theme) {
  const request = theme === null ? '' : `window.tjDesktop.setTheme(${JSON.stringify(theme)});\n  `;
  return tagged(
    'theme',
    `(async () => {
  ${request}const snapshot = await window.tjDesktop.getState();
  const root = document.documentElement;
  let stored;
  try {
    stored = localStorage.getItem('tj_theme');
  } catch (err) {
    stored = 'error: ' + String(err);
  }
  return {
    snapshot,
    dataTheme: root.dataset.theme ?? null,
    bgToken: getComputedStyle(root).getPropertyValue('--bg').trim(),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    stored,
  };
})()`,
    theme,
  );
}

/**
 * 투명도 한 줄의 페이지 쪽(창 검사 opacity) — 브리지로 setOpacity(value) 를 보낸 뒤(값은 고치지 않는다 — '70' · null 도) getState() 를 왕복하고
 * (순서 장벽) 그 스냅샷을 돌려준다. NaN 은 JSON 이 null 로 바꾸므로 코드 안에서 만든다 — 태그의 인자는 표식 { nan: true } 이고(가짜 페이지가
 * 읽는다), 그 밖은 { value } 다. value 는 JSON 으로 쓸 수 있는 값이거나 NaN 이다(실행기의 투명도 표).
 * @param {unknown} value
 * @returns {string}
 */
function opacityScript(value) {
  const nan = typeof value === 'number' && Number.isNaN(value);
  return tagged(
    'opacity',
    `(async () => {
  window.tjDesktop.setOpacity(${nan ? 'Number.NaN' : JSON.stringify(value)});
  return window.tjDesktop.getState();
})()`,
    nan ? { nan: true } : { value },
  );
}

/**
 * Esc 한 단계의 페이지 쪽(창 검사 escHide) — 페이지가 만든 Escape keydown 을 #root 안 요소에서 보낸다(bubbles — 렌더러가 window 에 건 캡처 ·
 * 버블 리스너에 닿는다. 실제 키 경로는 손으로 본다, 설계 §5.5). dialog 갈래: 'open' 은 aria-modal="true" 요소를 넣은 채, 'closes' 는 그 요소와
 * 그것을 동기로 지우는 #root keydown 리스너와 함께(React 커밋 대신 — 버블 길에서 window 보다 먼저 돈다), 'none' 은 요소 없이 보낸다. 보낸 뒤
 * 넣은 요소 · 리스너를 치우고 getState() 를 왕복한다(순서 장벽 — 렌더러가 보낸 tj-hide 가 그 응답보다 먼저 처리된다). 보낼 때 aria-modal 요소가
 * 있었는지(dialog) · #root 리스너가 돌았는지(ran) · 그 요소가 지워졌는지(removed) · 스냅샷을 돌려준다.
 * @param {'open' | 'closes' | 'none'} dialog
 * @returns {string}
 */
function escScript(dialog) {
  return tagged(
    'esc',
    `(async () => {
  const mode = ${JSON.stringify(dialog)};
  const root = document.getElementById('root');
  const target = root?.firstElementChild ?? root ?? document.body;
  const modal = mode === 'none' ? null : document.createElement('div');
  if (modal !== null) {
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('data-tj-smoke', 'dialog');
    document.body.append(modal);
  }
  let ran = false;
  const close = () => {
    ran = true;
    modal?.remove();
  };
  if (mode === 'closes') root?.addEventListener('keydown', close);
  const dialogAtStart = document.querySelector('[aria-modal="true"]') !== null;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  root?.removeEventListener('keydown', close);
  const removed = modal !== null && !modal.isConnected;
  modal?.remove();
  return { dialog: dialogAtStart, ran, removed, snapshot: await window.tjDesktop.getState() };
})()`,
    dialog,
  );
}

/**
 * ✕(숨기기) 클릭의 페이지 쪽(창 검사 visibility ①) — 진짜 단추(button[aria-label="숨기기"])를 누르고(렌더러의 onClick → tjDesktop.hide())
 * getState() 를 왕복한다(순서 장벽). 단추가 있었는지(found)와 스냅샷.
 */
const HIDE_BUTTON_SCRIPT = tagged(
  'hide-button',
  `(async () => {
  const button = document.querySelector('button[aria-label="숨기기"]');
  if (button === null) return { found: false, snapshot: null };
  button.click();
  return { found: true, snapshot: await window.tjDesktop.getState() };
})()`,
);
/** <html> 의 숨김 클래스(tapp-hidden — 렌더러가 tj-hidden · tj-shown 으로 단다)와 document.visibilityState(창 검사 visibility). */
const HIDDEN_STATE_SCRIPT = tagged(
  'hidden-state',
  `({ hiddenClass: document.documentElement.classList.contains('tapp-hidden'), visibilityState: document.visibilityState })`,
);

/** preload 의 격리 world — Electron 이 contextIsolation 에 쓰는 world 번호. */
const ISOLATED_WORLD_ID = 999;
/** 격리 world 의 표식과 CSP 위반 버퍼(preload 의 __tjIsoProbe · __tjCspBuffer). */
const ISOLATED_BUFFER_CODE = '({ probe: globalThis.__tjIsoProbe, buf: globalThis.__tjCspBuffer })';

/**
 * 문서의 CSP meta 들 — http-equiv 가 Content-Security-Policy(대소문자 무시)인 meta 의 content 와 <head> 안에 있는지.
 */
const CSP_META_SCRIPT = tagged(
  'csp-meta',
  `(() => {
  const metas = [...document.querySelectorAll('meta[http-equiv]')].filter((meta) => meta.httpEquiv.toLowerCase() === 'content-security-policy');
  return { contents: metas.map((meta) => meta.content), inHead: metas.map((meta) => meta.parentElement === document.head) };
})()`,
);

/**
 * 같은 출처 fetch 로 받은 응답 헤더 — 주소마다 { url, status, csp, nosniff, contentType } 이거나 { url, error }.
 * @param {readonly string[]} urls
 * @returns {string}
 */
function headersScript(urls) {
  return tagged(
    'csp-header',
    `Promise.all(${JSON.stringify(urls)}.map(async (url) => {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const header = (name) => response.headers.get(name);
    return { url, status: response.status, csp: header('content-security-policy'), nosniff: header('x-content-type-options'), contentType: header('content-type') };
  } catch (err) {
    return { url, error: String(err) };
  }
}))`,
    urls,
  );
}

/**
 * 같은 출처 fetch 의 상태 — 요청마다 { url, method, status } 이거나 { url, method, error }.
 * @param {readonly { url: string, method: string }[]} requests
 * @returns {string}
 */
function protocolScript(requests) {
  return tagged(
    'protocol',
    `Promise.all(${JSON.stringify(requests)}.map(async ({ url, method }) => {
  try {
    const response = await fetch(url, { method, cache: 'no-store' });
    return { url, method, status: response.status };
  } catch (err) {
    return { url, method, error: String(err) };
  }
}))`,
    requests,
  );
}

/** AI 한 수(src/tray/smoke.ts 의 ai() — 스스로 10초에 끊는다). */
const AI_SCRIPT = tagged('ai', 'window.__tjTraySmoke.ai()');

/**
 * 새 창을 연다 — window.open 이 null 을 돌려줬으면(창을 만들지 않았다) true.
 * @param {string} url
 * @returns {string}
 */
function windowOpenScript(url) {
  return tagged('window-open', `window.open(${JSON.stringify(url)}) === null`, url);
}

/**
 * 메인 프레임을 url 로 탐색시킨다. 탐색은 비동기다 — 막혔는지는 main 의 결정 기록과 그 탐색의 끝(did-stop-loading)으로 본다.
 * @param {string} url
 * @returns {string}
 */
function navigateScript(url) {
  return tagged('navigate', `(() => { location.href = ${JSON.stringify(url)}; return true; })()`, url);
}

/** 지금 문서의 주소. */
const LOCATION_SCRIPT = tagged('location', 'location.href');

/**
 * 권한 — check 경로(permissions.query: 알림 · 위치 · 클립보드 쓰기, Notification.permission)와 request 경로(Notification.requestPermission ·
 * 위치 요청). 위치 요청은 error 코드('error 1' = PERMISSION_DENIED) · 'position' · 'timeout' 으로 돌려준다(geolocationMs 까지 기다린다).
 * @param {number} geolocationMs
 * @returns {string}
 */
function permissionsScript(geolocationMs) {
  return tagged(
    'permissions',
    `(async () => {
  const state = async (name) => {
    try {
      return (await navigator.permissions.query({ name })).state;
    } catch (err) {
      return 'error: ' + String(err);
    }
  };
  const checks = { notifications: await state('notifications'), geolocation: await state('geolocation'), clipboardWrite: await state('clipboard-write') };
  const notificationPermission = Notification.permission;
  let requested;
  try {
    requested = await Notification.requestPermission();
  } catch (err) {
    requested = 'error: ' + String(err);
  }
  const geolocation = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ${geolocationMs});
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    try {
      navigator.geolocation.getCurrentPosition(() => done('position'), (err) => done('error ' + err.code), { maximumAge: 0, timeout: ${geolocationMs} });
    } catch (err) {
      done('error: ' + String(err));
    }
  });
  return { checks, notificationPermission, requested, geolocation };
})()`,
    geolocationMs,
  );
}

/** .invalid 빌드의 연결 시도(src/tray/smoke.ts 의 connectProbe() — 요청마다 3초까지). */
const CONNECT_PROBE_SCRIPT = tagged('connect-probe', 'window.__tjTraySmoke.connectProbe()');
/** --net 의 인증 설정 GET · Realtime join(src/tray/smoke.ts 의 net() — join 10초까지, 설정 GET 은 상한이 없다). */
const NET_SCRIPT = tagged('net', 'window.__tjTraySmoke.net()');

/**
 * canary — CSP 가 막아야 하는 fetch 하나. 끝난 모양('rejected …' · 'resolved <status>')을 글로 돌려준다(판정은 위반 이벤트로 한다).
 * @param {string} url
 * @returns {string}
 */
function canaryScript(url) {
  return tagged('canary', `fetch(${JSON.stringify(url)}).then((response) => 'resolved ' + response.status, (err) => 'rejected ' + String(err))`, url);
}

module.exports = {
  ISOLATED_WORLD_ID,
  ISOLATED_BUFFER_CODE,
  barrierScript,
  bootScript,
  MAIN_WORLD_SCRIPT,
  DISABLE_WARNINGS_SCRIPT,
  BRIDGE_SCRIPT,
  FRAMES_SCRIPT,
  themeScript,
  opacityScript,
  escScript,
  HIDE_BUTTON_SCRIPT,
  HIDDEN_STATE_SCRIPT,
  CSP_META_SCRIPT,
  headersScript,
  protocolScript,
  AI_SCRIPT,
  windowOpenScript,
  navigateScript,
  LOCATION_SCRIPT,
  permissionsScript,
  CONNECT_PROBE_SCRIPT,
  NET_SCRIPT,
  canaryScript,
};
