// desktop/main.js 배선 시험(설계 §5.5 · §5.3 · §5.7) — main.js 를 가짜 electron 위에서 실제로 돌려, 글자 시험(mainSource.test.ts)이
// 보지 못하는 실행 순서 · 조건 · 콜백을 본다. Electron 은 띄우지 않는다.
// - 가짜 electron 은 Module._load 훅이 모듈 해석보다 먼저 돌려준다. 진짜 electron 패키지를 찾지 않으므로 desktop/node_modules 가
//   없어도 돈다(electron 은 import · require 하지 않는다). 훅은 main.js 를 require 하는 동안만 걸고, require 캐시 · argv ·
//   환경 변수 · process 값은 사례마다 되돌린다 — 다른 시험 파일에 남지 않게.
// - main.js 는 개발 렌더러 루트(../dist-tray)와 트레이 아이콘을 __dirname 에서 찾는다. 제자리에서 돌리면 저장소의 dist-tray
//   (build:tray 를 했는지에 따라 있거나 없다)를 읽게 되므로, 사례마다 mkdtemp(한글 · 공백 이름) 안에 같은 모양의 나무
//   — desktop/(main.js · package.json · lib/*.cjs · smoke/*.cjs · assets/ 를 저장소에서 복사) · dist-tray/ · resources/renderer/ — 를 깔고
//   거기서 main.js 를 부른다. 사례마다 새로 복사하므로 main.js 를 고치면 이 시험이 바로 본다.
// - 사례 하나가 main.js 한 번 실행이다. stderr 의 '[tj] …' 줄(main 은 fs.writeSync(2) 로 쓴다)과 unhandledRejection 은 가로채 모은다.
// - 스모크 모드는 main 이 스모크 실행기(smoke/run.cjs)를 hooks 에 꽂는다. 실행기의 검사는 첫 did-finish-load 뒤에 돌므로(가짜는 그
//   사건을 내지 않는다) 여기서는 연결점 · 수집기 · 실패 경로만 본다 — 검사 자체는 실제 바이너리의 스모크가 본다. 실행기가 켜는
//   60초 감시 타이머는 사례마다 will-quit 으로 끄고, main 이 단 process 처리기(uncaughtException · unhandledRejection)는 사례마다 뗀다.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTrayBuildInfo, buildTrayCsp } from '../../scripts/trayBuild.ts';

const require = createRequire(import.meta.url);
const { formatSmokeArgs, parseSmokeArgs } = require('./smokeArgs.cjs') as typeof import('./smokeArgs.cjs');
const { RESULT_FILE } = require('./smokeOut.cjs') as typeof import('./smokeOut.cjs');

// 바꿔 끼우는 두 자리 — main.js 가 require 로 받는 것과 같은 객체다. 타입은 쓰는 멤버만 적는다(대입하려고).
type LoadFn = (this: unknown, request: string, parent: { filename?: string | null } | null | undefined, isMain: boolean) => unknown;
const nodeModule = require('node:module') as { _load: LoadFn };
const nodeFs = require('node:fs') as { writeSync: (...args: unknown[]) => unknown };
const realLoad = nodeModule._load;
const realWriteSync = nodeFs.writeSync;
const proc = process as NodeJS.Process & { resourcesPath?: string };

/** 저장소의 desktop/ — 사례마다 여기서 main.js · lib · assets 를 복사한다. */
const DESKTOP_SRC = fileURLToPath(new URL('..', import.meta.url));
const ENTRY_URL = 'app://twelvejanggi/tray.html';
const APP_VERSION = '0.1.0';
/** Node 에는 없는 process.versions 값 — 사례 동안만 채운다(스모크 결과의 versions · AppInfo 가 읽는다). */
const ELECTRON_VERSIONS = { electron: '44.9.3', chrome: '152.0.7977.167' };
const NONCE = '논스 1';
const OPEN_ERROR = '브라우저를 띄우지 못했다';
/** tray-build.json — build:tray 가 쓰는 모양(Supabase 값 없음). 200 응답의 CSP 는 이 header 판 그대로여야 한다. */
const BUILD = buildTrayBuildInfo(buildTrayCsp(undefined), null, '2026-10-27T00:00:00.000Z', null);
const TRAY_HTML = '<!doctype html>\n<meta charset="UTF-8" />\n<title>십이장기</title>\n';
const TRAY_JS = 'console.log("십이장기");\n';

