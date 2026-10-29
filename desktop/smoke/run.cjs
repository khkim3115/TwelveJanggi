'use strict';
// 앱 안 스모크 실행기(설계 §5.10 '앱 안 실행기') — 스모크의 안쪽 절반이다. 런처(desktop/scripts/smoke.cjs)가 스모크 인자로 띄운 실제 앱
// (같은 main.js · 고정한 electron)에서 main 이 이 파일을 require 해 createSmokeRun 의 결과를 hooks 에 꽂는다(비스모크는 require 하지
// 않는다). 앱은 평소와 같은 길로 돈다 — 실행기는 처리기를 바꿔 끼우지 않고 감싸서 기록만 하고, 창 · 트레이 · 페이지에서 사실을 모아
// 판정한 뒤 결과를 <outDir>/result.json 에 쓰고 실제 트레이 메뉴의 '종료' 를 눌러 끝낸다. 판정 규칙은 lib/smokeChecks.cjs 에 있고
// (같은 값을 보는 검사는 그 평가기를 쓴다), 여기는 사실을 모아 넘기는 일과 비교 몇 줄뿐이다.
// - 연결점(main.js 의 MainHooks): networkGuard(기본 세션 onBeforeRequest — 원격 요청 기록 · 취소) · registerIpc(창 전 — tj-smoke-preload ·
//   tj-smoke-csp 수신. Electron 은 듣는 쪽이 없는 send 를 버린다) · beforeLoad(창과 loadURL 사이, 동기 — 수집기) · setTray(붙은 메뉴) ·
//   record(권한 · 탐색 결정) · open(허용 목록 주소 — 열지 않고 기록).
// - 검사는 첫 did-finish-load 뒤에 돈다: 장벽(페이지가 getAppInfo 왕복 뒤 표식을 콘솔에 찍고, 수집기가 그 표식을 받는다) → 수동 검사 →
//   결과 쓰기 → '종료' 클릭. 이 파일의 검사는 boot · webPreferences · sandboxEffective · bridge · ipc · mime · securityWarnings · tray ·
//   screenshot · noNetwork · loginItem 이다. 능동 검사(cspMeta · cspHeader · protocol · ai · navigation · permissions · cspViolations ·
//   consoleErrors · cspCanary)와 그 검사가 쓰는 수집 사실(결정 · 열기 · did-fail-provisional-load · CSP 위반)의 판정은 Task 11 이 더한다.
// - 실패(60초 감시 타이머 · 수집기의 render-process-gone · preload-error · unresponsive · 메인 프레임 did-fail-load · 던진 단계 · main 이
//   단 uncaughtException · unhandledRejection)는 fail 하나로 끝난다: 원인을 stage 로 적은 실패 결과(smokeOut.failureResult + 모은 검사)를
//   한 번 쓰고 app.exit(1). 처음 실패가 이기고(두 번째 쓰기는 없다), fail 은 던지지 않는다.
// - electron 을 require 하지 않는다 — Electron 객체는 main 이 넘긴다(main.js 의 배선 시험 mainWiring.test.ts 가 가짜 electron 위에서 이
//   파일까지 돌린다). 페이지 쪽 사실은 executeJavaScript(main world)로 읽는다: 그 코드는 글이라 타입 검사 밖이다 — 작게 둔다.

const fs = require('node:fs');
const path = require('node:path');
const { ENTRY_URL } = require('../lib/appProtocol.cjs');
const { isNonEmptyString, isRecord, repr } = require('../lib/guards.cjs');
const { MIN_SCREENSHOT_COLORS, countDistinctColors, evaluateNoNetwork, evaluateQuiet, evaluateWebPreferences } = require('../lib/smokeChecks.cjs');
const { failureResult, writeResultAtomic } = require('../lib/smokeOut.cjs');
const { requiredChecks } = require('../lib/smokeResult.cjs');

/** 스모크의 진입 URL — main 이 스모크에서 여는 곳(tray.html?smoke). */
const SMOKE_URL = `${ENTRY_URL}?smoke`;
/** 감시 타이머 — 이 안에 검사를 마치고 종료가 will-quit 까지 가야 한다. 런처의 하드 타임아웃(기본 90초)보다 짧다. */
const WATCHDOG_MS = 60_000;
/** 페이지 호출(executeJavaScript) 한 번의 상한. */
const PAGE_MS = 10_000;
/** 사건(preload 보고 · 장벽 표식 · 창 보임 · 포커스 · 제목 줄의 버전)을 기다리는 상한. */
const WAIT_MS = 5_000;
/** 기다릴 때 다시 보는 간격. */
const POLL_MS = 50;
/** capturePage 한 번의 상한과 시도 횟수(설계: 5초 · 재시도 1회), 재시도 전 쉼. */
const CAPTURE_MS = 5_000;
const CAPTURE_ATTEMPTS = 2;
const CAPTURE_RETRY_MS = 500;
/** 네트워크 가드의 양성 대조 — 메인 쪽에서 창의 세션으로 보내는 요청 하나. 가드가 기록하고 취소해야 한다(.invalid 는 어디에도 없다). */
const GUARD_PROBE_URL = 'https://example.invalid/tj-net-guard-probe';
const GUARD_PROBE_MS = 5_000;
/** 가드가 기록 · 취소하는 스킴(대소문자 무시). 그 밖(app:// · devtools: · file: · data: …)은 건드리지 않는다. */
const REMOTE_SCHEME_RE = /^(?:https?|wss?):/i;
/** Electron 이 보안 경고 줄에 붙이는 글. */
const SECURITY_WARNING = 'Electron Security Warning';
/** 트레이 메뉴 — main 이 붙이는 항목(순서 그대로). */
const TRAY_LABELS = Object.freeze(['열기', '종료']);
/** 트레이 아이콘 — main 이 쓰는 파일(앱 폴더 기준). Tray 는 붙인 아이콘을 돌려주지 않아 같은 파일을 같은 nativeImage 로 다시 읽어 본다. */
const TRAY_ICON = path.join('assets', 'tray.png');
/** 스크린샷 파일 — 결과 폴더(outDir)에 쓴다(CI 아티팩트). */
const SCREENSHOT_FILE = 'screenshot.png';
/** detail 에 싣는 값 표현의 글자 수 상한. */
const MAX_REPR_CHARS = 160;

