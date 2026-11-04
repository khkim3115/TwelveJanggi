// desktop/main.js 배선 시험(mainWiring.test.ts)의 가짜 electron(#36 T6-8) — main.js 가 쓰는 멤버만 있는 구조 타입이다.
// - electron 은 import · require 하지 않는다(import type 포함) — 루트 검사(typecheck · test)는 desktop/node_modules 없이 돈다.
//   main.js 가 electron 을 require 하면 시험의 Module._load 훅이 이 객체를 돌려준다(mainWiring.test.ts 의 runMain).
// - 이름이 *.test.ts 가 아니어서 vitest 가 시험으로 모으지 않는다.
// - 호출은 모두 기록(calls)에 남는다 — 게터까지, ready · turn 과 함께. 처리기 · 리스너는 시험이 기록에서 꺼내 직접 부른다.
// - 창 · screen 은 Electron 처럼 상태를 갖고 사건을 낸다: show() · hide() 는 보임이 바뀔 때 'show' · 'hide' 를 내고, 파괴한 창은 멤버마다
//   던진다. 포커스 사건(blur)은 시험이 emit 으로 내거나 손잡이(handles.blurOnHide)가 낸다 — OS 의 포커스 규칙(전경 잠금 등)은 사례가 정한다.
//   emit 은 상태를 바꾸지 않으므로 OS 가 포커스를 가져간 것은 blur()(포커스만 끈다) 뒤 emit('blur') 로 흉내 낸다.
// - 디스플레이 · 아이콘 자리 · 손잡이(handles)는 사례가 정하고, 가짜가 부를 때마다 읽으므로 실행 도중에 바꿔도 된다.
// - 트레이 · 메뉴도 Electron 처럼 사건을 낸다: tray.emit 은 tray.on 으로 단 리스너를, menu.emit 은 menu.on 으로 단 리스너를 부른다.
//   Menu.buildFromTemplate 이 만든 메뉴는 fake.menus 에 쌓이고, 그 항목의 click() 은 Electron 의 MenuItem 처럼 checkbox 의 checked 를
//   먼저 뒤집은 뒤 템플릿의 click 을 부른다(낡은 메뉴의 항목도 그대로 누를 수 있다).
// - 로그인 항목은 Windows 를 흉내 낸다(fake.loginItems — 사례가 approved 를 바꿀 수 있다): openAtLogin 은 AUMID 이름 · 경로 · 인자가 글자까지
//   같은 항목, executableWillLaunchAtLogin 은 경로만 같고 작업 관리자에서 켜진(approved) 항목이다.
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** 트레이 창의 진입 URL(동결 계약 — 스모크는 ?smoke 를 붙인다). 가짜 메인 프레임의 url 이기도 하다. */
export const ENTRY_URL = 'app://twelvejanggi/tray.html';
/** 가짜 app.getVersion() — AppInfo.version · 스모크 결과의 versions.app 이 이 값이다. */
export const APP_VERSION = '0.1.0';
/** openExternal: 'reject' 일 때 가짜 shell.openExternal 이 거부하는 오류의 글. */
export const OPEN_ERROR = '브라우저를 띄우지 못했다';

/**
 * 가짜 electron 이 기록한 호출 하나. ready 는 whenReady 가 풀린 뒤인가, turn 은 ready 뒤 첫 동기 구간(1)인가 그 뒤(2)인가
 * (ready 전은 0) — onReady 사이에 await 가 끼면 그 뒤의 호출이 turn 2 가 된다.
 */
