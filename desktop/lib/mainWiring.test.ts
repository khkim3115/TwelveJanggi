// desktop/main.js 배선 시험(설계 §5.5 · §5.3 · §5.7) — main.js 를 가짜 electron 위에서 실제로 돌려, 글자 시험(mainSource.test.ts)이
// 보지 못하는 실행 순서 · 조건 · 콜백을 본다. Electron 은 띄우지 않는다.
// - 가짜 electron(fakeElectron.ts)은 Module._load 훅이 모듈 해석보다 먼저 돌려준다. 진짜 electron 패키지를 찾지 않으므로
//   desktop/node_modules 가 없어도 돈다(electron 은 import · require 하지 않는다). 훅은 main.js 를 require 하고 ready 뒤의 settle 이
//   끝날 때까지만 건다(스모크 실행기는 ready 뒤에 require 된다 — 아래 hooks 엿보기). require 캐시 · argv · 환경 변수 · process 값은
//   사례마다 되돌린다 — 다른 시험 파일에 남지 않게.
// - main.js 는 개발 렌더러 루트(../dist-tray)와 트레이 아이콘을 __dirname 에서 찾는다. 제자리에서 돌리면 저장소의 dist-tray
//   (build:tray 를 했는지에 따라 있거나 없다)를 읽게 되므로, 사례마다 mkdtemp(한글 · 공백 이름) 안에 같은 모양의 나무
//   — desktop/(main.js · package.json · lib/*.cjs · smoke/*.cjs · assets/ 를 저장소에서 복사) · dist-tray/ · resources/renderer/ — 를 깔고
//   거기서 main.js 를 부른다. 사례마다 새로 복사하므로 main.js 를 고치면 이 시험이 바로 본다.
// - 사례 하나가 main.js 한 번 실행이다. stderr 의 '[tj] …' 줄(main 은 fs.writeSync(2) 로 쓴다)과 unhandledRejection 은 가로채 모은다.
// - 갈래: runMain 이 require 전에 process.platform 을 사례의 플랫폼(주지 않으면 DEFAULT_PLATFORM)으로 바꾸고 afterEach 에서만 되돌린다
//   — onReady 와 그 뒤의 콜백도 그 갈래로 돈다. 그래서 호스트(필수 check 는 ubuntu)와 상관없이 같은 갈래를 보고, 갈래마다의 기대값은
//   사례가 고른 플랫폼에서 얻는다.
// - 시계: runMain 이 require 전에 가짜 시계(FAKE_CLOCK — setImmediate 는 진짜라 settle 이 돈다)를 건다. 사례가 먼저 걸었으면 vitest 는
//   아무것도 하지 않는다. main 은 전역 performance.now() 를 부를 때마다 읽어야 이 시계를 따른다(모듈 값으로 잡아 두지 않는다).
// - afterEach 순서: main 의 before-quit · will-quit 리스너(예약 · 실행기의 60초 감시 타이머를 끈다) → 남은 타이머 0 → 진짜 시계 →
//   settle → 바꾼 process 값 · node:fs 멤버 되돌리기 → 나무 지우기. 그리고 main 이 단 process 처리기(uncaughtException ·
//   unhandledRejection)는 settle 전에 뗀다.
// - 실패 감시: onReady 가 던지면 main 의 catch 가 '[tj] ready: …' 줄(스모크는 결과 stage 'ready')로 바꾼다. afterEach 는 그것을 실패로
//   본다 — 가짜에 빠진 멤버 때문에 던진 것을 catch 가 조용히 삼키고 다른 단언만 통과하지 않게. runMain(…, { expectReadyFailure: true })
//   인 사례만 허락한다.
// - 스모크 모드(smoke · packaged-smoke)는 main 이 스모크 실행기(smoke/run.cjs)를 hooks 에 꽂는다. 실행기의 검사는 첫 did-finish-load
//   뒤에 돌므로(가짜는 그 사건을 내지 않는다) 여기서는 연결점 · 수집기 · 실패 경로만 본다 — 검사 자체는 실제 바이너리의 스모크가 본다.
//   hooks 엿보기: 훅은 main 이 부르는 실행기 모듈을 진짜로 읽은 뒤(진짜는 require.cache 에 남는다), 만든 run 의 record · setTray ·
//   open 을 감싸 가짜의 기록(hook.record · hook.setTray · hook.open)에도 남기고 진짜에 넘긴다.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTrayBuildInfo, buildTrayCsp } from '../../scripts/trayBuild.ts';
import {
  APP_VERSION,
  ENTRY_URL,
  OPEN_ERROR,
  createFakeElectron,
  listenersOf,
  type Call,
  type Fake,
  type FakeContents,
  type FakeDisplay,
  type FakeImage,
  type FakePlatform,
  type FakeWindow,
  type Fn,
  type Rect,
} from './fakeElectron.ts';

const require = createRequire(import.meta.url);
const { formatSmokeArgs, parseSmokeArgs } = require('./smokeArgs.cjs') as typeof import('./smokeArgs.cjs');
const { RESULT_FILE } = require('./smokeOut.cjs') as typeof import('./smokeOut.cjs');

// 바꿔 끼우는 자리 — main.js 가 require 로 받는 것과 같은 객체다(main · lib 은 바꾼 node:fs 멤버를 그대로 부른다).
type LoadFn = (this: unknown, request: string, parent: { filename?: string | null } | null | undefined, isMain: boolean) => unknown;
const nodeModule = require('node:module') as { _load: LoadFn };
const nodeFs = require('node:fs') as typeof import('node:fs');
const realLoad = nodeModule._load;
const realWriteSync = nodeFs.writeSync;
const realMkdirSync = nodeFs.mkdirSync;
const proc = process as NodeJS.Process & { resourcesPath?: string };
/** 시험 전의 process.platform · execPath — runMain 이 바꾸고 afterEach 가 이 서술자로 되돌린다(afterAll 이 그대로인지 본다). */
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');
const REAL_EXEC_PATH = Object.getOwnPropertyDescriptor(process, 'execPath');

/** 저장소의 desktop/ — 사례마다 여기서 main.js · lib · assets 를 복사한다. */
const DESKTOP_SRC = fileURLToPath(new URL('..', import.meta.url));
/** Node 에는 없는 process.versions 값 — 사례 동안만 채운다(스모크 결과의 versions · AppInfo 가 읽는다). */
const ELECTRON_VERSIONS = { electron: '44.9.3', chrome: '152.0.7977.167' };
const NONCE = '논스 1';
/** tray-build.json — build:tray 가 쓰는 모양(Supabase 값 없음). 200 응답의 CSP 는 이 header 판 그대로여야 한다. */
const BUILD = buildTrayBuildInfo(buildTrayCsp(undefined), null, '2026-10-27T00:00:00.000Z', null);
const TRAY_HTML = '<!doctype html>\n<meta charset="UTF-8" />\n<title>십이장기</title>\n';
const TRAY_JS = 'console.log("십이장기");\n';

/** packaged-smoke 는 설치본에 스모크 인자를 준 실행이다(렌더러는 resources/renderer). */
type Mode = 'dev' | 'smoke' | 'packaged' | 'packaged-smoke';
/** 렌더러 루트 — valid 는 tray-build.json · tray.html · assets/tray.js, 나머지는 fail-closed 원인 하나씩이다. */
type Renderer = 'valid' | 'missing' | 'bad-build' | 'no-entry';
type Tree = { base: string; desktop: string; main: string; devRoot: string; resources: string; appData: string; profile: string; outDir: string };

const isPackagedMode = (mode: Mode): boolean => mode === 'packaged' || mode === 'packaged-smoke';
const isSmokeMode = (mode: Mode): boolean => mode === 'smoke' || mode === 'packaged-smoke';

const PLATFORMS: FakePlatform[] = ['win32', 'darwin', 'linux'];
/** 플랫폼을 고르지 않은 사례의 갈래 — 트레이 앱이 검증된 Windows 다. 호스트 값을 쓰지 않는다. */
const DEFAULT_PLATFORM: FakePlatform = 'win32';
/** runMain 이 거는 가짜 시계. setImmediate · queueMicrotask 는 진짜다 — settle 이 진짜 setImmediate 로 돈다. */
const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
};
/** main 이 실행기를 부르는 요청 글 — hooks 엿보기가 이 요청만 감싼다. */
const SMOKE_RUN_REQUEST = './smoke/run.cjs';
/** afterEach 가 부르는 main 의 종료 리스너(이 순서 — Electron 의 종료 순서). */
const QUIT_EVENTS = ['before-quit', 'will-quit'];

/** main 이 스모크에서 다는 process 처리기 두 가지. */
type ProcessEvent = 'uncaughtException' | 'unhandledRejection';
type ProcessListener = (reason: unknown) => void;
/** 이번 사례의 main 이 단 process 처리기 — runMain 이 그 전후를 견줘 채우고, afterEach 가 뗀다. */
type AddedListeners = Record<ProcessEvent, ProcessListener[]>;
const PROCESS_EVENTS: ProcessEvent[] = ['uncaughtException', 'unhandledRejection'];
/** process 의 그 사건 처리기 — @types/node 는 사건마다 오버로드가 따로라 갈라 부른다. */
const processListeners = (event: ProcessEvent): unknown[] =>
  event === 'uncaughtException' ? process.listeners(event) : process.listeners(event);

