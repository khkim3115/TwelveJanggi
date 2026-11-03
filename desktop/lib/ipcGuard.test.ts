// desktop/lib/ipcGuard.cjs 시험 — IPC 발신자 검증(설계 §5.7 · 체크리스트 17): 신뢰하는 것은 트레이 창의 메인 프레임뿐이다.
// 가짜 객체만 쓴다 — electron 은 import 하지 않는다(루트 검사는 desktop/node_modules 없이 돈다).
// 거부 사례는 신뢰 사례에서 조건 하나만 어기게 만든다 — 어느 조건 하나를 지워도 그 사례가 먼저 실패하도록.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createGuardedIpc, isTrustedSender } = require('./ipcGuard.cjs') as typeof import('./ipcGuard.cjs');

type FakeFrame = import('./ipcGuard.cjs').FrameLike;
type FakeContents = import('./ipcGuard.cjs').WebContentsLike;
type FakeEvent = import('./ipcGuard.cjs').IpcEventLike;

const PAGE = 'app://twelvejanggi/tray.html';
const ORIGIN = 'app://twelvejanggi';

/** 프레임 하나 — 기본은 신뢰하는 모양(앱 페이지 · 앱 출처 · 붙어 있음). */
function frame(over: Partial<FakeFrame> = {}): FakeFrame {
  return { detached: false, url: PAGE, origin: ORIGIN, ...over };
}

/** 트레이 창의 webContents 와 그 메인 프레임에서 온 메시지 — 신뢰 사례. */
function trayWorld(frameOver: Partial<FakeFrame> = {}) {
  const mainFrame = frame(frameOver);
  const contents: FakeContents = { mainFrame };
  const event: FakeEvent = { senderFrame: mainFrame, sender: contents };
  return { mainFrame, contents, event };
}

interface Case {
  event: FakeEvent;
  /** 처리기를 등록한 쪽이 신뢰하는 webContents(getTrustedWebContents 의 값). */
  trusted: FakeContents | null | undefined;
}

/** trayWorld 의 메시지를 그 창이 신뢰하는 사례로. */
function trustedCase(world: ReturnType<typeof trayWorld>): Case {
  return { event: world.event, trusted: world.contents };
}

/** 거부해야 하는 사례 — 각각 조건 하나만 어긋난다. [이름, 사례]. */
function untrustedCases(): Array<[string, Case]> {
  const base = trayWorld();
  const cases: Array<[string, Case]> = [
    ['senderFrame 이 null(탐색 · 파괴 뒤)', { event: { senderFrame: null, sender: base.contents }, trusted: base.contents }],
    ['detached 프레임', trustedCase(trayWorld({ detached: true }))],
    // 다른 창 — 자기 메인 프레임에서 보냈고 앱 페이지지만 신뢰하는 창(base)이 아니다.
    ['다른 webContents', { event: trayWorld().event, trusted: base.contents }],
    // 서브프레임 — 앱 페이지 · 앱 출처지만 sender.mainFrame 이 아니다.
    ['서브프레임', { event: { senderFrame: frame(), sender: base.contents }, trusted: base.contents }],
    ['신뢰할 창이 없음(undefined) — 창을 만들기 전', { event: base.event, trusted: undefined }],
    ['신뢰할 창이 없음(null)', { event: base.event, trusted: null }],
    // undefined === undefined 로 통과하지 않는다.
    ['보낸 webContents 도 신뢰할 창도 없음', { event: { senderFrame: base.mainFrame, sender: undefined } as unknown as FakeEvent, trusted: undefined }],
  ];
  // 출처만 어긋남(url 은 앱 페이지) — 'null' 은 출처 없는(불투명) 문서다. 끝 '/' 가 붙은 모양은 직렬화한 출처가 아니다.
  for (const origin of ['null', 'app://twelvejanggi.evil', 'app://other', 'app://TwelveJanggi', 'APP://twelvejanggi', 'app://twelvejanggi:80', 'app://twelvejanggi/', '']) {
    cases.push([`출처 ${JSON.stringify(origin)}`, trustedCase(trayWorld({ origin }))]);
  }
  // url 만 어긋남(출처는 앱) — isAppUrl 이 걸러야 한다.
  for (const url of ['app://twelvejanggi.evil/', 'app://twelvejanggiX/tray.html', 'app://other/', 'app://TwelveJanggi/tray.html', 'about:blank', 'https://khkim3115.github.io/', 'file:///C:/tray.html', '']) {
    cases.push([`url ${JSON.stringify(url)}`, trustedCase(trayWorld({ url }))]);
  }
  return cases;
}

