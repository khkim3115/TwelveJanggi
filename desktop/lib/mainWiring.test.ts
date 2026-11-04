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
// - 창 동작(설계 §5.2): 가짜는 ready-to-show 를 스스로 내지 않는다 — 보이는 창이 필요한 사례는 readyToShow 로 낸다. 렌더러의 IPC 는
//   main 이 단 처리기를 신뢰하는 발신자(트레이 창의 메인 프레임)로 직접 부른다(rendererSend · rendererInvoke). 보이기 · 숨기기 이유와
//   sent 기록은 스모크 모드의 hook.record 로 보고, dev · packaged 는 동작(창 상태 · 호출)만 본다. 설정 쓰기는 node:fs 의 renameSync 를
//   세는 감싸개(countRenames)로, 콘솔 중계는 fd 2 · process.stderr.write 잡기(captureRelay)로 본다 — 둘 다 afterEach 가 되돌린다.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const { PUSH_CHANNELS } = require('./pushChannels.cjs') as typeof import('./pushChannels.cjs');
const { consoleLine } = require('./consoleLine.cjs') as typeof import('./consoleLine.cjs');

// 바꿔 끼우는 자리 — main.js 가 require 로 받는 것과 같은 객체다(main · lib 은 바꾼 node:fs 멤버를 그대로 부른다).
type LoadFn = (this: unknown, request: string, parent: { filename?: string | null } | null | undefined, isMain: boolean) => unknown;
const nodeModule = require('node:module') as { _load: LoadFn };
const nodeFs = require('node:fs') as typeof import('node:fs');
const realLoad = nodeModule._load;
const realWriteSync = nodeFs.writeSync;
const realMkdirSync = nodeFs.mkdirSync;
const realRenameSync = nodeFs.renameSync;
const realStderrWrite = process.stderr.write;
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
/** 사례가 바꾼 process.stderr.write 를 되돌린다(captureRelay) — afterEach 가 부른다. */
let restoreStderr = (): void => {};

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

/**
 * 콘솔 중계 잡기(Task 7 의 '[tj]' 줄 잡기와 따로) — '[tj] ' 로 시작하지 않는 fd 2 쓰기 전부와 process.stderr.write 를 돌려주는 목록에
 * 모으고 내보내지 않는다. '[tj] ' 줄은 지금처럼 stderr 로 간다(main 의 logError 로 중계했다면 거기서 드러난다). afterEach 가 되돌린다.
 */
function captureRelay(): string[] {
  const relay: string[] = [];
  patchFs('writeSync', function (this: unknown, fd: unknown, data: unknown, ...rest: unknown[]): unknown {
    if (fd === 2 && !(typeof data === 'string' && data.startsWith('[tj] '))) {
      relay.push(String(data));
      return typeof data === 'string' ? Buffer.byteLength(data) : 0;
    }
    return Reflect.apply(captureWriteSync, this, [fd, data, ...rest]);
  });
  const stream = process.stderr;
  stream.write = ((chunk: unknown) => {
    relay.push(String(chunk));
    return true;
  }) as typeof stream.write;
  restoreStderr = () => {
    stream.write = realStderrWrite;
  };
  return relay;
}

/** 설정 파일로 가는 rename 한 번 — 성공했는가. */
type RenameAttempt = { ok: boolean };
type RenameLog = {
  /** 설정 파일로 간 rename 시도(차례대로) — 다른 경로의 rename 은 세지 않고 그대로 넘긴다. */
  attempts: RenameAttempt[];
  /** 다음 한 번의 rename 이 error 를 던진다(Error 인스턴스여야 settings.cjs 가 code 를 읽는다). */
  failNext(error: Error): void;
};

/**
 * node:fs 의 renameSync 를 세는 감싸개로 바꾼다 — runMain 전에 부른다(afterEach 가 되돌린다). main 이 부르는 settings.cjs 는 사례마다
 * 나무의 사본을 새로 읽고 rename 을 모듈 객체로 부르므로 감싼 함수가 잡힌다.
 */
function countRenames(file: string): RenameLog {
  const attempts: RenameAttempt[] = [];
  let failure: Error | null = null;
  patchFs('renameSync', (from: unknown, to: unknown) => {
    if (to !== file) return Reflect.apply(realRenameSync, nodeFs, [from, to]);
    if (failure !== null) {
      const error = failure;
      failure = null;
      attempts.push({ ok: false });
      throw error;
    }
    Reflect.apply(realRenameSync, nodeFs, [from, to]);
    attempts.push({ ok: true });
    return undefined;
  });
  return {
    attempts,
    failNext: (error) => {
      failure = error;
    },
  };
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
  // 임시 폴더의 실제 경로 아래에 만든다 — windows-latest 러너의 TEMP 는 8.3 짧은 이름(RUNNER~1)이라, main 이 고르는 경로와 견주는
  // 사례(settings.json 등)가 같은 글자를 보게
  const base = mkdtempSync(join(realpathSync.native(tmpdir()), 'tj-main 배선 '));
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
  /** 스모크 인자 뒤에 붙는 명령줄 인자(--hidden 등). */
  extraArgv?: readonly string[];
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
  process.argv = [process.execPath, currentTree().desktop, ...smokeArgv, ...(options.extraArgv ?? [])];
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

/** main 이 만든 트레이 창(하나뿐). */
function trayWindow(fake: Fake): FakeWindow {
  expect(fake.windows).toHaveLength(1);
  const [win] = fake.windows;
  if (win === undefined) throw new Error('트레이 창이 없다');
  return win;
}
/** 트레이 창의 메인 프레임에서 온 IPC 사건 — createGuardedIpc 의 발신자 검증을 지난다(창이 살아 있을 때). */
function trustedEvent(fake: Fake): { senderFrame: FakeContents['mainFrame']; sender: FakeContents } {
  const contents = windowContents(fake);
  return { senderFrame: contents.mainFrame, sender: contents };
}
/** 렌더러의 send — main 이 ipcMain.on 으로 단 그 채널의 첫 처리기(발신자 검증 포함)를 신뢰하는 발신자로 부른다. */
function rendererSend(fake: Fake, channel: string, ...args: unknown[]): void {
  const [listener] = listenersOf(fake.calls, 'ipcMain.on', channel);
  if (listener === undefined) throw new Error(`ipcMain.on ${channel} 처리기가 없다`);
  listener(trustedEvent(fake), ...args);
}
/** 렌더러의 invoke — main 이 ipcMain.handle 로 단 그 채널의 처리기를 신뢰하는 발신자로 부른 값. */
function rendererInvoke(fake: Fake, channel: string): unknown {
  const [handler] = listenersOf(fake.calls, 'ipcMain.handle', channel);
  if (handler === undefined) throw new Error(`ipcMain.handle ${channel} 처리기가 없다`);
  return handler(trustedEvent(fake));
}
const getState = (fake: Fake): unknown => rendererInvoke(fake, 'tj-get-state');
/** 창이 처음 그릴 준비가 됐다 — 가짜는 이 사건을 스스로 내지 않는다. 트레이 창을 돌려준다. */
function readyToShow(fake: Fake): FakeWindow {
  const win = trayWindow(fake);
  win.emit('ready-to-show', {});
  return win;
}
/** OS 가 포커스를 가져갔다 — 포커스를 잃고(blur()) blur 사건이 온다. 가짜의 emit 은 상태를 바꾸지 않으므로 둘 다 한다. */
function loseFocus(win: FakeWindow): void {
  win.blur();
  win.emit('blur', {});
}
/** 트레이 좌클릭(win32 — main 이 tray.on('click') 으로 단 처리기). */
function trayClick(fake: Fake): void {
  const [click] = listenersOf(fake.calls, 'tray.on', 'click');
  if (click === undefined) throw new Error('트레이 click 처리기가 없다');
  click({}, { x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0 });
}
/** setContextMenu 로 붙은 트레이 메뉴의 그 항목을 누른다(가짜 Menu.buildFromTemplate 은 { template } 을 돌려준다). */
function trayMenuClick(fake: Fake, label: string): void {
  const menu = callsOf(fake, 'tray.setContextMenu').at(-1)?.args[0] as { template: Array<{ label?: string; click?: Fn }> } | undefined;
  const item = menu?.template.find((candidate) => candidate.label === label);
  if (item?.click === undefined) throw new Error(`붙은 트레이 메뉴에 '${label}' 이 없다`);
  item.click({}, undefined, {});
}
/** main 의 before-quit 리스너를 부른다(Electron 의 종료 시작). */
function beforeQuit(fake: Fake): void {
  for (const listener of listenersOf(fake.calls, 'app.on', 'before-quit')) listener({ preventDefault: () => {} });
}
/** main 이 hooks.record 로 넘긴 기록 가운데 그 kind 의 것(스모크 모드 — 엿보기가 hook.record 로 남긴다). */
function recordsOf(fake: Fake, kind: 'window' | 'sent'): unknown[] {
  return callsOf(fake, 'hook.record')
    .map((call) => call.args[0])
    .filter((entry) => (entry as { kind?: unknown }).kind === kind);
}
/** name 호출들의 인자(그 자리 from 뒤의 것만 — 주지 않으면 처음부터). */
const argsOf = (fake: Fake, name: string, from = 0): unknown[][] => fake.calls.slice(from).filter((call) => call.name === name).map((call) => call.args);

/** 모드마다 main 이 쓰는 설정 파일 — 고른 userData 아래(dev TwelveJanggi-dev · 스모크 프로필 · 패키지는 Electron 기본 TwelveJanggi). */
function settingsFileOf(mode: Mode): string {
  const { appData, profile } = currentTree();
  const userData = mode === 'dev' ? join(appData, 'TwelveJanggi-dev') : isSmokeMode(mode) ? profile : join(appData, 'TwelveJanggi');
  return join(userData, 'settings.json');
}
function readSettingsFile(mode: Mode): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsFileOf(mode), 'utf8')) as Record<string, unknown>;
}
/** 시작 전에 설정 파일을 깐다 — 값이 문자열이면 그대로(깨진 파일), 아니면 JSON. */
function writeSettingsFileOf(mode: Mode, value: unknown): void {
  const file = settingsFileOf(mode);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}
