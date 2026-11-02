// desktop/smoke/run.cjs(앱 안 스모크 실행기) 시험 — createSmokeRun 에 구조 타입의 가짜 Electron 객체를 넘겨, main 의 순서(가드 →
// registerIpc → beforeLoad → setTray)로 꽂고 첫 did-finish-load 부터 장벽 → 수동 검사 → 능동 검사 → 장벽 → cspViolations · consoleErrors →
// canary → noNetwork · loginItem → 결과 → 붙은 메뉴 '종료' 까지 실제로 돌린다.
// 앱은 띄우지 않고 electron 은 import · require 하지 않는다(실행기도 하지 않는다 — Electron 객체는 main 이 넘긴다). 실제 바이너리의 판정은
// 스모크가 보고, 여기서는 가짜가 내놓는 사실이 바뀔 때 검사가 판정을 바꾸는지 본다 — 검사마다 음성 사례가 하나 이상 있다.
// - 가짜 페이지는 실행기가 보내는 코드의 태그 주석(smoke/pageScripts.cjs)으로 처리기를 고른다. 기본 처리기는 실제 앱이 낼 사실을 낸다:
//   - 탐색 · 새 창은 main 처럼 lib/navigation.cjs 의 가드를 실행기의 record · open 에 이어 부른다. 탐색은 Electron 44.9.3 의 실제 순서
//     (did-start-navigation → 가드 → did-stop-loading — 막힌 탐색에 did-fail-provisional-load 는 없다)로 사건을 낸다.
//   - 권한은 main 의 처리기처럼 lib/permissions.cjs 로 정하고 기록한다. app:// 응답 상태는 lib/appProtocol.cjs 의 resolveAppRequest 가 정한다.
//   - CSP 위반은 preload 처럼 tj-smoke-csp 로 보내고 격리 world 버퍼(world 999)에도 남긴다.
//   사례는 처리기 하나를 바꿔 그 검사의 음성 갈래를 탄다.
// - 가짜 기본 세션의 fetch 와 페이지의 원격 요청은 Electron 처럼 onBeforeRequest(붙어 있으면)를 먼저 지난다. 탐침은 { cancel: true } 면
//   가드의 취소(net::ERR_BLOCKED_BY_CLIENT)로 거부되고, {} 면 망으로 간다 — .invalid 는 DNS 에서 거부된다(사례가 정하면 응답한다).
// - securityWarnings: 경고 검사의 켜짐은 main 프로세스의 execPath · ELECTRON_ENABLE_SECURITY_WARNINGS 로 추론한다 — 사례마다 정하고
//   afterEach 가 되돌린다. 플랫폼마다 다른 규칙은 securityWarningsArming 을 바로 불러 본다.
// - 실행은 가짜 시계(setTimeout · clearTimeout · Date) 위에서 돈다(drive — 몇 바퀴 돌리고 시계를 민다). 그래서 상한까지 기다리는 사례도
//   빨리 끝나고, 실행기의 기다림은 모두 같은 시계를 따른다(runFast 는 그런 사례라는 표시일 뿐 같은 실행이다).
// - 결과는 mkdtemp(한글 · 공백 이름)의 outDir/result.json 을 읽는다. 실행기의 60초 감시 타이머는 '종료' 와 afterEach 의 will-quit 이 끈다.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTrayBuildInfo, buildTrayCsp } from '../../scripts/trayBuild.ts';

const require = createRequire(import.meta.url);
const { RESULT_FILE } = require('./smokeOut.cjs') as typeof import('./smokeOut.cjs');
const { requiredChecks } = require('./smokeResult.cjs') as typeof import('./smokeResult.cjs');
const { resolveAppRequest } = require('./appProtocol.cjs') as typeof import('./appProtocol.cjs');
const { createNavigationGuards } = require('./navigation.cjs') as typeof import('./navigation.cjs');
const { isPermissionAllowed } = require('./permissions.cjs') as typeof import('./permissions.cjs');

/** 기본 세션의 onBeforeRequest 처리기 — main 이 networkGuard 를 단다. */
type Guard = (details: { url: unknown; method?: unknown }, callback: (response: { cancel?: boolean }) => void) => void;
/** 실행기가 main 에 내주는 것 중 이 시험이 부르는 것 — run.cjs 의 JSDoc 타입(electron 타입)을 끌어오지 않게 구조 타입으로 적는다. */
type SmokeRun = {
  record(entry: unknown): void;
  open(href: string): void;
  networkGuard: Guard;
  registerIpc(ipc: { on(channel: string, listener: (event: unknown, payload: unknown) => void): void }): void;
  beforeLoad(win: unknown): void;
  setTray(tray: unknown, menu: unknown): void;
};
/** securityWarningsArming 이 읽는 main 의 process 값. */
type Proc = { platform: string; execPath: string; env: Record<string, string | undefined> };
const { createSmokeRun, securityWarningsArming } = require('../smoke/run.cjs') as {
  createSmokeRun(input: Record<string, unknown>): SmokeRun;
  securityWarningsArming(proc: Proc): { armed: boolean; detail: string };
};

type Check = { name: string; ok: boolean; detail: string };
type TrayBuild = ReturnType<typeof buildTrayBuildInfo>;
type FileIndex = import('./appProtocol.cjs').FileIndex;
/** preload 가 옮기는 위반 한 건(6필드). */
type Violation = { blockedURI: string; effectiveDirective: string; originalPolicy: string; disposition: string; sourceFile: string; lineNumber: number };

const NONCE = '논스 시험';
const APP_VERSION = '0.1.0';
const ELECTRON_VERSION = '44.9.3';
const SMOKE_URL = 'app://twelvejanggi/tray.html?smoke';
/** check 처리기가 받는 requestingOrigin — 끝 슬래시가 붙은 출처. */
const APP_ORIGIN_SLASH = 'app://twelvejanggi/';
const RENDERER_PID = 4242;
/** 가드 탐침(판결 1)과 그 상한 — 실행기가 메인 쪽에서 창의 세션으로 보내는 요청. */
const PROBE_URL = 'https://example.invalid/tj-net-guard-probe';
const PROBE_CAP_MS = 5_000;
/** 실행기가 다시 보는 간격 — 가짜 시계를 이만큼씩 민다. */
const POLL_MS = 50;
/** Electron 이 가드의 취소로 탐침을 거부할 때의 글(실제 스모크가 본 그대로). */
const BLOCKED = 'net::ERR_BLOCKED_BY_CLIENT';
const NOT_RESOLVED = 'net::ERR_NAME_NOT_RESOLVED';
const ENABLE = 'ELECTRON_ENABLE_SECURITY_WARNINGS';
const WORKER_SCRIPT = 'assets/ai.worker.js';
const AI_MS = 37;
const MIME_HTML = 'text/html; charset=utf-8';
const MIME_JS = 'text/javascript; charset=utf-8';
const CANARY_URL = 'https://example.invalid/tj-csp-canary';
/** 탐색 검사가 쓰는 허용 목록 주소 — 새 창(저장소)과 메인 프레임 탐색(허브). */
const REPO_URL = 'https://github.com/khkim3115/TwelveJanggi';
const HUB_URL = 'https://khkim3115.github.io/';
/** 격리 world 버퍼를 읽는 코드(브리프의 값 그대로). */
const ISOLATED_CODE = '({ probe: globalThis.__tjIsoProbe, buf: globalThis.__tjCspBuffer })';
/** 빌드 — default: Supabase 값 없음 · invalid: CI 의 가짜 값 · real: 실제 값 모양. */
const SUPABASE_URLS = { default: undefined, invalid: 'https://ci.invalid', real: 'https://abcd.supabase.co' } as const;
const CONNECT_PROBES = ['https://ci.invalid/tj-connect-probe', 'wss://ci.invalid/tj-connect-probe'];
const SETTINGS_URL = 'https://abcd.supabase.co/auth/v1/settings';
/** supabase-js 가 여는 Realtime 소켓 — 쿼리(apikey · vsn)가 붙는다. */
const SOCKET_URL = 'wss://abcd.supabase.co/realtime/v1/websocket?apikey=anon-key&vsn=1.0.0';
/** 실행기가 결과에 싣는 검사(실행 순서) — 조건부 검사(.invalid 빌드의 connectAllowed · --net 의 net)는 permissions 뒤에 온다. */
const BEFORE_CONDITIONAL = ['boot', 'webPreferences', 'sandboxEffective', 'bridge', 'ipc', 'mime', 'securityWarnings', 'tray', 'screenshot', 'cspMeta', 'cspHeader', 'protocol', 'ai', 'navigation', 'permissions'];
const AFTER_CONDITIONAL = ['cspViolations', 'consoleErrors', 'cspCanary', 'noNetwork', 'loginItem'];
/** main 프로세스의 execPath — 이 플랫폼의 개발 바이너리(경고 검사가 켜진다)와 그 밖의 실행 파일(켜지지 않는다). */
const DEV_BINARY =
  process.platform === 'win32' ? 'D:\\홍 길동\\desktop\\node_modules\\electron\\dist\\electron.exe' : '/home/홍 길동/desktop/node_modules/electron/dist/electron';
const OTHER_BINARY = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node';

/** 페이지 코드의 태그 주석(smoke/pageScripts.cjs) — 이름과 인자 JSON. 가짜 페이지는 이것으로 코드를 가른다(본문은 해석하지 않는다). */
const TAG_RE = /^\/\* tj-smoke:([\w-]+)(?: (.*?))? \*\/ /s;
/** getLastWebPreferences() — Electron 44.9.3 이 돌려주는 모양(기본값 키를 채운다). */
const WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  enableBlinkFeatures: '',
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  webviewTag: false,
};
/** capturePage() — 서로 다른 색 16개(검은 화면이 아니다). */
const SCREEN = {
  isEmpty: () => false,
  toBitmap: () => Buffer.from(Array.from({ length: 16 * 4 }, (_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) * 16))),
  toPNG: () => Buffer.from('png'),
  getSize: () => ({ width: 4, height: 4 }),
};

