// desktop/smoke/run.cjs 시험(smokeRun.test.ts)의 가짜 Electron 장치(#36 T6-8 · T11-5) — createSmokeRun 에 구조 타입의 가짜 Electron 객체를
// 넘겨 main 의 순서(가드 → registerIpc → beforeLoad → setTray)로 꽂고, 첫 did-finish-load 부터 결과 · 붙은 메뉴 '종료' 까지 돌린다.
// electron 은 import · require 하지 않는다(import type 포함 — 루트 검사는 desktop/node_modules 없이 돈다). 이름이 *.test.ts 가 아니어서
// vitest 가 시험으로 모으지 않는다. 사례마다의 준비 · 정리는 시험 파일 최상위에서 installRigLifecycle() 을 한 번 불러 건다.
// - 가짜 페이지는 실행기가 보내는 코드의 태그 주석(smoke/pageScripts.cjs)으로 처리기를 고른다. 기본 처리기는 실제 앱이 낼 사실을 낸다:
//   - 탐색 · 새 창은 main 처럼 lib/navigation.cjs 의 가드를 실행기의 record · open 에 이어 부른다. 탐색은 Electron 44.9.3 의 실제 순서
//     (did-start-navigation → 가드 → did-stop-loading — 막힌 탐색에 did-fail-provisional-load 는 없다)로 사건을 낸다.
//   - 권한은 main 의 처리기처럼 lib/permissions.cjs 로 정하고 기록한다. app:// 응답 상태는 lib/appProtocol.cjs 의 resolveAppRequest 가 정한다.
//   - CSP 위반은 preload 처럼 tj-smoke-csp 로 보내고 격리 world 버퍼(world 999)에도 남긴다.
//   사례는 처리기 하나를 바꿔 그 검사의 음성 갈래를 탄다.
// - 가짜 기본 세션의 fetch 와 페이지의 원격 요청은 Electron 처럼 onBeforeRequest(붙어 있으면)를 먼저 지난다. 탐침은 { cancel: true } 면
//   가드의 취소(net::ERR_BLOCKED_BY_CLIENT)로 거부되고, {} 면 망으로 간다 — .invalid 는 DNS 에서 거부된다(사례가 정하면 응답한다).
// - securityWarnings: 경고 검사의 켜짐은 main 프로세스의 execPath · ELECTRON_ENABLE_SECURITY_WARNINGS 로 추론한다 — 사례마다 정하고
//   afterEach 가 되돌린다.
// - 실행은 가짜 시계(setTimeout · clearTimeout · Date) 위에서 돈다(drive — 몇 바퀴 돌리고 시계를 민다). 그래서 상한까지 기다리는 사례도
//   빨리 끝나고, 실행기의 기다림은 모두 같은 시계를 따른다(runFast 는 그런 사례라는 표시일 뿐 같은 실행이다).
// - 결과는 mkdtemp(한글 · 공백 이름)의 outDir/result.json 을 읽는다. 실행기의 60초 감시 타이머는 '종료' 와 afterEach 의 will-quit 이 끈다.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { buildTrayBuildInfo, buildTrayCsp } from '../../scripts/trayBuild.ts';

const require = createRequire(import.meta.url);
const { RESULT_FILE } = require('./smokeOut.cjs') as typeof import('./smokeOut.cjs');
const { resolveAppRequest } = require('./appProtocol.cjs') as typeof import('./appProtocol.cjs');
const { createNavigationGuards } = require('./navigation.cjs') as typeof import('./navigation.cjs');
const { isPermissionAllowed } = require('./permissions.cjs') as typeof import('./permissions.cjs');

/** 기본 세션의 onBeforeRequest 처리기 — main 이 networkGuard 를 단다. */
type Guard = (details: { url: unknown; method?: unknown }, callback: (response: { cancel?: boolean }) => void) => void;
/** 실행기가 main 에 내주는 것 중 이 장치와 시험이 부르는 것 — run.cjs 의 JSDoc 타입(electron 타입)을 끌어오지 않게 구조 타입으로 적는다. */
export type SmokeRun = {
  record(entry: unknown): void;
  open(href: string): void;
  networkGuard: Guard;
  registerIpc(ipc: { on(channel: string, listener: (event: unknown, payload: unknown) => void): void }): void;
  beforeLoad(win: unknown): void;
  setTray(tray: unknown, menu: unknown): void;
};
const { createSmokeRun } = require('../smoke/run.cjs') as {
  createSmokeRun(input: Record<string, unknown>): SmokeRun;
};