/** 첫 실행이 아닌 저장 설정 — 기본값에 덮어쓸 것만 준다. */
const savedSettings = (patch: Record<string, unknown>) => ({
  theme: 'dark',
  opacity: 100,
  pinned: false,
  position: null,
  autostart: false,
  autostartDefaultApplied: true,
  ...patch,
});

/** 디스플레이 둘 — 주 디스플레이 오른쪽에 하나 더(둘 다 작업표시줄 40 은 아래). */
const TWO_DISPLAYS: readonly FakeDisplay[] = [
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 },
  { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 },
];
/** 작업표시줄 가운데쯤의 아이콘 — 아이콘 쪽 위치가 작업영역 가장자리에 잘리지 않는다(340×400 → { 1342, 632 }). */
const TRAY_LEFT: Rect = { x: 1500, y: 1040, width: 24, height: 40 };
/** 레이아웃 'solo' 의 콘텐츠 크기 — 배치(setBounds)는 위치와 함께 이 크기를 넘긴다(판정 R26). */
const SOLO_SIZE = { width: 340, height: 400 } as const;

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
    // 5. 바꾼 값 되돌리기 — node:fs 멤버(writeSync · renameSync 포함) · process.stderr.write · _load · require 캐시 · process 값(갈래 ·
    //    execPath · versions · env · resourcesPath)
    restoreFs();
    restoreStderr();
    restoreStderr = () => {};
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
  // 렌더러로 민 채널은 모두 PUSH_CHANNELS 에 있다(스냅샷에 필드가 있다 — 늦게 붙은 화면도 getState 로 같은 상태를 얻는다)
  const pushChannels: readonly string[] = Object.keys(PUSH_CHANNELS);
  const strays = fake === null ? [] : callsOf(fake, 'webContents.send').filter((call) => !pushChannels.includes(String(call.args[0])));
  expect(strays.map((call) => call.args[0]), 'PUSH_CHANNELS 밖의 webContents.send').toStrictEqual([]);
});

afterAll(() => {
  // 다른 시험 파일에 남기지 않는다 — _load · node:fs · process 값 · 시계는 원래 것이고, 캐시에는 이 시험이 부른 main.js · lib 사본이 없다.
  expect(nodeModule._load).toBe(realLoad);
  expect(nodeFs.writeSync).toBe(realWriteSync);
  expect(nodeFs.mkdirSync).toBe(realMkdirSync);
  expect(nodeFs.renameSync).toBe(realRenameSync);
  expect(process.stderr.write).toBe(realStderrWrite);
  expect(fsOriginals.size).toBe(0);
  expect(Object.getOwnPropertyDescriptor(process, 'platform')).toStrictEqual(REAL_PLATFORM);
  expect(Object.getOwnPropertyDescriptor(process, 'execPath')).toStrictEqual(REAL_EXEC_PATH);
  expect(vi.isFakeTimers()).toBe(false);
  expect(Object.keys(require.cache).filter((key) => key.includes('tj-main 배선'))).toStrictEqual([]);
});