/**
 * 이번 사례의 나무 — beforeEach 가 null 로 되돌린 뒤 깔고, 깔지 못하면 null 로 남는다. afterEach 가 지난 사례의 나무(첫 사례면
 * undefined)를 읽지 않게 한다. 사례 · 도우미는 currentTree() 로 읽는다.
 */
let tree: Tree | null = null;
let stderr: string[] = [];
let rejections: unknown[] = [];
let electronRequesters: Array<string | null> = [];
let cacheBefore = new Set<string>();
let restoreProcess = (): void => {};
/** 이번 사례의 가짜 electron — runMain 이 정한다(null 이면 main 을 돌리지 않았다). afterEach 가 main 의 종료 리스너를 부른다. */
let lastFake: Fake | null = null;
let added: AddedListeners = { uncaughtException: [], unhandledRejection: [] };
/** 이번 사례가 whenReady 실패를 허락했다(runMain 의 expectReadyFailure) — 아니면 afterEach 의 실패 감시가 그 실패를 잡는다. */
let readyFailureAllowed = false;
/** 사례가 바꾼 node:fs 멤버의 원래 값 — afterEach 가 되돌린다(patchFs). */
const fsOriginals = new Map<string, unknown>();

const onRejection = (reason: unknown): void => {
  rejections.push(reason);
};

/** node:fs 멤버 하나를 바꾼다 — main · lib 은 같은 객체를 require 하므로 바꾼 멤버를 그대로 부른다. afterEach 가 되돌린다. */
function patchFs(name: keyof typeof import('node:fs'), impl: (...args: never[]) => unknown): void {
  const members = nodeFs as unknown as Record<string, unknown>;
  if (!fsOriginals.has(name)) fsOriginals.set(name, members[name]);
  members[name] = impl;
}

function restoreFs(): void {
  const members = nodeFs as unknown as Record<string, unknown>;
  for (const [name, original] of fsOriginals) members[name] = original;
  fsOriginals.clear();
}

/** process 의 값 하나를 바꾼다(platform 처럼 쓰기 금지 · 설정 가능) — afterEach 가 restoreProcessValue 로 되돌린다. */
function setProcessValue(key: 'platform' | 'execPath', value: string): void {
  Object.defineProperty(process, key, { value, writable: false, enumerable: true, configurable: true });
}

function restoreProcessValue(key: 'platform' | 'execPath', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(process, key);
  else Object.defineProperty(process, key, descriptor);
}

/** main 의 '[tj] …' 줄(fd 2)은 모으기만 하고 내보내지 않는다. 그 밖의 쓰기는 그대로 둔다. */
function captureWriteSync(this: unknown, fd: unknown, data: unknown, ...rest: unknown[]): unknown {
  if (fd === 2 && typeof data === 'string' && data.startsWith('[tj] ')) {
    stderr.push(data.replace(/\n$/, ''));
    return Buffer.byteLength(data);
  }
  return Reflect.apply(realWriteSync, nodeFs, [fd, data, ...rest]);
}

/** 쌓인 마이크로태스크와 setImmediate 를 돌린다 — ready → onReady, window.open 의 setImmediate open, 약속의 catch. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 사례 하나의 나무 — desktop/ 는 저장소에서 복사한다. 렌더러 루트 · userData · 스모크 폴더는 아직 없다(runMain · main 이 만든다).
 * 깔다가 던지면 만든 폴더를 지우고 다시 던진다 — 그 사례의 tree 는 null 로 남으므로 afterEach 는 이 폴더를 모른다.
 */
function layTree(): Tree {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tj-main 배선 ')));
  try {
    const desktop = join(base, 'desktop');
    const copy = (rel: string) => copyFileSync(join(DESKTOP_SRC, rel), join(desktop, rel));
    mkdirSync(join(desktop, 'lib'), { recursive: true });
    mkdirSync(join(desktop, 'smoke'));
    mkdirSync(join(desktop, 'assets'));
    copy('main.js');
    copy('package.json'); // type 필드가 없다 — 저장소에서처럼 main.js 가 CommonJS 로 읽힌다
    for (const name of readdirSync(join(DESKTOP_SRC, 'lib'))) if (name.endsWith('.cjs')) copy(join('lib', name));
    for (const name of readdirSync(join(DESKTOP_SRC, 'smoke'))) if (name.endsWith('.cjs')) copy(join('smoke', name));
    for (const name of readdirSync(join(DESKTOP_SRC, 'assets'))) copy(join('assets', name));
    const appData = join(base, 'AppData Roaming');
    mkdirSync(appData);
    return {
      base,
      desktop,
      main: join(desktop, 'main.js'),
      devRoot: join(base, 'dist-tray'),
      resources: join(base, 'resources'),
      appData,
      profile: join(base, '스모크 프로필'),
      outDir: join(base, 'smoke out'),
    };
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    throw error;
  }
}

/** 이번 사례의 나무 — beforeEach 가 깐 뒤에만 부른다(깔지 못한 사례는 본문이 돌지 않는다). */
function currentTree(): Tree {
  if (tree === null) throw new Error('이번 사례의 나무가 없다 — beforeEach 의 layTree 가 실패했다');
  return tree;
}

/** 모드의 렌더러 루트 — main.js 가 고르는 곳(개발 ../dist-tray · 패키지 resources/renderer). smoke 는 개발 나무에서 돈다. */
const rootOf = (mode: Mode): string => (isPackagedMode(mode) ? join(currentTree().resources, 'renderer') : currentTree().devRoot);

function writeRenderer(root: string, renderer: Renderer): void {
  if (renderer === 'missing') return; // 루트째 없다 — build:tray 를 안 했거나 dist-tray 를 지웠다
  mkdirSync(join(root, 'assets'), { recursive: true });
  const build = renderer === 'bad-build' ? { ...BUILD, csp: { meta: BUILD.csp.meta } } : BUILD; // header 판이 없다
  writeFileSync(join(root, 'tray-build.json'), `${JSON.stringify(build, null, 2)}\n`);
  if (renderer !== 'no-entry') writeFileSync(join(root, 'tray.html'), TRAY_HTML);
  writeFileSync(join(root, 'assets', 'tray.js'), TRAY_JS);
}

type RunOptions = {
  renderer?: Renderer;
  lock?: boolean;
  /** TJ_DEVTOOLS 값 — 없으면 지운 채로 둔다. */
  devtools?: string;
  /** 스모크 인자를 직접 준다(틀린 인자) — 없으면 스모크 모드는 formatSmokeArgs 로 만든다. */
  smokeArgv?: readonly string[];
  openExternal?: 'resolve' | 'reject';
  /** 갈래 — process.platform 과 가짜(app.dock · setBounds 손잡이의 기본값)가 함께 따른다. 없으면 DEFAULT_PLATFORM. */
  platform?: FakePlatform;
  /** process.execPath — 없으면 그대로 둔다. */
  execPath?: string;
  /** 붙어 있는 디스플레이(앞이 주 디스플레이) · 아이콘 자리 — 없으면 가짜의 기본값. */
  displays?: readonly FakeDisplay[];
  trayBounds?: Rect;
  /** 이 이름의 가짜 호출이 기록한 뒤 error 를 던진다(fakeElectron 의 throwOn). */
  throwOn?: { name: string; error: unknown };
  /** whenReady 실패('[tj] ready:' 줄 · 결과 stage 'ready')를 이 사례에서만 허락한다 — afterEach 의 실패 감시가 넘어간다. */
  expectReadyFailure?: boolean;
};

/** 실행기 모듈과 그 run 중 hooks 엿보기가 감싸는 멤버 — run.cjs 의 JSDoc 타입(electron 타입)을 끌어오지 않게 구조 타입으로 적는다. */
type SmokeRunHooks = { record(entry: unknown): unknown; setTray(tray: unknown, menu: unknown, icon?: unknown): unknown; open(href: string): unknown };
type SmokeRunModule = { createSmokeRun(input: unknown): SmokeRunHooks };

/**
 * hooks 엿보기 — 진짜 실행기 모듈의 사본을 돌려준다. createSmokeRun 이 만든 run 의 record · setTray · open 은 가짜의 기록
 * (hook.record · hook.setTray · hook.open)에 남긴 뒤 진짜에 넘기고, 나머지 멤버는 진짜 그대로다.
 */
function peekSmokeRun(real: SmokeRunModule, fake: Fake): SmokeRunModule {
  return {
    ...real,
    createSmokeRun(input) {
      const run = real.createSmokeRun(input);
      return {
        ...run,
        record: (entry) => {
          fake.rec('hook.record', entry);
          return run.record(entry);
        },
        setTray: (tray, menu, icon) => {
          fake.rec('hook.setTray', tray, menu, icon);
          return run.setTray(tray, menu, icon);
        },
        open: (href) => {
          fake.rec('hook.open', href);
          return run.open(href);
        },
      };
    },
  };
}

