// desktop/main.js 배선 시험(mainWiring.test.ts)의 가짜 electron(#36 T6-8) — main.js 가 쓰는 멤버만 있는 구조 타입이다.
// - electron 은 import · require 하지 않는다(import type 포함) — 루트 검사(typecheck · test)는 desktop/node_modules 없이 돈다.
//   main.js 가 electron 을 require 하면 시험의 Module._load 훅이 이 객체를 돌려준다(mainWiring.test.ts 의 runMain).
// - 이름이 *.test.ts 가 아니어서 vitest 가 시험으로 모으지 않는다.
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
export type FakeContents = {
  mainFrame: { detached: boolean; url: string; origin: string };
  on(event: string, listener: Fn): void;
  setWindowOpenHandler(handler: Fn): void;
  openDevTools(options: unknown): void;
};
export type FakeImage = { isEmpty(): boolean; resize(size: unknown): FakeImage };
export type FakeOptions = { isPackaged: boolean; lock: boolean; appData: string; openExternal: 'resolve' | 'reject' };

/** calls 가운데 name(첫 인자 key) 호출의 처리기(둘째 인자) — app.on('web-contents-created', fn) 의 fn 같은 것. */
export function listenersOf(calls: readonly Call[], name: string, key: string): Fn[] {
  return calls.filter((call) => call.name === name && call.args[0] === key).map((call) => call.args[1] as Fn);
}

/**
 * 기록하는 가짜 electron — main.js 가 쓰는 멤버만 있다. 처리기 · 리스너는 기록에 남고 시험이 직접 부른다.
 * Electron 과 같게 한 것: setPath 는 없는 폴더면 던진다 · enableSandbox 와 registerSchemesAsPrivileged 는 ready 뒤면 던진다 ·
 * BrowserWindow 는 만들면서 'web-contents-created' 를 부른다. ipcMain 은 어느 멤버를 불러도(계산된 키 · 구조 분해 포함) 기록된다.
 */
export function createFakeElectron({ isPackaged, lock, appData, openExternal }: FakeOptions) {
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
export type Fake = ReturnType<typeof createFakeElectron>;