type Check = { name: string; ok: boolean; detail: string };
type TrayBuild = ReturnType<typeof buildTrayBuildInfo>;
type FileIndex = import('./appProtocol.cjs').FileIndex;
/** preload 가 옮기는 위반 한 건(6필드). */
type Violation = { blockedURI: string; effectiveDirective: string; originalPolicy: string; disposition: string; sourceFile: string; lineNumber: number };

export const NONCE = '논스 시험';
export const APP_VERSION = '0.1.0';
const ELECTRON_VERSION = '44.9.3';
export const SMOKE_URL = 'app://twelvejanggi/tray.html?smoke';
/** check 처리기가 받는 requestingOrigin — 끝 슬래시가 붙은 출처. */
export const APP_ORIGIN_SLASH = 'app://twelvejanggi/';
const RENDERER_PID = 4242;
/** 실행기가 다시 보는 간격 — 가짜 시계를 이만큼씩 민다. */
const POLL_MS = 50;
/** Electron 이 가드의 취소로 탐침을 거부할 때의 글(실제 스모크가 본 그대로). */
export const BLOCKED = 'net::ERR_BLOCKED_BY_CLIENT';
export const NOT_RESOLVED = 'net::ERR_NAME_NOT_RESOLVED';
export const ENABLE = 'ELECTRON_ENABLE_SECURITY_WARNINGS';
export const WORKER_SCRIPT = 'assets/ai.worker.js';
export const AI_MS = 37;
export const MIME_HTML = 'text/html; charset=utf-8';
export const MIME_JS = 'text/javascript; charset=utf-8';
const CANARY_URL = 'https://example.invalid/tj-csp-canary';
/** 빌드 — default: Supabase 값 없음 · invalid: CI 의 가짜 값 · real: 실제 값 모양. */
export const SUPABASE_URLS = { default: undefined, invalid: 'https://ci.invalid', real: 'https://abcd.supabase.co' } as const;
export const CONNECT_PROBES = ['https://ci.invalid/tj-connect-probe', 'wss://ci.invalid/tj-connect-probe'];
export const SETTINGS_URL = 'https://abcd.supabase.co/auth/v1/settings';
/** supabase-js 가 여는 Realtime 소켓 — 쿼리(apikey · vsn)가 붙는다. */
export const SOCKET_URL = 'wss://abcd.supabase.co/realtime/v1/websocket?apikey=anon-key&vsn=1.0.0';
/** main 프로세스의 execPath — 이 플랫폼의 개발 바이너리(경고 검사가 켜진다)와 그 밖의 실행 파일(켜지지 않는다). */
export const DEV_BINARY =
  process.platform === 'win32' ? 'D:\\홍 길동\\desktop\\node_modules\\electron\\dist\\electron.exe' : '/home/홍 길동/desktop/node_modules/electron/dist/electron';