/** main 이 거는 IPC(설계 §5.3 표 순서) — [등록 함수, 채널]. 스모크는 이 뒤에 hooks.registerIpc 가 tj-smoke-* 를 더한다. */
const MAIN_IPC: Array<[string, string]> = [
  ['ipcMain.handle', 'tj-app-info'],
  ['ipcMain.handle', 'tj-get-state'],
  ['ipcMain.on', 'tj-set-theme'],
  ['ipcMain.on', 'tj-set-opacity'],
  ['ipcMain.on', 'tj-set-layout'],
  ['ipcMain.on', 'tj-hide'],
];

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
    // ready 전에는 userData 를 읽어 두지 않는다(setPath 전에 읽은 값은 낡는다) — ready 뒤의 설정 읽기는 세지 않는다
    expect(callsOf(fake, 'app.getPath').filter((call) => !call.ready).map((call) => call.args)).toStrictEqual(mode === 'dev' ? [['appData']] : []);
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
    ...MAIN_IPC,
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

  it('IPC 는 createGuardedIpc 의 main 채널 여섯(설계 §5.3 순서) — 트레이 창의 메인 프레임만 AppInfo { version, electron, chrome, platform } 를 받는다', async () => {
    const fake = await runMain('dev');
    const ipc = fake.calls.filter((call) => call.name.startsWith('ipcMain.')).map((call) => [call.name, call.args[0]]);
    expect(ipc).toStrictEqual(MAIN_IPC);
    const handler = only(fake, 'ipcMain.handle', 'tj-app-info').args[1] as (event: unknown) => unknown;
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
  /**
   * ready 뒤에 FAIL_CLOSED_CALLS 밖의 호출이 없고, 고른 userData 아래에 settings.json 이 없고(설정을 읽지도 쓰지도 않는다), [tj] 줄은
   * '<무엇>: …(<어디>)' 한 줄이다. 그 줄을 돌려준다.
   */
  function expectClosed(fake: Fake, mode: Mode): string {
    expect(fake.calls.filter((call) => call.ready && !FAIL_CLOSED_CALLS.includes(call.name)).map((call) => call.name)).toStrictEqual([]);
    expect(existsSync(settingsFileOf(mode)), settingsFileOf(mode)).toBe(false);
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
    // preload 의 send 는 듣는 쪽이 없으면 버려진다 — 수신은 창보다 먼저, 발신자 검증(createGuardedIpc)을 거친다. main 채널을 모두 건 뒤에
    // 실행기의 것(hooks.registerIpc)이다.
    const ipc = after.flatMap((call, at) => (call.name.startsWith('ipcMain.') ? [{ call, at }] : []));
    expect(ipc.map(({ call }) => [call.name, call.args[0]])).toStrictEqual([
      ...MAIN_IPC,
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
    // ipcMain.on 은 main 채널 넷뿐이다(tj-smoke-* 없음)
    expect(callsOf(fake, 'ipcMain.on').map((call) => call.args[0])).toStrictEqual(['tj-set-theme', 'tj-set-opacity', 'tj-set-layout', 'tj-hide']);
    // webContents.on 은 탐색 가드 넷 — 개발 실행은 그 뒤 콘솔 중계 하나를 더 단다(수집기는 없다)
    expect(callsOf(fake, 'webContents.on').map((call) => call.args[0])).toStrictEqual(mode === 'dev' ? [...NAVIGATION_EVENTS, 'console-message'] : NAVIGATION_EVENTS);
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
  /** main 없이 만든 가짜와 창(show: false) — main 이 트레이 창에 단 리스너(blur 숨김 · show/hide 전달)가 끼지 않게 가짜의 사건 규칙만 본다. */
  function bareWindow(): { fake: Fake; win: FakeWindow } {
    const fake = createFakeElectron({ isPackaged: false, lock: true, appData: currentTree().appData, openExternal: 'reject', platform: 'win32' });
    const win: FakeWindow = new fake.electron.BrowserWindow({ show: false });
    return { fake, win };
  }

  it("focus() 는 포커스를 켜고 blur() 는 포커스만 끈다(사건 없음), emit('blur') 는 포커스를 바꾸지 않는다", () => {
    const { win } = bareWindow();
    const blurs: boolean[] = [];
    win.on('blur', () => blurs.push(win.isFocused()));
    win.focus();
    win.emit('blur', {}); // Electron 의 emit 처럼 상태는 그대로다
    expect(win.isFocused()).toBe(true);
    win.blur();
    expect(win.isFocused()).toBe(false);
    expect(blurs).toStrictEqual([true]); // blur() 는 사건을 내지 않는다 — 시험이 따로 낸다
  });

  it('show · hide 는 보임이 바뀔 때만 사건을 낸다 — 손잡이 blurOnHide 는 보임을 끄기 전에 blur 를 동기로 내고, 그때의 isVisible() 를 기록한다', () => {
    const { fake, win } = bareWindow();
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

/** 첫 실행 뒤의 설정 파일 — 기본값 + 첫 실행 표시(자동 실행 기본값을 적용했다). */
const FIRST_RUN_FILE = { theme: 'dark', opacity: 100, pinned: false, position: null, autostart: false, autostartDefaultApplied: true };
/** getState() 의 처음 값 — 기본 설정 · 혼자 하기 · 숨김. */
const INITIAL_STATE = { theme: 'dark', opacity: 100, mode: 'solo', visible: false };
/** 잠깐 막힌 rename(백신 · 색인기) — Error 인스턴스라 settings.cjs 가 code 를 읽는다. */
const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', syscall: 'rename' });

describe('설정 — <userData>/settings.json (설계 §5.2 설정 쓰기)', () => {
  it.each<Mode>(['dev', 'smoke', 'packaged', 'packaged-smoke'])('%s — 파일이 없으면 기본값으로 시작하고, onReady 안에서(동기) 첫 실행 표시를 쓴다 — [tj] 줄 없음', async (mode) => {
    const fake = await runMain(mode);
    expect(stderr).toStrictEqual([]);
    expect(readSettingsFile(mode)).toStrictEqual(FIRST_RUN_FILE); // 가짜 시계를 돌리지 않았다 — 예약이 아니라 그 자리에서 썼다
    expect(getState(fake)).toStrictEqual(INITIAL_STATE);
  });

  it('못 읽는 파일 — [tj] settings: 한 줄, 기본값으로 시작하고 그 파일은 그대로 둔다(첫 실행이 아니다 — 첫 실행 표시를 쓰지 않는다)', async () => {
    const broken = '{ "theme": "light", 깨진';
    writeSettingsFileOf('dev', broken);
    const log = countRenames(settingsFileOf('dev'));
    const fake = await runMain('dev');
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.startsWith('[tj] settings: '), stderr[0]).toBe(true);
    expect(stderr[0]).toContain(settingsFileOf('dev'));
    expect(getState(fake)).toStrictEqual(INITIAL_STATE);
    expect(log.attempts).toStrictEqual([]);
    expect(readFileSync(settingsFileOf('dev'), 'utf8')).toBe(broken);
  });

  it('저장된 설정으로 시작 — 창 배경 · 투명도 · getState, 첫 표시는 저장 위치, 고정이라 유예 뒤 blur 에도 숨지 않는다, 시작에 쓰지 않는다', async () => {
    writeSettingsFileOf('dev', savedSettings({ theme: 'light', opacity: 64, pinned: true, position: { x: 100, y: 100 } }));
    const log = countRenames(settingsFileOf('dev'));
    const fake = await runMain('dev');
    expect(only(fake, 'new BrowserWindow').args[0]).toMatchObject({ backgroundColor: '#f5f6f8', opacity: 0.64 });
    expect(getState(fake)).toStrictEqual({ theme: 'light', opacity: 64, mode: 'solo', visible: false });
    const win = readyToShow(fake);
    expect(argsOf(fake, 'win.setBounds')).toStrictEqual([[{ x: 100, y: 100, ...SOLO_SIZE }]]);
    vi.advanceTimersByTime(301);
    loseFocus(win);
    expect(win.isVisible()).toBe(true);
    expect(callsOf(fake, 'win.hide')).toStrictEqual([]);
    expect(log.attempts).toStrictEqual([]);
    expect(stderr).toStrictEqual([]);
  });

  it('예약 저장 — t0 · t0+100 · t0+200 의 변경은 t0+500 에 한 번(마지막 값)만 쓴다, t0+499 까지는 파일 그대로', async () => {
    const log = countRenames(settingsFileOf('dev'));
    const fake = await runMain('dev');
    expect(log.attempts).toStrictEqual([{ ok: true }]); // 시작의 첫 실행 표시 — 이 뒤로 센다
    rendererSend(fake, 'tj-set-opacity', 50);
    vi.advanceTimersByTime(100);
    rendererSend(fake, 'tj-set-opacity', 60);
    vi.advanceTimersByTime(100);
    rendererSend(fake, 'tj-set-opacity', 70);
    vi.advanceTimersByTime(299); // t0+499
    expect(log.attempts).toHaveLength(1);
    expect(readSettingsFile('dev')).toStrictEqual(FIRST_RUN_FILE);
    vi.advanceTimersByTime(1); // t0+500
    expect(log.attempts).toStrictEqual([{ ok: true }, { ok: true }]);
    expect(readSettingsFile('dev')).toStrictEqual({ ...FIRST_RUN_FILE, opacity: 70 });
    vi.advanceTimersByTime(1000);
    expect(log.attempts).toHaveLength(2);
  });

  it('rename 이 EPERM 이면 100ms 뒤 한 번 더 — 성공하면 dirty 를 지운다(before-quit 이 다시 쓰지 않는다), [tj] 줄 없음', async () => {
    const log = countRenames(settingsFileOf('dev'));
    const fake = await runMain('dev');
    log.failNext(eperm());
    rendererSend(fake, 'tj-set-opacity', 50);
    vi.advanceTimersByTime(300);
    expect(log.attempts).toStrictEqual([{ ok: true }, { ok: false }]);
    expect(readSettingsFile('dev').opacity).toBe(100);
    vi.advanceTimersByTime(99);
    expect(log.attempts).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(log.attempts).toStrictEqual([{ ok: true }, { ok: false }, { ok: true }]);
    expect(readSettingsFile('dev').opacity).toBe(50);
    beforeQuit(fake);
    expect(log.attempts).toHaveLength(3); // 쓴 뒤라 비울 것이 없다
    expect(vi.getTimerCount()).toBe(0);
    expect(stderr).toStrictEqual([]);
  });

  it.each(['예약', '재시도'] as const)('before-quit — 쓰지 않은 변경(%s 대기 중)은 곧바로 쓰고 예약 · 재시도 타이머를 지운다', async (pending) => {
    const log = countRenames(settingsFileOf('dev'));
    const fake = await runMain('dev');
    if (pending === '재시도') log.failNext(eperm());
    rendererSend(fake, 'tj-set-opacity', 50);
    vi.advanceTimersByTime(pending === '재시도' ? 300 : 100);
    expect(vi.getTimerCount()).toBe(1);
    const before = log.attempts.length;
    beforeQuit(fake);
    expect(log.attempts.slice(before)).toStrictEqual([{ ok: true }]);
    expect(readSettingsFile('dev').opacity).toBe(50);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(log.attempts).toHaveLength(before + 1);
    expect(stderr).toStrictEqual([]);
  });

  it('win32 session-end(로그오프 · 종료 — before-quit 이 오지 않는다) — 쓰지 않은 변경을 곧바로 쓰고 예약을 지운다', async () => {
    const log = countRenames(settingsFileOf('dev'));
    const fake = await runMain('dev');
    rendererSend(fake, 'tj-set-opacity', 50);
    vi.advanceTimersByTime(100);
    trayWindow(fake).emit('session-end', { reasons: ['logoff'] });
    expect(log.attempts).toStrictEqual([{ ok: true }, { ok: true }]);
    expect(readSettingsFile('dev').opacity).toBe(50);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(log.attempts).toHaveLength(2);
  });

  it('비우기의 쓰기가 실패하면 [tj] settings: 한 줄 — 기다릴 수 없어 다시 해 보지 않는다(타이머 없음)', async () => {
    const log = countRenames(settingsFileOf('dev'));
    const fake = await runMain('dev');
    rendererSend(fake, 'tj-set-opacity', 50);
    log.failNext(eperm());
    beforeQuit(fake);
    expect(log.attempts).toStrictEqual([{ ok: true }, { ok: false }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.startsWith('[tj] settings: EPERM'), stderr[0]).toBe(true);
  });
});

describe('IPC · push — 상태 묻기 · 바꾸기 · 숨기기 · 창 사건 (설계 §5.3)', () => {
  it('tj-get-state — 처음 { dark · 100 · solo · 숨김 }, ready-to-show 로 보인 뒤 visible true', async () => {
    const fake = await runMain('dev');
    expect(getState(fake)).toStrictEqual(INITIAL_STATE);
    readyToShow(fake);
    expect(getState(fake)).toStrictEqual({ ...INITIAL_STATE, visible: true });
  });

  it('tj-get-state 의 visible 은 창 getter 가 아니라 main 의 값이다 — 마지막으로 민 tj-shown · tj-hidden 과 늘 같다', async () => {
    const fake = await runMain('dev');
    const win = readyToShow(fake);
    // 'hide' 사건만 온다(가짜의 emit 은 Electron 처럼 상태를 바꾸지 않는다 — isVisible() 는 아직 참이다)
    win.emit('hide', {});
    expect(argsOf(fake, 'webContents.send').at(-1)).toStrictEqual(['tj-hidden']);
    expect(win.isVisible()).toBe(true);
    expect(getState(fake)).toStrictEqual(INITIAL_STATE);
  });

  it('tj-set-theme — light: 창 배경 #f5f6f8 → tj-theme, getState 는 곧바로 · settings.json 은 300ms 뒤. 받지 않는 값(purple 등)은 아무것도 하지 않는다', async () => {
    const fake = await runMain('dev');
    const mark = fake.calls.length;
    for (const theme of ['purple', 'Light', '', null, undefined, 1]) rendererSend(fake, 'tj-set-theme', theme);
    expect(fake.calls.slice(mark).map((call) => call.name)).toStrictEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    rendererSend(fake, 'tj-set-theme', 'light');
    expect(fake.calls.slice(mark).map((call) => [call.name, ...call.args])).toStrictEqual([
      ['win.setBackgroundColor', '#f5f6f8'],
      ['webContents.send', 'tj-theme', 'light'],
    ]);
    expect(getState(fake)).toStrictEqual({ ...INITIAL_STATE, theme: 'light' });
    vi.advanceTimersByTime(299);
    expect(readSettingsFile('dev').theme).toBe('dark');
    vi.advanceTimersByTime(1);
    expect(readSettingsFile('dev').theme).toBe('light');
  });

  it("tj-set-opacity — 150: 자른 값(setOpacity(1) · tj-opacity 100), 64: setOpacity(0.64) → tj-opacity 64. '70' · NaN 등은 아무것도 하지 않는다", async () => {
    const fake = await runMain('dev');
    const mark = fake.calls.length;
    for (const percent of ['70', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}]) rendererSend(fake, 'tj-set-opacity', percent);
    expect(fake.calls.slice(mark).map((call) => call.name)).toStrictEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    rendererSend(fake, 'tj-set-opacity', 150);
    rendererSend(fake, 'tj-set-opacity', 64);
    expect(fake.calls.slice(mark).map((call) => [call.name, ...call.args])).toStrictEqual([
      ['win.setOpacity', 1],
      ['webContents.send', 'tj-opacity', 100],
      ['win.setOpacity', 0.64],
      ['webContents.send', 'tj-opacity', 64],
    ]);
    expect(getState(fake)).toStrictEqual({ ...INITIAL_STATE, opacity: 64 });
    vi.advanceTimersByTime(300);
    expect(readSettingsFile('dev').opacity).toBe(64);
  });

  it('tj-set-layout — online(나무의 layout.cjs 를 360×480 으로 바꿔 둔다): setContentSize(360, 480) 뒤 그 크기로 다시 배치. 받지 않는 키(x 등)는 아무것도 하지 않는다', async () => {
    const layoutFile = join(currentTree().desktop, 'lib', 'layout.cjs');
    const source = readFileSync(layoutFile, 'utf8');
    const online = 'online: Object.freeze({ width: 340, height: 400 })';
    expect(source).toContain(online);
    writeFileSync(layoutFile, source.replace(online, 'online: Object.freeze({ width: 360, height: 480 })'));
    const fake = await runMain('dev', { trayBounds: TRAY_LEFT });
    readyToShow(fake);
    const mark = fake.calls.length;
    for (const key of ['x', 'Online', 'constructor', null]) rendererSend(fake, 'tj-set-layout', key);
    expect(fake.calls.slice(mark).map((call) => call.name)).toStrictEqual([]);
    rendererSend(fake, 'tj-set-layout', 'online');
    // 아이콘 { 1500, 1040, 24, 40 } 쪽 — 가운데 1512 에서 폭의 절반을 빼고, 아이콘 위로 높이 + 8
    const sized = fake.calls.slice(mark).filter((call) => call.name === 'win.setContentSize' || call.name === 'win.setBounds');
    expect(sized.map((call) => [call.name, ...call.args])).toStrictEqual([
      ['win.setContentSize', 360, 480],
      ['win.setBounds', { x: 1332, y: 552, width: 360, height: 480 }],
    ]);
    // 레이아웃은 남는다 — 숨겼다가 다시 보여도 그 크기로 놓는다
    rendererSend(fake, 'tj-hide');
    const again = fake.calls.length;
    trayClick(fake);
    expect(argsOf(fake, 'win.setBounds', again)).toStrictEqual([[{ x: 1332, y: 552, width: 360, height: 480 }]]);
  });

  it('tj-hide(Esc · ✕) — 숨기고 { window · hide · request } 를 기록한다', async () => {
    const fake = await runMain('smoke');
    const win = readyToShow(fake);
    rendererSend(fake, 'tj-hide');
    expect(win.isVisible()).toBe(false);
    expect(getState(fake)).toStrictEqual(INITIAL_STATE);
    expect(recordsOf(fake, 'window')).toStrictEqual([
      { kind: 'window', action: 'show', reason: 'start' },
      { kind: 'window', action: 'hide', reason: 'request' },
    ]);
  });

  it.each<Mode>(['dev', 'smoke', 'packaged-smoke'])('%s — 창 show · hide 사건(가짜의 직접 호출 — OS · 스모크가 일으킨 것)도 tj-shown · tj-hidden 을 보낸다(스모크는 sent 로 기록)', async (mode) => {
    const fake = await runMain(mode);
    const win = trayWindow(fake);
    win.show();
    expect(getState(fake)).toStrictEqual({ ...INITIAL_STATE, visible: true });
    win.hide();
    expect(getState(fake)).toStrictEqual(INITIAL_STATE);
    expect(argsOf(fake, 'webContents.send')).toStrictEqual([['tj-shown'], ['tj-hidden']]);
    const sent = isSmokeMode(mode) ? [{ kind: 'sent', channel: 'tj-shown' }, { kind: 'sent', channel: 'tj-hidden' }] : [];
    expect(recordsOf(fake, 'sent')).toStrictEqual(sent);
    expect(recordsOf(fake, 'window')).toStrictEqual([]); // showWindow · hideWindow 를 거치지 않았다
  });
});

describe('보이기 · 숨기기 · blur (설계 §5.2 — 가짜 시계)', () => {
  /** 시작 창을 숨긴 뒤 트레이 좌클릭으로 다시 보인다(showReason 'tray') — 그 뒤 시계는 사례가 돌린다. */
  function showByTray(fake: Fake): FakeWindow {
    const win = readyToShow(fake);
    rendererSend(fake, 'tj-hide');
    vi.advanceTimersByTime(1000);
    trayClick(fake);
    expect(win.isVisible()).toBe(true);
    return win;
  }

  it.each<Mode>(['dev', 'smoke', 'packaged', 'packaged-smoke'])("%s — ready-to-show 에 show('start'): 아이콘 쪽 배치(setBounds) → show → focus, getState visible true", async (mode) => {
    const fake = await runMain(mode, { trayBounds: TRAY_LEFT });
    const mark = fake.calls.length;
    const win = readyToShow(fake);
    const order = fake.calls.slice(mark).filter((call) => ['win.setBounds', 'win.show', 'win.focus'].includes(call.name));
    expect(order.map((call) => [call.name, ...call.args])).toStrictEqual([['win.setBounds', { x: 1342, y: 632, ...SOLO_SIZE }], ['win.show'], ['win.focus']]);
    expect([win.isVisible(), win.isFocused()]).toStrictEqual([true, true]);
    expect(getState(fake)).toStrictEqual({ ...INITIAL_STATE, visible: true });
    expect(recordsOf(fake, 'window')).toStrictEqual(isSmokeMode(mode) ? [{ kind: 'window', action: 'show', reason: 'start' }] : []);
  });

  it.each([
    ['dev', 'win32', false],
    ['packaged', 'win32', false],
    ['smoke', 'win32', true],
    ['packaged-smoke', 'win32', true],
    ['dev', 'linux', true],
  ] as const)('%s · %s + 명령줄 --hidden — ready-to-show 에 보인다: %s (로그인 실행은 Windows 의 --hidden, 스모크는 늘 아니다)', async (mode, platform, shown) => {
    const fake = await runMain(mode, { platform, extraArgv: ['--hidden'] });
    const win = readyToShow(fake);
    expect(win.isVisible()).toBe(shown);
    expect(callsOf(fake, 'win.show')).toHaveLength(shown ? 1 : 0);
    expect(getState(fake)).toStrictEqual({ ...INITIAL_STATE, visible: shown });
  });

  it.each(PLATFORMS)('%s — showWindow 는 darwin 에서만 app.focus({ steal: true }) 를 show 보다 먼저 부른다', async (platform) => {
    const fake = await runMain('dev', { platform });
    readyToShow(fake);
    expect(argsOf(fake, 'app.focus')).toStrictEqual(platform === 'darwin' ? [[{ steal: true }]] : []);
    if (platform === 'darwin') expect(indexOf(fake.calls, 'app.focus')).toBeLessThan(indexOf(fake.calls, 'win.show'));
  });

  it("close(Alt+F4 같은 OS 닫기) — 종료 중이 아니면 막고 hide('close'), before-quit 뒤에는 막지 않는다", async () => {
    const fake = await runMain('smoke');
    const win = readyToShow(fake);
    let prevented = 0;
    const close = { preventDefault: () => (prevented += 1) };
    win.emit('close', close);
    expect(prevented).toBe(1);
    expect(win.isVisible()).toBe(false);
    beforeQuit(fake);
    win.emit('close', close);
    expect(prevented).toBe(1);
    expect(recordsOf(fake, 'window')).toStrictEqual([
      { kind: 'window', action: 'show', reason: 'start' },
      { kind: 'window', action: 'hide', reason: 'close' },
    ]);
  });

  it("트레이 — win32 좌클릭은 show('tray'), 붙은 메뉴의 '열기' 는 show('menu') — 숨긴 창을 보인다", async () => {
    const fake = await runMain('smoke');
    const win = readyToShow(fake);
    rendererSend(fake, 'tj-hide');
    trayClick(fake);
    expect(win.isVisible()).toBe(true);
    rendererSend(fake, 'tj-hide');
    trayMenuClick(fake, '열기');
    expect(win.isVisible()).toBe(true);
    expect(recordsOf(fake, 'window')).toStrictEqual([
      { kind: 'window', action: 'show', reason: 'start' },
      { kind: 'window', action: 'hide', reason: 'request' },
      { kind: 'window', action: 'show', reason: 'tray' },
      { kind: 'window', action: 'hide', reason: 'request' },
      { kind: 'window', action: 'show', reason: 'menu' },
    ]);
  });

  it("second-instance — 숨긴 창을 보인다(show('second-instance')), 화면 상태는 그대로", async () => {
    const fake = await runMain('smoke');
    const win = readyToShow(fake);
    rendererSend(fake, 'tj-hide');
    const [secondInstance] = listenersOf(fake.calls, 'app.on', 'second-instance');
    if (secondInstance === undefined) throw new Error('second-instance 처리기가 없다');
    secondInstance({}, [process.execPath, currentTree().desktop], currentTree().base, {});
    expect(win.isVisible()).toBe(true);
    expect(getState(fake)).toStrictEqual({ ...INITIAL_STATE, visible: true });
    expect(recordsOf(fake, 'window')).toStrictEqual([
      { kind: 'window', action: 'show', reason: 'start' },
      { kind: 'window', action: 'hide', reason: 'request' },
      { kind: 'window', action: 'show', reason: 'second-instance' },
    ]);
  });

  it.each([
    [100, false],
    [300, false],
    [301, true],
  ])('시작 때 보인 창 — 보인 지 %ims 의 blur 로 숨는다: %s (유예 300ms 까지, 시작 표시는 미룬 확인을 하지 않는다)', async (ms, hides) => {
    const fake = await runMain('smoke');
    const win = readyToShow(fake);
    const timers = vi.getTimerCount();
    vi.advanceTimersByTime(ms);
    loseFocus(win);
    expect(vi.getTimerCount()).toBe(timers); // 미룬 확인을 걸지 않았다
    vi.advanceTimersByTime(1000);
    expect(win.isVisible()).toBe(!hides);
    expect(recordsOf(fake, 'window').slice(1)).toStrictEqual(hides ? [{ kind: 'window', action: 'hide', reason: 'blur' }] : []);
  });

  it.each([
    ['포커스를 잃은 채', false, true],
    ['포커스를 되찾음', true, false],
  ] as const)('트레이로 보인 창 — 100ms 의 blur 는 삼키고, 301ms 에 %s 이면 숨긴다: %s (미룬 확인 한 번)', async (_label, refocus, hides) => {
    const fake = await runMain('smoke');
    const win = showByTray(fake);
    const marks = recordsOf(fake, 'window').length;
    const timers = vi.getTimerCount();
    vi.advanceTimersByTime(100);
    loseFocus(win);
    expect(win.isVisible()).toBe(true);
    expect(vi.getTimerCount()).toBe(timers + 1); // 미룬 확인 하나
    vi.advanceTimersByTime(100);
    if (refocus) win.focus(); // 팝업 안을 다시 눌렀다
    vi.advanceTimersByTime(100); // 보인 지 300ms — 아직 확인하지 않는다
    expect(win.isVisible()).toBe(true);
    vi.advanceTimersByTime(1); // 301ms
    expect(win.isVisible()).toBe(!hides);
    expect(vi.getTimerCount()).toBe(timers);
    expect(recordsOf(fake, 'window').slice(marks)).toStrictEqual(hides ? [{ kind: 'window', action: 'hide', reason: 'blur' }] : []);
  });

  it('DevTools 가 열려 있으면 숨기지 않는다 — 유예 안 blur 뒤의 미룬 확인(100–300ms 사이에 연다) · 유예 뒤 blur 모두', async () => {
    const fake = await runMain('smoke');
    const win = showByTray(fake);
    const marks = recordsOf(fake, 'window').length;
    vi.advanceTimersByTime(100);
    loseFocus(win);
    vi.advanceTimersByTime(50);
    win.webContents.openDevTools({ mode: 'detach' });
    vi.advanceTimersByTime(151); // 301ms — 미룬 확인
    expect(win.isVisible()).toBe(true);
    vi.advanceTimersByTime(100);
    loseFocus(win); // 유예 뒤의 blur
    expect(win.isVisible()).toBe(true);
    expect(recordsOf(fake, 'window').slice(marks)).toStrictEqual([]);
  });

  it('hide 안의 동기 blur(그때 isVisible() 는 아직 참)는 바깥 클릭이 아니다 — 유예 뒤 tj-hide 는 request 숨김 하나로만 기록된다', async () => {
    const fake = await runMain('smoke');
    const win = readyToShow(fake);
    vi.advanceTimersByTime(301);
    fake.handles.blurOnHide = true;
    rendererSend(fake, 'tj-hide');
    expect(argsOf(fake, 'handle.blurOnHide')).toStrictEqual([[true]]); // 양성 대조 — blur 는 보이는 동안 왔다
    expect(win.isVisible()).toBe(false);
    expect(recordsOf(fake, 'window')).toStrictEqual([
      { kind: 'window', action: 'show', reason: 'start' },
      { kind: 'window', action: 'hide', reason: 'request' },
    ]);
  });

  it('before-quit 은 미룬 blur 확인을 지운다 — 남은 타이머 없음, 그 뒤로 창을 만지지 않는다', async () => {
    const fake = await runMain('dev');
    const win = showByTray(fake);
    vi.advanceTimersByTime(100);
    loseFocus(win);
    expect(vi.getTimerCount()).toBe(1);
    beforeQuit(fake);
    expect(vi.getTimerCount()).toBe(0);
    const mark = fake.calls.length;
    vi.advanceTimersByTime(1000);
    expect(fake.calls.slice(mark)).toStrictEqual([]);
    expect(win.isVisible()).toBe(true);
  });
});

describe('배치 · 이동 (설계 §5.2 — 아이콘 쪽 배치 · 디스플레이 변경 · 위치 저장)', () => {
  /** 사용자가 창을 dx 만큼 옮긴다 — 위치를 바꾸고 moved 를 낸다(darwin 갈래의 가짜는 setBounds 안에서 이미 낸다). will-move 는 사례가 낸다. */
  function drag(fake: Fake, win: FakeWindow, dx: number): void {
    win.setBounds({ x: win.getBounds().x + dx });
    if (!fake.handles.moveOnSetBounds) win.emit('moved', {});
  }
  /** 사용자가 끌기 시작했다 — will-move(Electron: 손으로 옮길 때만 온다). */
  function willMove(win: FakeWindow): void {
    win.emit('will-move', {}, win.getBounds());
  }

  it.each([
    ['아이콘이 작업표시줄 가운데쯤 — 아이콘 가운데 위', TWO_DISPLAYS, TRAY_LEFT, { x: 1342, y: 632 }],
    ['아이콘이 오른쪽 끝 — 작업영역 안으로(여백 8)', TWO_DISPLAYS, { x: 1880, y: 1040, width: 24, height: 40 }, { x: 1572, y: 632 }],
    ['아이콘 자리를 모름(빈 사각형) — 주 디스플레이(목록의 앞) 오른쪽 아래', [TWO_DISPLAYS[1], TWO_DISPLAYS[0]], { x: 0, y: 0, width: 0, height: 0 }, { x: 3492, y: 632 }],
  ] as const)('첫 표시는 아이콘 쪽 — %s', async (_label, displays, trayBounds, placed) => {
    const fake = await runMain('dev', { displays: displays as readonly FakeDisplay[], trayBounds });
    readyToShow(fake);
    expect(argsOf(fake, 'win.setBounds')).toStrictEqual([[{ ...placed, ...SOLO_SIZE }]]);
  });

  it('저장 위치가 주 디스플레이 밖 — 그 디스플레이의 작업영역 안(3700 → 3492). 보이는 중에 그 디스플레이를 떼면 남은 디스플레이 작업영역 안으로', async () => {
    writeSettingsFileOf('dev', savedSettings({ position: { x: 3700, y: 100 } }));
    const fake = await runMain('dev', { displays: TWO_DISPLAYS });
    readyToShow(fake);
    expect(argsOf(fake, 'win.setBounds')).toStrictEqual([[{ x: 3492, y: 100, ...SOLO_SIZE }]]);
    fake.removeDisplay(2);
    expect(argsOf(fake, 'win.setBounds')).toStrictEqual([[{ x: 3492, y: 100, ...SOLO_SIZE }], [{ x: 1572, y: 100, ...SOLO_SIZE }]]);
  });

  it('숨긴 중에는 디스플레이를 떼도 · 바뀌어도 배치하지 않는다 — 다음 표시가 남은 디스플레이 안으로 놓는다', async () => {
    writeSettingsFileOf('dev', savedSettings({ position: { x: 3700, y: 100 } }));
    const fake = await runMain('dev', { displays: TWO_DISPLAYS });
    readyToShow(fake);
    rendererSend(fake, 'tj-hide');
    const mark = fake.calls.length;
    fake.electron.screen.emit('display-metrics-changed', {}, fake.displays[0], ['workArea']);
    fake.removeDisplay(2);
    expect(argsOf(fake, 'win.setBounds', mark)).toStrictEqual([]);
    trayClick(fake);
    expect(argsOf(fake, 'win.setBounds', mark)).toStrictEqual([[{ x: 1572, y: 100, ...SOLO_SIZE }]]);
  });

  it('보이는 중 display-metrics-changed(배율 · 작업영역) — 바뀐 작업영역 안으로 다시 배치', async () => {
    writeSettingsFileOf('dev', savedSettings({ position: { x: 3700, y: 100 } }));
    const fake = await runMain('dev', { displays: TWO_DISPLAYS });
    readyToShow(fake);
    const second = fake.displays[1];
    if (second === undefined) throw new Error('둘째 디스플레이가 없다');
    second.workArea = { x: 1920, y: 0, width: 1800, height: 1040 }; // 그 디스플레이 오른쪽에 작업표시줄이 섰다
    fake.electron.screen.emit('display-metrics-changed', {}, structuredClone(second), ['workArea']);
    expect(argsOf(fake, 'win.setBounds')).toStrictEqual([[{ x: 3492, y: 100, ...SOLO_SIZE }], [{ x: 3372, y: 100, ...SOLO_SIZE }]]);
  });

  it('배치는 위치와 함께 레이아웃 크기를 넘긴다 — main 밖에서 창이 344×404 로 자라 있어도 다시 보이면 340×400 으로 놓는다(판정 R26)', async () => {
    const fake = await runMain('dev', { trayBounds: TRAY_LEFT });
    const win = readyToShow(fake);
    rendererSend(fake, 'tj-hide');
    // 가짜에 바로(main 을 거치지 않는다) — Windows 소수 배율에서 크기를 getBounds() 로 채운 setBounds 가 반올림으로 키운 창을 흉내 낸다
    win.setBounds({ width: 344, height: 404 });
    expect(win.getBounds()).toMatchObject({ width: 344, height: 404 });
    const mark = fake.calls.length;
    trayClick(fake);
    // 위치만 넘기면 가짜는(Electron 처럼) 빠진 크기를 지금 값으로 둔다 — 자란 크기가 남는다
    expect(argsOf(fake, 'win.setBounds', mark)).toStrictEqual([[{ x: 1342, y: 632, ...SOLO_SIZE }]]);
    expect(win.getBounds()).toStrictEqual({ x: 1342, y: 632, ...SOLO_SIZE });
  });

  it.each(['win32', 'darwin'] as const)('%s — 이동 저장: will-move 없는 moved 는 저장하지 않고, will-move 뒤의 moved 는 300ms 뒤 저장한다. 다시 보이면(배치) 게이트가 닫힌다', async (platform) => {
    const log = countRenames(settingsFileOf('dev'));
    const fake = await runMain('dev', { platform, trayBounds: TRAY_LEFT });
    const win = readyToShow(fake);
    const placed = { x: 1342, y: 632 };
    expect(win.getBounds()).toMatchObject(placed);
    const base = log.attempts.length;
    // 1. will-move 없이 옮겨졌다(프로그램 · OS) — 300ms 가 지나도 저장하지 않는다
    drag(fake, win, 50);
    vi.advanceTimersByTime(400);
    expect(readSettingsFile('dev').position).toBeNull();
    expect(log.attempts).toHaveLength(base);
    // 2. 사용자가 끌었다(will-move → moved) — 300ms 뒤 그 자리를 저장한다
    willMove(win);
    drag(fake, win, 50);
    vi.advanceTimersByTime(299);
    expect(log.attempts).toHaveLength(base);
    vi.advanceTimersByTime(1);
    const saved = { x: placed.x + 100, y: placed.y };
    expect(readSettingsFile('dev').position).toStrictEqual(saved);
    expect(log.attempts).toHaveLength(base + 1);
    // 2b. 기준이 저장한 자리로 옮겨 갔다 — 허용 오차(2px) 안의 moved 는 다시 쓰지 않는다
    drag(fake, win, 1);
    vi.advanceTimersByTime(400);
    expect(log.attempts).toHaveLength(base + 1);
    // 3. 숨겼다가 다시 보인다(win32 트레이 좌클릭 · darwin 은 붙은 메뉴의 '열기') — 그 배치가 게이트를 닫는다
    rendererSend(fake, 'tj-hide');
    if (platform === 'win32') trayClick(fake);
    else trayMenuClick(fake, '열기');
    expect(win.isVisible()).toBe(true);
    expect(win.getBounds()).toMatchObject(saved);
    drag(fake, win, 50);
    vi.advanceTimersByTime(400);
    expect(readSettingsFile('dev').position).toStrictEqual(saved);
    expect(log.attempts).toHaveLength(base + 1);
  });

  it('darwin — will-move 뒤에 다시 배치되면 그 setBounds 안의 동기 moved 는 저장하지 않는다(배치 중)', async () => {
    const log = countRenames(settingsFileOf('dev'));
    const fake = await runMain('dev', { platform: 'darwin', trayBounds: TRAY_LEFT });
    readyToShow(fake);
    const base = log.attempts.length;
    willMove(trayWindow(fake)); // 사용자가 끌기 시작했다
    fake.handles.trayBounds = { x: 1000, y: 1040, width: 24, height: 40 }; // 그사이 아이콘 자리가 바뀌었다
    const moved = (): number => callsOf(fake, 'win.emit').filter((call) => call.args[0] === 'moved').length;
    const before = moved();
    fake.electron.screen.emit('display-metrics-changed', {}, fake.displays[0], ['workArea']);
    expect(argsOf(fake, 'win.setBounds').at(-1)).toStrictEqual([{ x: 842, y: 632, ...SOLO_SIZE }]); // 새 아이콘 쪽으로 다시 놓았다
    expect(moved()).toBe(before + 1); // 양성 대조 — 그 setBounds 안에서 moved 가 왔다
    vi.advanceTimersByTime(400);
    expect(readSettingsFile('dev').position).toBeNull();
    expect(log.attempts).toHaveLength(base);
  });
});

describe('콘솔 중계 — 개발 실행에서만, consoleLine 한 줄로 (설계 §5.2)', () => {
  /** 페이지가 보낸 콘솔 한 줄(새 모양 — 첫 인자 객체). 터미널을 건드리는 글자(ESC · OSC 52 · BEL)와 가짜 '[tj]' 줄을 담았다. */
  const MESSAGE = { level: 'error', message: 'a\u001b]52;c;eA==\u0007\n[tj] x', sourceId: 'app://twelvejanggi/assets/a.js', lineNumber: 3 };

  it('dev — 탐색 가드 뒤 · loadURL 전에 단 console-message 리스너가 consoleLine 한 줄만 stderr 로 옮긴다(제어 문자 · 가짜 [tj] 줄 없음)', async () => {
    const relay = captureRelay();
    const fake = await runMain('dev');
    const listeners = listenersOf(fake.calls, 'webContents.on', 'console-message');
    expect(listeners).toHaveLength(1);
    const at = indexOf(fake.calls, 'webContents.on', 'console-message');
    expect(at).toBeGreaterThan(indexOf(fake.calls, 'webContents.on', 'will-attach-webview'));
    expect(at).toBeLessThan(indexOf(fake.calls, 'win.loadURL'));
    expect(relay).toStrictEqual([]);
    listeners[0]?.(structuredClone(MESSAGE));
    expect(relay).toStrictEqual([`${consoleLine(MESSAGE)}\n`]);
    expect(relay.join('')).not.toMatch(/[\u001b\u0007]/);
    expect(stderr).toStrictEqual([]);
  });

  it.each(['smoke', 'packaged-smoke'] as const)('%s — console-message 리스너는 실행기의 수집기 하나뿐이다(불러도 stderr 로 옮기지 않는다)', async (mode) => {
    const relay = captureRelay();
    const fake = await runMain(mode);
    const listeners = listenersOf(fake.calls, 'webContents.on', 'console-message');
    expect(listeners).toHaveLength(1);
    listeners[0]?.(structuredClone(MESSAGE));
    expect(relay).toStrictEqual([]);
    expect(stderr).toStrictEqual([]);
  });

  it('packaged — console-message 리스너가 없고 아무것도 옮기지 않는다', async () => {
    const relay = captureRelay();
    const fake = await runMain('packaged');
    expect(listenersOf(fake.calls, 'webContents.on', 'console-message')).toStrictEqual([]);
    expect(relay).toStrictEqual([]);
  });
});

describe('파괴 · 종료 — 창은 liveWindow() 로만 만진다 (설계 §5.2)', () => {
  type Condition = 'destroy' | 'before-quit' | '그대로';
  type Fired = 'display-removed' | 'blur';
  const CASES: Array<[Condition, Fired]> = (['destroy', 'before-quit', '그대로'] as const).flatMap((condition) =>
    (['display-removed', 'blur'] as const).map((fired): [Condition, Fired] => [condition, fired]),
  );
  /** 창 · webContents 호출(그 자리 뒤) — [이름, ...인자]. */
  const touchedSince = (fake: Fake, mark: number): unknown[][] =>
    fake.calls
      .slice(mark)
      .filter((call) => /^(win|webContents)\./.test(call.name))
      .map((call) => [call.name, ...call.args]);

  it.each(CASES)("%s 뒤 %s — 파괴 · 종료 뒤에는 던지지 않고 창 · webContents 를 부르지 않는다(대조 '그대로': 남은 디스플레이 안으로 setBounds · hide('blur'))", async (condition, fired) => {
    writeSettingsFileOf('dev', savedSettings({ position: { x: 3700, y: 100 } }));
    const fake = await runMain('dev', { displays: TWO_DISPLAYS });
    const win = readyToShow(fake);
    vi.advanceTimersByTime(301); // 유예가 지난 보이는 창
    if (condition === 'destroy') win.destroy();
    if (condition === 'before-quit') beforeQuit(fake);
    const mark = fake.calls.length;
    // blur 는 main 의 리스너를 바로 부른다 — 파괴한 창은 emit 도 던진다(이미 줄에 선 사건이 파괴 뒤에 닿은 경우를 흉내 낸다)
    const fire = (): void => {
      if (fired === 'display-removed') fake.removeDisplay(2);
      else for (const listener of listenersOf(fake.calls, 'win.on', 'blur')) listener({});
    };
    expect(fire).not.toThrow();
    const touched = touchedSince(fake, mark);
    if (condition !== '그대로') expect(touched).toStrictEqual([]);
    else if (fired === 'display-removed') expect(touched.filter(([name]) => name === 'win.setBounds')).toStrictEqual([['win.setBounds', { x: 1572, y: 100, ...SOLO_SIZE }]]);
    else expect(touched.filter(([name]) => name === 'win.hide')).toStrictEqual([['win.hide']]);
  });

  it.each([
    ['파괴한 뒤', true],
    ['파괴하기 전(대조)', false],
  ] as const)('tj-set-theme · tj-set-opacity · tj-hide — %s: 파괴 뒤에는 발신자 검증이 막음(처리기 안 불림) — 던지지 않음 · 호출 0', async (_label, destroyed) => {
    const fake = await runMain('dev');
    const win = readyToShow(fake);
    if (destroyed) win.destroy();
    const mark = fake.calls.length;
    expect(() => {
      rendererSend(fake, 'tj-set-theme', 'light');
      rendererSend(fake, 'tj-set-opacity', 64);
      rendererSend(fake, 'tj-hide');
    }).not.toThrow();
    const names = touchedSince(fake, mark).map(([name]) => name);
    const handled = ['win.setBackgroundColor', 'webContents.send', 'win.setOpacity', 'webContents.send', 'win.hide', 'win.emit', 'webContents.send'];
    expect(names).toStrictEqual(destroyed ? [] : handled);
    expect(vi.getTimerCount()).toBe(destroyed ? 0 : 1); // 파괴 뒤에는 저장 예약도 없다
  });
});