/** 가짜 앱 — 페이지 처리기가 사실을 낼 때 쓰는 자리(콘솔 · 위반 · 원격 요청 · 탐색 · 결정 기록). */
type FakeApp = {
  build: TrayBuild;
  /** main 이 webContents 에 거는 탐색 가드 — 실행기의 record · open 에 잇는다 */
  guards: ReturnType<typeof createNavigationGuards>;
  /** main 의 권한 처리기가 결정마다 부르는 기록기(= 실행기의 record) */
  record(entry: unknown): void;
  /** 허용 목록 주소를 여는 함수(= 실행기의 open — 열지 않고 기록한다) */
  open(href: string): void;
  log(level: 'info' | 'warning' | 'error', message: string): void;
  /** preload 처럼 위반을 tj-smoke-csp 로 보내고 격리 world 버퍼에도 남긴다(buffer false 면 보내기만 한다 — 유실) */
  violate(event: Violation, options?: { buffer?: boolean }): void;
  /** 페이지의 원격 요청 — onBeforeRequest(붙어 있으면)를 지난다. 가드가 정한 처리를 돌려준다 */
  request(url: string, method?: string): Promise<'cancelled' | 'passed'>;
  /** 트레이 창의 webContents 사건을 낸다(did-start-navigation · did-stop-loading …) */
  emit(event: string, ...args: unknown[]): void;
  commit(url: string): void;
  url(): string;
};
type PageHandler = (arg: unknown, app: FakeApp) => unknown;

type Scenario = {
  /**
   * 기본 세션의 onBeforeRequest — run: 실행기의 가드 그대로(기록 · 취소) · pass: 실행기가 기록한 뒤 {} 로 통과시킨다 ·
   * hang: 실행기가 기록한 뒤 콜백을 부르지 않는다 · foreign: 실행기의 가드 없이 취소만 한다(기록 없음) · none: 붙이지 않는다. 기본 run
   */
  guard?: 'run' | 'pass' | 'hang' | 'foreign' | 'none';
  /** 가드를 지난 탐침의 끝 — unresolved: DNS 실패(.invalid) · respond: 200 응답. 기본 unresolved */
  network?: 'unresolved' | 'respond';
  /** 가드가 취소한 탐침의 거부 — 기본 new Error(BLOCKED) */
  blocked?: () => unknown;
  /** 첫 장벽 표식보다 먼저 오는 콘솔 줄(warning) */
  warningsBeforeMarker?: readonly string[];
  /** n 번째 장벽(1부터)이 표식을 콘솔에 찍는가 — 기본 늘 찍는다 */
  barrierMarks?: (n: number) => boolean;
  /** main 프로세스의 execPath · ELECTRON_ENABLE_SECURITY_WARNINGS(없으면 지운다). 기본은 런처처럼 env 로 켠다 */
  arming?: { execPath: string; enable?: string };
  /** tray-build.json 의 Supabase 값 — 기본 default */
  build?: keyof typeof SUPABASE_URLS;
  /** --net. 기본 false */
  net?: boolean;
  /** tray-build.json 의 workerScript. 기본 WORKER_SCRIPT */
  workerScript?: string | null;
  /** 페이지 처리기 바꾸기(태그 → 처리기) — 그 검사의 음성 갈래 */
  page?: Partial<Record<string, PageHandler>>;
  /** 격리 world 의 답 — 기본은 preload 처럼 world 999 에서만 { probe: 1, buf: 버퍼 } */
  isolated?: (buffer: readonly Violation[]) => unknown;
  /** main 의 net.fetch(app://…) 답 — 기본은 resolveAppRequest 의 상태 */
  mainFetch?: (url: string) => Promise<{ status: number }>;
  /** 렌더러 루트 바로 위의 package.json 을 깔지 않는다(탈출 검사의 전제가 깨진다) */
  noParentFile?: boolean;
};
type Outcome = {
  result: Record<string, unknown>;
  checks: Check[];
  fetches: string[];
  quits: number;
  exits: number[];
  /** 가짜 페이지가 받은 코드의 태그(순서대로) */
  pageCalls: string[];
  isolatedCalls: Array<{ worldId: number; codes: string[] }>;
};
type Running = { fetches: string[]; ended(): boolean; finish(): Promise<Outcome> };
type Rig = { run: SmokeRun; start(): Running };

let base = '';
let restoreProcess = (): void => {};
/** 이번 사례의 실행기에 will-quit 을 낸다 — 감시 타이머가 남았으면 끈다. */
let quitApp: (() => void) | null = null;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tj-실행기 '));
  const execPath = process.execPath;
  const enable = process.env[ENABLE];
  restoreProcess = () => {
    process.execPath = execPath;
    if (enable === undefined) delete process.env[ENABLE];
    else process.env[ENABLE] = enable;
  };
});

afterEach(() => {
  vi.useRealTimers();
  quitApp?.();
  quitApp = null;
  restoreProcess();
  rmSync(base, { recursive: true, force: true });
});