/**
 * main.js 를 한 번 돌린다 — 렌더러 루트를 깔고 argv · TJ_DEVTOOLS · 가짜 시계 · 갈래(process.platform) · execPath 를 정한 뒤, 훅을 건 채
 * require 하고 ready 뒤까지 기다린다. 훅은 'electron' 에 가짜를, main 이 부르는 실행기에 감싼 사본(peekSmokeRun)을 돌려주고 나머지는
 * 원래 _load 로 넘긴다. argv 는 require 가 끝나면(던져도) 바로, 훅은 ready 뒤의 settle 이 끝나면 되돌린다. 시계 · 갈래 · execPath 는
 * afterEach 에서만 되돌린다(onReady 와 그 뒤의 콜백도 같은 값으로 돈다).
 */
async function runMain(mode: Mode, options: RunOptions = {}): Promise<Fake> {
  writeRenderer(rootOf(mode), options.renderer ?? 'valid');
  const platform = options.platform ?? DEFAULT_PLATFORM;
  const fake = createFakeElectron({
    isPackaged: isPackagedMode(mode),
    lock: options.lock ?? true,
    appData: currentTree().appData,
    openExternal: options.openExternal ?? 'reject',
    platform,
    displays: options.displays,
    trayBounds: options.trayBounds,
    throwOn: options.throwOn,
  });
  const smokeArgv =
    options.smokeArgv ?? (isSmokeMode(mode) ? formatSmokeArgs({ outDir: currentTree().outDir, profile: currentTree().profile, net: false, nonce: NONCE }) : []);
  if (options.devtools !== undefined) process.env.TJ_DEVTOOLS = options.devtools;
  readyFailureAllowed = options.expectReadyFailure === true;
  lastFake = fake;
  vi.useFakeTimers(FAKE_CLOCK); // 사례가 먼저 걸었으면 vitest 는 아무것도 하지 않는다
  setProcessValue('platform', platform);
  if (options.execPath !== undefined) setProcessValue('execPath', options.execPath);
  const argv = process.argv;
  process.argv = [process.execPath, currentTree().desktop, ...smokeArgv];
  const before = { uncaughtException: new Set(processListeners('uncaughtException')), unhandledRejection: new Set(processListeners('unhandledRejection')) };
  nodeModule._load = function (request, parent, isMain) {
    if (request === 'electron') {
      electronRequesters.push(parent?.filename ?? null);
      return fake.electron;
    }
    const loaded = realLoad.call(this, request, parent, isMain); // 진짜 모듈은 require.cache 에 그대로 남는다
    return request === SMOKE_RUN_REQUEST && parent?.filename === currentTree().main ? peekSmokeRun(loaded as SmokeRunModule, fake) : loaded;
  };
  try {
    try {
      require(currentTree().main);
    } finally {
      process.argv = argv;
    }
    await settle(); // ready → onReady(스모크는 여기서 실행기를 require 한다) · 약속의 catch
  } finally {
    nodeModule._load = realLoad;
  }
  // main 이 단 process 처리기(스모크는 ready 뒤에 단다) — 사례가 직접 부르고, afterEach 가 뗀다.
  for (const event of PROCESS_EVENTS) {
    added[event] = processListeners(event).filter((listener) => !before[event].has(listener)) as ProcessListener[];
  }
  return fake;
}

/**
 * whenReady 실패의 흔적 — '[tj] ready:' 줄이나 스모크 결과의 stage 'ready'. 없으면 null. afterEach 가 정리 도중(나무를 지우기 전)에
 * 부르므로 던지지 않는다 — 결과 파일이 없거나 읽지 못하면 결과 쪽 흔적은 없는 것이다.
 */
function readyFailure(): string | null {
  const line = stderr.find((entry) => entry.startsWith('[tj] ready:'));
  if (line !== undefined) return line;
  if (tree === null) return null;
  try {
    const result = JSON.parse(readFileSync(join(tree.outDir, RESULT_FILE), 'utf8')) as { stage?: unknown; error?: unknown };
    return result.stage === 'ready' ? `결과 stage 'ready': ${String(result.error)}` : null;
  } catch {
    return null;
  }
}

const callsOf = (fake: Fake, name: string): Call[] => fake.calls.filter((call) => call.name === name);
/** calls 에서 name(첫 인자가 key — 주지 않으면 아무것이나) 호출의 자리. 없으면 -1. */
const indexOf = (calls: readonly Call[], name: string, key?: string): number =>
  calls.findIndex((call) => call.name === name && (key === undefined || call.args[0] === key));
/** name(첫 인자 key) 호출은 정확히 하나다 — 그 호출. */
function only(fake: Fake, name: string, key?: string): Call {
  const found = fake.calls.filter((call) => call.name === name && (key === undefined || call.args[0] === key));
  expect(found.map((call) => call.name), `${name} ${key ?? ''} 는 한 번`).toHaveLength(1);
  return found[0] as Call;
}
/** 트레이 창(하나뿐)의 webContents. */
function windowContents(fake: Fake): FakeContents {
  expect(fake.windows).toHaveLength(1);
  const [win] = fake.windows;
  if (win === undefined) throw new Error('트레이 창이 없다');
  return win.webContents;
}
/** 스모크 결과 — out 폴더에는 result.json 하나만 있다(임시 파일 없음). */
function readResult(): Record<string, unknown> {
  expect(readdirSync(currentTree().outDir)).toStrictEqual([RESULT_FILE]);
  return JSON.parse(readFileSync(join(currentTree().outDir, RESULT_FILE), 'utf8')) as Record<string, unknown>;
}
/** 결과의 versions(smokeOut.cjs 의 SmokeVersions) — 결과 파일마다 이 모양이다. IPC 의 AppInfo 와는 다른 계약이다. */
const expectedVersions = () => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, app: APP_VERSION });

beforeEach(() => {
  // 지난 사례의 값부터 비운다 — layTree 가 던져도 afterEach 는 지난 사례의 나무 · 기록 · 되돌리기를 쓰지 않는다(폴더는 layTree 가 치웠다)
  tree = null;
  restoreProcess = () => {};
  lastFake = null;
  added = { uncaughtException: [], unhandledRejection: [] };
  readyFailureAllowed = false;
  stderr = [];
  rejections = [];
  electronRequesters = [];
  cacheBefore = new Set(Object.keys(require.cache));
  tree = layTree();
  const devtools = process.env.TJ_DEVTOOLS;
  const resourcesPath = proc.resourcesPath;
  const missingVersions = Object.entries(ELECTRON_VERSIONS).filter(([key]) => !(key in process.versions));
  for (const [key, value] of missingVersions) Object.defineProperty(process.versions, key, { value, configurable: true, enumerable: true });
  delete process.env.TJ_DEVTOOLS; // 개발자 셸에 켜져 있어도 사례가 정한다
  proc.resourcesPath = tree.resources;
  restoreProcess = () => {
    for (const [key] of missingVersions) Reflect.deleteProperty(process.versions, key);
    if (devtools === undefined) delete process.env.TJ_DEVTOOLS;
    else process.env.TJ_DEVTOOLS = devtools;
    if (resourcesPath === undefined) delete proc.resourcesPath;
    else proc.resourcesPath = resourcesPath;
  };
  process.on('unhandledRejection', onRejection);
  patchFs('writeSync', captureWriteSync);
});

afterEach(async () => {
  const fake = lastFake;
  let readyFailureSeen: string | null = null;
  try {
    if (fake !== null) {
      // 1. main 의 종료 리스너 — before-quit → will-quit(실행기의 60초 감시 타이머를 끈다). 남은 예약이 지운 나무에 쓰지 않게.
      const quitEvent = { preventDefault: () => {} };
      for (const event of QUIT_EVENTS) for (const listener of listenersOf(fake.calls, 'app.on', event)) listener(quitEvent);
      // 2. 남은 타이머가 없다 — runMain 이 건 가짜 시계에서 센다
      expect(vi.getTimerCount(), '남은 타이머(끄지 않은 예약 · 감시 타이머)').toBe(0);
    }
  } finally {
    // main 이 단 process 처리기는 settle 전에 뗀다 — 그 사이에 던진 것이 실행기의 fail(곧 지울 나무의 결과)로 묻히지 않고 드러나게
    for (const event of PROCESS_EVENTS) for (const listener of added[event]) process.off(event, listener);
    // 3 · 4. 진짜 시계로 돌아가 쌓인 setImmediate · 마이크로태스크를 돌린다
    vi.useRealTimers();
    await settle();
    process.off('unhandledRejection', onRejection);
    if (!readyFailureAllowed) readyFailureSeen = readyFailure(); // 결과 파일은 나무를 지우기 전에 읽는다
    // 5. 바꾼 값 되돌리기 — node:fs 멤버(writeSync 포함) · _load · require 캐시 · process 값(갈래 · execPath · versions · env · resourcesPath)
    restoreFs();
    nodeModule._load = realLoad;
    for (const key of Object.keys(require.cache)) if (!cacheBefore.has(key)) delete require.cache[key];
    restoreProcessValue('platform', REAL_PLATFORM);
    restoreProcessValue('execPath', REAL_EXEC_PATH);
    restoreProcess();
    // 6. 나무 — 깔지 못한 사례의 폴더는 layTree 가 이미 지웠다
    if (tree !== null) rmSync(tree.base, { recursive: true, force: true });
  }
  expect(rejections, 'unhandledRejection').toStrictEqual([]);
  expect(readyFailureSeen, 'whenReady 실패 — onReady 가 던졌다(가짜에 빠진 멤버?). 일부러면 expectReadyFailure').toBeNull();
});

