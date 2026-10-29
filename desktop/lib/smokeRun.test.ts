// desktop/smoke/run.cjs(앱 안 스모크 실행기) 시험 — createSmokeRun 에 구조 타입의 가짜 Electron 객체를 넘겨, main 의 순서(가드 →
// registerIpc → beforeLoad → setTray)로 꽂고 첫 did-finish-load 부터 장벽 → 수동 검사 11개 → 결과 → 붙은 메뉴 '종료' 까지 실제로 돌린다.
// 앱은 띄우지 않고 electron 은 import · require 하지 않는다(실행기도 하지 않는다 — Electron 객체는 main 이 넘긴다). 실제 바이너리의 판정은
// 스모크가 보고, 여기서는 가짜가 내놓는 사실이 바뀔 때 두 검사가 판정을 바꾸는지 본다(Task 10 렌즈 리뷰 F1 · F2).
// - noNetwork: 가짜 기본 세션의 fetch 는 Electron 처럼 onBeforeRequest(붙어 있으면)를 먼저 지난다. { cancel: true } 면 가드의 취소
//   (net::ERR_BLOCKED_BY_CLIENT)로 거부되고, {} 면 망으로 간다 — .invalid 는 DNS 에서 거부된다(사례가 정하면 응답한다). 콜백이 없으면
//   끝나지 않는다(상한 사례는 가짜 타이머로 돈다).
// - securityWarnings: 경고 검사의 켜짐은 main 프로세스의 execPath · ELECTRON_ENABLE_SECURITY_WARNINGS 로 추론한다 — 사례마다 정하고
//   afterEach 가 되돌린다. 플랫폼마다 다른 규칙은 securityWarningsArming 을 바로 불러 본다.
// - 결과는 mkdtemp(한글 · 공백 이름)의 outDir/result.json 을 읽는다. 실행기의 60초 감시 타이머는 '종료' 와 afterEach 의 will-quit 이 끈다.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { RESULT_FILE } = require('./smokeOut.cjs') as typeof import('./smokeOut.cjs');

/** 기본 세션의 onBeforeRequest 처리기 — main 이 networkGuard 를 단다. */
type Guard = (details: { url: unknown }, callback: (response: { cancel?: boolean }) => void) => void;
/** 실행기가 main 에 내주는 것 중 이 시험이 부르는 것 — run.cjs 의 JSDoc 타입(electron 타입)을 끌어오지 않게 구조 타입으로 적는다. */
type SmokeRun = {
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

const NONCE = '논스 시험';
const APP_VERSION = '0.1.0';
const ELECTRON_VERSION = '44.9.3';
const SMOKE_URL = 'app://twelvejanggi/tray.html?smoke';
const RENDERER_PID = 4242;
/** 가드 탐침(판결 1)과 그 상한 — 실행기가 메인 쪽에서 창의 세션으로 보내는 요청. */
const PROBE_URL = 'https://example.invalid/tj-net-guard-probe';
const PROBE_CAP_MS = 5_000;
/** Electron 이 가드의 취소로 탐침을 거부할 때의 글(실제 스모크가 본 그대로). */
const BLOCKED = 'net::ERR_BLOCKED_BY_CLIENT';
const NOT_RESOLVED = 'net::ERR_NAME_NOT_RESOLVED';
const ENABLE = 'ELECTRON_ENABLE_SECURITY_WARNINGS';
/** 실행기가 결과에 싣는 수동 검사 11개(순서 그대로). */
const PASSIVE = ['boot', 'webPreferences', 'sandboxEffective', 'bridge', 'ipc', 'mime', 'securityWarnings', 'tray', 'screenshot', 'noNetwork', 'loginItem'];
/** main 프로세스의 execPath — 이 플랫폼의 개발 바이너리(경고 검사가 켜진다)와 그 밖의 실행 파일(켜지지 않는다). */
const DEV_BINARY =
  process.platform === 'win32' ? 'D:\\홍 길동\\desktop\\node_modules\\electron\\dist\\electron.exe' : '/home/홍 길동/desktop/node_modules/electron/dist/electron';
const OTHER_BINARY = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node';

/** 페이지(main world) 사실 — 실행기가 보내는 코드에 든 글로 고른다. 장벽은 따로 본다(표식을 콘솔에 찍는다). */
const PAGE_FACTS: Array<[string, unknown]> = [
  ['.tapp-version', { rootChildren: 1, title: '십이장기', version: APP_VERSION, bodyBackground: 'rgb(13, 17, 23)', bgToken: '#0d1117', colorScheme: 'dark' }],
  ['__tjIsoProbe', { isoProbe: 'undefined', cspBuffer: 'undefined', require: 'undefined', process: 'undefined' }],
  ['ELECTRON_DISABLE_SECURITY_WARNINGS', false],
  ['__tjTraySmoke.bridge()', { keys: ['getAppInfo'], contract: ['getAppInfo'] }],
  ['requestAnimationFrame', true],
];
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

type Scenario = {
  /**
   * 기본 세션의 onBeforeRequest — run: 실행기의 가드 그대로(기록 · 취소) · pass: 실행기가 기록한 뒤 {} 로 통과시킨다 ·
   * hang: 실행기가 기록한 뒤 콜백을 부르지 않는다 · foreign: 실행기의 가드 없이 취소만 한다(기록 없음) · none: 붙이지 않는다. 기본 run
   */
  guard?: 'run' | 'pass' | 'hang' | 'foreign' | 'none';
  /** 가드를 지난 요청의 끝 — unresolved: DNS 실패(.invalid) · respond: 200 응답. 기본 unresolved */
  network?: 'unresolved' | 'respond';
  /** 가드가 취소한 요청의 거부 — 기본 new Error(BLOCKED) */
  blocked?: () => unknown;
  /** 장벽 표식보다 먼저 오는 콘솔 줄(warning) */
  warningsBeforeMarker?: readonly string[];
  /** main 프로세스의 execPath · ELECTRON_ENABLE_SECURITY_WARNINGS(없으면 지운다). 기본은 런처처럼 env 로 켠다 */
  arming?: { execPath: string; enable?: string };
};
type Outcome = { result: Record<string, unknown>; checks: Check[]; fetches: string[]; quits: number; exits: number[] };
type Running = { fetches: string[]; ended(): boolean; finish(): Promise<Outcome> };

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
  quitApp?.();
  quitApp = null;
  restoreProcess();
  rmSync(base, { recursive: true, force: true });
});