/** setImmediate 로 한 바퀴씩 돈다(가짜 시계가 건드리지 않는다). 실행기의 흐름은 마이크로태스크라 몇 바퀴면 된다. */
async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** predicate 가 참이 될 때까지 돈다 — 2초(실제 시각) 안에 오지 않으면 던진다. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what}: 2초 안에 오지 않았다`);
    await turns(1);
  }
}

/** 가짜 시계 위에서 돈다 — 몇 바퀴 돌리고, cond 가 아직이면 시계를 POLL_MS 민다. 200초를 밀어도 안 되면 던진다. */
async function drive(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 4_000; i += 1) {
    await turns(3);
    if (cond()) return;
    vi.advanceTimersByTime(POLL_MS);
  }
  throw new Error('가짜 시계로 200초를 밀어도 끝나지 않았다');
}

/** Electron 44.9.3 의 탐색(실제 스모크에서 본 순서) — did-start-navigation → will-frame-navigate → (막으면) did-stop-loading.
 * will-frame-navigate 가 막으면 will-navigate 는 오지 않고(alsoWillNavigate 면 온다), did-fail-provisional-load 도 없다(그 사건은 오류
 * 페이지로 들어간 탐색에만 난다). 막지 않은 탐색은 들어간다(URL 이 바뀐다). silent 면 did-stop-loading 이 없다(탐색이 끝나지 않았다). */
function electronNavigate(app: FakeApp, url: string, { alsoWillNavigate = false, silent = false } = {}): void {
  let prevented = false;
  const event = {
    url,
    preventDefault: () => {
      prevented = true;
    },
  };
  app.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
  app.guards.willFrameNavigate(event);
  if (!prevented || alsoWillNavigate) app.guards.willNavigate(event);
  setImmediate(() => {
    if (!prevented) app.commit(url);
    if (!silent) app.emit('did-stop-loading');
  });
}

/** main 의 권한 처리기 — lib/permissions.cjs 로 정하고 결정마다 기록한다(check 는 requestingOrigin, request 는 requestingUrl).
 * later 면 기록을 다음 바퀴로 미룬다(페이지의 답이 기록보다 먼저 온다). */
function decideLikeMain(app: FakeApp, { later = false } = {}): unknown {
  const note = (entry: unknown): void => {
    if (later) setImmediate(() => app.record(entry));
    else app.record(entry);
  };
  const check = (permission: string): string => {
    const allowed = isPermissionAllowed({ permission, requestingOrigin: APP_ORIGIN_SLASH, requestingUrl: SMOKE_URL });
    note({ kind: 'permission-check', permission, url: APP_ORIGIN_SLASH, allowed });
    return allowed ? 'granted' : 'denied';
  };
  const request = (permission: string): boolean => {
    const allowed = isPermissionAllowed({ permission, requestingUrl: SMOKE_URL });
    note({ kind: 'permission-request', permission, url: SMOKE_URL, allowed });
    return allowed;
  };
  return {
    checks: { notifications: check('notifications'), geolocation: check('geolocation'), clipboardWrite: check('clipboard-sanitized-write') },
    notificationPermission: check('notifications'),
    requested: request('notifications') ? 'granted' : 'denied',
    geolocation: request('geolocation') ? 'position' : 'error 1',
  };
}

/** 페이지의 connectProbe() — .invalid 빌드에서 https 를 fetch 하고 wss 소켓을 연다. 가드가 취소한 소켓은 Chromium 이 콘솔 error 를 남긴다. */
async function probeLikePage(app: FakeApp, { socket = true } = {}): Promise<unknown> {
  const origin = app.build.supabaseOrigin;
  if (origin === null || !new URL(origin).hostname.endsWith('.invalid')) return { attempted: [] };
  const [http = '', ws = ''] = CONNECT_PROBES;
  const attempted = [http];
  await app.request(http);
  if (socket) {
    attempted.push(ws);
    await app.request(ws);
    app.log('error', `WebSocket connection to '${ws}' failed: `);
  }
  return { attempted };
}

/** 페이지의 net() — 설정 GET(apikey 머리글이라 CORS 사전 요청 OPTIONS 가 먼저 간다)과 Realtime 소켓. result 는 덮어쓸 필드. */
async function netLikePage(app: FakeApp, result: Record<string, unknown> = {}): Promise<unknown> {
  const preflight = await app.request(SETTINGS_URL, 'OPTIONS');
  const settings = preflight === 'passed' ? await app.request(SETTINGS_URL, 'GET') : 'cancelled';
  const socket = await app.request(SOCKET_URL, 'GET');
  return {
    configured: true,
    settingsStatus: settings === 'passed' ? 200 : null,
    realtimeConnected: socket === 'passed',
    joinStatus: socket === 'passed' ? 'SUBSCRIBED' : null,
    error: null,
    ...result,
  };
}

/** Chromium 의 canary — CSP 가 막은 fetch 하나가 정책마다 위반 하나 · 콘솔 error 하나를 낸다. */
function canaryLikeChromium(app: FakeApp, { policies = ['meta', 'header'] as ReadonlyArray<'meta' | 'header'>, errors = 2 } = {}): string {
  for (const which of policies) {
    app.violate({ blockedURI: CANARY_URL, effectiveDirective: 'connect-src', originalPolicy: app.build.csp[which], disposition: 'enforce', sourceFile: '', lineNumber: 0 });
  }
  for (let i = 0; i < errors; i += 1) {
    app.log('error', `Refused to connect to '${CANARY_URL}' because it violates the following Content Security Policy directive: "connect-src 'self'".`);
  }
  return 'rejected TypeError: Failed to fetch';
}

/** 실제 앱이 낼 페이지 사실 — 태그마다. 장벽은 rig 가 따로 본다(표식을 콘솔에 찍는다). */
function healthyPage(index: FileIndex): Record<string, PageHandler> {
  return {
    boot: () => ({ rootChildren: 1, title: '십이장기', version: APP_VERSION, bodyBackground: 'rgb(13, 17, 23)', bgToken: '#0d1117', colorScheme: 'dark' }),
    'main-world': () => ({ isoProbe: 'undefined', cspBuffer: 'undefined', require: 'undefined', process: 'undefined' }),
    'disable-warnings': () => false,
    bridge: () => ({ keys: ['getAppInfo'], contract: ['getAppInfo'] }),
    frames: () => true,
    'csp-meta': (_arg, app) => ({ contents: [app.build.csp.meta], inHead: [true] }),
    'csp-header': (arg, app) =>
      (arg as string[]).map((url) => ({ url, status: 200, csp: app.build.csp.header, nosniff: 'nosniff', contentType: url.endsWith('.html') ? MIME_HTML : MIME_JS })),
    protocol: (arg) =>
      (arg as Array<{ url: string; method: string }>).map(({ url, method }) => ({ url, method, status: resolveAppRequest({ url, method }, index).status })),
    ai: () => ({ aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS }),
    'window-open': (arg, app) => app.guards.windowOpen({ url: String(arg) }).action === 'deny',
    navigate: (arg, app) => {
      electronNavigate(app, String(arg));
      return true;
    },
    location: (_arg, app) => app.url(),
    permissions: (_arg, app) => decideLikeMain(app),
    'connect-probe': (_arg, app) => probeLikePage(app),
    net: (_arg, app) => netLikePage(app),
    canary: (_arg, app) => canaryLikeChromium(app),
  };
}

/** 실행기를 만들어 main 의 순서로 꽂는다. start() 가 첫 did-finish-load 를 낸다 — finish 는 '종료' 클릭이나 exit 까지 기다려 결과를 읽는다. */
function rigScenario(scenario: Scenario = {}): Rig {
  const {
    guard = 'run',
    network = 'unresolved',
    blocked = () => new Error(BLOCKED),
    warningsBeforeMarker = [],
    arming = { execPath: OTHER_BINARY, enable: '1' },
    build = 'default',
    net = false,
    workerScript = WORKER_SCRIPT,
  } = scenario;
  process.execPath = arming.execPath;
  if (arming.enable === undefined) delete process.env[ENABLE];
  else process.env[ENABLE] = arming.enable;

  // 앱 폴더 — ipc 검사가 desktop 패키지 · 고정한 electron 패키지의 version 을 읽는다. 렌더러 루트 — protocol 검사의 전제(바로 위의
  // package.json · 디렉터리 assets · tray-build.json)를 깐다
  const appRoot = join(base, 'desktop');
  const rendererRoot = join(base, 'dist-tray');
  const outDir = join(base, 'smoke out');
  mkdirSync(join(appRoot, 'node_modules', 'electron'), { recursive: true });
  mkdirSync(join(rendererRoot, 'assets'), { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ version: APP_VERSION }));
  writeFileSync(join(appRoot, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: ELECTRON_VERSION }));
  if (scenario.noParentFile !== true) writeFileSync(join(base, 'package.json'), JSON.stringify({ name: '저장소' }));
  const trayBuild = buildTrayBuildInfo(buildTrayCsp(SUPABASE_URLS[build]), workerScript, '2026-10-29T00:00:00.000Z', null);
  writeFileSync(join(rendererRoot, 'tray-build.json'), JSON.stringify(trayBuild));
  const index: FileIndex = {
    files: new Map([
      ['tray.html', join(rendererRoot, 'tray.html')],
      [WORKER_SCRIPT, join(rendererRoot, WORKER_SCRIPT)],
    ]),
    unmapped: [],
  };

  const appEvents = new EventEmitter();
  quitApp = () => appEvents.emit('will-quit');
  const exits: number[] = [];
  let quits = 0;
  const app = {
    on: (event: string, listener: () => void) => appEvents.on(event, listener),
    exit: (code: number) => exits.push(code),
    getVersion: () => APP_VERSION,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    getAppMetrics: () => [{ pid: RENDERER_PID, sandboxed: true, integrityLevel: 'untrusted' }],
    hasSingleInstanceLock: () => true,
  };

  let beforeRequest: Guard | null = null;
  const fetches: string[] = [];
  const defaultSession = {
    webRequest: {
      onBeforeRequest: (listener: Guard) => {
        beforeRequest = listener;
      },
    },
    /** Electron 의 session.fetch 처럼 onBeforeRequest 를 먼저 지난다. */
    fetch: (url: string): Promise<{ status: number }> => {
      fetches.push(url);
      return new Promise((resolve, reject) => {
        const toNetwork = (): void => {
          if (network === 'respond') resolve({ status: 200 });
          else reject(new Error(NOT_RESOLVED));
        };
        const listener = beforeRequest;
        if (listener === null) toNetwork();
        else listener({ url, method: 'GET' }, (response) => (response.cancel === true ? reject(blocked()) : toNetwork()));
      });
    },
  };

  const events = new EventEmitter();
  const ipc = new Map<string, (event: unknown, payload: unknown) => void>();
  const buffer: Violation[] = [];
  const pageCalls: string[] = [];
  const isolatedCalls: Outcome['isolatedCalls'] = [];
  let currentUrl = SMOKE_URL;
  let barriers = 0;
  const handlers: Record<string, PageHandler | undefined> = { ...healthyPage(index), ...scenario.page };
  const info = { version: APP_VERSION, electron: ELECTRON_VERSION, chrome: process.versions.chrome, platform: process.platform };
  const contents = Object.assign(events, {
    session: defaultSession,
    getURL: () => currentUrl,
    getOSProcessId: () => RENDERER_PID,
    getLastWebPreferences: () => ({ ...WEB_PREFERENCES }),
    capturePage: async () => SCREEN,
    executeJavaScript: async (code: string): Promise<unknown> => {
      const tag = TAG_RE.exec(code);
      if (tag === null) throw new Error(`가짜 페이지가 모르는 코드다(태그 없음): ${code.slice(0, 60)}`);
      const [, name = '', json] = tag;
      pageCalls.push(name);
      const arg: unknown = json === undefined ? undefined : JSON.parse(json);
      if (name === 'barrier') {
        // 장벽 — getAppInfo 왕복 뒤 표식을 콘솔에 찍는다. 첫 장벽에서는 그보다 먼저 온 줄을 앞에 둔다
        barriers += 1;
        if (barriers === 1) for (const message of warningsBeforeMarker) events.emit('console-message', { level: 'warning', message, sourceId: '', lineNumber: 0 });
        if (scenario.barrierMarks?.(barriers) ?? true) events.emit('console-message', { level: 'info', message: String(arg), sourceId: '', lineNumber: 1 });
        return info;
      }
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`가짜 페이지에 '${name}' 처리기가 없다`);
      return handler(arg, fakeApp);
    },
    executeJavaScriptInIsolatedWorld: async (worldId: number, scripts: Array<{ code: string }>): Promise<unknown> => {
      isolatedCalls.push({ worldId, codes: scripts.map((script) => script.code) });
      if (scenario.isolated !== undefined) return scenario.isolated(buffer);
      // preload 의 격리 world 전역은 world 999 에서만 보인다
      return worldId === 999 ? { probe: 1, buf: buffer.map((violation) => ({ ...violation })) } : { probe: undefined, buf: undefined };
    },
  });
  let visible = true;
  let focused = true;
  const win = {
    webContents: contents,
    isVisible: () => visible,
    isFocused: () => focused,
    hide: () => {
      visible = false;
      focused = false;
    },
    show: () => {
      visible = true;
    },
  };
  const tray = { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }) };
  const menu = {
    items: [
      {
        label: '열기',
        click: () => {
          visible = true;
          focused = true;
        },
      },
      {
        label: '종료',
        click: () => {
          quits += 1;
          appEvents.emit('before-quit');
          appEvents.emit('will-quit');
        },
      },
    ],
  };
  const mainFetch = scenario.mainFetch ?? (async (url: string) => ({ status: resolveAppRequest({ url, method: 'GET' }, index).status }));

  const run = createSmokeRun({
    args: { enabled: true, outDir, profile: join(base, 'profile'), net, nonce: NONCE, error: null },
    app,
    session: { defaultSession },
    net: { fetch: mainFetch },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 64, height: 64 }) }) },
    trayBuild,
    rendererRoot,
    appRoot,
    index,
  });
  const fakeApp: FakeApp = {
    build: trayBuild,
    guards: createNavigationGuards({ open: run.open, record: run.record }),
    record: run.record,
    open: run.open,
    log: (level, message) => events.emit('console-message', { level, message, sourceId: '', lineNumber: 0 }),
    violate: (event, { buffer: buffered = true } = {}) => {
      if (buffered) buffer.push(event);
      ipc.get('tj-smoke-csp')?.({}, { ...event });
    },
    request: (url, method = 'GET') =>
      new Promise((resolve) => {
        const listener = beforeRequest;
        if (listener === null) resolve('passed');
        else listener({ url, method }, (response) => resolve(response.cancel === true ? 'cancelled' : 'passed'));
      }),
    emit: (event, ...args) => {
      events.emit(event, ...args);
    },
    commit: (url) => {
      currentUrl = url;
    },
    url: () => currentUrl,
  };
  // 사례의 onBeforeRequest — main 의 순서대로 가드가 먼저다. null 이면 붙이지 않는다
  const guards: Record<NonNullable<Scenario['guard']>, Guard | null> = {
    run: run.networkGuard,
    pass: (details, callback) => run.networkGuard(details, () => callback({})),
    hang: (details) => run.networkGuard(details, () => {}),
    foreign: (_details, callback) => callback({ cancel: true }),
    none: null,
  };
  const attached = guards[guard];
  if (attached !== null) defaultSession.webRequest.onBeforeRequest(attached);
  run.registerIpc({ on: (channel, listener) => ipc.set(channel, listener) });
  run.beforeLoad(win);
  run.setTray(tray, menu);
  ipc.get('tj-smoke-preload')?.({}, { sandboxed: true, contextIsolated: true });

  const ended = (): boolean => quits > 0 || exits.length > 0;
  return {
    run,
    start(): Running {
      events.emit('did-finish-load');
      return {
        fetches,
        ended,
        async finish(): Promise<Outcome> {
          await waitFor(ended, "결과 뒤 '종료' 클릭이나 exit");
          const result = JSON.parse(readFileSync(join(outDir, RESULT_FILE), 'utf8')) as Record<string, unknown>;
          return { result, checks: result.checks as Check[], fetches, quits, exits, pageCalls, isolatedCalls };
        },
      };
    },
  };
}

const startScenario = (scenario?: Scenario): Running => rigScenario(scenario).start();

/** 가짜 시계로 끝까지 돈다 — 실행기의 기다림(사건 5초 · 페이지 호출 상한 · 감시 타이머)은 모두 이 시계를 따른다. */
async function runScenario(scenario?: Scenario): Promise<Outcome> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const running = startScenario(scenario);
    await drive(running.ended);
    return await running.finish();
  } finally {
    vi.useRealTimers();
  }
}

/** 상한까지 기다리는 사례 — 같은 가짜 시계 위의 실행이다(이름은 무엇을 보는 사례인지 드러낸다). */
const runFast = runScenario;

/** 결과의 그 검사(한 번만 있다). */
function checkOf(outcome: Outcome, name: string): Check {
  const found = outcome.checks.filter((check) => check.name === name);
  expect(found.map((check) => check.name), `${name} 검사는 한 번`).toStrictEqual([name]);
  return found[0] as Check;
}

/** ok 가 아닌 검사 [이름, detail]. */
const failing = (outcome: Outcome): string[][] => outcome.checks.filter((entry) => !entry.ok).map((entry) => [entry.name, entry.detail]);

/** 그 검사만 실패했다 — detail 에 fragments 가 모두 든다. 결과는 성공 경로(stage · error 없음, '종료' 한 번)다. */
function expectOnlyFailure(outcome: Outcome, name: string, fragments: readonly string[]): Check {
  expect(failing(outcome).map(([failed]) => failed)).toStrictEqual([name]);
  const check = checkOf(outcome, name);
  for (const fragment of fragments) expect(check.detail).toContain(fragment);
  expect([outcome.quits, outcome.exits]).toStrictEqual([1, []]);
  return check;
}

/** 위반 한 건(preload 모양). */
function violation(over: Partial<Violation> = {}): Violation {
  return { blockedURI: CANARY_URL, effectiveDirective: 'connect-src', originalPolicy: '', disposition: 'enforce', sourceFile: '', lineNumber: 0, ...over };
}

describe('전체 흐름 — 필수 검사가 모두 있고 ok 인 성공 결과', () => {
  /** 이 빌드 · --net 의 필수 검사(런처의 규칙) — 결과의 검사 이름 집합이 이것과 같아야 한다. */
  const requiredFor = (build: keyof typeof SUPABASE_URLS, net: boolean): string[] =>
    requiredChecks({ net, supabaseOrigin: buildTrayCsp(SUPABASE_URLS[build]).supabaseOrigin }).sort();

  it("기본 빌드 — 20개가 실행 순서대로 모두 ok · stage · error 없음 · 메모 필드는 ai() 와 canary 전 위반 수 · 붙은 메뉴 '종료' 한 번", async () => {
    const outcome = await runScenario();
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual([...BEFORE_CONDITIONAL, ...AFTER_CONDITIONAL]);
    expect([...outcome.checks.map((entry) => entry.name)].sort()).toStrictEqual(requiredFor('default', false));
    expect(failing(outcome)).toStrictEqual([]);
    expect(Object.keys(outcome.result).filter((key) => key === 'stage' || key === 'error')).toStrictEqual([]);
    expect(outcome.result.nonce).toBe(NONCE);
    expect([...(outcome.result.required as string[])].sort()).toStrictEqual(requiredFor('default', false));
    expect({
      boot: outcome.result.boot,
      cspViolations: outcome.result.cspViolations,
      aiWorker: outcome.result.aiWorker,
      aiAnswered: outcome.result.aiAnswered,
      ms: outcome.result.ms,
    }).toStrictEqual({ boot: true, cspViolations: 0, aiWorker: 'worker', aiAnswered: true, ms: AI_MS });
    expect([outcome.quits, outcome.exits]).toStrictEqual([1, []]);
    // 기본 빌드는 connectProbe · net 을 부르지 않는다 — 원격 요청은 가드 탐침뿐이다
    expect(outcome.pageCalls.filter((name) => name === 'connect-probe' || name === 'net')).toStrictEqual([]);
    expect(checkOf(outcome, 'noNetwork').detail).toContain('기대한 요청 1종만 기록됐다');
  });

  it('격리 world 는 world 999 에서 브리프의 코드로 읽는다 — cspViolations 와 cspCanary 가 한 번씩', async () => {
    const outcome = await runScenario();
    expect(outcome.isolatedCalls).toStrictEqual([
      { worldId: 999, codes: [ISOLATED_CODE] },
      { worldId: 999, codes: [ISOLATED_CODE] },
    ]);
  });

  it('.invalid 빌드 — connectAllowed 까지 21개 ok, noNetwork 는 탐침 + connectProbe 두 주소, consoleErrors 는 취소된 소켓의 오류를 뺀다', async () => {
    const outcome = await runScenario({ build: 'invalid' });
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual([...BEFORE_CONDITIONAL, 'connectAllowed', ...AFTER_CONDITIONAL]);
    expect([...outcome.checks.map((entry) => entry.name)].sort()).toStrictEqual(requiredFor('invalid', false));
    expect(failing(outcome)).toStrictEqual([]);
    expect(checkOf(outcome, 'connectAllowed').detail).toContain(CONNECT_PROBES.join(' · '));
    expect(checkOf(outcome, 'noNetwork').detail).toContain('기대한 요청 3종만 기록됐다');
    expect(checkOf(outcome, 'consoleErrors').detail).toContain('connectProbe 의 취소된 요청 오류 1건은 뺐다');
  });

  it('--net · 실제 값 빌드 — net 까지 21개 ok, noNetwork 는 탐침 + 인증 설정 · Realtime 소켓(가드가 통과시켰다)', async () => {
    const outcome = await runScenario({ build: 'real', net: true });
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual([...BEFORE_CONDITIONAL, 'net', ...AFTER_CONDITIONAL]);
    expect([...outcome.checks.map((entry) => entry.name)].sort()).toStrictEqual(requiredFor('real', true));
    expect(failing(outcome)).toStrictEqual([]);
    expect(checkOf(outcome, 'net').detail).toContain('join "SUBSCRIBED"');
    expect(checkOf(outcome, 'noNetwork').detail).toContain('기대한 요청 3종만 기록됐다');
  });
});

describe('noNetwork — 가드 탐침은 가드의 기록 + ERR_BLOCKED_BY_CLIENT 거부일 때만 센다(F1)', () => {
  it('가드가 기록하고 취소한다 → ok, detail 은 본 거부를 싣는다', async () => {
    const outcome = await runScenario();
    expect(outcome.fetches).toStrictEqual([PROBE_URL]);
    const check = checkOf(outcome, 'noNetwork');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(PROBE_URL);
    expect(check.detail).toContain(JSON.stringify(BLOCKED));
  });

  it('거부의 cause 에 ERR_BLOCKED_BY_CLIENT 가 들어도 취소다(fetch failed + cause 모양)', async () => {
    const check = checkOf(await runScenario({ blocked: () => new TypeError('fetch failed', { cause: new Error(BLOCKED) }) }), 'noNetwork');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(`fetch failed (cause: ${BLOCKED})`);
  });

  /** [사례, 시나리오, detail 에 들 글] — 취소를 증명하지 못한 탐침. detail 은 본 것을 말하고 통과 문장('가드가 기록했고')은 없다. */
  const NOT_CANCELLED: Array<[string, Scenario, string[]]> = [
    ['가드가 기록하고 취소하지 않는다 — .invalid 의 DNS 실패 거부', { guard: 'pass' }, [`거부 ${JSON.stringify(NOT_RESOLVED)} 로 끝났다`, 'ERR_BLOCKED_BY_CLIENT(가드의 취소)가 아니다']],
    ['가드가 기록하고 취소하지 않는다 — 응답을 받았다', { guard: 'pass', network: 'respond' }, ['응답(200)을 받았다 — 가드가 취소하지 않았다']],
    ['가드가 붙지 않았다 — 기록 없음 · DNS 실패 거부', { guard: 'none' }, [`거부 ${JSON.stringify(NOT_RESOLVED)} 로 끝났다`, `기대했지만 기록되지 않은 요청 1종: ${PROBE_URL}`]],
  ];
  it.each(NOT_CANCELLED)('%s → 실패', async (_label, scenario, fragments) => {
    const check = checkOf(await runScenario(scenario), 'noNetwork');
    expect(check.ok, check.detail).toBe(false);
    for (const fragment of fragments) expect(check.detail).toContain(fragment);
    expect(check.detail).not.toContain('가드가 기록했고');
  });

  it('실행기의 가드 없이 다른 무엇이 취소했다(ERR_BLOCKED_BY_CLIENT 이지만 기록 없음) → 실패, 이유는 기록뿐이다', async () => {
    const check = checkOf(await runScenario({ guard: 'foreign' }), 'noNetwork');
    expect(check.ok, check.detail).toBe(false);
    expect(check.detail).toBe(`기대했지만 기록되지 않은 요청 1종: ${PROBE_URL}`);
  });

  it('가드가 기록하고 콜백을 부르지 않는다 → 상한(5초)까지 기다린 뒤 실패, detail 은 끝나지 않았다고 말한다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const running = startScenario({ guard: 'hang' });
      await drive(() => running.fetches.length > 0);
      vi.advanceTimersByTime(PROBE_CAP_MS - 1);
      await turns(5);
      expect(running.ended(), '상한 전에는 기다린다').toBe(false);
      vi.advanceTimersByTime(1);
      await drive(running.ended);
      const check = checkOf(await running.finish(), 'noNetwork');
      expect(check.ok, check.detail).toBe(false);
      expect(check.detail).toBe(`가드 탐침이 ${PROBE_CAP_MS}ms 안에 끝나지 않았다(응답 · 거부 없음)`); // 기록은 됐다 — 상한만이 이유다
    } finally {
      vi.useRealTimers();
    }
  });

  it('기대 밖 원격 요청(페이지가 몰래 보낸 것)은 기록되고 취소되고 noNetwork 를 실패시킨다', async () => {
    const outcome = await runScenario({
      page: {
        ai: async (_arg, app) => {
          await app.request('https://example.invalid/tj-sneaky');
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    expectOnlyFailure(outcome, 'noNetwork', ['기대 밖 요청 1종: https://example.invalid/tj-sneaky']);
  });
});

describe('networkGuard — --net 일 때만 Supabase 두 요청(출처 + 경로)을 통과시키고 기록한다', () => {
  /** 가드의 답 — {} 면 통과, { cancel: true } 면 취소. 콜백은 한 번이다. */
  function answers(run: SmokeRun, url: unknown, method: string): unknown[] {
    const responses: unknown[] = [];
    run.networkGuard({ url, method }, (response) => responses.push(response));
    return responses;
  }
  /** [URL, 메서드, 통과하는가] — --net · 실제 값 빌드. */
  const NET_CASES: Array<[string, string, boolean]> = [
    [SETTINGS_URL, 'GET', true],
    [SETTINGS_URL, 'OPTIONS', true], // apikey 머리글이 만드는 CORS 사전 요청
    [`${SETTINGS_URL}?x=1`, 'GET', true], // 쿼리는 보지 않는다
    [SETTINGS_URL, 'POST', false],
    [SOCKET_URL, 'GET', true],
    ['wss://abcd.supabase.co/realtime/v1/websocket', 'GET', true],
    [SOCKET_URL, 'OPTIONS', false],
    [SOCKET_URL, 'POST', false],
    ['https://abcd.supabase.co/auth/v1/token?grant_type=refresh_token', 'POST', false],
    ['https://abcd.supabase.co/auth/v1/signup', 'POST', false],
    ['https://abcd.supabase.co/rest/v1/tj_rooms', 'GET', false],
    ['https://abcd.supabase.co/auth/v1/settings/', 'GET', false], // 경로가 다르다
    ['http://abcd.supabase.co/auth/v1/settings', 'GET', false], // 프로토콜이 다르다
    ['https://abcd.supabase.co:8443/auth/v1/settings', 'GET', false], // 포트가 다르다
    ['https://other.supabase.co/auth/v1/settings', 'GET', false],
    ['ws://abcd.supabase.co/realtime/v1/websocket', 'GET', false],
    ['https://abcd.supabase.co/realtime/v1/websocket', 'GET', false],
    [PROBE_URL, 'GET', false],
  ];
  it.each(NET_CASES)('--net · 실제 값: %s %s → 통과 %s (기록은 늘 한다)', (url, method, passes) => {
    const { run } = rigScenario({ build: 'real', net: true });
    expect(answers(run, url, method)).toStrictEqual([passes ? {} : { cancel: true }]);
  });

  /** --net 이 아니거나 통과시킬 출처가 없는 실행 — 원격은 모두 취소한다. */
  const NO_PASS: Array<[string, Scenario, string]> = [
    ['--net 아님 · 실제 값 빌드', { build: 'real' }, SETTINGS_URL],
    ['--net · 값 없는 빌드', { build: 'default', net: true }, SETTINGS_URL],
    ['--net · .invalid 빌드', { build: 'invalid', net: true }, 'https://ci.invalid/auth/v1/settings'],
  ];
  it.each(NO_PASS)('%s → %s GET 도 취소한다', (_label, scenario, url) => {
    const { run } = rigScenario(scenario);
    expect(answers(run, url, 'GET')).toStrictEqual([{ cancel: true }]);
    expect(answers(run, SOCKET_URL, 'GET')).toStrictEqual([{ cancel: true }]);
  });

  it('원격이 아닌 스킴은 그대로 두고, 이상한 details 에도 콜백을 한 번 부른다', () => {
    const { run } = rigScenario({ build: 'real', net: true });
    expect(answers(run, 'app://twelvejanggi/tray.html', 'GET')).toStrictEqual([{}]);
    expect(answers(run, undefined, 'GET')).toStrictEqual([{}]);
    expect(answers(run, SETTINGS_URL, undefined as unknown as string)).toStrictEqual([{ cancel: true }]);
  });
});

describe('securityWarnings — 경고 검사가 켜졌다는 근거가 있어야 0건이 뜻이 있다(F2)', () => {
  it('execPath 가 개발 바이너리 → ok, detail 은 그 근거와 main 의 값으로 추론했다는 말을 싣는다', async () => {
    const check = checkOf(await runScenario({ arming: { execPath: DEV_BINARY } }), 'securityWarnings');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(`경고 검사 켜짐: execPath ${JSON.stringify(DEV_BINARY)} 가`);
    expect(check.detail).toContain('main 프로세스의 값으로 추론했다 — 렌더러에서 본 것이 아니다');
    expect(check.detail).not.toContain(ENABLE);
  });

  it('ELECTRON_ENABLE_SECURITY_WARNINGS=1 → ok, detail 은 그 근거를 싣는다', async () => {
    const check = checkOf(await runScenario({ arming: { execPath: OTHER_BINARY, enable: '1' } }), 'securityWarnings');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(`경고 검사 켜짐: ${ENABLE}="1"(main 프로세스의 값으로 추론했다 — 렌더러에서 본 것이 아니다)`);
    expect(check.detail).not.toContain('execPath');
  });

  it('둘 다 아니다 → 경고 0건이어도 실패(경고 검사가 켜져 있지 않다)', async () => {
    const check = checkOf(await runScenario({ arming: { execPath: OTHER_BINARY } }), 'securityWarnings');
    expect(check.ok, check.detail).toBe(false);
    expect(check.detail.startsWith('경고 검사가 켜져 있지 않다'), check.detail).toBe(true);
  });

  it('켜졌지만 장벽 표식 전에 경고 한 줄 → 실패', async () => {
    const warning = '%cElectron Security Warning (Insecure Content-Security-Policy)';
    const check = checkOf(await runScenario({ warningsBeforeMarker: [warning] }), 'securityWarnings');
    expect(check.ok, check.detail).toBe(false);
    expect(check.detail).toContain(`음성 기록 1건: ${warning}`);
    expect(check.detail).not.toContain('경고 검사가 켜져 있지 않다');
  });
});

describe('securityWarningsArming — main 의 process 값으로 추론하는 켜짐(execPath 는 win32 만 대소문자 무시)', () => {
  /** [사례, 켜짐, main 의 값] */
  const CASES: Array<[string, boolean, Proc]> = [
    ['win32 · electron.exe', true, { platform: 'win32', execPath: 'C:\\홍 길동\\electron.exe', env: {} }],
    ['win32 · 대소문자 무시', true, { platform: 'win32', execPath: 'C:\\홍 길동\\ELECTRON.EXE', env: {} }],
    ['win32 · 패키지 실행 파일', false, { platform: 'win32', execPath: 'C:\\홍 길동\\TwelveJanggi.exe', env: {} }],
    ['win32 · 이름이 electron.exe 로 끝나는 다른 파일', false, { platform: 'win32', execPath: 'C:\\홍 길동\\myelectron.exe', env: {} }],
    ['linux · electron', true, { platform: 'linux', execPath: '/home/홍 길동/electron', env: {} }],
    ['linux · 대소문자를 가린다', false, { platform: 'linux', execPath: '/home/홍 길동/Electron', env: {} }],
    ['env 1', true, { platform: 'linux', execPath: '/usr/bin/node', env: { [ENABLE]: '1' } }],
    ['env 빈 값', false, { platform: 'win32', execPath: 'C:\\nodejs\\node.exe', env: { [ENABLE]: '' } }],
  ];
  it.each(CASES)('%s → 켜짐 %s', (_label, armed, proc) => {
    const arming = securityWarningsArming(proc);
    expect(arming.armed, arming.detail).toBe(armed);
    expect(arming.detail.startsWith(armed ? '경고 검사 켜짐: ' : '경고 검사가 켜져 있지 않다 — '), arming.detail).toBe(true);
    expect(arming.detail).toContain('렌더러에서 본 것이 아니다');
  });

  it('둘 다면 근거를 둘 다 싣는다(env 먼저)', () => {
    const execPath = 'C:\\홍 길동\\electron.exe';
    const { armed, detail } = securityWarningsArming({ platform: 'win32', execPath, env: { [ENABLE]: '1' } });
    expect(armed).toBe(true);
    expect(detail).toBe(`경고 검사 켜짐: ${ENABLE}="1" · execPath ${JSON.stringify(execPath)} 가 electron.exe 로 끝난다(main 프로세스의 값으로 추론했다 — 렌더러에서 본 것이 아니다)`);
  });
});

describe('cspMeta — 문서의 CSP meta 하나(<head>)가 csp.meta 와 같다(공백 정규화)', () => {
  it('공백만 다르면 같다', async () => {
    const outcome = await runScenario({
      page: { 'csp-meta': (_arg, app) => ({ contents: [`  ${app.build.csp.meta.replace(/; /g, ';\n  ')}  `], inHead: [true] }) },
    });
    expect(checkOf(outcome, 'cspMeta').ok).toBe(true);
  });

  /** [사례, 페이지가 본 meta, detail 에 들 글] */
  const CASES: Array<[string, PageHandler, string]> = [
    ['meta 가 둘', (_arg, app) => ({ contents: [app.build.csp.meta, app.build.csp.meta], inHead: [true, true] }), 'CSP meta 가 2개다(1개여야 한다)'],
    ['meta 가 없다', () => ({ contents: [], inHead: [] }), 'CSP meta 가 0개다(1개여야 한다)'],
    ['content 가 다르다', (_arg, app) => ({ contents: [app.build.csp.meta.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")], inHead: [true] }), 'CSP meta 의 content 가 csp.meta 와 다르다'],
    ['<head> 밖', (_arg, app) => ({ contents: [app.build.csp.meta], inHead: [false] }), 'CSP meta 가 <head> 밖에 있다'],
    ['모양이 틀렸다', () => 'meta', '페이지 사실이 { contents, inHead } 가 아니다'],
  ];
  it.each(CASES)('%s → 실패', async (_label, handler, fragment) => {
    expectOnlyFailure(await runScenario({ page: { 'csp-meta': handler } }), 'cspMeta', [fragment]);
  });
});

describe('cspHeader — tray.html 과 AI 워커 스크립트의 응답 헤더: CSP = csp.header · nosniff · 명시 MIME', () => {
  const WORKER_URL = `app://twelvejanggi/${WORKER_SCRIPT}`;

  it('두 응답을 페이지에서 fetch 한다 — tray.html 과 workerScript', async () => {
    const asked: unknown[] = [];
    const outcome = await runScenario({
      page: {
        'csp-header': (arg, app) => {
          asked.push(arg);
          return healthyPage({ files: new Map(), unmapped: [] })['csp-header']?.(arg, app);
        },
      },
    });
    expect(asked).toStrictEqual([['app://twelvejanggi/tray.html', WORKER_URL]]);
    expect(checkOf(outcome, 'cspHeader').ok).toBe(true);
  });

  /** 워커 응답 하나를 바꾼다. */
  const workerResponse =
    (over: Record<string, unknown>): PageHandler =>
    (arg, app) =>
      (arg as string[]).map((url) => ({
        url,
        status: 200,
        csp: app.build.csp.header,
        nosniff: 'nosniff',
        contentType: url.endsWith('.html') ? MIME_HTML : MIME_JS,
        ...(url === WORKER_URL ? over : {}),
      }));
  /** [사례, 페이지 처리기, detail 에 들 글] */
  const CASES: Array<[string, PageHandler, string[]]> = [
    ['워커에 nosniff 가 없다', workerResponse({ nosniff: null }), [`${WORKER_URL}: X-Content-Type-Options 가 null 다(기대 "nosniff")`]],
    ['워커에 CSP 헤더가 없다', workerResponse({ csp: null }), [`${WORKER_URL}: Content-Security-Policy 가 csp.header 와 다르다`]],
    ['워커의 CSP 가 meta 판이다(frame-ancestors 없음)', (arg, app) => workerResponse({ csp: app.build.csp.meta })(arg, app), [`${WORKER_URL}: Content-Security-Policy 가 csp.header 와 다르다`]],
    ['워커의 MIME 이 text/plain', workerResponse({ contentType: 'text/plain; charset=utf-8' }), [`${WORKER_URL}: Content-Type 이 "text/plain; charset=utf-8" 다(기대 "${MIME_JS}")`]],
    ['워커가 404', workerResponse({ status: 404 }), [`${WORKER_URL}: 상태가 404 다(기대 200)`]],
    ['워커 fetch 가 실패했다', workerResponse({ error: 'TypeError: Failed to fetch' }), [`${WORKER_URL}: fetch 가 실패했다`]],
  ];
  it.each(CASES)('%s → 실패', async (_label, handler, fragments) => {
    expectOnlyFailure(await runScenario({ page: { 'csp-header': handler } }), 'cspHeader', fragments);
  });

  it('workerScript 가 null 인 빌드 → 실패(페이지에 묻지 않는다)', async () => {
    const outcome = await runScenario({ workerScript: null });
    expectOnlyFailure(outcome, 'cspHeader', ['workerScript 가 null 이다']);
    expect(outcome.pageCalls).not.toContain('csp-header');
  });
});