/**
 * main 이 넘기는 것 — Electron 객체와, main 이 검증해 처리기에 쓰는 렌더러 값.
 * @typedef {object} SmokeRunInput
 * @property {import('../lib/smokeArgs.cjs').SmokeOn} args 스모크 인자 — outDir(결과 폴더) · nonce · net
 * @property {import('electron').App} app
 * @property {typeof import('electron').session} session 세션 모듈 — 창의 세션이 main 이 가드를 단 기본 세션인지 본다
 * @property {import('electron').Net} net 메인 쪽 요청 — Task 11 의 protocol 검사(net.fetch('app://other/…'))가 쓴다
 * @property {typeof import('electron').nativeImage} nativeImage 트레이 아이콘 파일을 다시 읽는다
 * @property {import('../lib/trayBuildInfo.cjs').TrayBuildInfo} trayBuild 검증한 tray-build.json
 * @property {string} rendererRoot 렌더러 루트(개발 <repo>/dist-tray)
 * @property {string} appRoot 앱 폴더(desktop/ — main.js 의 __dirname). package.json · node_modules/electron · assets 가 여기 있다
 * @property {import('../lib/appProtocol.cjs').FileIndex} index main 이 app:// 처리기에 쓰는 파일 색인
 */
/**
 * main 이 hooks 에 꽂는 것과 fail.
 * @typedef {object} SmokeRun
 * @property {(entry: DecisionRecord) => void} record 권한 · 탐색 결정 기록(main 의 hooks.record)
 * @property {(href: string) => void} open 허용 목록 주소를 열지 않고 기록한다(main 의 hooks.open)
 * @property {(details: { url: unknown }, callback: (response: { cancel?: boolean }) => void) => void} networkGuard
 *   기본 세션의 onBeforeRequest — http · https · ws · wss 는 기록하고 취소한다
 * @property {(ipc: import('../lib/ipcGuard.cjs').GuardedIpc) => void} registerIpc preload 의 스모크 send 를 받는다(창 전)
 * @property {(win: import('electron').BrowserWindow) => void} beforeLoad 수집기를 붙인다(창과 loadURL 사이, 동기)
 * @property {(tray: import('electron').Tray, menu: import('electron').Menu) => void} setTray 붙은 트레이 메뉴를 받는다
 * @property {(stage: string, error: unknown) => void} fail 실패 결과를 한 번 쓰고 app.exit(1) — 처음 실패가 이긴다. 던지지 않는다
 */
/**
 * 결정 기록 한 건 — 탐색 결정(navigation.cjs)이거나 권한 결정(main.js)이다(Task 11 의 탐색 · 권한 검사가 읽는다).
 * @typedef {import('../lib/navigation.cjs').NavigationRecord | import('../main.js').PermissionRecord} DecisionRecord
 */
/**
 * console-message 한 건(details 형).
 * @typedef {object} ConsoleEntry
 * @property {string} level 'info' · 'warning' · 'error' · 'debug'
 * @property {string} message
 * @property {string} sourceId
 * @property {number} lineNumber
 */
/**
 * 실패로 치지 않는 불러오기 실패(did-fail-provisional-load · 서브프레임 did-fail-load)의 기록.
 * @typedef {object} LoadFailure
 * @property {'did-fail-load' | 'did-fail-provisional-load'} kind
 * @property {number} errorCode
 * @property {string} errorDescription
 * @property {string} url
 * @property {boolean} isMainFrame
 */
/** @typedef {import('../lib/smokeChecks.cjs').CheckVerdict} CheckVerdict */
/** @typedef {import('../lib/smokeResult.cjs').SmokeCheck} SmokeCheck */

/**
 * @param {unknown} value
 * @returns {string}
 */
function show(value) {
  return repr(value, MAX_REPR_CHARS);
}

/**
 * 오류의 글 — Error 는 message, 문자열은 그대로, 그 밖은 값 표현. 던지지 않는다.
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : show(err);
}

/**
 * stderr 에 '[tj] …' 를 동기로 쓴다(main.js 의 logError 와 같은 줄 모양 — 런처가 [app:err] 로 보여 준다). 쓸 곳이 없으면 버린다.
 * @param {string} message
 */