/** setImmediate 로 한 바퀴씩 돈다(가짜 타이머가 건드리지 않는다). 실행기의 흐름은 마이크로태스크라 몇 바퀴면 된다. */
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

/** 실행기를 만들어 main 의 순서로 꽂고 첫 did-finish-load 를 낸다. finish 는 '종료' 클릭이나 exit 까지 기다려 결과를 읽는다. */
function startScenario(scenario: Scenario = {}): Running {
  const {
    guard = 'run',
    network = 'unresolved',
    blocked = () => new Error(BLOCKED),
    warningsBeforeMarker = [],
    arming = { execPath: OTHER_BINARY, enable: '1' },
  } = scenario;
  process.execPath = arming.execPath;
  if (arming.enable === undefined) delete process.env[ENABLE];
  else process.env[ENABLE] = arming.enable;

  // 앱 폴더 — ipc 검사가 desktop 패키지 · 고정한 electron 패키지의 version 을 읽는다
  const appRoot = join(base, 'desktop');
  const outDir = join(base, 'smoke out');
  mkdirSync(join(appRoot, 'node_modules', 'electron'), { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ version: APP_VERSION }));
  writeFileSync(join(appRoot, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: ELECTRON_VERSION }));

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
        else listener({ url }, (response) => (response.cancel === true ? reject(blocked()) : toNetwork()));
      });
    },
  };

  const events = new EventEmitter();
  const info = { version: APP_VERSION, electron: ELECTRON_VERSION, chrome: process.versions.chrome, platform: process.platform };
  const contents = Object.assign(events, {
    session: defaultSession,
    getURL: () => SMOKE_URL,
    getOSProcessId: () => RENDERER_PID,
    getLastWebPreferences: () => ({ ...WEB_PREFERENCES }),
    capturePage: async () => SCREEN,
    executeJavaScript: async (code: string): Promise<unknown> => {
      const barrier = /console\.info\(("[^"]*")\)/.exec(code);
      if (barrier !== null) {
        // 장벽 — getAppInfo 왕복 뒤 표식을 콘솔에 찍는다. 그보다 먼저 온 줄은 앞에 둔다
        for (const message of warningsBeforeMarker) events.emit('console-message', { level: 'warning', message, sourceId: '', lineNumber: 0 });
        events.emit('console-message', { level: 'info', message: JSON.parse(String(barrier[1])) as string, sourceId: '', lineNumber: 1 });
        return info;
      }
      const fact = PAGE_FACTS.find(([needle]) => code.includes(needle));
      if (fact === undefined) throw new Error(`가짜 페이지가 모르는 코드다: ${code.slice(0, 60)}`);
      return fact[1];
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

  const run = createSmokeRun({
    args: { enabled: true, outDir, profile: join(base, 'profile'), net: false, nonce: NONCE, error: null },
    app,
    session: { defaultSession },
    net: {},
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 64, height: 64 }) }) },
    trayBuild: { supabaseOrigin: null, workerScript: 'assets/ai.worker.js', builtAt: '2026-10-29T00:00:00.000Z', commit: null },
    rendererRoot: join(base, 'dist-tray'),
    appRoot,
    index: { files: new Map([['tray.html', join(base, 'dist-tray', 'tray.html')]]), unmapped: [] },
  });
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
  const ipc = new Map<string, (event: unknown, payload: unknown) => void>();
  run.registerIpc({ on: (channel, listener) => ipc.set(channel, listener) });
  run.beforeLoad(win);
  run.setTray(tray, menu);
  ipc.get('tj-smoke-preload')?.({}, { sandboxed: true, contextIsolated: true });
  events.emit('did-finish-load');

  const ended = (): boolean => quits > 0 || exits.length > 0;
  return {
    fetches,
    ended,
    async finish(): Promise<Outcome> {
      await waitFor(ended, "결과 뒤 '종료' 클릭이나 exit");
      const result = JSON.parse(readFileSync(join(outDir, RESULT_FILE), 'utf8')) as Record<string, unknown>;
      return { result, checks: result.checks as Check[], fetches, quits, exits };
    },
  };
}