/**
 * 가짜 electron 이 기록한 호출 하나. ready 는 whenReady 가 풀린 뒤인가, turn 은 ready 뒤 첫 동기 구간(1)인가 그 뒤(2)인가
 * (ready 전은 0) — onReady 사이에 await 가 끼면 그 뒤의 호출이 turn 2 가 된다.
 */
type Call = { name: string; args: unknown[]; ready: boolean; turn: 0 | 1 | 2 };
type Fn = (...args: unknown[]) => unknown;
type FakeContents = {
  mainFrame: { detached: boolean; url: string; origin: string };
  on(event: string, listener: Fn): void;
  setWindowOpenHandler(handler: Fn): void;
  openDevTools(options: unknown): void;
};
type FakeImage = { isEmpty(): boolean; resize(size: unknown): FakeImage };
type FakeOptions = { isPackaged: boolean; lock: boolean; appData: string; openExternal: 'resolve' | 'reject' };

/** calls 가운데 name(첫 인자 key) 호출의 처리기(둘째 인자) — app.on('web-contents-created', fn) 의 fn 같은 것. */
function listenersOf(calls: readonly Call[], name: string, key: string): Fn[] {
  return calls.filter((call) => call.name === name && call.args[0] === key).map((call) => call.args[1] as Fn);
}

/**
 * 기록하는 가짜 electron — main.js 가 쓰는 멤버만 있다. 처리기 · 리스너는 기록에 남고 시험이 직접 부른다.
 * Electron 과 같게 한 것: setPath 는 없는 폴더면 던진다 · enableSandbox 와 registerSchemesAsPrivileged 는 ready 뒤면 던진다 ·
 * BrowserWindow 는 만들면서 'web-contents-created' 를 부른다. ipcMain 은 어느 멤버를 불러도(계산된 키 · 구조 분해 포함) 기록된다.
 */