afterAll(() => {
  // 다른 시험 파일에 남기지 않는다 — _load · node:fs · process 값 · 시계는 원래 것이고, 캐시에는 이 시험이 부른 main.js · lib 사본이 없다.
  expect(nodeModule._load).toBe(realLoad);
  expect(nodeFs.writeSync).toBe(realWriteSync);
  expect(nodeFs.mkdirSync).toBe(realMkdirSync);
  expect(fsOriginals.size).toBe(0);
  expect(Object.getOwnPropertyDescriptor(process, 'platform')).toStrictEqual(REAL_PLATFORM);
  expect(Object.getOwnPropertyDescriptor(process, 'execPath')).toStrictEqual(REAL_EXEC_PATH);
  expect(vi.isFakeTimers()).toBe(false);
  expect(Object.keys(require.cache).filter((key) => key.includes('tj-main 배선'))).toStrictEqual([]);
});

const MODES: Mode[] = ['dev', 'smoke', 'packaged'];
/** [모드, 갈래] 짝 — 세 모드 × 세 갈래. */
const MODE_PLATFORMS: Array<[Mode, FakePlatform]> = MODES.flatMap((mode) => PLATFORMS.map((platform): [Mode, FakePlatform] => [mode, platform]));

describe('최상위(ready 전)', () => {
  /** 모드마다 main 이 고르는 userData — 스모크는 늘 자기 프로필이다. null 은 setPath 를 부르지 않는다(패키지는 Electron 기본값). */
  const chosenUserData = (mode: Mode): string | null =>
    mode === 'dev' ? join(currentTree().appData, 'TwelveJanggi-dev') : isSmokeMode(mode) ? currentTree().profile : null;

  it.each<Mode>([...MODES, 'packaged-smoke'])('%s — userData → enableSandbox → 스킴 특권 → 단일 인스턴스 잠금, 잠금은 고른 userData 에 걸린다', async (mode) => {
    const fake = await runMain(mode);
    const userData = chosenUserData(mode);
    const lockAt = indexOf(fake.calls, 'app.requestSingleInstanceLock');
    const head = fake.calls.slice(0, lockAt + 1);
    expect(head.map((call) => call.name)).toStrictEqual([
      ...(mode === 'dev' ? ['app.getPath'] : []),
      ...(userData === null ? [] : ['app.setPath']),
      'app.enableSandbox',
      'protocol.registerSchemesAsPrivileged',
      'app.requestSingleInstanceLock',
    ]);
    expect(head.filter((call) => call.ready).map((call) => call.name)).toStrictEqual([]);
    expect(only(fake, 'app.enableSandbox').ready).toBe(false); // 모든 모드에서 한 번
    expect(callsOf(fake, 'app.getPath').map((call) => call.args)).toStrictEqual(mode === 'dev' ? [['appData']] : []); // userData 를 읽어 두지 않는다
    expect(callsOf(fake, 'app.setPath').map((call) => call.args)).toStrictEqual(userData === null ? [] : [['userData', userData]]);
    if (userData !== null) expect(existsSync(userData)).toBe(true); // setPath 전에 만든다
    expect(head.at(-1)?.args).toStrictEqual([userData]);
    expect(only(fake, 'protocol.registerSchemesAsPrivileged').args).toStrictEqual([
      [{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }],
    ]);
    // 잠금을 얻으면 ready 전에 세 처리기를 건다
    const held = fake.calls.slice(lockAt + 1).filter((call) => !call.ready && call.name === 'app.on');
    expect(held.map((call) => call.args[0]).sort()).toStrictEqual(['before-quit', 'second-instance', 'window-all-closed']);
  });

  it('틀린 스모크 인자 — [tj] smoke args 한 줄 + exit(1) 말고는 아무것도 하지 않는다(userData · sandbox · 잠금 · 결과 파일 없음)', async () => {
    const smokeArgv = ['--tj-smoke', `--tj-smoke-out=${currentTree().outDir}`];
    const fake = await runMain('smoke', { smokeArgv });
    expect(fake.calls.map((call) => [call.name, ...call.args])).toStrictEqual([['app.exit', 1]]);
    expect(stderr).toStrictEqual([`[tj] smoke args: ${parseSmokeArgs(smokeArgv).error}`]);
    expect(existsSync(currentTree().outDir)).toBe(false);
    expect(existsSync(currentTree().profile)).toBe(false);
  });

  it('잠금을 못 얻은 스모크 — [tj] lock 한 줄 · 결과(stage lock) · exit(1), ready 를 기다리지 않는다', async () => {
    const fake = await runMain('smoke', { lock: false });
    const lockAt = indexOf(fake.calls, 'app.requestSingleInstanceLock');
    expect(fake.calls.slice(lockAt + 1).map((call) => [call.name, ...call.args])).toStrictEqual([['app.exit', 1]]);
    const result = readResult();
    expect(result).toStrictEqual({ nonce: NONCE, stage: 'lock', error: expect.stringContaining(currentTree().profile), checks: [], versions: expectedVersions() });
    expect(stderr).toStrictEqual([`[tj] lock: ${String(result.error)}`]);
  });

  it('잠금을 못 얻은 비스모크 — app.quit() 하나뿐(줄 · 결과 없음), ready 를 기다리지 않는다', async () => {
    const fake = await runMain('dev', { lock: false });
    const lockAt = indexOf(fake.calls, 'app.requestSingleInstanceLock');
    expect(fake.calls.slice(lockAt + 1).map((call) => call.name)).toStrictEqual(['app.quit']);
    expect(stderr).toStrictEqual([]);
    expect(existsSync(currentTree().outDir)).toBe(false);
  });

  // userData 를 만들거나 정하지 못함(#36 T10-2) — 가짜 node:fs 손잡이로 mkdirSync 를 바꾼다. 'throw' 는 만들다 던지고(권한 · 디스크),
  // 'skip' 은 만든 척만 해서 setPath 가 없는 폴더라 던진다.
  it.each([
    ['mkdirSync 가 던진다', 'throw'],
    ['폴더가 없어 setPath 가 던진다', 'skip'],
  ] as const)('userData — %s → [tj] userData: 한 줄 · exit(1), 뒤 단계(sandbox · 스킴 특권 · 잠금 · ready)는 하지 않는다', async (_label, how) => {
    const userData = join(currentTree().appData, 'TwelveJanggi-dev');
    const denied = Object.assign(new Error(`EACCES: permission denied, mkdir '${userData}'`), { code: 'EACCES' });
    patchFs('mkdirSync', (dir: unknown, ...rest: unknown[]) => {
      if (dir !== userData) return Reflect.apply(realMkdirSync, nodeFs, [dir, ...rest]);
      if (how === 'throw') throw denied;
      return undefined;
    });
    const fake = await runMain('dev');
    expect(fake.calls.map((call) => call.name)).toStrictEqual(['app.getPath', ...(how === 'skip' ? ['app.setPath'] : []), 'app.exit']);
    expect(only(fake, 'app.exit').args).toStrictEqual([1]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.startsWith('[tj] userData: '), stderr[0]).toBe(true);
    expect(stderr[0]).toContain(userData);
    if (how === 'throw') expect(stderr[0]).toContain(denied.message);
    expect(existsSync(userData)).toBe(false);
  });
});