describe('isTrustedSender', () => {
  it('트레이 창 메인 프레임에서 온 메시지는 신뢰한다', () => {
    const { contents, event } = trayWorld();
    expect(isTrustedSender(event, contents)).toBe(true);
  });

  it.each(['app://twelvejanggi/', 'app://twelvejanggi/tray.html?smoke', 'app://twelvejanggi/tray.html#top', 'app://twelvejanggi?x'])(
    '앱 페이지 url 은 모양과 상관없이 신뢰한다: %s',
    (url) => {
      const { contents, event } = trayWorld({ url });
      expect(isTrustedSender(event, contents)).toBe(true);
    },
  );

  it.each(untrustedCases())('거부: %s', (_name, { event, trusted }) => {
    expect(isTrustedSender(event, trusted)).toBe(false);
  });

  it('senderFrame 은 한 번만 읽어 그 값으로 모두 판정한다(읽을 때마다 바뀌거나 null 이 된다)', () => {
    const { mainFrame, contents } = trayWorld();
    const answers: Array<FakeFrame | null> = [mainFrame, null];
    let reads = 0;
    const event: FakeEvent = {
      get senderFrame() {
        reads += 1;
        return answers.shift() ?? null;
      },
      sender: contents,
    };
    expect(isTrustedSender(event, contents)).toBe(true); // 두 번 읽었다면 두 번째의 null 로 거부했을 것이다
    expect(reads).toBe(1);
  });

  it('읽다가 던지면(파괴된 프레임의 url · origin 이 던진다) 던지지 않고 거부한다', () => {
    const disposed = (): never => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed');
    };
    // 던지는 자리까지 닿도록 앞의 조건은 모두 맞춘다(같은 webContents · 메인 프레임 · 앱 출처).
    const badUrl: FakeFrame = { detached: false, origin: ORIGIN, get url(): string { return disposed(); } };
    const badOrigin: FakeFrame = { detached: false, url: PAGE, get origin(): string { return disposed(); } };
    for (const bad of [badUrl, badOrigin]) {
      const contents: FakeContents = { mainFrame: bad };
      expect(isTrustedSender({ senderFrame: bad, sender: contents }, contents)).toBe(false);
    }
    const badMain: FakeContents = { get mainFrame(): FakeFrame { return disposed(); } };
    expect(isTrustedSender({ senderFrame: frame(), sender: badMain }, badMain)).toBe(false);
    const { contents } = trayWorld();
    const badFrameEvent: FakeEvent = { get senderFrame(): FakeFrame { return disposed(); }, sender: contents };
    expect(isTrustedSender(badFrameEvent, contents)).toBe(false);
    expect(isTrustedSender(undefined as unknown as FakeEvent, contents)).toBe(false);
  });
});

/** ipcMain 흉내 — 등록된 처리기를 채널별로 붙잡아 둔다. */
type Listener = (event: FakeEvent, ...args: unknown[]) => unknown;
function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  return {
    handlers,
    listeners,
    handle(channel: string, listener: Listener) {
      handlers.set(channel, listener);
    },
    on(channel: string, listener: Listener) {
      listeners.set(channel, listener);
    },
  };
}
/** 등록된 처리기 — 없으면 시험을 바로 실패시킨다. */
function registered(map: Map<string, Listener>, channel: string): Listener {
  const listener = map.get(channel);
  if (!listener) throw new Error(`등록되지 않은 채널: ${channel}`);
  return listener;
}

