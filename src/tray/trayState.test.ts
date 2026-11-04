// 트레이 화면 상태(trayState)의 계약(설계 §5.4 · §5.3) — 구독 다섯을 먼저 걸고 그 뒤에만 묻는다 · 받은 값(push · 스냅샷)만 반영한다 ·
// ☀️ · 슬라이더 처리 함수는 main 에 청하기만 하고 미리 바꾸지 않는다 · 숨김은 <html> 의 tapp-hidden · 브리지가 없으면 아무것도 하지 않는다.
// 모듈 최상위에 상태가 있어 사례마다 vi.resetModules() 뒤 새로 불러온다. document · localStorage 는 가짜다(node 환경).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '../lib/theme';
import type { TjDesktop, TrayMode, TrayState } from './desktop';

type TrayStateModule = typeof import('./trayState');

/** main 의 기본 설정 그대로의 스냅샷(다크 · 100 · 콜드 스타트 solo · 보임). */
const SNAPSHOT: TrayState = { theme: 'dark', opacity: 100, mode: 'solo', visible: true };
/** connectBridge 가 거는 구독 — 이 순서로 다섯. */
const SUBSCRIPTIONS = ['onTheme', 'onOpacity', 'onMode', 'onShown', 'onHidden'];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 가짜 document — applyTheme · 숨김 클래스가 쓰는 면(<html> 의 dataset · classList, meta 조회)만. */
function fakePage() {
  const classes = new Set<string>();
  const dataset: Record<string, string | undefined> = {};
  const document = {
    documentElement: {
      dataset,
      classList: {
        add: (...names: string[]) => names.forEach((name) => classes.add(name)),
        remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
          const on = force ?? !classes.has(name);
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
      },
    },
    querySelector: () => null,
  };
  return { document, classes, dataset };
}

/** 가짜 localStorage — 저장값은 items 로 본다. */
function fakeStorage(initial: Record<string, string>) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    storage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, String(value));
      },
    },
  };
}

/** 가짜 브리지 — 부른 것을 calls 에 순서대로 적고, 구독한 콜백을 push 로 부르게 둔다(구독하지 않은 채 부르면 던진다). */
function fakeBridge(answer: () => Promise<TrayState> = () => Promise.resolve(SNAPSHOT)) {
  const calls: string[] = [];
  const notSubscribed = (name: string) => (): never => {
    throw new Error(`${name} 를 구독하지 않았다`);
  };
  const push: {
    theme: (theme: Theme) => void;
    opacity: (percent: number) => void;
    mode: (mode: TrayMode) => void;
    shown: () => void;
    hidden: () => void;
  } = {
    theme: notSubscribed('onTheme'),
    opacity: notSubscribed('onOpacity'),
    mode: notSubscribed('onMode'),
    shown: notSubscribed('onShown'),
    hidden: notSubscribed('onHidden'),
  };
  const off = (name: string) => () => {
    calls.push(`off ${name}`);
  };
  const bridge: TjDesktop = {
    getAppInfo: () => {
      calls.push('getAppInfo');
      return Promise.resolve({ version: '0.0.0', electron: '0', chrome: '0', platform: 'test' });
    },
    getState: () => {
      calls.push('getState');
      return answer();
    },
    setTheme: (theme) => {
      calls.push(`setTheme ${theme}`);
    },
    setOpacity: (percent) => {
      calls.push(`setOpacity ${percent}`);
    },
    setLayout: (key) => {
      calls.push(`setLayout ${key}`);
    },
    hide: () => {
      calls.push('hide');
    },
    onTheme: (cb) => {
      calls.push('onTheme');
      push.theme = cb;
      return off('onTheme');
    },
    onOpacity: (cb) => {
      calls.push('onOpacity');
      push.opacity = cb;
      return off('onOpacity');
    },
    onMode: (cb) => {
      calls.push('onMode');
      push.mode = cb;
      return off('onMode');
    },
    onShown: (cb) => {
      calls.push('onShown');
      push.shown = cb;
      return off('onShown');
    },
    onHidden: (cb) => {
      calls.push('onHidden');
      push.hidden = cb;
      return off('onHidden');
    },
  };
  return { bridge, calls, push };
}

/** 새 모듈 — 가짜 document · localStorage 를 깐 뒤 모듈 상태를 비우고 다시 불러온다. stored 는 불러오기 전의 저장값이다. */
async function fresh(stored: Record<string, string> = {}) {
  const page = fakePage();
  const store = fakeStorage(stored);
  vi.stubGlobal('document', page.document);
  vi.stubGlobal('localStorage', store.storage);
  vi.resetModules();
  const tray: TrayStateModule = await import('./trayState');
  return { tray, page, store };
}