describe('ready 뒤 — 정상 렌더러', () => {
  /** 창보다 먼저 서야 하는 처리기 — [호출, 첫 인자]. */
  const BEFORE_WINDOW: Array<[string, string?]> = [
    ['protocol.handle', 'app'],
    ['session.setPermissionRequestHandler'],
    ['session.setPermissionCheckHandler'],
    ['session.setDevicePermissionHandler'],
    ['session.on', 'will-download'],
    ['app.on', 'select-client-certificate'],
    ['app.on', 'web-contents-created'],
    ['ipcMain.handle', 'tj-app-info'],
  ];
  /** 창의 webContents 에 loadURL 전에 걸려야 하는 탐색 가드 다섯. */
  const GUARDS: Array<[string, string?]> = [
    ['webContents.on', 'will-frame-navigate'],
    ['webContents.on', 'will-navigate'],
    ['webContents.on', 'will-redirect'],
    ['webContents.setWindowOpenHandler'],
    ['webContents.on', 'will-attach-webview'],
  ];

  it.each(MODE_PLATFORMS)('%s · %s — 처리기 · IPC 는 창보다 먼저, 탐색 가드는 loadURL 전에 — 모두 한 동기 구간(await 없음)', async (mode, platform) => {
    const fake = await runMain(mode, { platform });
    const after = fake.calls.filter((call) => call.ready);
    const windowAt = indexOf(after, 'new BrowserWindow');
    const loadAt = indexOf(after, 'win.loadURL');
    expect(windowAt).toBeGreaterThan(-1);
    for (const [name, key] of BEFORE_WINDOW) {
      const at = indexOf(after, name, key);
      expect(at, `${name} ${key ?? ''}`).toBeGreaterThan(-1);
      expect(at, `${name} ${key ?? ''}`).toBeLessThan(windowAt);
    }
    for (const [name, key] of GUARDS) {
      const at = indexOf(after, name, key);
      expect(at, `${name} ${key ?? ''}`).toBeGreaterThan(windowAt);
      expect(at, `${name} ${key ?? ''}`).toBeLessThan(loadAt);
    }
    expect(indexOf(after, 'new Tray')).toBeGreaterThan(windowAt);
    expect(after.filter((call) => call.turn !== 1).map((call) => call.name)).toStrictEqual([]);
    expect(only(fake, 'Menu.setApplicationMenu').args).toStrictEqual([null]);
    // 갈래마다 양성 대조 — 기대값은 고른 갈래에서 얻는다: win32 는 AUMID(자동 실행 이름과 같은 값) 한 번, darwin 은 Dock 숨기기 한 번,
    // linux 는 둘 다 없다
    expect(callsOf(fake, 'app.setAppUserModelId').map((call) => call.args)).toStrictEqual(platform === 'win32' ? [['com.khkim.twelvejanggi']] : []);
    expect(callsOf(fake, 'app.dock.hide')).toHaveLength(platform === 'darwin' ? 1 : 0);
    expect(stderr).toStrictEqual([]); // [tj] 줄 없음(아이콘도 읽었다)
  });

  it.each(MODE_PLATFORMS)('%s · %s — 창 옵션은 설계 §5.2 블록 그대로(설정 기본값 — 다크 · 투명도 100, webPreferences 는 공장 값), 진입 URL, 끝내지 않는다', async (mode, platform) => {
    const fake = await runMain(mode, { platform });
    expect(only(fake, 'new BrowserWindow').args).toStrictEqual([
      {
        width: 340,
        height: 400,
        useContentSize: true,
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        title: '십이장기',
        backgroundColor: '#0d1117',
        opacity: 1,
        webPreferences: { preload: join(currentTree().desktop, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
      },
    ]);
    // macOS — 만든 뒤(loadURL 전) 'screen-saver' 단계로 띄우고, Dock 은 창을 만들기 전에 숨긴다(만든 뒤면 깜빡인다). 그 밖은 둘 다 없다.
    const windowAt = indexOf(fake.calls, 'new BrowserWindow');
    const onTopAt = indexOf(fake.calls, 'win.setAlwaysOnTop');
    expect(callsOf(fake, 'win.setAlwaysOnTop').map((call) => call.args)).toStrictEqual(platform === 'darwin' ? [[true, 'screen-saver']] : []);
    if (platform === 'darwin') {
      expect(indexOf(fake.calls, 'app.dock.hide')).toBeGreaterThan(-1);
      expect(indexOf(fake.calls, 'app.dock.hide')).toBeLessThan(windowAt);
      expect(onTopAt).toBeGreaterThan(windowAt);
      expect(onTopAt).toBeLessThan(indexOf(fake.calls, 'win.loadURL'));
    }
    expect(callsOf(fake, 'win.loadURL').map((call) => call.args)).toStrictEqual([[isSmokeMode(mode) ? `${ENTRY_URL}?smoke` : ENTRY_URL]]);
    if (!isSmokeMode(mode)) expect(callsOf(fake, 'session.webRequest.onBeforeRequest')).toStrictEqual([]); // hooks 는 비스모크에서 없다
    expect(callsOf(fake, 'app.exit')).toStrictEqual([]);
    expect(callsOf(fake, 'app.quit')).toStrictEqual([]);
    expect(existsSync(currentTree().outDir)).toBe(false);
  });

  it('세션 처리기는 permissions.cjs 의 판정 그대로다 — 권한(request · check) · 장치 · 다운로드 · 클라이언트 인증서', async () => {
    const fake = await runMain('dev');
    type RequestHandler = (contents: null, permission: string, callback: (allowed: boolean) => void, details: { requestingUrl?: string }) => void;
    type CheckHandler = (contents: null, permission: string, origin: string, details: { requestingUrl?: string }) => boolean;
    const request = only(fake, 'session.setPermissionRequestHandler').args[0] as RequestHandler;
    const decide = (permission: string, requestingUrl: string) => {
      const answers: boolean[] = [];
      request(null, permission, (allowed) => answers.push(allowed), { requestingUrl });
      return answers;
    };
    expect(decide('notifications', ENTRY_URL)).toStrictEqual([true]);
    expect(decide('geolocation', ENTRY_URL)).toStrictEqual([false]);
    expect(decide('notifications', 'https://example.invalid/')).toStrictEqual([false]);
    const check = only(fake, 'session.setPermissionCheckHandler').args[0] as CheckHandler;
    expect(check(null, 'notifications', 'app://twelvejanggi/', {})).toBe(true);
    expect(check(null, 'notifications', 'app://twelvejanggi/', { requestingUrl: 'https://example.invalid/' })).toBe(false);
    expect(check(null, 'media', 'app://twelvejanggi/', { requestingUrl: ENTRY_URL })).toBe(false);
    const device = only(fake, 'session.setDevicePermissionHandler').args[0] as Fn;
    expect(device({ deviceType: 'usb', origin: 'app://twelvejanggi' })).toBe(false);
    const prevented: string[] = [];
    const event = (name: string) => ({ preventDefault: () => prevented.push(name) });
    const picked: unknown[][] = [];
    listenersOf(fake.calls, 'session.on', 'will-download')[0]?.(event('will-download'), {}, {});
    listenersOf(fake.calls, 'app.on', 'select-client-certificate')[0]?.(
      event('select-client-certificate'),
      {},
      'https://example.invalid/',
      [{ subjectName: '인증서' }],
      (...args: unknown[]) => picked.push(args),
    );
    expect(prevented).toStrictEqual(['will-download', 'select-client-certificate']);
    expect(picked).toStrictEqual([[]]); // 인증서를 고르지 않고 잇는다
  });

  it('IPC 는 createGuardedIpc 의 tj-app-info 하나 — 트레이 창의 메인 프레임만 AppInfo { version, electron, chrome, platform } 를 받는다', async () => {
    const fake = await runMain('dev');
    const ipc = fake.calls.filter((call) => call.name.startsWith('ipcMain.')).map((call) => [call.name, call.args[0]]);
    expect(ipc).toStrictEqual([['ipcMain.handle', 'tj-app-info']]);
    const handler = only(fake, 'ipcMain.handle').args[1] as (event: unknown) => unknown;
    const contents = windowContents(fake);
    expect(handler({ senderFrame: contents.mainFrame, sender: contents })).toStrictEqual({
      version: APP_VERSION,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
    });
    const foreign = { detached: false, url: 'https://example.invalid/', origin: 'https://example.invalid' };
    expect(() => handler({ senderFrame: foreign, sender: contents })).toThrow('허용되지 않은 IPC 발신자');
  });

  it('electron 은 main.js 만 require 한다 — 훅이 해석보다 먼저 답해 진짜 패키지는 캐시에 오지 않는다', async () => {
    await runMain('dev');
    expect(electronRequesters).toStrictEqual([currentTree().main]);
    expect(Object.keys(require.cache).filter((key) => /[\\/]node_modules[\\/]electron[\\/]/.test(key))).toStrictEqual([]);
  });
});

describe('DevTools — 개발 실행에서 TJ_DEVTOOLS=1 일 때만 연다', () => {
  const CASES: Array<[Mode, string | undefined, boolean]> = [
    ['dev', '1', true],
    ['dev', undefined, false],
    ['dev', 'true', false],
    ['smoke', undefined, false],
    ['packaged', '1', false],
    ['packaged', undefined, false],
  ];
  it.each(CASES)('%s · TJ_DEVTOOLS=%s → 연다: %s', async (mode, devtools, opens) => {
    const fake = await runMain(mode, { devtools });
    expect(callsOf(fake, 'new BrowserWindow')).toHaveLength(1); // 창이 있어야 '열지 않는다' 가 뜻이 있다
    expect(callsOf(fake, 'webContents.openDevTools').map((call) => call.args)).toStrictEqual(opens ? [[{ mode: 'detach' }]] : []);
  });
});

/** fail-closed 원인 — what 은 [tj] 줄의 '<무엇>: ', where 는 줄에 드는 틀린 자리다. */
type Cause = { label: string; renderer: Exclude<Renderer, 'valid'>; what: string; where: (root: string) => string };
const CAUSES: Cause[] = [
  { label: '렌더러 루트가 없다(tray-build.json 없음)', renderer: 'missing', what: 'tray-build.json: ', where: (root) => join(root, 'tray-build.json') },
  { label: 'tray-build.json 이 틀렸다(csp.header 없음)', renderer: 'bad-build', what: 'tray-build.json: ', where: (root) => join(root, 'tray-build.json') },
  { label: 'tray.html 이 없다', renderer: 'no-entry', what: 'tray.html: ', where: (root) => root },
];
/** fail-closed 일 때 ready 뒤에 부를 수 있는 것 — 처리기 · 세션 · IPC · 창 · 트레이는 하나도 없다. */
const FAIL_CLOSED_CALLS = ['app.setAppUserModelId', 'Menu.setApplicationMenu', 'dialog.showErrorBox', 'app.quit', 'app.exit'];

describe.each(CAUSES)('fail-closed — $label', ({ renderer, what, where }) => {
  /** ready 뒤에 FAIL_CLOSED_CALLS 밖의 호출이 없고, [tj] 줄은 '<무엇>: …(<어디>)' 한 줄이다. 그 줄을 돌려준다. */
  function expectClosed(fake: Fake, mode: Mode): string {
    expect(fake.calls.filter((call) => call.ready && !FAIL_CLOSED_CALLS.includes(call.name)).map((call) => call.name)).toStrictEqual([]);
    expect(stderr).toHaveLength(1);
    const line = stderr[0] ?? '';
    expect(line.startsWith(`[tj] ${what}`), line).toBe(true);
    expect(line).toContain(where(rootOf(mode)));
    expect(line.includes('npm run build:tray'), '개발 나무에서만 build:tray 를 안내한다').toBe(!isPackagedMode(mode));
    return line;
  }

  it.each(['dev', 'packaged'] as const)('%s — [tj] 한 줄 → 오류 상자 → app.quit()', async (mode) => {
    const fake = await runMain(mode, { renderer });
    expectClosed(fake, mode);
    const box = only(fake, 'dialog.showErrorBox');
    expect(box.args[0]).toBe('십이장기');
    expect(box.args[1]).toContain(what);
    expect(box.args[1]).toContain(where(rootOf(mode)));
    expect(fake.calls.at(-1)?.name).toBe('app.quit');
    expect(indexOf(fake.calls, 'app.quit')).toBeGreaterThan(indexOf(fake.calls, 'dialog.showErrorBox'));
    expect(callsOf(fake, 'app.exit')).toStrictEqual([]);
    expect(existsSync(currentTree().outDir)).toBe(false);
  });

  it('smoke — [tj] 한 줄 · 결과(stage tray-build, 같은 이유) · exit(1), 오류 상자 없음', async () => {
    const fake = await runMain('smoke', { renderer });
    const line = expectClosed(fake, 'smoke');
    const result = readResult();
    expect(result).toStrictEqual({
      nonce: NONCE,
      stage: 'tray-build',
      error: expect.stringContaining(where(rootOf('smoke'))),
      checks: [],
      versions: expectedVersions(),
    });
    expect(String(result.error).startsWith(what)).toBe(true);
    expect(line.startsWith(`[tj] ${String(result.error)}`), '줄과 결과의 이유가 같다').toBe(true);
    expect(callsOf(fake, 'app.exit').map((call) => call.args)).toStrictEqual([[1]]);
    expect(callsOf(fake, 'dialog.showErrorBox')).toStrictEqual([]);
    expect(callsOf(fake, 'app.quit')).toStrictEqual([]);
  });
});

// onReady 가 던졌다(#36 T6-1) — 가짜의 protocol.handle 이 던지게 해서(가짜에 빠진 멤버를 부른 것처럼) 처리기 · 창 · 트레이가 반쯤 선
// 자리에서 멈춘다. 스모크는 실행기를 꽂은 뒤라 그 감시 타이머 · process 처리기도 afterEach 가 정리한다.
describe('whenReady 실패 — onReady 가 던지면 반쯤 뜬 채 두지 않는다', () => {
  const MISSING = 'protocol.handle is not a function';
  const throwOn = { name: 'protocol.handle', error: new TypeError(MISSING) };

  it('dev — [tj] ready: 줄 → 오류 상자(이유) → app.quit(), 창 · 트레이는 만들지 않는다', async () => {
    const fake = await runMain('dev', { throwOn, expectReadyFailure: true });
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.startsWith(`[tj] ready: ${MISSING}`), stderr[0]).toBe(true);
    const box = only(fake, 'dialog.showErrorBox');
    expect(box.args[0]).toBe('십이장기');
    expect(box.args[1]).toContain(MISSING);
    expect(fake.calls.at(-1)?.name).toBe('app.quit');
    expect(indexOf(fake.calls, 'app.quit')).toBeGreaterThan(indexOf(fake.calls, 'dialog.showErrorBox'));
    expect([...callsOf(fake, 'new BrowserWindow'), ...callsOf(fake, 'new Tray'), ...callsOf(fake, 'app.exit')]).toStrictEqual([]);
    expect(existsSync(currentTree().outDir)).toBe(false);
  });

  it('smoke — [tj] ready: 줄 · 결과(stage ready, 같은 이유) · exit(1), 오류 상자 · quit 없음', async () => {
    const fake = await runMain('smoke', { throwOn, expectReadyFailure: true });
    expect(readResult()).toStrictEqual({ nonce: NONCE, stage: 'ready', error: MISSING, checks: [], versions: expectedVersions() });
    expect(callsOf(fake, 'app.exit').map((call) => call.args)).toStrictEqual([[1]]);
    expect(callsOf(fake, 'dialog.showErrorBox')).toStrictEqual([]);
    expect(callsOf(fake, 'app.quit')).toStrictEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.startsWith(`[tj] ready: ${MISSING}`), stderr[0]).toBe(true);
  });
});