function createFakeElectron({ isPackaged, lock, appData, openExternal }: FakeOptions) {
  const calls: Call[] = [];
  const windows: Array<{ webContents: FakeContents }> = [];
  let ready = false;
  let turn: Call['turn'] = 0;
  let userData: string | null = null;
  const rec = (name: string, ...args: unknown[]): void => {
    if (ready && turn === 0) {
      turn = 1;
      queueMicrotask(() => {
        turn = 2;
      });
    }
    calls.push({ name, args, ready, turn });
  };

  const app = {
    get isPackaged(): boolean {
      return isPackaged;
    },
    getPath(name: string): string {
      rec('app.getPath', name);
      if (name === 'appData') return appData;
      if (name === 'userData') return userData ?? join(appData, 'TwelveJanggi');
      throw new Error(`가짜 getPath 가 모르는 이름이다: ${name}`);
    },
    setPath(name: string, value: string): void {
      rec('app.setPath', name, value);
      if (!isAbsolute(value) || !existsSync(value)) throw new Error(`setPath: 없는 폴더다 (${value})`);
      if (name === 'userData') userData = value;
    },
    enableSandbox(): void {
      rec('app.enableSandbox');
      if (ready) throw new Error('enableSandbox 는 ready 전에만 부를 수 있다');
    },
    /** 잠금은 지금의 userData 에 걸린다 — 기록의 인자가 그 값이다(null 은 Electron 기본값). */
    requestSingleInstanceLock(): boolean {
      rec('app.requestSingleInstanceLock', userData);
      return lock;
    },
    whenReady(): Promise<void> {
      rec('app.whenReady');
      return Promise.resolve().then(() => {
        ready = true;
      });
    },
    on: (event: string, listener: Fn) => rec('app.on', event, listener),
    exit: (code: number) => rec('app.exit', code),
    quit: () => rec('app.quit'),
    setAppUserModelId: (id: string) => rec('app.setAppUserModelId', id),
    getVersion: () => APP_VERSION,
  };
  class BrowserWindow {
    readonly webContents: FakeContents = {
      mainFrame: { detached: false, url: ENTRY_URL, origin: 'app://twelvejanggi' },
      on: (event, listener) => rec('webContents.on', event, listener),
      setWindowOpenHandler: (handler) => rec('webContents.setWindowOpenHandler', handler),
      openDevTools: (options) => rec('webContents.openDevTools', options),
    };
    readonly once = (event: string, listener: Fn) => rec('win.once', event, listener);
    readonly on = (event: string, listener: Fn) => rec('win.on', event, listener);
    readonly isDestroyed = () => false;
    constructor(options: unknown) {
      rec('new BrowserWindow', options);
      windows.push(this);
      // Electron 처럼 webContents 를 만들면서 'web-contents-created' 를 부른다 — main 의 탐색 가드가 여기서 걸린다.
      for (const listener of listenersOf(calls, 'app.on', 'web-contents-created')) listener({}, this.webContents);
    }
    loadURL(url: string): Promise<void> {
      rec('win.loadURL', url);
      return Promise.resolve();
    }
  }
  class Tray {
    readonly setToolTip = (text: string) => rec('tray.setToolTip', text);
    readonly setContextMenu = (menu: unknown) => rec('tray.setContextMenu', menu);
    readonly on = (event: string, listener: Fn) => rec('tray.on', event, listener);
    constructor(image: FakeImage) {
      rec('new Tray', { empty: image.isEmpty() });
    }
  }
  const nativeImage = {
    createFromPath(file: string): FakeImage {
      rec('nativeImage.createFromPath', file);
      const image: FakeImage = { isEmpty: () => !existsSync(file), resize: () => image };
      return image;
    },
  };
  const Menu = {
    setApplicationMenu: (menu: unknown) => rec('Menu.setApplicationMenu', menu),
    buildFromTemplate: (template: unknown) => ({ template }),
  };
  const dialog = { showErrorBox: (title: string, content: string) => rec('dialog.showErrorBox', title, content) };
  const ipcMain = new Proxy(
    {},
    { get: (_target, key) => (typeof key === 'string' ? (...args: unknown[]) => rec(`ipcMain.${key}`, ...args) : undefined) },
  );
  const protocol = {
    registerSchemesAsPrivileged(schemes: unknown): void {
      rec('protocol.registerSchemesAsPrivileged', schemes);
      if (ready) throw new Error('registerSchemesAsPrivileged 는 ready 전에만 부를 수 있다');
    },
    handle: (scheme: string, handler: Fn) => rec('protocol.handle', scheme, handler),
  };
  const session = {
    defaultSession: {
      setPermissionRequestHandler: (handler: Fn) => rec('session.setPermissionRequestHandler', handler),
      setPermissionCheckHandler: (handler: Fn) => rec('session.setPermissionCheckHandler', handler),
      setDevicePermissionHandler: (handler: Fn) => rec('session.setDevicePermissionHandler', handler),
      on: (event: string, listener: Fn) => rec('session.on', event, listener),
      webRequest: { onBeforeRequest: (listener: Fn) => rec('session.webRequest.onBeforeRequest', listener) },
    },
  };
  const shell = {
    openExternal(href: string): Promise<void> {
      rec('shell.openExternal', href);
      return openExternal === 'resolve' ? Promise.resolve() : Promise.reject(new Error(OPEN_ERROR));
    },
  };
  /** main 은 스모크 실행기에 넘기기만 한다 — 배선 시험에서는 아무도 부르지 않는다. */
  const net = {};
  return { electron: { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, net, protocol, session, shell }, calls, windows };
}
type Fake = ReturnType<typeof createFakeElectron>;