export type Call = { name: string; args: unknown[]; ready: boolean; turn: 0 | 1 | 2 };
export type Fn = (...args: unknown[]) => unknown;
/** 가짜가 흉내 내는 플랫폼 갈래 — process.platform 값이다(runMain 이 둘을 같은 값으로 정한다). */
export type FakePlatform = 'win32' | 'darwin' | 'linux';
/** Electron 의 Rectangle · Point 와 같은 모양. */
export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
/** Electron 의 Display 중 main 이 쓰는 부분. bounds 는 디스플레이 전체, workArea 는 작업표시줄 · 메뉴 막대를 뺀 영역이다. */
export type FakeDisplay = { id: number; bounds: Rect; workArea: Rect; scaleFactor: number };
export type FakeContents = {
  mainFrame: { detached: boolean; url: string; origin: string };
  on(event: string, listener: Fn): void;
  setWindowOpenHandler(handler: Fn): void;
  openDevTools(options: unknown): void;
  send(channel: string, ...args: unknown[]): void;
  isDevToolsOpened(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
  getBackgroundThrottling(): boolean;
};
/** 가짜 BrowserWindow — main 이 new 로 만든다(fake.windows 에 쌓인다). */
export type FakeWindow = {
  readonly webContents: FakeContents;
  once(event: string, listener: Fn): void;
  on(event: string, listener: Fn): void;
  emit(event: string, ...args: unknown[]): boolean;
  isDestroyed(): boolean;
  destroy(): void;
  loadURL(url: string): Promise<void>;
  show(): void;
  hide(): void;
  focus(): void;
  blur(): void;
  isFocused(): boolean;
  isVisible(): boolean;
  getBounds(): Rect;
  setBounds(bounds: Partial<Rect>): void;
  setContentSize(width: number, height: number): void;
  setOpacity(opacity: number): void;
  setBackgroundColor(color: string): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
};
export type FakeImage = { isEmpty(): boolean; resize(size: unknown): FakeImage };
/** 가짜 Tray — main 이 new 로 만든다(fake.trays 에 쌓인다). emit 은 on 으로 단 리스너를 부른다(Electron 의 EventEmitter 처럼). */
export type FakeTray = {
  on(event: string, listener: Fn): void;
  emit(event: string, ...args: unknown[]): boolean;
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  popUpContextMenu(menu?: unknown): void;
  getBounds(): Rect;
};
/** 메뉴 템플릿의 항목 중 가짜가 읽는 부분(Electron 의 MenuItemConstructorOptions). */
type MenuTemplateEntry = { label?: string; type?: string; checked?: boolean; enabled?: boolean; click?: Fn };
/**
 * 가짜 MenuItem — Electron 처럼 checked · enabled 는 바꿀 수 있는 값이고, click() 은 checkbox 면 checked 를 먼저 뒤집은 뒤 템플릿의
 * click(항목, 창, 사건)을 부른다. enabled 는 보지 않는다 — Electron 의 MenuItem.click 도 보지 않는다(꺼진 항목을 못 누르게 하는 것은
 * 네이티브 메뉴다).
 */
export type FakeMenuItem = { label: string | undefined; type: string; checked: boolean; enabled: boolean; click(): void };
/** 가짜 Menu — Menu.buildFromTemplate 이 만든다(fake.menus 에 쌓인다). */
export type FakeMenu = {
  readonly template: readonly unknown[];
  readonly items: FakeMenuItem[];
  on(event: string, listener: Fn): void;
  emit(event: string, ...args: unknown[]): boolean;
};
/**
 * 가짜 로그인 항목 한 줄 — Windows 의 HKCU Run 값 하나와 그 StartupApproved(approved — 작업 관리자에서 켜져 있다). name 은 값 이름(AUMID),
 * path · args 는 명령줄이다.
 */
export type FakeLoginItem = { name: string | null; path: string; args: string[]; approved: boolean };
/** 사례가 실행 도중에도 바꾸는 손잡이 — 가짜가 부를 때마다 읽는다. */
export type FakeHandles = {
  /**
   * hide() 안에서, 창의 보임을 끄기 전에 blur 를 동기로 낸다 — Windows 가 활성 창을 숨길 때처럼 리스너가 도는 동안 isVisible() 가
   * 아직 true 다. 그때의 isVisible() 값을 'handle.blurOnHide' 로 기록한다(시험의 양성 대조). 기본은 끔.
   */
  blurOnHide: boolean;
  /** setBounds() 안에서 move · moved 를 동기로 낸다 — macOS 의 moved 는 move 의 별칭이다. darwin 갈래의 기본값은 켬. */
  moveOnSetBounds: boolean;
  /** Tray.getBounds() 가 돌려주는 아이콘 자리. */
  trayBounds: Rect;
};
export type FakeOptions = {
  isPackaged: boolean;
  lock: boolean;
  appData: string;
  openExternal: 'resolve' | 'reject';
  platform: FakePlatform;
  /** 붙어 있는 디스플레이(앞이 주 디스플레이) — 없으면 DEFAULT_DISPLAYS. 가짜는 사본을 쓴다. */
  displays?: readonly FakeDisplay[];
  /** 아이콘 자리 — 없으면 DEFAULT_TRAY_BOUNDS. */
  trayBounds?: Rect;
  /** 이 이름의 호출은 기록한 뒤 error 를 던진다 — onReady 안에서 던지는 사례(whenReady 실패)를 만든다. */
  throwOn?: { name: string; error: unknown };
  /** 시작 때 이미 있는 로그인 항목 — 가짜는 사본을 쓴다(fake.loginItems). 없으면 비었다. */
  loginItems?: readonly FakeLoginItem[];
  /** getLoginItemSettings() 의 wasOpenedAtLogin(macOS — 로그인으로 열렸다). 없으면 false. */
  wasOpenedAtLogin?: boolean;
};

/** 디스플레이를 정하지 않은 사례의 화면 — 1920×1080 하나, 작업표시줄(높이 40)은 아래. */
export const DEFAULT_DISPLAYS: readonly FakeDisplay[] = Object.freeze([
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 },
]);
/** 아이콘 자리를 정하지 않은 사례 — 기본 화면의 작업표시줄 오른쪽. */
export const DEFAULT_TRAY_BOUNDS: Readonly<Rect> = Object.freeze({ x: 1800, y: 1040, width: 24, height: 40 });