/** 남은 마이크로태스크(스냅샷 응답의 then)를 모두 돌린다. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 새 모듈을 가짜 브리지에 붙이고(구독 → 묻기) 처음 스냅샷까지 받은 상태. */
async function connected(snapshot: TrayState = SNAPSHOT) {
  const env = await fresh();
  const rig = fakeBridge(() => Promise.resolve(snapshot));
  env.tray.connectBridge(rig.bridge);
  env.tray.requestSnapshot(rig.bridge);
  await settle();
  return { ...env, rig };
}

describe('불러오기', () => {
  it('불러오기만으로는 쓰지 않는다 — 처음 테마는 저장값(첫 페인트와 같다), 나머지는 기본값', async () => {
    const { tray, page, store } = await fresh({ tj_theme: 'light' });

    expect(tray.getTrayView()).toEqual({ theme: 'light', opacity: 100, mode: 'solo', hidden: false });
    expect(page.dataset).toEqual({});
    expect(page.classes.size).toBe(0);
    expect([...store.items]).toEqual([['tj_theme', 'light']]);
  });
});

describe('connectBridge · requestSnapshot — 먼저 구독하고 그 뒤에만 묻는다', () => {
  it('connectBridge 는 구독 다섯만 건다(getState · set* 없음). requestSnapshot 이 그 뒤에 getState 를 한 번 부른다', async () => {
    const { tray } = await fresh();
    const rig = fakeBridge();

    tray.connectBridge(rig.bridge);
    expect(rig.calls).toEqual(SUBSCRIPTIONS);

    tray.requestSnapshot(rig.bridge);
    await settle();
    expect(rig.calls).toEqual([...SUBSCRIPTIONS, 'getState']);
  });

  it('스냅샷은 네 값을 모두 반영한다 — 테마는 <html data-theme> · 저장값에도, visible false 면 tapp-hidden', async () => {
    const { tray, page, store, rig } = await connected({ theme: 'light', opacity: 55, mode: 'online', visible: false });

    expect(tray.getTrayView()).toEqual({ theme: 'light', opacity: 55, mode: 'online', hidden: true });
    expect(page.dataset.theme).toBe('light');
    expect(store.items.get('tj_theme')).toBe('light');
    expect(page.classes.has('tapp-hidden')).toBe(true);
    expect(rig.calls).toEqual([...SUBSCRIPTIONS, 'getState']);
  });

  it('응답이 최종값이다 — 묻고 답을 받기 전에 온 push 는 반영되고, 뒤에 온 답이 덮는다', async () => {
    const { tray, page } = await fresh();
    let answer: (state: TrayState) => void = () => {
      throw new Error('getState 를 부르지 않았다');
    };
    const rig = fakeBridge(
      () =>
        new Promise<TrayState>((resolve) => {
          answer = resolve;
        }),
    );
    tray.connectBridge(rig.bridge);
    tray.requestSnapshot(rig.bridge);

    rig.push.opacity(80);
    expect(tray.getTrayView().opacity).toBe(80);

    answer({ theme: 'light', opacity: 64, mode: 'online', visible: true });
    await settle();
    expect(tray.getTrayView()).toEqual({ theme: 'light', opacity: 64, mode: 'online', hidden: false });
    expect(page.dataset.theme).toBe('light');
  });

  it('getState 가 거부되면 console.warn 한 번 — 던지지 않고 상태는 그대로', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tray } = await fresh();
    const rig = fakeBridge(() => Promise.reject(new Error('ipc 끊김')));
    tray.connectBridge(rig.bridge);
    const before = tray.getTrayView();

    expect(() => tray.requestSnapshot(rig.bridge)).not.toThrow();
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('[tray] getState');
    expect(tray.getTrayView()).toBe(before);
  });
});