type Mode = 'dev' | 'smoke' | 'packaged';
/** 렌더러 루트 — valid 는 tray-build.json · tray.html · assets/tray.js, 나머지는 fail-closed 원인 하나씩이다. */
type Renderer = 'valid' | 'missing' | 'bad-build' | 'no-entry';
type Tree = { base: string; desktop: string; main: string; devRoot: string; resources: string; appData: string; profile: string; outDir: string };

/** main 이 스모크에서 다는 process 처리기 두 가지. */
type ProcessEvent = 'uncaughtException' | 'unhandledRejection';
type ProcessListener = (reason: unknown) => void;
/** 이번 사례의 main 이 단 process 처리기 — runMain 이 그 전후를 견줘 채우고, afterEach 가 뗀다. */
type AddedListeners = Record<ProcessEvent, ProcessListener[]>;
const PROCESS_EVENTS: ProcessEvent[] = ['uncaughtException', 'unhandledRejection'];
/** process 의 그 사건 처리기 — @types/node 는 사건마다 오버로드가 따로라 갈라 부른다. */
const processListeners = (event: ProcessEvent): unknown[] =>
  event === 'uncaughtException' ? process.listeners(event) : process.listeners(event);

let tree: Tree;
let stderr: string[] = [];
let rejections: unknown[] = [];
let electronRequesters: Array<string | null> = [];
let cacheBefore = new Set<string>();
let restoreProcess = (): void => {};
/** 이번 사례의 가짜 electron — afterEach 가 will-quit 을 불러 실행기의 감시 타이머를 끈다. */
let lastFake: Fake | null = null;
let added: AddedListeners = { uncaughtException: [], unhandledRejection: [] };

const onRejection = (reason: unknown): void => {
  rejections.push(reason);
};

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

/** 사례 하나의 나무 — desktop/ 는 저장소에서 복사한다. 렌더러 루트 · userData · 스모크 폴더는 아직 없다(runMain · main 이 만든다). */
function layTree(): Tree {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tj-main 배선 ')));
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
}

/** 모드의 렌더러 루트 — main.js 가 고르는 곳(개발 ../dist-tray · 패키지 resources/renderer). 스모크는 개발 나무에서 돈다. */
const rootOf = (mode: Mode): string => (mode === 'packaged' ? join(tree.resources, 'renderer') : tree.devRoot);

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
};

/**
 * main.js 를 한 번 돌린다 — 렌더러 루트를 깔고 argv · TJ_DEVTOOLS 를 정한 뒤, 훅을 건 채 require 하고 ready 뒤까지 기다린다.
 * 훅은 'electron' 에만 가짜를 돌려주고 나머지는 원래 _load 로 넘긴다. require 가 끝나면(던져도) 훅 · argv 를 바로 되돌린다.
 */