describe('protocol — 루트 위 실제 파일을 겨냥한 인코딩 탈출 넷 · 없는 파일 · 디렉터리 · tray-build.json → 404, POST → 405, 다른 호스트 → 404', () => {
  it('페이지가 보낸 요청 — 탈출 넷 · 없는 파일 · 디렉터리 · tray-build.json(GET) · tray.html(POST)', async () => {
    const asked: unknown[] = [];
    const outcome = await runScenario({
      page: {
        protocol: (arg, app) => {
          asked.push(arg);
          return healthyPage({ files: new Map([['tray.html', 'x']]), unmapped: [] }).protocol?.(arg, app);
        },
      },
    });
    expect(asked).toStrictEqual([
      [
        { url: 'app://twelvejanggi/..%2fpackage.json', method: 'GET' },
        { url: 'app://twelvejanggi/%2e%2e%5cpackage.json', method: 'GET' },
        { url: 'app://twelvejanggi/..%5cpackage.json', method: 'GET' },
        { url: 'app://twelvejanggi/%2e%2e%2fpackage.json', method: 'GET' },
        { url: 'app://twelvejanggi/tj-smoke-missing.js', method: 'GET' },
        { url: 'app://twelvejanggi/assets', method: 'GET' },
        { url: 'app://twelvejanggi/tray-build.json', method: 'GET' },
        { url: 'app://twelvejanggi/tray.html', method: 'POST' },
      ],
    ]);
    expect(checkOf(outcome, 'protocol').ok, checkOf(outcome, 'protocol').detail).toBe(true);
  });

  /** 한 요청의 상태만 바꾼다. */
  const statusFor =
    (target: string, method: string, status: number): PageHandler =>
    (arg) =>
      (arg as Array<{ url: string; method: string }>).map((request) => ({
        ...request,
        status: request.url === target && request.method === method ? status : request.method === 'POST' ? 405 : 404,
      }));
  /** [사례, 페이지 처리기, detail 에 들 글] */
  const CASES: Array<[string, PageHandler, string]> = [
    ['%2e%2e%5c 가 루트 위 파일을 내줬다', statusFor('app://twelvejanggi/%2e%2e%5cpackage.json', 'GET', 200), '%2e%2e%5cpackage.json: GET app://twelvejanggi/%2e%2e%5cpackage.json 의 상태가 200 다(기대 404)'],
    ['디렉터리가 200', statusFor('app://twelvejanggi/assets', 'GET', 200), '디렉터리: GET app://twelvejanggi/assets 의 상태가 200 다(기대 404)'],
    ['tray-build.json 을 내줬다', statusFor('app://twelvejanggi/tray-build.json', 'GET', 200), 'tray-build.json: GET app://twelvejanggi/tray-build.json 의 상태가 200 다(기대 404)'],
    ['POST 가 404', statusFor('app://twelvejanggi/tray.html', 'POST', 404), 'POST: POST app://twelvejanggi/tray.html 의 상태가 404 다(기대 405)'],
    ['fetch 가 실패했다', (arg) => (arg as Array<Record<string, unknown>>).map((request) => ({ ...request, error: 'TypeError: Failed to fetch' })), '..%2fpackage.json: GET app://twelvejanggi/..%2fpackage.json 의 상태가 "TypeError: Failed to fetch" 다(기대 404)'],
  ];
  it.each(CASES)('%s → 실패', async (_label, handler, fragment) => {
    expectOnlyFailure(await runScenario({ page: { protocol: handler } }), 'protocol', [fragment]);
  });

  it('메인 net.fetch(app://other/tray.html) 이 200 → 실패', async () => {
    const outcome = await runScenario({ mainFetch: async () => ({ status: 200 }) });
    expectOnlyFailure(outcome, 'protocol', ['메인 net.fetch(app://other/tray.html) 의 상태가 200 다(기대 404)']);
  });

  it('메인 net.fetch 가 거부됐다 → 실패', async () => {
    const outcome = await runScenario({ mainFetch: async () => Promise.reject(new Error('지원하지 않는 스킴')) });
    expectOnlyFailure(outcome, 'protocol', ['메인 net.fetch(app://other/tray.html) 가 거부됐다: 지원하지 않는 스킴']);
  });

  it('루트 바로 위의 package.json 이 없다 → 404 가 아무것도 증명하지 못하므로 실패(탈출 전제)', async () => {
    const outcome = await runScenario({ noParentFile: true });
    expectOnlyFailure(outcome, 'protocol', ['탈출 검사가 겨냥할 파일이 없다', join(base, 'package.json')]);
  });
});