describe('push — main 이 민 값만 반영한다', () => {
  it("onTheme('light') → view · <html data-theme> · 저장값(tj_theme) 모두 light — 받기만 하고 되돌려 보내지 않는다", async () => {
    const { tray, page, store, rig } = await connected();
    expect(page.dataset.theme).toBe('dark');

    rig.push.theme('light');

    expect(tray.getTrayView().theme).toBe('light');
    expect(page.dataset.theme).toBe('light');
    expect(store.items.get('tj_theme')).toBe('light');
    expect(rig.calls).toEqual([...SUBSCRIPTIONS, 'getState']);
  });

  it("onMode → view.mode — 레이아웃 요청(setLayout)은 화면(TrayApp)이 한다", async () => {
    const { tray, rig } = await connected();

    rig.push.mode('online');
    expect(tray.getTrayView().mode).toBe('online');
    rig.push.mode('solo');
    expect(tray.getTrayView().mode).toBe('solo');

    expect(rig.calls).toEqual([...SUBSCRIPTIONS, 'getState']);
  });

  it('onHidden → <html> 에 tapp-hidden, onShown → 빠진다 · 스냅샷 visible false → 붙는다', async () => {
    const { tray, page, rig } = await connected();
    expect(page.classes.has('tapp-hidden')).toBe(false);

    rig.push.hidden();
    expect(page.classes.has('tapp-hidden')).toBe(true);
    expect(tray.getTrayView().hidden).toBe(true);

    rig.push.shown();
    expect(page.classes.has('tapp-hidden')).toBe(false);
    expect(tray.getTrayView().hidden).toBe(false);

    tray.applySnapshot({ ...SNAPSHOT, visible: false });
    expect(page.classes.has('tapp-hidden')).toBe(true);
    expect(tray.getTrayView().hidden).toBe(true);
  });

  it('subscribeTrayView — 바뀔 때만 알리고, 해제하면 멈춘다 · 바뀌지 않으면 getTrayView 는 같은 객체다(useSyncExternalStore)', async () => {
    const { tray, rig } = await connected();
    const seen: unknown[] = [];
    const unsubscribe = tray.subscribeTrayView(() => seen.push(tray.getTrayView()));
    const before = tray.getTrayView();

    rig.push.opacity(100); // 같은 값
    rig.push.shown(); // 이미 보인다
    expect(tray.getTrayView()).toBe(before);
    expect(seen).toEqual([]);

    rig.push.opacity(70);
    expect(seen).toEqual([{ ...before, opacity: 70 }]);

    unsubscribe();
    rig.push.opacity(40);
    expect(seen).toHaveLength(1);
    expect(tray.getTrayView().opacity).toBe(40);
  });
});

describe('☀️ · 슬라이더 처리 함수 — 청하기만 하고 미리 바꾸지 않는다', () => {
  it("requestThemeToggle() → setTheme('light') 한 번. onTheme 가 오기 전에는 view · data-theme · 저장값이 그대로다", async () => {
    const { tray, page, store, rig } = await connected();
    const before = tray.getTrayView();

    tray.requestThemeToggle();

    expect(rig.calls).toEqual([...SUBSCRIPTIONS, 'getState', 'setTheme light']);
    expect(tray.getTrayView()).toBe(before);
    expect(page.dataset.theme).toBe('dark');
    expect(store.items.get('tj_theme')).toBe('dark');

    rig.push.theme('light'); // main 이 받아들여 민 값
    expect(tray.getTrayView().theme).toBe('light');
    tray.requestThemeToggle(); // 이제는 반대(dark)를 청한다
    expect(rig.calls.slice(-1)).toEqual(['setTheme dark']);
  });

  it('스냅샷 전에는 저장값의 반대를 청한다 — 저장값이 light 면 dark', async () => {
    const { tray } = await fresh({ tj_theme: 'light' });
    const rig = fakeBridge();
    tray.connectBridge(rig.bridge);

    tray.requestThemeToggle();

    expect(rig.calls).toEqual([...SUBSCRIPTIONS, 'setTheme dark']);
  });

  it('requestOpacity(55) → setOpacity(55) 한 번. onOpacity(55) 전에는 view.opacity 가 그대로다', async () => {
    const { tray, rig } = await connected();

    tray.requestOpacity(55);

    expect(rig.calls).toEqual([...SUBSCRIPTIONS, 'getState', 'setOpacity 55']);
    expect(tray.getTrayView().opacity).toBe(100);

    rig.push.opacity(55);
    expect(tray.getTrayView().opacity).toBe(55);
  });

  it('브리지가 없으면(브라우저 개발 · 새 모듈) 던지지 않고 아무것도 바꾸지 않는다 — 따로 반영하지 않는다(흐름은 하나)', async () => {
    const { tray, page, store } = await fresh({ tj_theme: 'light' });
    page.dataset.theme = 'light'; // main.tsx 가 첫 페인트에 적용한 값
    tray.connectBridge(undefined);
    tray.requestSnapshot(undefined);
    const before = tray.getTrayView();

    expect(() => {
      tray.requestThemeToggle();
      tray.requestOpacity(55);
    }).not.toThrow();
    await settle();

    expect(tray.getTrayView()).toBe(before);
    expect(page.dataset.theme).toBe('light');
    expect(store.items.get('tj_theme')).toBe('light');
    expect(page.classes.size).toBe(0);
  });
});