async function runMain(mode: Mode, options: RunOptions = {}): Promise<Fake> {
  writeRenderer(rootOf(mode), options.renderer ?? 'valid');
  const fake = createFakeElectron({
    isPackaged: mode === 'packaged',
    lock: options.lock ?? true,
    appData: tree.appData,
    openExternal: options.openExternal ?? 'reject',
  });
  const smokeArgv =
    options.smokeArgv ?? (mode === 'smoke' ? formatSmokeArgs({ outDir: tree.outDir, profile: tree.profile, net: false, nonce: NONCE }) : []);
  if (options.devtools !== undefined) process.env.TJ_DEVTOOLS = options.devtools;
  const argv = process.argv;
  process.argv = [process.execPath, tree.desktop, ...smokeArgv];
  const before = { uncaughtException: new Set(processListeners('uncaughtException')), unhandledRejection: new Set(processListeners('unhandledRejection')) };
  lastFake = fake;
  nodeModule._load = function (request, parent, isMain) {
    if (request !== 'electron') return realLoad.call(this, request, parent, isMain);
    electronRequesters.push(parent?.filename ?? null);
    return fake.electron;
  };
  try {
    require(tree.main);
  } finally {
    nodeModule._load = realLoad;
    process.argv = argv;
  }
  await settle();
  // main 이 단 process 처리기(스모크는 ready 뒤에 단다) — 사례가 직접 부르고, afterEach 가 뗀다.
  for (const event of PROCESS_EVENTS) {
    added[event] = processListeners(event).filter((listener) => !before[event].has(listener)) as ProcessListener[];
  }
  return fake;
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
  return (fake.windows[0] as { webContents: FakeContents }).webContents;
}
/** 스모크 결과 — out 폴더에는 result.json 하나만 있다(임시 파일 없음). */
function readResult(): Record<string, unknown> {
  expect(readdirSync(tree.outDir)).toStrictEqual([RESULT_FILE]);
  return JSON.parse(readFileSync(join(tree.outDir, RESULT_FILE), 'utf8')) as Record<string, unknown>;
}
/** 결과의 versions(계획 Task 8 SmokeResult.versions) — 결과 파일마다 이 모양이다. IPC 의 AppInfo 와는 다른 계약이다. */
const expectedVersions = () => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, app: APP_VERSION });

beforeEach(() => {
  tree = layTree();
  stderr = [];
  rejections = [];
  electronRequesters = [];
  cacheBefore = new Set(Object.keys(require.cache));
  const devtools = process.env.TJ_DEVTOOLS;
  const resourcesPath = proc.resourcesPath;
  const added = Object.entries(ELECTRON_VERSIONS).filter(([key]) => !(key in process.versions));
  for (const [key, value] of added) Object.defineProperty(process.versions, key, { value, configurable: true, enumerable: true });
  delete process.env.TJ_DEVTOOLS; // 개발자 셸에 켜져 있어도 사례가 정한다
  proc.resourcesPath = tree.resources;
  restoreProcess = () => {
    for (const [key] of added) Reflect.deleteProperty(process.versions, key);
    if (devtools === undefined) delete process.env.TJ_DEVTOOLS;
    else process.env.TJ_DEVTOOLS = devtools;
    if (resourcesPath === undefined) delete proc.resourcesPath;
    else proc.resourcesPath = resourcesPath;
  };
  process.on('unhandledRejection', onRejection);
  nodeFs.writeSync = captureWriteSync;
});

afterEach(async () => {
  // 스모크 실행기 정리 — 감시 타이머(60초)는 will-quit 이 끈다(남으면 지운 나무에 결과를 쓴다). main 이 단 process 처리기는 뗀다.
  if (lastFake !== null) for (const quit of listenersOf(lastFake.calls, 'app.on', 'will-quit')) quit();
  for (const event of PROCESS_EVENTS) for (const listener of added[event]) process.off(event, listener);
  lastFake = null;
  added = { uncaughtException: [], unhandledRejection: [] };
  await settle();
  process.off('unhandledRejection', onRejection);
  nodeFs.writeSync = realWriteSync;
  nodeModule._load = realLoad;
  for (const key of Object.keys(require.cache)) if (!cacheBefore.has(key)) delete require.cache[key];
  restoreProcess();
  rmSync(tree.base, { recursive: true, force: true });
  expect(rejections, 'unhandledRejection').toStrictEqual([]);
});

afterAll(() => {
  // 다른 시험 파일에 남기지 않는다 — _load · writeSync 는 원래 것이고, 캐시에는 이 시험이 부른 main.js · lib 사본이 없다.
  expect(nodeModule._load).toBe(realLoad);
  expect(nodeFs.writeSync).toBe(realWriteSync);
  expect(Object.keys(require.cache).filter((key) => key.includes('tj-main 배선'))).toStrictEqual([]);
});

const MODES: Mode[] = ['dev', 'smoke', 'packaged'];