describe('ai — 모듈 워커가 답했다(aiWorker worker) · 합법 수 · ms', () => {
  /** [사례, ai() 의 답, detail 에 들 글] */
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ['조용한 동기 폴백', { aiWorker: 'fallback', aiAnswered: true, legal: true, ms: 5 }, 'aiWorker 가 "fallback" 다(기대 "worker"'],
    ['답하지 않았다', { aiWorker: 'worker', aiAnswered: false, legal: false, ms: 10_000 }, 'aiAnswered 가 false 다'],
    ['합법 수가 아니다', { aiWorker: 'worker', aiAnswered: true, legal: false, ms: 5 }, 'legal 이 false 다'],
    ['ms 가 숫자가 아니다', { aiWorker: 'worker', aiAnswered: true, legal: true, ms: '5' }, 'ms 가 "5" 다'],
  ];
  it.each(CASES)('%s → 실패, 메모 필드는 ai() 가 낸 값', async (_label, answer, fragment) => {
    const outcome = await runScenario({ page: { ai: () => answer } });
    expectOnlyFailure(outcome, 'ai', [fragment]);
    expect(outcome.result.aiWorker).toBe(answer.aiWorker);
    expect(outcome.result.aiAnswered).toBe(answer.aiAnswered === true);
    expect(outcome.result.ms).toBe(typeof answer.ms === 'number' ? answer.ms : 0);
  });
});