export const OTHER_BINARY = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node';

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
export type FakeApp = {
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
export type PageHandler = (arg: unknown, app: FakeApp) => unknown;

export type Scenario = {
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
export type Outcome = {
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

/** 이번 사례의 mkdtemp 폴더 — 사례 밖(설치 전 · 사례 사이)에는 '' 다. 읽기는 rigBase() 로만 한다(사례 밖이면 던진다). */
let base = '';
let restoreProcess = (): void => {};
/** 이번 사례의 실행기에 will-quit 을 낸다 — 감시 타이머가 남았으면 끈다. */
let quitApp: (() => void) | null = null;

/**
 * 사례마다의 준비 · 정리 — mkdtemp 폴더, main 의 process 값(execPath · ELECTRON_ENABLE_SECURITY_WARNINGS), 실행기의 will-quit.
 * 시험 파일 최상위에서 한 번 부른다(beforeEach · afterEach 가 그 파일의 모든 사례에 걸린다).
 */
export function installRigLifecycle(): void {
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
    // base 부터 비운다 — 뒤의 단계가 던져도 사례 밖의 rig 사용은 rigBase() 가 막는다
    const laid = base;
    base = '';
    vi.useRealTimers();
    quitApp?.();
    quitApp = null;
    restoreProcess();
    if (laid !== '') rmSync(laid, { recursive: true, force: true }); // mkdtemp 가 던진 사례에는 지울 폴더가 없다
  });
}

/**
 * 이번 사례의 mkdtemp 폴더 — rigScenario 가 앱 폴더 · 렌더러 루트 · outDir 을 이 안에 깐다(사례가 기대값으로 읽는다).
 * 사례 밖(installRigLifecycle() 호출이 없거나 사례 사이)에는 던진다 — 빈 base 로 깔면 경로가 모두 cwd 기준이 되어 저장소에 쓴다.
 */
export function rigBase(): string {
  if (base === '') throw new Error('rig 는 사례 안에서만 쓴다 — 시험 파일 최상위에서 installRigLifecycle() 호출을 빠뜨렸거나 사례 밖에서 불렀다');
  return base;
}

/** setImmediate 로 한 바퀴씩 돈다(가짜 시계가 건드리지 않는다). 실행기의 흐름은 마이크로태스크라 몇 바퀴면 된다. */
export async function turns(count: number): Promise<void> {
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
export async function drive(cond: () => boolean): Promise<void> {
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
export function electronNavigate(app: FakeApp, url: string, { alsoWillNavigate = false, silent = false } = {}): void {
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
export function decideLikeMain(app: FakeApp, { later = false } = {}): unknown {
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
export async function probeLikePage(app: FakeApp, { socket = true } = {}): Promise<unknown> {
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
export async function netLikePage(app: FakeApp, result: Record<string, unknown> = {}): Promise<unknown> {
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
export function canaryLikeChromium(app: FakeApp, { policies = ['meta', 'header'] as ReadonlyArray<'meta' | 'header'>, errors = 2 } = {}): string {
  for (const which of policies) {
    app.violate({ blockedURI: CANARY_URL, effectiveDirective: 'connect-src', originalPolicy: app.build.csp[which], disposition: 'enforce', sourceFile: '', lineNumber: 0 });
  }
  for (let i = 0; i < errors; i += 1) {
    app.log('error', `Refused to connect to '${CANARY_URL}' because it violates the following Content Security Policy directive: "connect-src 'self'".`);
  }
  return 'rejected TypeError: Failed to fetch';
}

/** 실제 앱이 낼 페이지 사실 — 태그마다. 장벽은 rig 가 따로 본다(표식을 콘솔에 찍는다). */
export function healthyPage(index: FileIndex): Record<string, PageHandler> {
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
export function rigScenario(scenario: Scenario = {}): Rig {
  const caseDir = rigBase(); // 사례 밖이면 여기서 던진다 — process 값을 바꾸거나 파일을 쓰기 전에
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
  const appRoot = join(caseDir, 'desktop');
  const rendererRoot = join(caseDir, 'dist-tray');
  const outDir = join(caseDir, 'smoke out');
  mkdirSync(join(appRoot, 'node_modules', 'electron'), { recursive: true });
  mkdirSync(join(rendererRoot, 'assets'), { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ version: APP_VERSION }));
  writeFileSync(join(appRoot, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: ELECTRON_VERSION }));
  if (scenario.noParentFile !== true) writeFileSync(join(caseDir, 'package.json'), JSON.stringify({ name: '저장소' }));
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
    args: { enabled: true, outDir, profile: join(caseDir, 'profile'), net, nonce: NONCE, error: null },
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

export const startScenario = (scenario?: Scenario): Running => rigScenario(scenario).start();

/** 가짜 시계로 끝까지 돈다 — 실행기의 기다림(사건 5초 · 페이지 호출 상한 · 감시 타이머)은 모두 이 시계를 따른다. */
export async function runScenario(scenario?: Scenario): Promise<Outcome> {
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
export const runFast = runScenario;

/** 결과의 그 검사(한 번만 있다). */
export function checkOf(outcome: Outcome, name: string): Check {
  const found = outcome.checks.filter((check) => check.name === name);
  expect(found.map((check) => check.name), `${name} 검사는 한 번`).toStrictEqual([name]);
  return found[0] as Check;
}

/** ok 가 아닌 검사 [이름, detail]. */
export const failing = (outcome: Outcome): string[][] => outcome.checks.filter((entry) => !entry.ok).map((entry) => [entry.name, entry.detail]);

/** 그 검사만 실패했다 — detail 에 fragments 가 모두 든다. 결과는 성공 경로(stage · error 없음, '종료' 한 번)다. */
export function expectOnlyFailure(outcome: Outcome, name: string, fragments: readonly string[]): Check {
  expect(failing(outcome).map(([failed]) => failed)).toStrictEqual([name]);
  const check = checkOf(outcome, name);
  for (const fragment of fragments) expect(check.detail).toContain(fragment);
  expect([outcome.quits, outcome.exits]).toStrictEqual([1, []]);
  return check;
}

/** 위반 한 건(preload 모양). */
export function violation(over: Partial<Violation> = {}): Violation {
  return { blockedURI: CANARY_URL, effectiveDirective: 'connect-src', originalPolicy: '', disposition: 'enforce', sourceFile: '', lineNumber: 0, ...over };
}