/** calls 가운데 name(첫 인자 key) 호출의 처리기(둘째 인자) — app.on('web-contents-created', fn) 의 fn 같은 것. */
export function listenersOf(calls: readonly Call[], name: string, key: string): Fn[] {
  return calls.filter((call) => call.name === name && call.args[0] === key).map((call) => call.args[1] as Fn);
}

/** 두 사각형이 겹치는 넓이 — 겹치지 않거나 변만 닿으면 0. */
function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** 두 인자 목록이 차례까지 글자 그대로 같다. */
function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, at) => arg === b[at]);
}

/** 점에서 사각형까지의 맨해튼 거리 — 사각형 안(변 포함)이면 0. */
function distanceTo(rect: Rect, point: Point): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return dx + dy;
}

/**
 * 기록하는 가짜 electron — main.js 가 쓰는 멤버만 있다. 처리기 · 리스너는 기록에 남고 시험이 직접 부른다.
 * Electron 과 같게 한 것: setPath 는 없는 폴더면 던진다 · enableSandbox 와 registerSchemesAsPrivileged 는 ready 뒤면 던진다 ·
 * screen 은 ready 전이면 던진다 · app.dock 은 darwin 에만 있다 · BrowserWindow 는 만들면서 'web-contents-created' 를 부르고, 위치를
 * 주지 않으면 주 디스플레이 작업영역 가운데에 놓인다 · 파괴한 창은 창 · webContents 의 멤버마다 TypeError('Object has been destroyed')
 * 를 던진다(isDestroyed 만 답한다). ipcMain 은 어느 멤버를 불러도(계산된 키 · 구조 분해 포함) 기록된다. app 의 속성 쓰기는
 * 'app.set' 으로 기록하고 값은 그대로 둔다(쓴 값이 그대로 남는다 — 동일성 — 바꿔 끼운 메서드는 그 뒤로 원래 메서드 대신 불린다).
 * 로그인 항목(Windows 흉내 — Electron 44.9.3): getLoginItemSettings({ path, args }) 의 openAtLogin 은 값 이름이 AUMID(setAppUserModelId 로
 * 정한 값)이고 경로(path · 없으면 process.execPath) · 인자(args · 없으면 [])가 글자까지 같은 항목이 있다(approved 는 보지 않는다),
 * executableWillLaunchAtLogin 은 경로가 같고 approved 인 항목이 있다(인자는 보지 않는다). setLoginItemSettings({ openAtLogin: true, … }) 는
 * 그 이름(name · 없으면 AUMID)의 항목을 쓰고 approved = enabled !== false 다. openAtLogin 이 아니면 그 이름의 항목을 지운다.
 */