describe('navigation — 새 창은 늘 deny(밖 0회 · 안 1회 열기), 메인 프레임 탐색은 막고 URL 그대로(밖 · 허브 한 번 열기)', () => {
  it('정상 — 열기 기록은 저장소 · 허브 한 번씩, 결정 기록 넷', async () => {
    const check = checkOf(await runScenario(), 'navigation');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(`${HUB_URL} 를 막고 한 번 열었다`);
  });

  it('Electron 이 막힌 will-frame-navigate 뒤에도 will-navigate 를 낸다 → 허브를 두 번 연다 → 실패', async () => {
    const outcome = await runScenario({
      page: {
        navigate: (arg, app) => {
          electronNavigate(app, String(arg), { alsoWillNavigate: true });
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', [`${HUB_URL} 열기 기록이 2번이다(기대 1번)`]);
  });

  it('막은 탐색이 끝나지 않는다(did-start-navigation 뒤 did-stop-loading 이 없다) → 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({
      page: {
        navigate: (arg, app) => {
          electronNavigate(app, String(arg), { silent: true });
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', [
      'https://example.invalid/: 탐색이 끝나지 않았다(did-start-navigation 뒤 did-stop-loading 을 받지 못했다)',
      `${HUB_URL}: 탐색이 끝나지 않았다(did-start-navigation 뒤 did-stop-loading 을 받지 못했다)`,
    ]);
  });

  it('did-start-navigation 이 없다(탐색이 시작된 기록 없음) → 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({
      page: {
        navigate: (arg, app) => {
          app.guards.willFrameNavigate({ url: String(arg), preventDefault: () => {} });
          setImmediate(() => app.emit('did-stop-loading'));
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', ['https://example.invalid/: did-start-navigation 을 받지 못했다']);
  });

  it('did-stop-loading 이 탐색 시작보다 먼저 왔다(앞 탐색의 것) → 끝으로 세지 않는다', async () => {
    const outcome = await runFast({
      page: {
        navigate: (arg, app) => {
          app.emit('did-stop-loading');
          electronNavigate(app, String(arg), { silent: true });
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', ['https://example.invalid/: 탐색이 끝나지 않았다(did-start-navigation 뒤 did-stop-loading 을 받지 못했다)']);
  });

  it('가드 없이 탐색이 들어갔다 → URL 이 바뀌고 결정 기록이 없다 → 실패', async () => {
    const outcome = await runFast({
      page: {
        navigate: (arg, app) => {
          setImmediate(() => app.commit(String(arg)));
          return true;
        },
      },
    });
    const check = checkOf(outcome, 'navigation');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('https://example.invalid/: will-frame-navigate 차단 기록이 없다');
    expect(check.detail).toContain(`getURL() 이 "${HUB_URL}" 다(기대 ${SMOKE_URL})`);
  });

  it('허용 목록 밖 새 창도 연다(무엇이든 여는 결함 있는 가드) → 실패', async () => {
    const outcome = await runScenario({
      page: {
        'window-open': (arg, app) => {
          const url = String(arg);
          app.record({ kind: 'window-open', url, blocked: true, href: url });
          setImmediate(() => app.open(url));
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', ['허용 목록 밖 https://example.invalid/tj-window-open 를 열었다(1번)']);
  });

  it('새 창이 만들어졌다(window.open 이 null 이 아니다 · deny 기록 없음) → 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({ page: { 'window-open': () => false } });
    expectOnlyFailure(outcome, 'navigation', [
      'window.open(https://example.invalid/tj-window-open) 이 창을 돌려줬다(null 이 아니다)',
      `window.open(${REPO_URL}) 의 deny 기록이 없다`,
      `${REPO_URL} 열기 기록이 0번이다(기대 1번)`,
    ]);
  });
});

describe('permissions — 감싼 처리기의 결정 기록을 기다린 뒤 판정(check: 알림 · 위치 · 클립보드 쓰기, request: 알림 · 위치)', () => {
  it('기록이 페이지의 답보다 늦게 와도 기다린다 → ok', async () => {
    const check = checkOf(await runScenario({ page: { permissions: (_arg, app) => decideLikeMain(app, { later: true }) } }), 'permissions');
    expect(check.ok, check.detail).toBe(true);
  });

  it('위치 권한을 허락했다(처리기 결함) → 실패 — 기록과 페이지 상태 둘 다', async () => {
    const outcome = await runScenario({
      page: {
        permissions: (_arg, app) => {
          app.record({ kind: 'permission-check', permission: 'notifications', url: APP_ORIGIN_SLASH, allowed: true });
          app.record({ kind: 'permission-check', permission: 'geolocation', url: APP_ORIGIN_SLASH, allowed: true });
          app.record({ kind: 'permission-check', permission: 'clipboard-sanitized-write', url: APP_ORIGIN_SLASH, allowed: true });
          app.record({ kind: 'permission-request', permission: 'notifications', url: SMOKE_URL, allowed: true });
          app.record({ kind: 'permission-request', permission: 'geolocation', url: SMOKE_URL, allowed: true });
          return {
            checks: { notifications: 'granted', geolocation: 'granted', clipboardWrite: 'granted' },
            notificationPermission: 'granted',
            requested: 'granted',
            geolocation: 'position',
          };
        },
      },
    });
    expectOnlyFailure(outcome, 'permissions', [
      'permission-check geolocation 결정이 true 다(기대 false)',
      'permission-request geolocation 결정이 true 다(기대 false)',
      '허용 목록 밖 권한을 허락했다',
      'permissions.query(geolocation) 이 "granted" 다(기대 "denied")',
      'getCurrentPosition 이 "position" 다(기대 "error 1")',
    ]);
  });

  it('처리기를 감싸지 않았다(Electron 기본 — 모두 허락 · 기록 없음) → 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({
      page: {
        permissions: () => ({
          checks: { notifications: 'granted', geolocation: 'granted', clipboardWrite: 'granted' },
          notificationPermission: 'granted',
          requested: 'granted',
          geolocation: 'position',
        }),
      },
    });
    expectOnlyFailure(outcome, 'permissions', ['감싼 처리기의 결정 기록이 오지 않았다: permission-check notifications']);
  });
});

describe('cspViolations · consoleErrors — 두 번째 장벽 뒤, canary 단계 전의 위반 · 콘솔', () => {
  it('능동 검사 중 위반 한 건 → cspViolations 만 실패(canary 는 그 단계의 위반만 본다), 메모 cspViolations 1', async () => {
    const outcome = await runScenario({
      page: {
        ai: (_arg, app) => {
          app.violate(violation({ blockedURI: 'app://twelvejanggi/assets/x.js', effectiveDirective: 'worker-src', originalPolicy: app.build.csp.meta }));
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    expectOnlyFailure(outcome, 'cspViolations', ['음성 기록 1건', 'app://twelvejanggi/assets/x.js']);
    expect(outcome.result.cspViolations).toBe(1);
  });

  it("콘솔에 'Content Security Policy' 한 줄(warning) → cspViolations 실패", async () => {
    const message = "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.";
    const outcome = await runScenario({
      page: {
        'csp-meta': (_arg, app) => {
          app.log('warning', message);
          return { contents: [app.build.csp.meta], inHead: [true] };
        },
      },
    });
    expectOnlyFailure(outcome, 'cspViolations', [message]);
  });

  it('preload 가 보냈지만 격리 world 버퍼에 없다(유실) → cspViolations 실패', async () => {
    const outcome = await runScenario({
      page: {
        ai: (_arg, app) => {
          app.violate(violation({ effectiveDirective: 'worker-src', originalPolicy: app.build.csp.meta }), { buffer: false });
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    // canary 단계 뒤의 대조도 같은 유실을 본다
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['cspViolations', 'cspCanary']);
    expect(checkOf(outcome, 'cspViolations').detail).toContain('격리 world 버퍼(0건)가 preload 가 보낸 목록(1건)과 다르다');
  });

  it('격리 world 표식이 없다(다른 world 를 읽었다) → cspViolations · cspCanary 실패', async () => {
    const outcome = await runScenario({ isolated: (buffer) => ({ probe: undefined, buf: [...buffer] }) });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['cspViolations', 'cspCanary']);
    expect(checkOf(outcome, 'cspViolations').detail).toContain('격리 world 표식 __tjIsoProbe 가 undefined 다(기대 1');
  });

  it('능동 검사 중 콘솔 error 한 줄 → consoleErrors 만 실패', async () => {
    const outcome = await runScenario({
      page: {
        ai: (_arg, app) => {
          app.log('error', 'Uncaught TypeError: x is not a function');
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    expectOnlyFailure(outcome, 'consoleErrors', ['음성 기록 1건: Uncaught TypeError: x is not a function']);
  });

  it('기본 빌드에서는 connectProbe 주소를 든 오류도 빼지 않는다 → consoleErrors 실패', async () => {
    const message = `WebSocket connection to '${CONNECT_PROBES[1]}' failed: `;
    const outcome = await runScenario({
      page: {
        ai: (_arg, app) => {
          app.log('error', message);
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    expectOnlyFailure(outcome, 'consoleErrors', [`음성 기록 1건: ${message}`]);
  });

  it('.invalid 빌드에서도 probe 주소가 없는 오류는 뺄 수 없다 → consoleErrors 실패', async () => {
    const outcome = await runScenario({
      build: 'invalid',
      page: {
        'connect-probe': async (_arg, app) => {
          const answer = await probeLikePage(app);
          app.log('error', 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT');
          return answer;
        },
      },
    });
    expectOnlyFailure(outcome, 'consoleErrors', ['음성 기록 1건: Failed to load resource: net::ERR_BLOCKED_BY_CLIENT']);
  });

  it('능동 검사 뒤 장벽의 표식을 받지 못했다 → 상한까지 기다린 뒤 cspViolations · consoleErrors 실패(양성 기록 없음)', async () => {
    const outcome = await runFast({ barrierMarks: (n) => n !== 2 });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['cspViolations', 'consoleErrors']);
    for (const name of ['cspViolations', 'consoleErrors']) expect(checkOf(outcome, name).detail).toContain('양성 기록이 없다');
  });

  it('canary 뒤 장벽의 표식을 받지 못했다 → cspCanary 실패(그 단계의 콘솔 오류를 다 셌다고 할 수 없다)', async () => {
    const outcome = await runFast({ barrierMarks: (n) => n !== 3 });
    expectOnlyFailure(outcome, 'cspCanary', ['canary 뒤 장벽의 표식을 받지 못했다']);
  });
});

describe('cspCanary — 마지막 단계의 막힌 fetch: 두 전달 경로가 한 건씩 · 그 단계의 콘솔 오류 최대 3건', () => {
  it('정상 — detail 은 두 정책과 콘솔 오류 수를 싣는다', async () => {
    const check = checkOf(await runScenario(), 'cspCanary');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain('meta · header 정책이 한 건씩 집행됐다');
    expect(check.detail).toContain('이 단계의 콘솔 오류 2건(최대 3건)');
  });

  it('meta 경로만 집행됐다 → 2건을 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({ page: { canary: (_arg, app) => canaryLikeChromium(app, { policies: ['meta'], errors: 1 }) } });
    expectOnlyFailure(outcome, 'cspCanary', ['위반이 정확히 2건이어야 한다: 1건', 'header 정책의 위반이 0건이다(1건이어야 한다)']);
  });

  it('그 단계의 콘솔 오류가 4건 → 실패', async () => {
    const outcome = await runScenario({ page: { canary: (_arg, app) => canaryLikeChromium(app, { errors: 4 }) } });
    expectOnlyFailure(outcome, 'cspCanary', ['이 단계의 콘솔 오류가 4건이다(최대 3건)']);
  });

  it('그 단계에 canary 가 아닌 위반이 끼었다 → 실패', async () => {
    const outcome = await runScenario({
      page: {
        canary: (_arg, app) => {
          app.violate(violation({ blockedURI: 'https://example.invalid/다른', effectiveDirective: 'img-src', originalPolicy: app.build.csp.meta }));
          return canaryLikeChromium(app);
        },
      },
    });
    expectOnlyFailure(outcome, 'cspCanary', ['canary 가 아닌 위반 1건']);
  });
});

describe('connectAllowed — .invalid 빌드: 빌드 출처로 만든 두 주소를 시도 · CSP 위반 0 · 가드가 둘 다 기록하고 취소', () => {
  it('소켓을 시도하지 않았다 → 기록을 상한까지 기다린 뒤 connectAllowed · noNetwork 실패', async () => {
    const outcome = await runFast({ build: 'invalid', page: { 'connect-probe': (_arg, app) => probeLikePage(app, { socket: false }) } });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['connectAllowed', 'noNetwork']);
    const check = checkOf(outcome, 'connectAllowed');
    expect(check.detail).toContain(`attempted ["${CONNECT_PROBES[0]}"] 가 빌드 출처로 만든 ${JSON.stringify(CONNECT_PROBES)} 와 다르다`);
    expect(check.detail).toContain(`기대했지만 기록되지 않은 요청 1종: ${CONNECT_PROBES[1]}`);
  });

  it('페이지가 다른 주소를 시도했다(빌드와 다른 출처) → 실패', async () => {
    const outcome = await runFast({
      build: 'invalid',
      page: {
        'connect-probe': async (_arg, app) => {
          const urls = ['https://other.invalid/tj-connect-probe', 'wss://other.invalid/tj-connect-probe'];
          for (const url of urls) await app.request(url);
          return { attempted: urls };
        },
      },
    });
    const check = checkOf(outcome, 'connectAllowed');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('가 빌드 출처로 만든');
  });

  it('CSP 가 소켓을 막았다(위반 · 요청 없음) → connectAllowed · cspViolations · noNetwork 실패', async () => {
    const outcome = await runFast({
      build: 'invalid',
      page: {
        'connect-probe': async (_arg, app) => {
          const [http = '', ws = ''] = CONNECT_PROBES;
          await app.request(http);
          app.violate(violation({ blockedURI: ws, effectiveDirective: 'connect-src', originalPolicy: app.build.csp.meta }));
          return { attempted: [http, ws] };
        },
      },
    });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['connectAllowed', 'cspViolations', 'noNetwork']);
    expect(checkOf(outcome, 'connectAllowed').detail).toContain(`CSP 위반 1건: ${JSON.stringify(CONNECT_PROBES[1])}`);
  });

  it('attempted 가 목록이 아니다 → 실패', async () => {
    const outcome = await runFast({ build: 'invalid', page: { 'connect-probe': () => ({}) } });
    expect(checkOf(outcome, 'connectAllowed').detail).toContain('connectProbe() 의 attempted 가 문자열 목록이 아니다');
  });
});

describe('net — --net: 인증 설정 200 · Realtime 소켓 연결(join 응답은 정보), 값 없는 · .invalid 빌드는 다시 빌드하라는 실패', () => {
  it('설정 GET 이 401 → 실패', async () => {
    const outcome = await runScenario({ build: 'real', net: true, page: { net: (_arg, app) => netLikePage(app, { settingsStatus: 401 }) } });
    expectOnlyFailure(outcome, 'net', ['인증 설정 GET 의 상태가 401 다(기대 200)']);
  });

  it('소켓이 붙지 않았다 → 실패, join 응답은 정보로 싣는다', async () => {
    const outcome = await runScenario({
      build: 'real',
      net: true,
      page: { net: (_arg, app) => netLikePage(app, { realtimeConnected: false, joinStatus: 'TIMED_OUT' }) },
    });
    expectOnlyFailure(outcome, 'net', ['Realtime 소켓이 붙지 않았다', 'join "TIMED_OUT"']);
  });

  it('configured false(페이지 번들에 값이 없다) → 실패', async () => {
    const outcome = await runScenario({
      build: 'real',
      net: true,
      page: { net: () => ({ configured: false, settingsStatus: null, realtimeConnected: false, joinStatus: null, error: null }) },
    });
    const check = checkOf(outcome, 'net');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('configured 가 false 다');
  });

  it('값 없는 빌드 → 다시 빌드하라는 실패, net() 은 부르지 않는다', async () => {
    const outcome = await runScenario({ net: true });
    expectOnlyFailure(outcome, 'net', ['빌드에 Supabase 값이 없다', 'npm run build:tray']);
    expect(outcome.pageCalls).not.toContain('net');
  });

  it('.invalid 빌드 → 다시 빌드하라는 실패(connectAllowed 는 돈다), net() 은 부르지 않는다', async () => {
    const outcome = await runScenario({ build: 'invalid', net: true });
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual([...BEFORE_CONDITIONAL, 'connectAllowed', 'net', ...AFTER_CONDITIONAL]);
    expectOnlyFailure(outcome, 'net', ['CI 의 가짜 값', 'https://ci.invalid', 'npm run build:tray']);
    expect(outcome.pageCalls).not.toContain('net');
  });

  it('net() 이 끝나지 않는다 → 실행기의 상한(30초)에서 check:net 으로 끝난다(감시 타이머 60초 전) · [tj] 한 줄', async () => {
    // 실행기의 fail 은 stderr(fd 2)에 '[tj] …' 를 쓴다 — 모아서 본다(시험 출력에 내보내지 않는다)
    const nodeFs = require('node:fs') as { writeSync: (...args: unknown[]) => unknown };
    const realWriteSync = nodeFs.writeSync;
    const lines: string[] = [];
    nodeFs.writeSync = (fd: unknown, data: unknown, ...rest: unknown[]): unknown => {
      if (fd === 2 && typeof data === 'string' && data.startsWith('[tj] ')) {
        lines.push(data);
        return Buffer.byteLength(data);
      }
      return Reflect.apply(realWriteSync, nodeFs, [fd, data, ...rest]);
    };
    let outcome: Outcome;
    try {
      outcome = await runFast({ build: 'real', net: true, page: { net: () => new Promise(() => {}) } });
    } finally {
      nodeFs.writeSync = realWriteSync;
    }
    expect(outcome.result.stage).toBe('check:net');
    expect(String(outcome.result.error)).toBe('페이지 net(): 30000ms 안에 끝나지 않았다');
    expect(outcome.exits).toStrictEqual([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('[tj] smoke check:net: 페이지 net(): 30000ms 안에 끝나지 않았다'), lines[0]).toBe(true);
    // 실패 결과에도 그때까지의 검사가 실린다 — net 앞의 검사들
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual(BEFORE_CONDITIONAL);
  });
});