describe('최상위(ready 전)', () => {
  /** 모드마다 main 이 고르는 userData — null 은 setPath 를 부르지 않는다(패키지는 Electron 기본값). */
  const chosenUserData = (mode: Mode): string | null =>
    mode === 'dev' ? join(tree.appData, 'TwelveJanggi-dev') : mode === 'smoke' ? tree.profile : null;

  it.each(MODES)('%s — userData → enableSandbox → 스킴 특권 → 단일 인스턴스 잠금, 잠금은 고른 userData 에 걸린다', async (mode) => {
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
    const smokeArgv = ['--tj-smoke', `--tj-smoke-out=${tree.outDir}`];
    const fake = await runMain('smoke', { smokeArgv });
    expect(fake.calls.map((call) => [call.name, ...call.args])).toStrictEqual([['app.exit', 1]]);
    expect(stderr).toStrictEqual([`[tj] smoke args: ${parseSmokeArgs(smokeArgv).error}`]);
    expect(existsSync(tree.outDir)).toBe(false);
    expect(existsSync(tree.profile)).toBe(false);
  });

  it('잠금을 못 얻은 스모크 — [tj] lock 한 줄 · 결과(stage lock) · exit(1), ready 를 기다리지 않는다', async () => {
    const fake = await runMain('smoke', { lock: false });
    const lockAt = indexOf(fake.calls, 'app.requestSingleInstanceLock');
    expect(fake.calls.slice(lockAt + 1).map((call) => [call.name, ...call.args])).toStrictEqual([['app.exit', 1]]);
    const result = readResult();
    expect(result).toStrictEqual({ nonce: NONCE, stage: 'lock', error: expect.stringContaining(tree.profile), checks: [], versions: expectedVersions() });
    expect(stderr).toStrictEqual([`[tj] lock: ${String(result.error)}`]);
  });

  it('잠금을 못 얻은 비스모크 — app.quit() 하나뿐(줄 · 결과 없음), ready 를 기다리지 않는다', async () => {
    const fake = await runMain('dev', { lock: false });
    const lockAt = indexOf(fake.calls, 'app.requestSingleInstanceLock');
    expect(fake.calls.slice(lockAt + 1).map((call) => call.name)).toStrictEqual(['app.quit']);
    expect(stderr).toStrictEqual([]);
    expect(existsSync(tree.outDir)).toBe(false);
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

  it.each(MODES)('%s — 처리기 · IPC 는 창보다 먼저, 탐색 가드는 loadURL 전에 — 모두 한 동기 구간(await 없음)', async (mode) => {
    const fake = await runMain(mode);
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
    expect(callsOf(fake, 'app.setAppUserModelId').map((call) => call.args)).toStrictEqual(
      process.platform === 'win32' ? [['com.khkim.twelvejanggi']] : [],
    );
    expect(stderr).toStrictEqual([]); // [tj] 줄 없음(아이콘도 읽었다)
  });

  it.each(MODES)('%s — 창 옵션은 브리프 값 그대로(webPreferences 는 공장 값), 진입 URL, 끝내지 않는다', async (mode) => {
    const fake = await runMain(mode);
    expect(only(fake, 'new BrowserWindow').args).toStrictEqual([
      {
        width: 340,
        height: 400,
        useContentSize: true,
        resizable: false,
        maximizable: false,
        show: false,
        title: '십이장기',
        backgroundColor: '#0d1117',
        webPreferences: { preload: join(tree.desktop, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
      },
    ]);
    expect(callsOf(fake, 'win.loadURL').map((call) => call.args)).toStrictEqual([[mode === 'smoke' ? `${ENTRY_URL}?smoke` : ENTRY_URL]]);
    if (mode !== 'smoke') expect(callsOf(fake, 'session.webRequest.onBeforeRequest')).toStrictEqual([]); // hooks 는 비스모크에서 없다
    expect(callsOf(fake, 'app.exit')).toStrictEqual([]);
    expect(callsOf(fake, 'app.quit')).toStrictEqual([]);
    expect(existsSync(tree.outDir)).toBe(false);
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
    expect(electronRequesters).toStrictEqual([tree.main]);
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
    expect(line.includes('npm run build:tray'), '개발 나무에서만 build:tray 를 안내한다').toBe(mode !== 'packaged');
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
    expect(existsSync(tree.outDir)).toBe(false);
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

/** 스모크 실행기의 수집기 — 창과 loadURL 사이에 트레이 창의 webContents 에 동기로 붙는다(설계 §5.10 '앱 안 실행기'). */
const COLLECTORS = ['console-message', 'did-fail-load', 'did-fail-provisional-load', 'render-process-gone', 'preload-error', 'unresponsive', 'did-finish-load'];
/** 탐색 가드가 webContents.on 으로 거는 사건 — 비스모크에서는 이것뿐이다. */
const NAVIGATION_EVENTS = ['will-frame-navigate', 'will-navigate', 'will-redirect', 'will-attach-webview'];

describe('스모크 실행기 연결(smoke/run.cjs) — main 은 스모크에서만 꽂는다', () => {
  it('스모크 — 처리기 · 창 · 트레이보다 먼저 꽂힌다: 네트워크 가드(창 전) · tj-smoke-* 수신(tj-app-info 다음, 창 전) · 수집기(창과 loadURL 사이) · will-quit · process 처리기, 한 동기 구간', async () => {
    const fake = await runMain('smoke');
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
    expect(Object.keys(require.cache)).toContain(join(tree.desktop, 'smoke', 'run.cjs'));
    expect(Object.keys(require.cache).filter((key) => /[\\/]node_modules[\\/]electron[\\/]/.test(key))).toStrictEqual([]);
    expect(stderr).toStrictEqual([]);
    expect(existsSync(tree.outDir)).toBe(false); // 결과는 검사가 끝나거나 실패할 때만 쓴다
  });

  it.each(['dev', 'packaged'] as const)('%s — 꽂지 않는다: run.cjs 를 require 하지 않고, 가드 · tj-smoke-* · 수집기 · will-quit · process 처리기가 없다', async (mode) => {
    const fake = await runMain(mode);
    expect(Object.keys(require.cache).filter((key) => key.startsWith(join(tree.desktop, 'smoke')))).toStrictEqual([]);
    expect(callsOf(fake, 'session.webRequest.onBeforeRequest')).toStrictEqual([]);
    expect(callsOf(fake, 'ipcMain.on')).toStrictEqual([]);
    expect(callsOf(fake, 'webContents.on').map((call) => call.args[0])).toStrictEqual(NAVIGATION_EVENTS);
    expect(listenersOf(fake.calls, 'app.on', 'will-quit')).toStrictEqual([]);
    expect(added).toStrictEqual({ uncaughtException: [], unhandledRejection: [] });
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
    expect(existsSync(tree.outDir)).toBe(false);
    expect(callsOf(fake, 'app.exit')).toStrictEqual([]);
    expect(stderr).toStrictEqual([]);
  });

  it('감시 타이머 — 60초에 결과(stage watchdog) · exit(1), 그 전에는 아무것도 하지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fake = await runMain('smoke');
      vi.advanceTimersByTime(59_999);
      expect(existsSync(tree.outDir)).toBe(false);
      vi.advanceTimersByTime(1);
      expect(readResult()).toStrictEqual({ nonce: NONCE, stage: 'watchdog', error: expect.stringContaining('60'), checks: [], versions: expectedVersions() });
      expect(callsOf(fake, 'app.exit').map((call) => call.args)).toStrictEqual([[1]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('감시 타이머 — will-quit 이 끈다(그 뒤로는 결과 · exit 없음)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fake = await runMain('smoke');
      const quits = listenersOf(fake.calls, 'app.on', 'will-quit');
      expect(quits).toHaveLength(1);
      for (const quit of quits) quit();
      vi.advanceTimersByTime(120_000);
      expect(existsSync(tree.outDir)).toBe(false);
      expect(callsOf(fake, 'app.exit')).toStrictEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