export function createFakeElectron({
  isPackaged,
  lock,
  appData,
  openExternal,
  platform,
  displays: shownDisplays = DEFAULT_DISPLAYS,
  trayBounds = DEFAULT_TRAY_BOUNDS,
  throwOn,
  loginItems: startLoginItems = [],
  wasOpenedAtLogin = false,
}: FakeOptions) {
  const calls: Call[] = [];
  const windows: FakeWindow[] = [];
  const trays: FakeTray[] = [];
  const menus: FakeMenu[] = [];
  /** 지금 있는 로그인 항목 — 사례가 approved 를 바꿀 수 있다(작업 관리자에서 끈 것을 흉내 낸다). */
  const loginItems: FakeLoginItem[] = structuredClone([...startLoginItems]);
  /** setAppUserModelId 로 정한 AUMID — 로그인 항목의 기본 값 이름이다(Electron). */
  let appUserModelId: string | null = null;
  /** 지금 붙어 있는 디스플레이 — 앞이 주 디스플레이다. removeDisplay 가 줄인다. */
  const displays: FakeDisplay[] = structuredClone([...shownDisplays]);
  const handles: FakeHandles = { blurOnHide: false, moveOnSetBounds: platform === 'darwin', trayBounds: { ...trayBounds } };
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
    if (throwOn !== undefined && name === throwOn.name) throw throwOn.error;
  };

  const dock = { hide: () => rec('app.dock.hide') };
  const app = new Proxy(
    {
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
      setAppUserModelId: (id: string) => {
        rec('app.setAppUserModelId', id);
        appUserModelId = id;
      },
      getVersion: () => APP_VERSION,
      /** 부를 때의 process.execPath 를 기본 경로로 쓴다(사례가 runMain 의 execPath 로 정한다). */
      getLoginItemSettings(
        ...args: [options?: { path?: string; args?: string[] }]
      ): { openAtLogin: boolean; executableWillLaunchAtLogin: boolean; wasOpenedAtLogin: boolean } {
        rec('app.getLoginItemSettings', ...args);
        const [options] = args;
        const exe = options?.path ?? process.execPath;
        const argv = options?.args ?? [];
        return {
          openAtLogin: loginItems.some((item) => item.name === appUserModelId && item.path === exe && sameArgs(item.args, argv)),
          executableWillLaunchAtLogin: loginItems.some((item) => item.path === exe && item.approved),
          wasOpenedAtLogin,
        };
      },
      setLoginItemSettings(settings: { openAtLogin?: boolean; name?: string; path?: string; args?: string[]; enabled?: boolean }): void {
        rec('app.setLoginItemSettings', settings);
        const name = settings.name ?? appUserModelId;
        const at = loginItems.findIndex((item) => item.name === name);
        if (at !== -1) loginItems.splice(at, 1);
        if (settings.openAtLogin === true) {
          loginItems.push({ name, path: settings.path ?? process.execPath, args: [...(settings.args ?? [])], approved: settings.enabled !== false });
        }
      },
      /** macOS 에만 있다 — 그 밖의 갈래는 undefined 다(Electron 과 같다). */
      get dock(): typeof dock | undefined {
        rec('app.dock');
        return platform === 'darwin' ? dock : undefined;
      },
      focus: (...args: [options?: unknown]) => rec('app.focus', ...args),
    },
    {
      set(target, key, value): boolean {
        rec('app.set', key, value);
        return Reflect.set(target, key, value);
      },
    },
  );

  /** 주 디스플레이 — 목록의 첫 디스플레이다. */
  const primary = (): FakeDisplay => {
    const [first] = displays;
    if (first === undefined) throw new Error('가짜에 붙어 있는 디스플레이가 없다');
    return first;
  };
  /** 점을 품은 디스플레이, 없으면 bounds 까지 가장 가까운 것(같으면 앞의 것). */
  const nearestTo = (point: Point): FakeDisplay =>
    displays.reduce((best, display) => (distanceTo(display.bounds, point) < distanceTo(best.bounds, point) ? display : best), primary());
  /** 가장 많이 겹치는 디스플레이(같으면 앞의 것), 겹침이 없으면 사각형 가운데에서 가장 가까운 것 — Electron 의 getDisplayMatching 규칙. */
  const matching = (rect: Rect): FakeDisplay => {
    let best: FakeDisplay | null = null;
    let bestArea = 0;
    for (const display of displays) {
      const area = overlapArea(display.bounds, rect);
      if (area > bestArea) {
        best = display;
        bestArea = area;
      }
    }
    return best ?? nearestTo({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  };
  const screenListeners = new Map<string, Fn[]>();
  /** screen 의 멤버를 기록한다 — Electron 처럼 ready 전에는 쓸 수 없다. */
  const useScreen = (member: string, ...args: unknown[]): void => {
    rec(`screen.${member}`, ...args);
    if (!ready) throw new Error(`screen.${member} 는 ready 전에 쓸 수 없다`);
  };
  /** Electron 처럼 부를 때마다 새 Display 객체를 돌려준다(main 이 고쳐도 가짜의 목록은 그대로다). */
  const screen = {
    getPrimaryDisplay: (): FakeDisplay => {
      useScreen('getPrimaryDisplay');
      return structuredClone(primary());
    },
    getDisplayMatching: (rect: Rect): FakeDisplay => {
      useScreen('getDisplayMatching', rect);
      return structuredClone(matching(rect));
    },
    getDisplayNearestPoint: (point: Point): FakeDisplay => {
      useScreen('getDisplayNearestPoint', point);
      return structuredClone(nearestTo(point));
    },
    on: (event: string, listener: Fn): void => {
      useScreen('on', event, listener);
      screenListeners.set(event, [...(screenListeners.get(event) ?? []), listener]);
    },
    /** 사건을 낸다(시험이 부른다) — Electron 의 인자 모양 그대로 넘긴다: (event, display[, changedMetrics]). */
    emit: (event: string, ...args: unknown[]): boolean => {
      rec('screen.emit', event, ...args);
      const listeners = screenListeners.get(event) ?? [];
      for (const listener of listeners) listener(...args);
      return listeners.length > 0;
    },
  };
  /** 디스플레이 하나를 떼고(목록에서 뺀다) Electron 처럼 'display-removed'(event, 뗀 디스플레이)를 낸다. */
  function removeDisplay(id: number): void {
    const at = displays.findIndex((display) => display.id === id);
    if (at === -1) throw new Error(`붙어 있지 않은 디스플레이다: ${id}`);
    const [removed] = displays.splice(at, 1);
    screen.emit('display-removed', {}, structuredClone(removed));
  }

  type WindowOptions = { x?: number; y?: number; width?: number; height?: number; show?: boolean };
  class BrowserWindow implements FakeWindow {
    readonly #listeners = new Map<string, Array<{ listener: Fn; once: boolean }>>();
    #destroyed = false;
    #visible: boolean;
    #focused = false;
    #bounds: Rect;
    #devToolsOpened = false;
    #backgroundThrottling = true;
    /** hide() 가 blur 를 내는 중이다 — 그 리스너가 다시 hide() 를 불러도 blur 를 또 내지 않는다. */
    #blurringInHide = false;

    readonly webContents: FakeContents = {
      mainFrame: { detached: false, url: ENTRY_URL, origin: 'app://twelvejanggi' },
      on: (event, listener) => this.#use('webContents.on', event, listener),
      setWindowOpenHandler: (handler) => this.#use('webContents.setWindowOpenHandler', handler),
      openDevTools: (options) => {
        this.#use('webContents.openDevTools', options);
        this.#devToolsOpened = true;
      },
      send: (channel, ...args) => this.#use('webContents.send', channel, ...args),
      isDevToolsOpened: () => {
        this.#use('webContents.isDevToolsOpened');
        return this.#devToolsOpened;
      },
      setBackgroundThrottling: (allowed) => {
        this.#use('webContents.setBackgroundThrottling', allowed);
        this.#backgroundThrottling = allowed;
      },
      getBackgroundThrottling: () => {
        this.#use('webContents.getBackgroundThrottling');
        return this.#backgroundThrottling;
      },
    };

    constructor(options: WindowOptions) {
      rec('new BrowserWindow', options);
      const width = options.width ?? 800;
      const height = options.height ?? 600;
      const area = primary().workArea;
      this.#bounds = {
        x: options.x ?? Math.round(area.x + (area.width - width) / 2),
        y: options.y ?? Math.round(area.y + (area.height - height) / 2),
        width,
        height,
      };
      this.#visible = options.show !== false;
      windows.push(this);
      // Electron 처럼 webContents 를 만들면서 'web-contents-created' 를 부른다 — main 의 탐색 가드가 여기서 걸린다.
      for (const listener of listenersOf(calls, 'app.on', 'web-contents-created')) listener({}, this.webContents);
    }

    readonly once = (event: string, listener: Fn): void => {
      this.#use('win.once', event, listener);
      this.#listen(event, listener, true);
    };
    readonly on = (event: string, listener: Fn): void => {
      this.#use('win.on', event, listener);
      this.#listen(event, listener, false);
    };
    /** 사건을 낸다(시험이 부른다) — 상태는 바꾸지 않는다(Electron 의 emit 과 같다). OS 가 숨긴 것은 hide() 로 흉내 낸다. */
    readonly emit = (event: string, ...args: unknown[]): boolean => {
      this.#alive();
      return this.#emit(event, ...args);
    };
    readonly isDestroyed = (): boolean => this.#destroyed;
    readonly destroy = (): void => {
      this.#use('win.destroy');
      this.#destroyed = true;
    };
    readonly loadURL = (url: string): Promise<void> => {
      this.#use('win.loadURL', url);
      return Promise.resolve();
    };
    readonly show = (): void => {
      this.#use('win.show');
      if (this.#visible) return;
      this.#visible = true;
      this.#emit('show', {});
    };
    readonly hide = (): void => {
      this.#use('win.hide');
      if (!this.#visible) return;
      if (handles.blurOnHide && !this.#blurringInHide) {
        this.#blurringInHide = true;
        try {
          this.#focused = false; // blur 리스너 안의 isFocused() 는 false 다(Electron)
          rec('handle.blurOnHide', this.#visible); // 낸 때의 isVisible() — 보임은 아직 켜져 있다
          this.#emit('blur', {});
        } finally {
          this.#blurringInHide = false;
        }
        if (!this.#visible) return; // blur 리스너가 이 안에서 이미 숨겼다('hide' 도 그때 냈다)
      }
      this.#visible = false;
      this.#focused = false;
      this.#emit('hide', {});
    };
    readonly focus = (): void => {
      this.#use('win.focus');
      this.#focused = true;
    };
    /**
     * 포커스를 잃는다(Electron 의 win.blur() 흉내) — 포커스만 끄고 사건은 내지 않는다. 시험이 OS 가 포커스를 가져간 것을 흉내 낼 때
     * 이것 뒤에 emit('blur') 를 따로 낸다(emit 은 상태를 바꾸지 않는다).
     */
    readonly blur = (): void => {
      this.#use('win.blur');
      this.#focused = false;
    };
    readonly isFocused = (): boolean => {
      this.#use('win.isFocused');
      return this.#focused;
    };
    readonly isVisible = (): boolean => {
      this.#use('win.isVisible');
      return this.#visible;
    };
    readonly getBounds = (): Rect => {
      this.#use('win.getBounds');
      return { ...this.#bounds };
    };
    /** 주지 않은 값은 지금 값 그대로다(Electron). 손잡이가 켜져 있으면(darwin 기본) 그 안에서 move · moved 를 낸다. */
    readonly setBounds = (bounds: Partial<Rect>): void => {
      this.#use('win.setBounds', bounds);
      this.#bounds = { ...this.#bounds, ...bounds };
      if (handles.moveOnSetBounds) {
        this.#emit('move', {});
        this.#emit('moved', {});
      }
    };
    /** 프레임 없는 창이라 콘텐츠 크기가 창 크기다. */
    readonly setContentSize = (width: number, height: number): void => {
      this.#use('win.setContentSize', width, height);
      this.#bounds = { ...this.#bounds, width, height };
    };
    readonly setOpacity = (opacity: number): void => this.#use('win.setOpacity', opacity);
    readonly setBackgroundColor = (color: string): void => this.#use('win.setBackgroundColor', color);
    readonly setAlwaysOnTop = (...args: [flag: boolean, level?: string]): void => this.#use('win.setAlwaysOnTop', ...args);

    /** 파괴한 창의 멤버는 Electron 처럼 던진다(기록하지 않는다). */
    #alive(): void {
      if (this.#destroyed) throw new TypeError('Object has been destroyed');
    }
    /** 창 · webContents 멤버 하나를 쓴다 — 살아 있으면 기록한다. */
    #use(name: string, ...args: unknown[]): void {
      this.#alive();
      rec(name, ...args);
    }
    #listen(event: string, listener: Fn, once: boolean): void {
      this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), { listener, once }]);
    }
    /** 'win.emit' 으로 기록하고 리스너를 등록 순서대로 부른다 — once 는 부르기 전에 뗀다(Node 의 EventEmitter 와 같다). */
    #emit(event: string, ...args: unknown[]): boolean {
      rec('win.emit', event, ...args);
      const entries = this.#listeners.get(event) ?? [];
      this.#listeners.set(
        event,
        entries.filter((entry) => !entry.once),
      );
      for (const { listener } of entries) listener(...args);
      return entries.length > 0;
    }
  }
  /** 사건 이름별 리스너 — 트레이 · 메뉴가 쓴다. emit 은 등록 순서대로 부르고, 리스너가 있었는지 돌려준다. */
  class Listeners {
    readonly #byEvent = new Map<string, Fn[]>();
    add(event: string, listener: Fn): void {
      this.#byEvent.set(event, [...(this.#byEvent.get(event) ?? []), listener]);
    }
    fire(event: string, args: unknown[]): boolean {
      const listeners = this.#byEvent.get(event) ?? [];
      for (const listener of listeners) listener(...args);
      return listeners.length > 0;
    }
  }
  class Tray implements FakeTray {
    readonly #listeners = new Listeners();
    readonly setToolTip = (text: string) => rec('tray.setToolTip', text);
    /** 붙인 메뉴를 그대로 기록한다 — 사례가 기록에서 붙은 메뉴를 꺼낸다. */
    readonly setContextMenu = (menu: unknown) => rec('tray.setContextMenu', menu);
    /** 띄운 메뉴를 그대로 기록한다(인자 없이 부르면 붙은 메뉴를 띄우는 것이다 — Electron). 네이티브 메뉴 루프는 흉내 내지 않는다. */
    readonly popUpContextMenu = (...args: [menu?: unknown]) => rec('tray.popUpContextMenu', ...args);
    readonly on = (event: string, listener: Fn): void => {
      rec('tray.on', event, listener);
      this.#listeners.add(event, listener);
    };
    /** 사건을 낸다(시험 · 스모크가 부른다) — Electron 의 인자 모양 그대로 넘긴다(click 은 event, bounds, position). */
    readonly emit = (event: string, ...args: unknown[]): boolean => {
      rec('tray.emit', event, ...args);
      return this.#listeners.fire(event, args);
    };
    readonly getBounds = (): Rect => {
      rec('tray.getBounds');
      return { ...handles.trayBounds };
    };
    /** 받은 이미지 객체를 그대로 기록한다 — 스모크에 넘긴 아이콘이 붙인 것과 같은 객체인지 본다. */
    constructor(image: FakeImage) {
      rec('new Tray', image);
      trays.push(this);
    }
  }
  const nativeImage = {
    createFromPath(file: string): FakeImage {
      rec('nativeImage.createFromPath', file);
      const image: FakeImage = { isEmpty: () => !existsSync(file), resize: () => image };
      return image;
    },
  };
  /** 만든 메뉴 하나(Electron 의 Menu 인스턴스) — 템플릿에서 항목을 만든다. */
  class MenuInstance implements FakeMenu {
    readonly #listeners = new Listeners();
    readonly template: readonly unknown[];
    readonly items: FakeMenuItem[];
    constructor(template: readonly unknown[]) {
      this.template = template;
      this.items = template.map((raw) => {
        const entry = raw as MenuTemplateEntry;
        const item: FakeMenuItem = {
          label: entry.label,
          type: entry.type ?? 'normal',
          checked: entry.checked === true,
          enabled: entry.enabled !== false,
          click: () => {
            if (item.type === 'checkbox' || item.type === 'radio') item.checked = !item.checked; // Electron 도 click 전에 뒤집는다
            entry.click?.(item, undefined, {});
          },
        };
        return item;
      });
    }
    readonly on = (event: string, listener: Fn): void => {
      rec('menu.on', event, listener);
      this.#listeners.add(event, listener);
    };
    /** 사건을 낸다(시험이 부른다) — macOS 의 menu-will-show · menu-will-close 를 흉내 낸다. */
    readonly emit = (event: string, ...args: unknown[]): boolean => {
      rec('menu.emit', event, ...args);
      return this.#listeners.fire(event, args);
    };
  }
  const Menu = {
    setApplicationMenu: (menu: unknown) => rec('Menu.setApplicationMenu', menu),
    buildFromTemplate: (template: readonly unknown[]): FakeMenu => {
      rec('Menu.buildFromTemplate', template);
      const menu = new MenuInstance(template);
      menus.push(menu);
      return menu;
    },
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
  return {
    electron: { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, net, protocol, screen, session, shell },
    calls,
    windows,
    trays,
    /** Menu.buildFromTemplate 이 만든 메뉴(만든 차례) — 맨 뒤가 최신 메뉴다. */
    menus,
    loginItems,
    /** 기록기 — 시험 장치(mainWiring 의 hooks 엿보기)도 같은 기록에 남긴다. */
    rec,
    handles,
    displays,
    removeDisplay,
  };
}
export type Fake = ReturnType<typeof createFakeElectron>;