describe('app:// 처리기', () => {
  /** 처리기를 단 정상 실행(패키지 — 렌더러 루트는 resources/renderer). */
  async function serve(): Promise<(request: unknown) => Promise<Response>> {
    const fake = await runMain('packaged');
    return only(fake, 'protocol.handle', 'app').args[1] as (request: unknown) => Promise<Response>;
  }
  const headersOf = (response: Response) => Object.fromEntries(response.headers);

  it('200 — 헤더는 content-type · CSP(tray-build.json 의 header 판 그대로) · nosniff 셋, HEAD 는 본문 없이', async () => {
    const handle = await serve();
    const html = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': BUILD.csp.header, 'x-content-type-options': 'nosniff' };
    const root = await handle(new Request('app://twelvejanggi/'));
    expect([root.status, headersOf(root), await root.text()]).toStrictEqual([200, html, TRAY_HTML]);
    const script = await handle(new Request('app://twelvejanggi/assets/tray.js'));
    expect([script.status, headersOf(script), await script.text()]).toStrictEqual([
      200,
      { ...html, 'content-type': 'text/javascript; charset=utf-8' },
      TRAY_JS,
    ]);
    const head = await handle(new Request(ENTRY_URL, { method: 'HEAD' }));
    expect([head.status, headersOf(head), head.body]).toStrictEqual([200, html, null]);
  });

  it('404 · 405 는 text/plain(+nosniff, CSP 없음) — HEAD 는 본문 없이', async () => {
    const handle = await serve();
    const plain = { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' };
    const cases: Array<[Request, number, string | null]> = [
      [new Request(ENTRY_URL, { method: 'POST', body: '수' }), 405, 'Method Not Allowed'],
      [new Request('app://twelvejanggi/없는.js'), 404, 'Not Found'],
      [new Request('app://twelvejanggi/없는.js', { method: 'HEAD' }), 404, null],
      [new Request('app://twelvejanggi/tray-build.json'), 404, 'Not Found'],
      [new Request('app://other/tray.html'), 404, 'Not Found'],
    ];
    for (const [request, status, body] of cases) {
      const response = await handle(request);
      const text = response.body === null ? null : await response.text();
      expect([request.method, request.url, response.status, headersOf(response), text]).toStrictEqual([request.method, request.url, status, plain, body]);
    }
  });

  it('던지거나 reject 하지 않는다 — 색인 뒤에 지운 파일 · method 를 읽으면 던지는 요청 · null 도 404 응답이다', async () => {
    const handle = await serve();
    rmSync(join(rootOf('packaged'), 'assets', 'tray.js'));
    const hostile = {
      url: ENTRY_URL,
      get method(): string {
        throw new Error('요청이 깨졌다');
      },
    };
    for (const request of [new Request('app://twelvejanggi/assets/tray.js'), hostile, null]) {
      const response = await handle(request); // 던지거나 reject 하면 이 시험이 그 오류로 실패한다
      expect(response).toBeInstanceOf(Response);
      expect([response.status, response.headers.get('content-type')]).toStrictEqual([404, 'text/plain; charset=utf-8']);
    }
  });
});

describe('허용 목록 주소 — 기본 open 은 shell.openExternal', () => {
  const REPO = 'https://github.com/khkim3115/TwelveJanggi';
  const HUB = 'https://khkim3115.github.io/';

  /** 트레이 창의 will-navigate(REPO) · window.open(HUB) 을 불러 기본 open 으로 연다 — 둘 다 막고 시스템 브라우저로 넘긴다. */
  async function openBoth(openExternal: 'resolve' | 'reject'): Promise<void> {
    const fake = await runMain('dev', { openExternal });
    let prevented = 0;
    const [willNavigate] = listenersOf(fake.calls, 'webContents.on', 'will-navigate');
    willNavigate?.({ url: REPO, preventDefault: () => (prevented += 1) });
    const windowOpen = only(fake, 'webContents.setWindowOpenHandler').args[0] as (details: { url: string }) => unknown;
    expect(windowOpen({ url: HUB })).toStrictEqual({ action: 'deny' });
    await settle();
    expect(prevented).toBe(1);
    expect(callsOf(fake, 'shell.openExternal').map((call) => call.args)).toStrictEqual([[REPO], [HUB]]);
  }

  it('열지 못하면 [tj] openExternal 한 줄씩 남긴다 — unhandledRejection 은 없다', async () => {
    await openBoth('reject');
    expect(stderr).toStrictEqual([`[tj] openExternal: ${OPEN_ERROR}`, `[tj] openExternal: ${OPEN_ERROR}`]);
    expect(rejections).toStrictEqual([]);
  });

  it('열면 아무 줄도 남기지 않는다', async () => {
    await openBoth('resolve');
    expect(stderr).toStrictEqual([]);
  });
});

/** 스모크 실행기의 수집기 — 창과 loadURL 사이에 트레이 창의 webContents 에 동기로 붙는다(설계 §5.10 '앱 안 실행기'). run.cjs 의 beforeLoad 순서. */
const COLLECTORS = ['console-message', 'did-fail-load', 'did-fail-provisional-load', 'did-start-navigation', 'did-stop-loading', 'render-process-gone', 'preload-error', 'unresponsive', 'did-finish-load'];
/** 탐색 가드가 webContents.on 으로 거는 사건 — 비스모크에서는 이것뿐이다. */
const NAVIGATION_EVENTS = ['will-frame-navigate', 'will-navigate', 'will-redirect', 'will-attach-webview'];

describe('스모크 실행기 연결(smoke/run.cjs) — main 은 스모크에서만 꽂는다', () => {
  it.each(['smoke', 'packaged-smoke'] as const)('%s — 처리기 · 창 · 트레이보다 먼저 꽂힌다: 네트워크 가드(창 전) · tj-smoke-* 수신(tj-app-info 다음, 창 전) · 수집기(창과 loadURL 사이) · will-quit · process 처리기, 한 동기 구간', async (mode) => {
    const fake = await runMain(mode);
    const after = fake.calls.filter((call) => call.ready);
    const windowAt = indexOf(after, 'new BrowserWindow');
    const loadAt = indexOf(after, 'win.loadURL');
    // guardSession 이 hooks 를 읽을 때 가드가 이미 있었다 — 기본 세션의 onBeforeRequest 하나
    expect(callsOf(fake, 'session.webRequest.onBeforeRequest')).toHaveLength(1);
    expect(indexOf(after, 'session.webRequest.onBeforeRequest')).toBeLessThan(windowAt);
    // preload 의 send 는 듣는 쪽이 없으면 버려진다 — 수신은 창보다 먼저, 발신자 검증(createGuardedIpc)을 거친다
    const ipc = after.flatMap((call, at) => (call.name.startsWith('ipcMain.') ? [{ call, at }] : []));
    expect(ipc.map(({ call }) => [call.name, call.args[0]])).toStrictEqual([
      ['ipcMain.handle', 'tj-app-info'],
      ['ipcMain.on', 'tj-smoke-preload'],
      ['ipcMain.on', 'tj-smoke-csp'],
    ]);
    for (const { call, at } of ipc) expect(at, String(call.args[0])).toBeLessThan(windowAt);
    for (const event of COLLECTORS) {
      const at = indexOf(after, 'webContents.on', event);
      expect(at, event).toBeGreaterThan(windowAt);
      expect(at, event).toBeLessThan(loadAt);
    }
    expect(listenersOf(fake.calls, 'app.on', 'will-quit')).toHaveLength(1); // 감시 타이머를 끄는 곳
    expect(after.filter((call) => call.turn !== 1).map((call) => call.name)).toStrictEqual([]);
    expect(PROCESS_EVENTS.map((event) => added[event].length)).toStrictEqual([1, 1]);
    // 실행기는 electron 을 require 하지 않는다 — Electron 객체는 main 이 넘긴다
    expect(Object.keys(require.cache)).toContain(join(currentTree().desktop, 'smoke', 'run.cjs'));
    expect(Object.keys(require.cache).filter((key) => /[\\/]node_modules[\\/]electron[\\/]/.test(key))).toStrictEqual([]);
    expect(stderr).toStrictEqual([]);
    expect(existsSync(currentTree().outDir)).toBe(false); // 결과는 검사가 끝나거나 실패할 때만 쓴다
  });

  it.each(['dev', 'packaged'] as const)('%s — 꽂지 않는다: run.cjs 를 require 하지 않고, 가드 · tj-smoke-* · 수집기 · will-quit · process 처리기가 없다', async (mode) => {
    const fake = await runMain(mode);
    expect(Object.keys(require.cache).filter((key) => key.startsWith(join(currentTree().desktop, 'smoke')))).toStrictEqual([]);
    expect(callsOf(fake, 'session.webRequest.onBeforeRequest')).toStrictEqual([]);
    expect(callsOf(fake, 'ipcMain.on')).toStrictEqual([]);
    expect(callsOf(fake, 'webContents.on').map((call) => call.args[0])).toStrictEqual(NAVIGATION_EVENTS);
    expect(listenersOf(fake.calls, 'app.on', 'will-quit')).toStrictEqual([]);
    expect(added).toStrictEqual({ uncaughtException: [], unhandledRejection: [] });
    expect(fake.calls.filter((call) => call.name.startsWith('hook.')).map((call) => call.name)).toStrictEqual([]); // 엿볼 run 이 없다
  });

  it('hooks 엿보기 — main 이 꽂은 run 의 record 가 받은 결정을 가짜의 기록(hook.record)에서 본다: 막힌 will-navigate 하나', async () => {
    const fake = await runMain('smoke');
    const url = 'https://example.invalid/밖';
    let prevented = 0;
    const [willNavigate] = listenersOf(fake.calls, 'webContents.on', 'will-navigate');
    willNavigate?.({ url, preventDefault: () => (prevented += 1) });
    expect(prevented).toBe(1);
    expect(callsOf(fake, 'hook.record').map((call) => call.args)).toStrictEqual([[{ kind: 'will-navigate', url, blocked: true, href: null }]]);
    expect(callsOf(fake, 'hook.open')).toStrictEqual([]); // 허용 목록 밖 — 열지 않는다
    expect(callsOf(fake, 'hook.setTray')).toHaveLength(1); // 트레이 메뉴를 붙일 때 한 번 — 감싼 setTray 도 진짜에 넘어간다
  });

  it('네트워크 가드 — http · https · ws · wss 는 취소하고, app:// 와 그 밖의 스킴은 그대로 둔다(요청마다 콜백 한 번)', async () => {
    const fake = await runMain('smoke');
    type Guard = (details: { url: unknown }, callback: (response: unknown) => void) => void;
    const guard = only(fake, 'session.webRequest.onBeforeRequest').args[0] as Guard;
    const answer = (url: unknown): unknown[] => {
      const responses: unknown[] = [];
      guard({ url }, (response) => responses.push(response));
      return responses;
    };
    const remote = ['https://example.invalid/tj', 'http://127.0.0.1:5173/tray.html', 'wss://ci.invalid/realtime/v1/websocket', 'ws://localhost:5173/', 'HTTPS://EXAMPLE.INVALID/'];
    for (const url of remote) expect(answer(url), url).toStrictEqual([{ cancel: true }]);
    const local = ['app://twelvejanggi/tray.html', 'app://twelvejanggi/assets/ai.worker.js', 'devtools://devtools/bundled/x.html', 'file:///C:/x.txt', 'data:text/plain,x', 'httpx://x/', '', undefined];
    for (const url of local) expect(answer(url), String(url)).toStrictEqual([{}]);
    expect(stderr).toStrictEqual([]);
  });

  it('허용 목록 주소 — 스모크에서는 시스템 브라우저로 열지 않는다(open 은 실행기의 기록기)', async () => {
    const fake = await runMain('smoke');
    let prevented = 0;
    const [willNavigate] = listenersOf(fake.calls, 'webContents.on', 'will-navigate');
    willNavigate?.({ url: 'https://github.com/khkim3115/TwelveJanggi', preventDefault: () => (prevented += 1) });
    const windowOpen = only(fake, 'webContents.setWindowOpenHandler').args[0] as (details: { url: string }) => unknown;
    expect(windowOpen({ url: 'https://khkim3115.github.io/' })).toStrictEqual({ action: 'deny' });
    await settle();
    expect(prevented).toBe(1);
    expect(callsOf(fake, 'shell.openExternal')).toStrictEqual([]);
    // 실행기의 open 이 받았다 — 엿보기가 감싼 open 이 기록한 뒤 진짜에 넘긴다(will-navigate 는 곧바로, window.open 은 다음 tick)
    expect(callsOf(fake, 'hook.open').map((call) => call.args)).toStrictEqual([['https://github.com/khkim3115/TwelveJanggi'], ['https://khkim3115.github.io/']]);
    expect(stderr).toStrictEqual([]);
  });

  it.each([
    ['uncaughtException', 'unhandledRejection'],
    ['unhandledRejection', 'uncaughtException'],
  ] as const)('%s 다음 %s — 실행기의 fail: 결과(stage = 처음 원인) 한 번 · [tj] 한 줄 · exit(1) 한 번', async (first, second) => {
    const fake = await runMain('smoke');
    const [firstListener] = added[first];
    const [secondListener] = added[second];
    firstListener?.(new Error(`${first} 의 원인`));
    secondListener?.(new Error(`${second} 의 원인`)); // 처음 실패가 이긴다 — 두 번째 쓰기 · exit 없음
    expect(readResult()).toStrictEqual({ nonce: NONCE, stage: first, error: `${first} 의 원인`, checks: [], versions: expectedVersions() });
    expect(callsOf(fake, 'app.exit').map((call) => call.args)).toStrictEqual([[1]]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.startsWith(`[tj] smoke ${first}: ${first} 의 원인`), stderr[0]).toBe(true);
  });

  /** [사건, 리스너 인자, 결과 error 에 들 글] — 무인 실행의 비정상 종료 사건은 결과를 쓰고 exit 1 이다. */
  const GONE: Array<[string, unknown[], string]> = [
    ['render-process-gone', [{}, { reason: 'crashed', exitCode: 3 }], 'crashed'],
    ['preload-error', [{}, 'C:\\앱\\preload.js', new Error('preload 가 던졌다')], 'preload 가 던졌다'],
    ['unresponsive', [], '응답'],
    ['did-fail-load', [{}, -6, 'ERR_FILE_NOT_FOUND', `${ENTRY_URL}?smoke`, true, 1, 1], 'ERR_FILE_NOT_FOUND'],
  ];
  it.each(GONE)('수집기 %s — 결과(stage = 사건 이름) · exit(1)', async (event, args, fragment) => {
    const fake = await runMain('smoke');
    const [listener] = listenersOf(fake.calls, 'webContents.on', event);
    listener?.(...args);
    expect(readResult()).toStrictEqual({ nonce: NONCE, stage: event, error: expect.stringContaining(fragment), checks: [], versions: expectedVersions() });
    expect(callsOf(fake, 'app.exit').map((call) => call.args)).toStrictEqual([[1]]);
  });

  it('서브프레임 did-fail-load · did-fail-provisional-load 는 기록만 한다 — 결과 · exit · [tj] 줄 없음', async () => {
    const fake = await runMain('smoke');
    const [failLoad] = listenersOf(fake.calls, 'webContents.on', 'did-fail-load');
    const [failProvisional] = listenersOf(fake.calls, 'webContents.on', 'did-fail-provisional-load');
    expect([typeof failLoad, typeof failProvisional]).toStrictEqual(['function', 'function']);
    failLoad?.({}, -3, 'ERR_ABORTED', 'https://example.invalid/', false, 1, 2);
    failProvisional?.({}, -3, 'ERR_ABORTED', 'https://example.invalid/', true, 1, 1);
    await settle();
    expect(existsSync(currentTree().outDir)).toBe(false);
    expect(callsOf(fake, 'app.exit')).toStrictEqual([]);
    expect(stderr).toStrictEqual([]);
  });

  // 두 감시 타이머 사례는 자기 가짜 시계(setTimeout · clearTimeout 만)를 먼저 건다 — runMain 의 기본 시계는 그때 아무것도 하지 않는다.
  // 진짜 시계로 되돌리는 일은 afterEach 가 한다(여기서 되돌리면 afterEach 의 남은 타이머 세기가 'Timers are not mocked' 로 던진다).
  it('감시 타이머 — 60초에 결과(stage watchdog) · exit(1), 그 전에는 아무것도 하지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = await runMain('smoke');
    vi.advanceTimersByTime(59_999);
    expect(existsSync(currentTree().outDir)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(readResult()).toStrictEqual({ nonce: NONCE, stage: 'watchdog', error: expect.stringContaining('60'), checks: [], versions: expectedVersions() });
    expect(callsOf(fake, 'app.exit').map((call) => call.args)).toStrictEqual([[1]]);
  });

  it('감시 타이머 — will-quit 이 끈다(그 뒤로는 결과 · exit 없음)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = await runMain('smoke');
    const quits = listenersOf(fake.calls, 'app.on', 'will-quit');
    expect(quits).toHaveLength(1);
    for (const quit of quits) quit();
    vi.advanceTimersByTime(120_000);
    expect(existsSync(currentTree().outDir)).toBe(false);
    expect(callsOf(fake, 'app.exit')).toStrictEqual([]);
  });
});