function logError(message) {
  try {
    fs.writeSync(2, `[tj] ${message}\n`);
  } catch {
    // 쓸 곳이 없다
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * predicate 가 참이 될 때까지 ms 까지 기다린다 — 참이 됐으면 true, 시간이 다 됐으면 false.
 * @param {() => boolean} predicate
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
async function until(predicate, ms) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}

/**
 * work 를 ms 까지만 기다린다. 넘으면 '<what>: <ms>ms 안에 끝나지 않았다' 로 거부한다. 어느 쪽이든 타이머는 남기지 않는다.
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
function within(work, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: ${ms}ms 안에 끝나지 않았다`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 문제 목록으로 판정한다 — 없으면 통과(passDetail), 있으면 실패(문제를 '; ' 로 이은 것).
 * @param {readonly string[]} problems
 * @param {string} passDetail
 * @returns {CheckVerdict}
 */
function verdictOf(problems, passDetail) {
  return problems.length === 0 ? { ok: true, detail: passDetail } : { ok: false, detail: problems.join('; ') };
}

/**
 * 문자열 목록인가.
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * 두 목록이 같은 순서로 같은가.
 * @param {readonly unknown[]} a
 * @param {readonly unknown[]} b
 * @returns {boolean}
 */
function sameList(a, b) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * '#rrggbb' · '#rgb' 를 getComputedStyle 이 쓰는 'rgb(r, g, b)' 로 바꾼다. 그 모양이 아니면 null.
 * @param {unknown} hex
 * @returns {string | null}
 */
function rgbOfHex(hex) {
  if (typeof hex !== 'string') return null;
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const parts = long ? long.slice(1) : short ? short.slice(1).map((digit) => digit + digit) : null;
  return parts === null ? null : `rgb(${parts.map((part) => parseInt(part, 16)).join(', ')})`;
}

/**
 * package.json 의 version — 읽지 못하거나 비어 있으면 던진다(그 검사의 실패 단계가 된다).
 * @param {string} file
 * @returns {string}
 */
function packageVersion(file) {
  const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
  if (!isNonEmptyString(version)) throw new Error(`${file} 에 version 이 없다`);
  return version;
}

/**
 * 장벽의 페이지 쪽 — 브리지로 getAppInfo 를 왕복한 뒤 표식을 콘솔에 찍고 AppInfo 를 돌려준다.
 * @param {string} marker
 * @returns {string}
 */
function barrierScript(marker) {
  return `window.tjDesktop.getAppInfo().then((info) => { console.info(${JSON.stringify(marker)}); return info; })`;
}

/**
 * boot 의 페이지 쪽 사실 — 제목 줄의 버전은 getAppInfo 가 풀린 뒤 React 가 그리므로, 기대한 버전이 보일 때까지 WAIT_MS 까지 기다린 뒤 읽는다.
 * @param {string | null} version getAppInfo().version
 * @returns {string}
 */
function bootScript(version) {
  return `(async () => {
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
  })()`;
}

/** main world 에서 보이면 안 되는 것 — preload 의 격리 world 전역 둘과 Node 의 require · process. */
const MAIN_WORLD_SCRIPT = `({
  isoProbe: typeof globalThis.__tjIsoProbe,
  cspBuffer: typeof globalThis.__tjCspBuffer,
  require: typeof globalThis.require,
  process: typeof globalThis.process,
})`;
/** 페이지가 보안 경고를 스스로 끄지 않았는가(main world). */
const DISABLE_WARNINGS_SCRIPT = 'Boolean(window.ELECTRON_DISABLE_SECURITY_WARNINGS)';
/** 브리지의 키와 계약 상수(src/tray/smoke.ts 의 bridge()). */
const BRIDGE_SCRIPT = 'window.__tjTraySmoke.bridge()';
/** 화면이 두 프레임을 그릴 때까지(최대 1초) 기다린다 — 창을 보인 직후의 capturePage 가 빈 화면을 받지 않게. 그렸으면 true. */
const FRAMES_SCRIPT = `new Promise((resolve) => {
  setTimeout(() => resolve(false), 1000);
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
})`;

/**
 * 스모크 실행기를 만든다 — 만들 때 감시 타이머를 켜고(will-quit 까지), 로그인 항목의 시작 값을 읽는다. 나머지는 main 이 hooks 로 부른다.
 * @param {SmokeRunInput} input
 * @returns {SmokeRun}
 */
function createSmokeRun({ args, app, session, nativeImage, trayBuild, rendererRoot, appRoot, index }) {
  /** @type {SmokeCheck[]} */
  const checks = [];
  // 수집한 사실 — 수집기 · IPC · 가드 · 연결점이 채우고, 검사가 읽는다.
  const facts = {
    /** @type {ConsoleEntry[]} */
    console: [],
    /** @type {unknown[]} preload 의 tj-smoke-preload 보고 */
    preloadReports: [],
    /** @type {unknown[]} preload 의 tj-smoke-csp 위반 이벤트 */
    cspEvents: [],
    /** @type {string[]} 네트워크 가드가 취소한 요청 URL */
    requests: [],
    /** @type {DecisionRecord[]} 권한 · 탐색 결정 */
    decisions: [],
    /** @type {string[]} 허용 목록 주소(열지 않았다) */
    opened: [],
    /** @type {LoadFailure[]} */
    loadFailures: [],
  };
  // 콜백이 바꾸는 상태 — 한 객체에 둔다(지역 변수는 TS 흐름 분석이 콜백의 변경을 놓친다).
  const state = {
    /** @type {'running' | 'succeeded' | 'failed'} 성공 결과를 썼거나(succeeded) 실패 결과를 썼다(failed) */
    phase: 'running',
    /** 지금 하는 단계 — 감시 타이머의 이유에 쓴다 */
    step: '창을 기다린다',
    /** 첫 did-finish-load 를 받았다 */
    started: false,
    /** 장벽 표식을 콘솔 수집기가 받았다 — 콘솔로 '없었다' 를 보는 검사의 양성 기록 */
    markerSeen: false,
    barriers: 0,
    /** @type {import('electron').BrowserWindow | null} */
    win: null,
    /** @type {import('electron').Tray | null} */
    tray: null,
    /** @type {import('electron').Menu | null} */
    menu: null,
  };
  const loginItemAtStart = readLoginItem();

  const watchdog = setTimeout(() => fail('watchdog', `${WATCHDOG_MS / 1000}초 안에 끝나지 않았다 — 진행 중: ${state.step}`), WATCHDOG_MS);
  app.on('will-quit', () => clearTimeout(watchdog));

  /** 아직 결과를 쓰지 않았는가. */
  const running = () => state.phase === 'running';

  /**
   * 실패 — 원인을 stage 로 적은 실패 결과(failureResult + 지금까지 모은 검사)를 한 번 쓰고 app.exit(1). 처음 실패가 이긴다.
   * 성공 결과를 쓴 뒤의 실패(종료 경로가 멈춤 · 종료 클릭이 던짐 · process 처리기)도 실패로 덮어쓴다 — 결과가 exit 1 과 같은 말을 하게.
   * 결과를 못 써도 exit(1) 이다(런처는 결과가 없으면 실패로 본다). 던지지 않는다.
   * @param {string} stage
   * @param {unknown} error
   */
  function fail(stage, error) {
    if (state.phase === 'failed') return;
    state.phase = 'failed';
    clearTimeout(watchdog);
    const message = errorText(error);
    const stack = error instanceof Error && typeof error.stack === 'string' ? `\n${error.stack}` : '';
    logError(`smoke ${stage}: ${message}${stack}`);
    try {
      const result = failureResult({ nonce: args.nonce, stage, error: message, versions: versions() });
      writeResultAtomic(args.outDir, { ...result, checks: [...checks] });
    } catch (err) {
      logError(`smoke result: ${errorText(err)}`);
    }
    app.exit(1);
  }

  /**
   * 수집기가 본 비정상 사건 — 검사 중일 때만 실패다. 결과를 쓴 뒤(종료 경로가 창 · 렌더러를 닫는 중)의 사건은 실패로 치지 않는다.
   * @param {string} stage
   * @param {string} why
   */
  function collectorFailure(stage, why) {
    if (running()) fail(stage, why);
  }

  /** @returns {import('../lib/smokeOut.cjs').SmokeVersions} */
  function versions() {
    return { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, app: app.getVersion() };
  }

  /**
   * 로그인 항목 — openAtLogin 값. 읽지 못했으면 그 이유(글).
   * @returns {boolean | string}
   */
  function readLoginItem() {
    try {
      return app.getLoginItemSettings().openAtLogin;
    } catch (err) {
      return `읽지 못했다(${errorText(err)})`;
    }
  }

  /** @returns {import('electron').BrowserWindow} */
  function trayWindow() {
    if (state.win === null) throw new Error('트레이 창이 없다(beforeLoad 를 받지 못했다)');
    return state.win;
  }

  /**
   * 페이지(main world)에서 code 를 돌린 값. PAGE_MS 를 넘으면 거부한다.
   * @param {string} code
   * @param {string} what
   * @returns {Promise<unknown>}
   */
  function page(code, what) {
    return within(trayWindow().webContents.executeJavaScript(code), PAGE_MS, `페이지 ${what}`);
  }

  // ── 연결점(main 의 hooks) ──────────────────────────────────────────────

  /** @param {DecisionRecord} entry */
  function record(entry) {
    facts.decisions.push(entry);
  }

  /** @param {string} href */
  function open(href) {
    facts.opened.push(href);
  }

  /**
   * 기본 세션의 onBeforeRequest — http · https · ws · wss 는 기록하고 취소한다. app:// 와 그 밖의 스킴은 그대로 두고 기록하지 않는다.
   * 콜백은 무슨 일이 있어도 한 번 부른다(부르지 않으면 요청이 멈춘다).
   * @param {{ url: unknown }} details
   * @param {(response: { cancel?: boolean }) => void} callback
   */
  function networkGuard(details, callback) {
    let cancel = false;
    try {
      const url = details.url;
      if (typeof url === 'string' && REMOTE_SCHEME_RE.test(url)) {
        cancel = true;
        facts.requests.push(url);
      }
    } finally {
      callback(cancel ? { cancel: true } : {});
    }
  }

  /** @param {import('../lib/ipcGuard.cjs').GuardedIpc} ipc */
  function registerIpc(ipc) {
    ipc.on('tj-smoke-preload', (_event, report) => {
      facts.preloadReports.push(report);
    });
    ipc.on('tj-smoke-csp', (_event, violation) => {
      facts.cspEvents.push(violation);
    });
  }

  /**
   * 수집기를 붙인다 — main 이 창을 만든 뒤 loadURL 전에 동기로 부른다. 검사는 첫 did-finish-load 에서 시작한다.
   * @param {import('electron').BrowserWindow} win
   */
  function beforeLoad(win) {
    state.win = win;
    const contents = win.webContents;
    // details 형(인자 하나) — 위치 인자(level · message …)는 deprecated 다.
    contents.on('console-message', (details) => {
      facts.console.push({ level: details.level, message: details.message, sourceId: details.sourceId, lineNumber: details.lineNumber });
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) collectorFailure('did-fail-load', `${errorCode} ${errorDescription} (${validatedURL})`);
      else facts.loadFailures.push({ kind: 'did-fail-load', errorCode, errorDescription, url: validatedURL, isMainFrame });
    });
    contents.on('did-fail-provisional-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      facts.loadFailures.push({ kind: 'did-fail-provisional-load', errorCode, errorDescription, url: validatedURL, isMainFrame });
    });
    contents.on('render-process-gone', (_event, details) => {
      collectorFailure('render-process-gone', `렌더러가 사라졌다: ${details.reason} (exitCode ${details.exitCode})`);
    });
    contents.on('preload-error', (_event, preloadPath, error) => {
      collectorFailure('preload-error', `${preloadPath}: ${errorText(error)}`);
    });
    contents.on('unresponsive', () => {
      collectorFailure('unresponsive', '렌더러가 응답하지 않는다');
    });
    contents.on('did-finish-load', () => {
      if (state.started) return;
      state.started = true;
      // 단계마다 실패를 받으므로 거부하지 않는다 — 그래도 새는 것은 마지막 그물이 받는다.
      runChecks().catch((err) => fail(state.step, err));
    });
  }

  /**
   * @param {import('electron').Tray} tray
   * @param {import('electron').Menu} menu
   */
  function setTray(tray, menu) {
    state.tray = tray;
    state.menu = menu;
  }

  // ── 검사 ────────────────────────────────────────────────────────────

  /**
   * 단계 하나 — 던지면 그 이름을 stage 로 실패한다. 결과를 이미 썼으면 돌지 않는다.
   * @template T
   * @param {string} name
   * @param {() => T | Promise<T>} work
   * @returns {Promise<{ done: true, value: Awaited<T> } | { done: false }>}
   */
  async function step(name, work) {
    if (!running()) return { done: false };
    state.step = name;
    try {
      return { done: true, value: await work() };
    } catch (err) {
      fail(name, err);
      return { done: false };
    }
  }

  /**
   * 검사 하나 — 판정을 checks 에 적는다. 던지면 'check:<이름>' 으로 실패한다. 계속해도 되면 true.
   * @param {string} name
   * @param {() => CheckVerdict | Promise<CheckVerdict>} judge
   * @returns {Promise<boolean>}
   */
  async function check(name, judge) {
    const outcome = await step(`check:${name}`, judge);
    if (outcome.done) checks.push({ name, ok: outcome.value.ok, detail: outcome.value.detail });
    return outcome.done;
  }

  /** 첫 did-finish-load 뒤 — 장벽 → 수동 검사 → 결과 쓰기 → 트레이 메뉴 '종료'. */
  async function runChecks() {
    const barrierOutcome = await step('barrier', barrier);
    if (!barrierOutcome.done) return;
    const info = barrierOutcome.value;
    /** @type {Array<[string, () => CheckVerdict | Promise<CheckVerdict>]>} */
    const passive = [
      ['boot', () => checkBoot(info)],
      ['webPreferences', checkWebPreferences],
      ['sandboxEffective', checkSandboxEffective],
      ['bridge', checkBridge],
      ['ipc', () => checkIpc(info)],
      ['mime', checkMime],
      ['securityWarnings', checkSecurityWarnings],
      ['tray', checkTray],
      ['screenshot', checkScreenshot],
      ['noNetwork', checkNoNetwork],
      ['loginItem', checkLoginItem], // 끝 값은 결과를 쓰기 직전에 읽는다
    ];
    for (const [name, judge] of passive) {
      if (!(await check(name, judge))) return;
    }
    const written = await step('result', writeSuccess);
    if (!written.done) return;
    // 성공 결과를 썼다 — 실제 트레이 메뉴의 '종료' 로 끝낸다(before-quit · isQuitting · 창 닫기 경로). will-quit 이 감시 타이머를 끈다.
    state.step = 'quit';
    try {
      menuItem('종료').click();
    } catch (err) {
      fail('quit', err);
    }
  }

  /**
   * 장벽 — 페이지가 getAppInfo 를 왕복한 뒤(invoke → main 의 tj-app-info) 표식을 콘솔에 찍는다. 수집기가 그 표식을 받아야 콘솔로
   * '없었다' 를 보는 검사를 판정한다(Electron 은 불러온 뒤 자기 IPC 를 한 번 더 돌고 보안 경고를 찍는다). 받지 못하면 양성 기록 없음으로
   * 남긴다 — 그 검사가 실패한다. 돌려주는 값은 AppInfo(boot · ipc 가 쓴다).
   * @returns {Promise<unknown>}
   */
  async function barrier() {
    state.barriers += 1;
    const marker = `tj-smoke-barrier ${args.nonce} ${state.barriers}`;
    const info = await page(barrierScript(marker), '장벽(getAppInfo)');
    state.markerSeen = await until(() => facts.console.some((entry) => entry.message === marker), WAIT_MS);
    return info;
  }

  /**
   * boot — 진입 URL · #root 렌더 · 제목 줄의 버전(= getAppInfo().version) · body 배경이 다크 토큰(--bg, color-scheme dark — CSS 경로).
   * @param {unknown} info 장벽의 AppInfo
   * @returns {Promise<CheckVerdict>}
   */
  async function checkBoot(info) {
    const version = isRecord(info) && isNonEmptyString(info.version) ? info.version : null;
    const url = trayWindow().webContents.getURL();
    const seen = await page(bootScript(version), 'boot');
    if (!isRecord(seen)) return verdictOf([`페이지 사실이 객체가 아니다: ${show(seen)}`], '');
    const problems = [];
    if (url !== SMOKE_URL) problems.push(`getURL() 이 ${show(url)} 다(기대 ${SMOKE_URL})`);
    const rootChildren = typeof seen.rootChildren === 'number' ? seen.rootChildren : 0;
    if (rootChildren <= 0) problems.push(`#root 가 그려지지 않았다(${show(seen.rootChildren)})`);
    if (version === null) problems.push(`getAppInfo().version 이 없다: ${show(info)}`);
    else if (seen.version !== version) problems.push(`제목 줄의 버전이 ${show(seen.version)} 다(getAppInfo ${show(version)})`);
    const background = rgbOfHex(seen.bgToken);
    if (background === null) problems.push(`--bg 토큰이 #rrggbb 가 아니다: ${show(seen.bgToken)}`);
    else if (seen.bodyBackground !== background) problems.push(`body 배경이 ${show(seen.bodyBackground)} 다(--bg ${background})`);
    if (seen.colorScheme !== 'dark') problems.push(`color-scheme 이 ${show(seen.colorScheme)} 다(다크 토큰이면 dark)`);
    return verdictOf(
      problems,
      `${url} · #root 자식 ${rootChildren} · 제목 줄 ${show(seen.title)} ${show(seen.version)} = getAppInfo().version · body 배경 ${show(seen.bodyBackground)} = --bg ${show(seen.bgToken)}(color-scheme dark)`,
    );
  }

  /**
   * webPreferences — 창을 만들 때 쓴 설정. getLastWebPreferences() 는 비공개 API 라 구조 캐스트로 부르고, 값은 고치지 않고 그대로
   * 평가기에 넘긴다(골라 담은 복사본은 없는 키를 undefined 값의 키로 바꾼다).
   * @returns {CheckVerdict}
   */
  function checkWebPreferences() {
    const contents = /** @type {{ getLastWebPreferences(): unknown }} */ (/** @type {unknown} */ (trayWindow().webContents));
    return evaluateWebPreferences(contents.getLastWebPreferences());
  }

  /**
   * sandboxEffective — preload 의 실효 보고(sandboxed · contextIsolated true) · OS 수준 sandbox(getAppMetrics 의 이 렌더러 pid —
   * win32 · darwin 은 sandboxed, win32 는 integrityLevel untrusted · low) · main world 에 격리 world 전역 · require · process 가 없음.
   * @returns {Promise<CheckVerdict>}
   */
  async function checkSandboxEffective() {
    const contents = trayWindow().webContents;
    await until(() => facts.preloadReports.length > 0, WAIT_MS);
    const pid = contents.getOSProcessId();
    const metric = app.getAppMetrics().find((entry) => entry.pid === pid);
    const world = await page(MAIN_WORLD_SCRIPT, 'main world');
    const problems = [];
    if (facts.preloadReports.length === 0) problems.push('preload 보고(tj-smoke-preload)가 오지 않았다');
    for (const report of facts.preloadReports) {
      if (!(isRecord(report) && report.sandboxed === true && report.contextIsolated === true)) {
        problems.push(`preload 보고가 ${show(report)} 다(기대 sandboxed · contextIsolated true)`);
      }
    }
    if (metric === undefined) {
      problems.push(`getAppMetrics() 에 이 렌더러(pid ${pid})가 없다`);
    } else {
      if ((process.platform === 'win32' || process.platform === 'darwin') && metric.sandboxed !== true) {
        problems.push(`렌더러(pid ${pid})의 sandboxed 가 ${show(metric.sandboxed)} 다`);
      }
      if (process.platform === 'win32' && metric.integrityLevel !== 'untrusted' && metric.integrityLevel !== 'low') {
        problems.push(`렌더러(pid ${pid})의 integrityLevel 이 ${show(metric.integrityLevel)} 다(기대 untrusted · low)`);
      }
    }
    const leaked = isRecord(world) ? Object.entries(world).filter(([, type]) => type !== 'undefined') : null;
    if (leaked === null) problems.push(`main world 사실이 객체가 아니다: ${show(world)}`);
    else if (leaked.length > 0) problems.push(`main world 에 보인다: ${leaked.map(([name, type]) => `${name}(${type})`).join(', ')}`);
    const level = metric?.integrityLevel === undefined ? '' : ` · integrityLevel ${metric.integrityLevel}`;
    return verdictOf(
      problems,
      `preload 보고 ${facts.preloadReports.length}건 sandboxed · contextIsolated · 렌더러 pid ${pid} sandboxed ${show(metric?.sandboxed)}${level} · main world 에 __tjIsoProbe · __tjCspBuffer · require · process 없음`,
    );
  }

  /**
   * bridge — window.tjDesktop 의 키가 계약 상수(TJ_DESKTOP_KEYS)와 같다(비어 있지 않다). 순서는 보지 않는다.
   * @returns {Promise<CheckVerdict>}
   */
  async function checkBridge() {
    const bridge = await page(BRIDGE_SCRIPT, 'bridge()');
    const keys = isRecord(bridge) ? bridge.keys : undefined;
    const contract = isRecord(bridge) ? bridge.contract : undefined;
    if (!isStringList(keys) || !isStringList(contract)) return verdictOf([`bridge() 가 { keys, contract } 문자열 목록이 아니다: ${show(bridge)}`], '');
    const problems = [];
    if (contract.length === 0) problems.push('계약 상수가 비었다');
    if (!sameList([...keys].sort(), [...contract].sort())) problems.push(`tjDesktop 키 ${show(keys)} 가 계약 ${show(contract)} 와 다르다`);
    return verdictOf(problems, `tjDesktop 키 ${show(keys)} = 계약 상수`);
  }

  /**
   * ipc — 장벽에서 getAppInfo() 가 돌려준 AppInfo 가 desktop 패키지 버전 · 고정한 electron 패키지 버전(이 바이너리로 돌았다) ·
   * 이 프로세스의 chrome · platform 과 같다.
   * @param {unknown} info
   * @returns {CheckVerdict}
   */
  function checkIpc(info) {
    /** @type {Record<string, string>} */
    const expected = {
      version: packageVersion(path.join(appRoot, 'package.json')),
      electron: packageVersion(path.join(appRoot, 'node_modules', 'electron', 'package.json')),
      chrome: process.versions.chrome,
      platform: process.platform,
    };
    if (!isRecord(info)) return verdictOf([`getAppInfo() 가 객체가 아니다: ${show(info)}`], '');
    const problems = Object.entries(expected)
      .filter(([key, value]) => info[key] !== value)
      .map(([key, value]) => `${key} 가 ${show(info[key])} 다(기대 ${show(value)})`);
    return verdictOf(problems, `getAppInfo() = ${show(info)} — desktop 패키지 · electron 패키지 버전과 같다`);
  }

  /**
   * mime — main 의 파일 색인에 MIME 표 밖 확장자가 없다.
   * @returns {CheckVerdict}
   */
  function checkMime() {
    const { files, unmapped } = index;
    return verdictOf(
      unmapped.length === 0 ? [] : [`표에 없는 확장자 ${unmapped.length}개: ${unmapped.slice(0, 5).join(', ')}`],
      `색인 ${files.size}개 파일 · 표 밖 확장자 0 (${rendererRoot})`,
    );
  }

  /**
   * securityWarnings — 장벽 표식을 받은 뒤 'Electron Security Warning' 줄이 0건이고, 페이지가 경고를 스스로 끄지 않았다.
   * @returns {Promise<CheckVerdict>}
   */
  async function checkSecurityWarnings() {
    const disabled = await page(DISABLE_WARNINGS_SCRIPT, 'ELECTRON_DISABLE_SECURITY_WARNINGS');
    const warnings = facts.console.filter((entry) => entry.message.includes(SECURITY_WARNING)).map((entry) => entry.message);
    const quiet = evaluateQuiet({ positiveSeen: state.markerSeen, negatives: warnings });
    const problems = quiet.ok ? [] : [quiet.detail];
    if (disabled !== false) problems.push(`main world 의 ELECTRON_DISABLE_SECURITY_WARNINGS 가 ${show(disabled)} 다(기대 false)`);
    return verdictOf(problems, `'${SECURITY_WARNING}' 0건(장벽 표식을 받은 뒤 · 콘솔 ${facts.console.length}줄) · main world 의 ELECTRON_DISABLE_SECURITY_WARNINGS 거짓`);
  }

  /**
   * 붙은 트레이 메뉴의 항목.
   * @param {string} label
   * @returns {import('electron').MenuItem}
   */
  function menuItem(label) {
    const item = state.menu?.items.find((candidate) => candidate.label === label);
    if (item === undefined) throw new Error(`붙은 트레이 메뉴에 '${label}' 이 없다`);
    return item;
  }

  /**
   * tray — 트레이 · 아이콘(비어 있지 않음) · 붙은 메뉴 라벨 '열기' · '종료' · 단일 인스턴스 잠금. 창을 숨긴 뒤 붙은 메뉴의 '열기' 를
   * 누르면 창이 보이고 포커스를 받는다. getBounds() 는 정보다.
   * @returns {Promise<CheckVerdict>}
   */
  async function checkTray() {
    const win = trayWindow();
    const { tray, menu } = state;
    if (tray === null || menu === null) return verdictOf(['트레이 메뉴를 받지 못했다(setTray 없음)'], '');
    const problems = [];
    if (tray.isDestroyed()) problems.push('트레이가 파괴됐다');
    const icon = nativeImage.createFromPath(path.join(appRoot, TRAY_ICON));
    const size = icon.getSize();
    if (icon.isEmpty()) problems.push(`트레이 아이콘이 빈 이미지다(${TRAY_ICON})`);
    const labels = menu.items.map((item) => item.label);
    if (!sameList(labels, TRAY_LABELS)) problems.push(`메뉴 라벨이 ${show(labels)} 다(기대 ${show(TRAY_LABELS)})`);
    if (!app.hasSingleInstanceLock()) problems.push('단일 인스턴스 잠금을 쥐고 있지 않다');
    // '열기' — ready-to-show 로 보인 창을 숨긴 뒤 누른다(이미 보이는 창이면 '열기' 가 아무것도 하지 않아도 통과하므로).
    const shownFirst = await until(() => win.isVisible(), WAIT_MS);
    const openItem = menu.items.find((item) => item.label === '열기');
    if (openItem === undefined) {
      problems.push("붙은 메뉴에 '열기' 가 없다");
    } else {
      win.hide();
      if (win.isVisible()) problems.push('hide() 뒤에도 창이 보인다');
      openItem.click();
      const opened = await until(() => win.isVisible() && win.isFocused(), WAIT_MS);
      if (!opened) problems.push(`'열기' 뒤 창이 보이고 포커스를 받지 않았다(보임 ${win.isVisible()} · 포커스 ${win.isFocused()})`);
    }
    const bounds = tray.isDestroyed() ? null : tray.getBounds();
    const where = bounds === null ? '없음' : `${bounds.width}×${bounds.height} @ ${bounds.x},${bounds.y}`;
    return verdictOf(
      problems,
      `트레이 · 아이콘 ${size.width}×${size.height} · 메뉴 ${labels.join(' · ')} · 잠금 보유 · 숨김 → '열기' → 보임 · 포커스(처음 ready-to-show 로 보임 ${shownFirst}) · getBounds ${where}`,
    );
  }

  /**
   * screenshot — 창을 보인 뒤 capturePage()(5초 시간 제한 · 재시도 1회) → 서로 다른 색이 MIN_SCREENSHOT_COLORS 개 이상(검은 화면 거부)
   * → <outDir>/screenshot.png(비어 있지 않은 화면이면 실패해도 쓴다 — 근거).
   * @returns {Promise<CheckVerdict>}
   */
  async function checkScreenshot() {
    const win = trayWindow();
    const wasVisible = win.isVisible();
    if (!wasVisible) win.show();
    const painted = await page(FRAMES_SCRIPT, '프레임');
    /** @type {string[]} */
    const tries = [];
    /** @type {import('electron').NativeImage | null} */
    let image = null;
    let colors = 0;
    for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await delay(CAPTURE_RETRY_MS);
      try {
        const captured = await within(win.webContents.capturePage(), CAPTURE_MS, 'capturePage');
        image = captured;
        colors = captured.isEmpty() ? 0 : countDistinctColors(captured.toBitmap());
        if (colors >= MIN_SCREENSHOT_COLORS) break;
        tries.push(`${attempt}회: 색 ${colors}개`);
      } catch (err) {
        tries.push(`${attempt}회: ${errorText(err)}`);
      }
    }
    const file = path.join(args.outDir, SCREENSHOT_FILE);
    const shot = image;
    const saved = shot !== null && !shot.isEmpty();
    if (saved) {
      fs.mkdirSync(args.outDir, { recursive: true });
      fs.writeFileSync(file, shot.toPNG());
    }
    const size = shot === null ? null : shot.getSize();
    const problems = [];
    if (colors < MIN_SCREENSHOT_COLORS) problems.push(`서로 다른 색이 ${colors}개다(최소 ${MIN_SCREENSHOT_COLORS}) — ${tries.join(', ')}`);
    const note = `${wasVisible ? '' : '보이지 않던 창을 보인 뒤 · '}프레임 ${painted === true ? '그림' : '확인 못 함'}`;
    return verdictOf(
      problems.map((problem) => `${problem} (${note})`),
      `${size === null ? '' : `${size.width}×${size.height} · `}서로 다른 색 ${colors}개(최소 ${MIN_SCREENSHOT_COLORS}) · ${note} → ${saved ? file : '저장 안 함'}`,
    );
  }

  /**
   * noNetwork — 가드가 기록한 원격 요청이 기대 목록과 같다. 기대 목록에는 늘 가드 탐침이 있다: 메인 쪽에서 창의 세션으로 보낸 요청을
   * 가드가 기록 · 취소해야 '아무것도 못 봤다' 와 '가드가 없다' 가 갈린다. 탐침이 응답을 받으면 실패다. 창의 세션이 main 이 가드를 단
   * 기본 세션이어야 한다(아니면 창의 요청은 가드를 지나지 않는다).
   * @returns {Promise<CheckVerdict>}
   */
  async function checkNoNetwork() {
    const contents = trayWindow().webContents;
    const problems = [];
    if (contents.session !== session.defaultSession) problems.push('창의 세션이 main 이 가드를 단 기본 세션이 아니다');
    /** @type {string} */
    let probe;
    try {
      const response = await within(contents.session.fetch(GUARD_PROBE_URL), GUARD_PROBE_MS, '가드 탐침');
      probe = `응답 ${response.status}`;
      problems.push(`가드 탐침이 응답(${response.status})을 받았다 — 가드가 취소하지 않았다`);
    } catch (err) {
      probe = `거부(${errorText(err)})`;
    }
    const recorded = evaluateNoNetwork(facts.requests, [GUARD_PROBE_URL]);
    if (!recorded.ok) problems.push(recorded.detail);
    return verdictOf(problems, `${recorded.detail} — 가드 탐침 ${GUARD_PROBE_URL} 를 기록 · 취소했다(${probe})`);
  }

  /**
   * loginItem — openAtLogin 이 시작(실행기를 만들 때) · 끝(지금) 모두 false 다(내 PC 의 로그인 항목을 바꾸지 않았다).
   * @returns {CheckVerdict}
   */
  function checkLoginItem() {
    const atEnd = readLoginItem();
    const problems = [];
    if (loginItemAtStart !== false) problems.push(`시작의 openAtLogin 이 ${show(loginItemAtStart)} 다`);
    if (atEnd !== false) problems.push(`끝의 openAtLogin 이 ${show(atEnd)} 다`);
    return verdictOf(problems, 'openAtLogin 시작 · 끝 모두 false');
  }

  /**
   * 성공 결과를 쓴다 — stage · error 없음(판정기는 그 둘이 있으면 실패로 본다). 메모 필드 중 aiWorker · aiAnswered · ms 는 ai 검사
   * (Task 11) 전에는 재지 않는다: 'unused' · false · 0 은 'AI 를 부르지 않았다' 는 뜻이다. cspViolations 는 preload 가 보낸 위반 수다.
   */
  function writeSuccess() {
    /** @type {import('../lib/smokeResult.cjs').SmokeResult} */
    const result = {
      nonce: args.nonce,
      required: requiredChecks({ net: args.net, supabaseOrigin: trayBuild.supabaseOrigin }),
      checks: [...checks],
      versions: versions(),
      build: { supabaseOrigin: trayBuild.supabaseOrigin, workerScript: trayBuild.workerScript, builtAt: trayBuild.builtAt, commit: trayBuild.commit },
      boot: checks.some((entry) => entry.name === 'boot' && entry.ok),
      cspViolations: facts.cspEvents.length,
      aiWorker: 'unused',
      aiAnswered: false,
      ms: 0,
    };
    writeResultAtomic(args.outDir, result);
    state.phase = 'succeeded';
  }

  return { record, open, networkGuard, registerIpc, beforeLoad, setTray, fail };
}

module.exports = { createSmokeRun };
