'use strict';
// 트레이 창의 preload(#20 설계 §5.6) — sandbox · contextIsolation 의 격리 world 에서 페이지 스크립트보다 먼저 돈다.
// - 45 규칙: require('electron') 만 쓰고 이 파일 하나로 자족한다(sandbox preload 의 require 는 다른 파일을 부르지 못한다).
// - 노출은 window.tjDesktop 하나다(얼린 객체, 11키 — #21 설계 §5.3). raw ipcRenderer 는 노출하지 않는다. 채널은 tj-* 다.
//   값은 고치지 않고 그대로 보낸다(정규화는 main 한 곳). 구독 함수는 감싼 리스너를 걸고 해제 함수를 돌려준다 — IpcRendererEvent 는 넘기지 않는다.
//   채널 이름은 글자로 쓴다(이 파일은 자족해야 한다). 계약 시험이 구독 채널 집합을 PUSH_CHANNELS 와 대조한다.
// - 스모크(tray.html?smoke)일 때만: 실효 상태 보고(tj-smoke-preload) · 격리 world 표식(__tjIsoProbe) · CSP 위반 수집
//   (tj-smoke-csp 로 보내고 격리 world 버퍼 __tjCspBuffer 에도 남긴다 — 둘 다 최대 50건). 스모크가 아니면 아무것도 하지 않는다
//   — 프로덕션에서는 로드 때 아무것도 보내거나 듣지 않는다. IPC 는 브리지 함수를 부를 때만 나가고 구독도 부를 때만 건다.
// desktop/lib/preloadContract.test.ts 가 이 파일을 글자로 읽어 Electron 의 감싸기와 같은 new Function(...) 으로 돌린다.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * main→렌더러 채널 하나의 구독 함수를 만든다. cb 가 함수가 아니면 아무것도 걸지 않고 아무것도 하지 않는 해제 함수를 돌려준다.
 * @param {string} channel
 * @returns {(cb: (...payload: unknown[]) => void) => () => void}
 */
function subscribe(channel) {
  return (cb) => {
    if (typeof cb !== 'function') return () => {};
    // 첫 인자(IpcRendererEvent)는 버리고 payload 만 넘긴다.
    /** @param {unknown} _event @param {...unknown} payload */
    const listener = (_event, ...payload) => cb(...payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

// 키 순서는 src/tray/desktop.ts 의 TJ_DESKTOP_KEYS 와 같다.
contextBridge.exposeInMainWorld(
  'tjDesktop',
  Object.freeze({
    getAppInfo: () => ipcRenderer.invoke('tj-app-info'),
    getState: () => ipcRenderer.invoke('tj-get-state'),
    /** @param {unknown} theme */ setTheme: (theme) => ipcRenderer.send('tj-set-theme', theme),
    /** @param {unknown} percent */ setOpacity: (percent) => ipcRenderer.send('tj-set-opacity', percent),
    /** @param {unknown} key */ setLayout: (key) => ipcRenderer.send('tj-set-layout', key),
    hide: () => ipcRenderer.send('tj-hide'),
    onTheme: subscribe('tj-theme'),
    onOpacity: subscribe('tj-opacity'),
    onMode: subscribe('tj-mode'),
    onShown: subscribe('tj-shown'),
    onHidden: subscribe('tj-hidden'),
  }),
);

if (new URLSearchParams(location.search).has('smoke')) {
  /** CSP 위반을 모으는 상한 — 보내기와 버퍼가 같은 건수에서 멈춘다(스모크가 둘이 같은지 본다). */
  const MAX_CSP_VIOLATIONS = 50;

  ipcRenderer.send('tj-smoke-preload', { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated });

  // 격리 world 표식 · 버퍼 — main world 에서 보이면 격리가 깨진 것이다. configurable 은 계약 시험이 지우게 하려는 것이다
  // (격리 world 의 전역에는 페이지 스크립트가 닿지 못하므로 막을 것이 없다).
  Object.defineProperty(globalThis, '__tjIsoProbe', { value: 1, configurable: true });
  /**
   * 위반 한 건 — SecurityPolicyViolationEvent 에서 판정에 쓰는 6필드만 옮긴다.
   * @type {Array<Pick<SecurityPolicyViolationEvent, 'blockedURI' | 'effectiveDirective' | 'originalPolicy' | 'disposition' | 'sourceFile' | 'lineNumber'>>}
   */
  const violations = [];
  Object.defineProperty(globalThis, '__tjCspBuffer', { value: violations, configurable: true });

  // 캡처 단계에서 document 에 건다 — 요소에서 난 위반도 문서에서 난 위반(fetch 의 connect-src 등)도 페이지 스크립트보다 먼저 받는다.
  document.addEventListener(
    'securitypolicyviolation',
    (event) => {
      if (violations.length >= MAX_CSP_VIOLATIONS) return;
      const violation = {
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        originalPolicy: event.originalPolicy,
        disposition: event.disposition,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
      };
      violations.push(violation);
      ipcRenderer.send('tj-smoke-csp', violation);
    },
    true,
  );
}