// 가짜 electron(fakeElectron.ts)의 Electron 흉내 — 창 동작 · 트레이 · 디스플레이 사례가 기대는 규칙을 가짜 자체로 본다. main 이 만든
// 창을 사례가 직접 부르므로 그 호출도 기록에 남는다.
describe('가짜 electron — 창 · screen · app 의 Electron 흉내', () => {
  /** main 이 만든 트레이 창(하나뿐). */
  function trayWindow(fake: Fake): FakeWindow {
    expect(fake.windows).toHaveLength(1);
    const [win] = fake.windows;
    if (win === undefined) throw new Error('트레이 창이 없다');
    return win;
  }

  it('show · hide 는 보임이 바뀔 때만 사건을 낸다 — 손잡이 blurOnHide 는 보임을 끄기 전에 blur 를 동기로 내고, 그때의 isVisible() 를 기록한다', async () => {
    const fake = await runMain('dev');
    const win = trayWindow(fake);
    const seen: Array<[string, boolean]> = [];
    for (const event of ['show', 'hide', 'blur']) win.on(event, () => seen.push([event, win.isVisible()]));
    win.hide(); // show: false 로 만들었다 — 이미 숨어 있다
    win.show();
    win.show(); // 이미 보인다
    win.hide(); // 손잡이 끔 — blur 없음
    win.show();
    fake.handles.blurOnHide = true;
    win.hide();
    expect(seen).toStrictEqual([
      ['show', true],
      ['hide', false],
      ['show', true],
      ['blur', true],
      ['hide', false],
    ]);
    expect(callsOf(fake, 'handle.blurOnHide').map((call) => call.args)).toStrictEqual([[true]]);
  });

  it.each(PLATFORMS)('%s — setBounds 는 주지 않은 값을 그대로 두고, darwin 은 그 안에서 move · moved 를 동기로 낸다(손잡이 moveOnSetBounds 의 기본값)', async (platform) => {
    const fake = await runMain('dev', { platform });
    const win = trayWindow(fake);
    const seen: string[] = [];
    win.on('move', () => seen.push(`move ${win.getBounds().x}`));
    win.on('moved', () => seen.push('moved'));
    win.setBounds({ x: 12, y: 34 });
    seen.push('setBounds 뒤');
    expect(seen).toStrictEqual(platform === 'darwin' ? ['move 12', 'moved', 'setBounds 뒤'] : ['setBounds 뒤']);
    expect(win.getBounds()).toStrictEqual({ x: 12, y: 34, width: 340, height: 400 });
  });

  it('destroy 뒤에는 isDestroyed() 만 답하고 창 · webContents 의 멤버는 TypeError(Object has been destroyed) 를 던진다', async () => {
    const fake = await runMain('dev');
    const win = trayWindow(fake);
    win.destroy();
    expect(win.isDestroyed()).toBe(true);
    const members = [
      () => win.show(),
      () => win.hide(),
      () => win.isVisible(),
      () => win.setBounds({ x: 0 }),
      () => win.emit('blur'),
      () => win.on('blur', () => {}),
      () => win.destroy(),
      () => win.webContents.send('tj-shown'),
      () => win.webContents.getBackgroundThrottling(),
    ];
    for (const member of members) {
      expect(member).toThrow(TypeError);
      expect(member).toThrow('Object has been destroyed');
    }
  });

  it('screen — 주 디스플레이는 목록의 앞, getDisplayMatching 은 가장 많이 겹치는 것(겹침이 없으면 가장 가까운 것), removeDisplay 는 떼고 display-removed 를 낸다, ready 전에는 던진다', async () => {
    const primary: FakeDisplay = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
    const left: FakeDisplay = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1.5 };
    const fake = await runMain('dev', { displays: [primary, left] });
    const { screen } = fake.electron;
    const popup = (x: number): Rect => ({ x, y: 10, width: 340, height: 400 });
    expect(screen.getPrimaryDisplay()).toStrictEqual(primary);
    expect([popup(-100), popup(-300), popup(-2500), popup(2500)].map((rect) => screen.getDisplayMatching(rect).id)).toStrictEqual([1, 2, 2, 1]);
    expect(screen.getDisplayNearestPoint({ x: -5, y: 5 }).id).toBe(2);
    const removed: unknown[] = [];
    screen.on('display-removed', (_event, display) => removed.push(display));
    fake.removeDisplay(2);
    expect(removed).toStrictEqual([left]);
    expect(screen.getDisplayMatching(popup(-300)).id).toBe(1); // 남은 디스플레이
    const early = createFakeElectron({ isPackaged: false, lock: true, appData: currentTree().appData, openExternal: 'reject', platform: 'win32' });
    expect(() => early.electron.screen.getPrimaryDisplay()).toThrow('ready 전');
  });

  it('app — 속성 쓰기는 app.set 으로 기록되고 쓴 값이 그대로 남는다(동일성) · dock 은 darwin 에만 있다 · new Tray 는 받은 이미지 객체를 기록한다', async () => {
    const fake = await runMain('dev', { platform: 'linux' });
    const replacement = (): void => {};
    const app = fake.electron.app as unknown as Record<string, unknown>;
    app.setLoginItemSettings = replacement;
    expect(app.setLoginItemSettings).toBe(replacement);
    expect(callsOf(fake, 'app.set').map((call) => call.args)).toStrictEqual([['setLoginItemSettings', replacement]]);
    expect(fake.electron.app.dock).toBeUndefined();
    const [icon] = only(fake, 'new Tray').args as [FakeImage];
    expect(icon.isEmpty()).toBe(false); // 기록이 이미지 객체 그 자체다(아이콘 파일을 읽었다)
  });
});