const runScenario = (scenario?: Scenario): Promise<Outcome> => startScenario(scenario).finish();

/** 결과의 그 검사(한 번만 있다). */
function checkOf(outcome: Outcome, name: string): Check {
  const found = outcome.checks.filter((check) => check.name === name);
  expect(found.map((check) => check.name), `${name} 검사는 한 번`).toStrictEqual([name]);
  return found[0] as Check;
}

describe('noNetwork — 가드 탐침은 가드의 기록 + ERR_BLOCKED_BY_CLIENT 거부일 때만 센다(F1)', () => {
  it("가드가 기록하고 취소한다 → ok, detail 은 본 거부를 싣는다 — 실행은 성공 결과(수동 검사 11개 모두 ok) · 붙은 메뉴 '종료' 로 끝난다", async () => {
    const outcome = await runScenario();
    expect(outcome.fetches).toStrictEqual([PROBE_URL]);
    const check = checkOf(outcome, 'noNetwork');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(PROBE_URL);
    expect(check.detail).toContain(JSON.stringify(BLOCKED));
    // 가짜가 실제 실행과 같은 길을 탄다 — stage · error 없는 성공 결과, 검사 11개 모두 ok, '종료' 한 번, exit 없음
    expect(outcome.result.nonce).toBe(NONCE);
    expect(Object.keys(outcome.result).filter((key) => key === 'stage' || key === 'error')).toStrictEqual([]);
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual(PASSIVE);
    expect(outcome.checks.filter((entry) => !entry.ok).map((entry) => [entry.name, entry.detail])).toStrictEqual([]);
    expect([outcome.quits, outcome.exits]).toStrictEqual([1, []]);
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const running = startScenario({ guard: 'hang' });
      await waitFor(() => running.fetches.length > 0, '가드 탐침');
      vi.advanceTimersByTime(PROBE_CAP_MS - 1);
      await turns(5);
      expect(running.ended(), '상한 전에는 기다린다').toBe(false);
      vi.advanceTimersByTime(1);
      const check = checkOf(await running.finish(), 'noNetwork');
      expect(check.ok, check.detail).toBe(false);
      expect(check.detail).toBe(`가드 탐침이 ${PROBE_CAP_MS}ms 안에 끝나지 않았다(응답 · 거부 없음)`); // 기록은 됐다 — 상한만이 이유다
    } finally {
      vi.useRealTimers();
    }
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