describe('createGuardedIpc', () => {
  it('handle — 신뢰하는 발신자면 event · 인자를 넘기고 결과를 그대로 돌려준다', () => {
    const ipc = fakeIpcMain();
    const { contents, event } = trayWorld();
    const fn = vi.fn((_event: FakeEvent, a: number, b: number) => a + b);
    createGuardedIpc(ipc, () => contents).handle('tj-sum', fn);
    expect([...ipc.handlers.keys()]).toStrictEqual(['tj-sum']);
    expect(ipc.listeners.size).toBe(0);
    expect(registered(ipc.handlers, 'tj-sum')(event, 2, 3)).toBe(5);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(event, 2, 3);
  });

  it('handle — 비동기 처리기의 약속도 그대로 돌려준다', async () => {
    const ipc = fakeIpcMain();
    const { contents, event } = trayWorld();
    createGuardedIpc(ipc, () => contents).handle('tj-async', async () => 'ok');
    await expect(registered(ipc.handlers, 'tj-async')(event)).resolves.toBe('ok');
  });

  it.each(untrustedCases())('handle — 거부(%s): 던지고 처리기를 부르지 않는다', (_name, { event, trusted }) => {
    const ipc = fakeIpcMain();
    const fn = vi.fn();
    createGuardedIpc(ipc, () => trusted).handle('tj-x', fn);
    expect(() => registered(ipc.handlers, 'tj-x')(event, 'arg')).toThrow(/IPC 발신자/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('on — 신뢰하는 발신자면 event · 인자를 넘겨 부른다', () => {
    const ipc = fakeIpcMain();
    const { contents, event } = trayWorld();
    const fn = vi.fn();
    createGuardedIpc(ipc, () => contents).on('tj-send', fn);
    expect([...ipc.listeners.keys()]).toStrictEqual(['tj-send']);
    expect(ipc.handlers.size).toBe(0);
    registered(ipc.listeners, 'tj-send')(event, { a: 1 }, 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(event, { a: 1 }, 2);
  });

  it.each(untrustedCases())('on — 거부(%s): 조용히 무시한다(던지지도 부르지도 않는다)', (_name, { event, trusted }) => {
    const ipc = fakeIpcMain();
    const fn = vi.fn();
    createGuardedIpc(ipc, () => trusted).on('tj-x', fn);
    expect(() => registered(ipc.listeners, 'tj-x')(event, 'arg')).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('신뢰할 창은 메시지마다 다시 묻는다 — 처리기는 창보다 먼저 등록해도 된다', () => {
    const ipc = fakeIpcMain();
    const { contents, event } = trayWorld();
    let current: FakeContents | undefined; // 아직 창이 없다
    const guarded = createGuardedIpc(ipc, () => current);
    guarded.handle('tj-late', () => 'ok');
    const fn = vi.fn();
    guarded.on('tj-late-send', fn);
    expect(() => registered(ipc.handlers, 'tj-late')(event)).toThrow();
    registered(ipc.listeners, 'tj-late-send')(event);
    expect(fn).not.toHaveBeenCalled();
    current = contents; // 창을 만들었다
    expect(registered(ipc.handlers, 'tj-late')(event)).toBe('ok');
    registered(ipc.listeners, 'tj-late-send')(event);
    expect(fn).toHaveBeenCalledTimes(1);
    current = undefined; // 창을 닫았다
    expect(() => registered(ipc.handlers, 'tj-late')(event)).toThrow();
  });

  it('getTrustedWebContents 가 던지면 신뢰하지 않는다 — on 은 메인 프로세스로 던지지 않는다', () => {
    const ipc = fakeIpcMain();
    const { event } = trayWorld();
    const fn = vi.fn();
    const guarded = createGuardedIpc(ipc, () => {
      throw new Error('Object has been destroyed');
    });
    guarded.handle('tj-h', fn);
    guarded.on('tj-o', fn);
    expect(() => registered(ipc.handlers, 'tj-h')(event)).toThrow(/IPC 발신자/);
    expect(() => registered(ipc.listeners, 'tj-o')(event)).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('돌려주는 것은 handle · on 둘뿐이다', () => {
    expect(Object.keys(createGuardedIpc(fakeIpcMain(), () => undefined)).sort()).toStrictEqual(['handle', 'on']);
  });
});
