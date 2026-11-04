// desktop/preload.js 계약 시험(설계 §5.6). preload 를 글자로 읽어 Electron 의 감싸기와 같은
// new Function('require', 'process', 'exports', 'module', 'global', 본문) 으로 돌린다. 가짜 require 는 'electron' 만 알고 그 밖은
// 던진다(45 sandbox 규칙을 기계적으로 지킨다). location · document 는 vi.stubGlobal 로 준다. 진짜 electron 은 import 하지 않는다 —
// 바이너리를 받거나 MODULE_NOT_FOUND 가 난다.
// - 비스모크: 브리지 하나(tjDesktop, 11키, 얼림)만 노출하고 로드 때 아무것도 보내거나 듣지 않는다(#36 T6-5).
// - 스모크(?smoke): 실효 상태 보고 · 격리 world 표식 · CSP 위반 수집(보내기와 격리 world 버퍼 모두 최대 50건).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TJ_DESKTOP_KEYS } from '../../src/tray/desktop.ts';
import { PUSH_CHANNELS } from './pushChannels.cjs';

const SOURCE = readFileSync(new URL('../preload.js', import.meta.url), 'utf8');
/**
 * 가짜 process 의 실효 상태 — 두 필드가 서로 다른 두 벌이다. 스모크 보고가 필드마다 process 를 그대로 옮기는지 본다
 * (값을 박아 두거나 다른 필드를 읽으면 한 벌에서 어긋난다). 가짜 process 에는 다른 값도 있다 — 보고에는 두 필드만 실린다.
 */
const PROCESS_STATES = [
  { sandboxed: true, contextIsolated: false },
  { sandboxed: false, contextIsolated: true },
] as const;
type ProcessState = (typeof PROCESS_STATES)[number];

/** 격리 world 전역(스모크만) — 시험은 진짜 globalThis 위에서 돌므로 시험마다 지운다. */
type IsolatedGlobals = { __tjIsoProbe?: unknown; __tjCspBuffer?: unknown };
const isolated = globalThis as IsolatedGlobals;

/** preload 를 한 번 돌린다(process 의 실효 상태는 state) — 쓴 가짜 객체를 돌려준다. */
function runPreload(search: string, state: ProcessState = PROCESS_STATES[0]) {
  const exposeInMainWorld = vi.fn();
  const invoke = vi.fn((..._args: unknown[]) => Promise.resolve('invoke 결과'));
  const send = vi.fn();
  const on = vi.fn();
  const removeListener = vi.fn();
  const addEventListener = vi.fn();
  const required: string[] = [];
  const fakeRequire = (name: string) => {
    required.push(name);
    if (name === 'electron') return { contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke, send, on, removeListener } };
    throw new Error(`sandbox preload 는 ${name} 을 require 할 수 없다`);
  };
  vi.stubGlobal('location', { search });
  vi.stubGlobal('document', { addEventListener });
  const module = { exports: {} };
  const wrapped = new Function('require', 'process', 'exports', 'module', 'global', SOURCE);
  wrapped(fakeRequire, { ...state, type: 'renderer', platform: 'win32' }, module.exports, module, globalThis);
  return { exposeInMainWorld, invoke, send, on, removeListener, addEventListener, required };
}

/** exposeInMainWorld 로 노출한 브리지(한 번만 불렸다는 것은 각 시험이 따로 본다). */
function exposedBridge(exposeInMainWorld: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return exposeInMainWorld.mock.calls[0]?.[1] as Record<string, unknown>;
}

/** 페이지에서 난 CSP 위반 흉내 — 6필드 밖의 값(columnNumber · sample · statusCode · target)도 함께 온다. */
function violation(i: number) {
  return {
    blockedURI: `https://example.invalid/${i}`,
    effectiveDirective: 'connect-src',
    originalPolicy: "default-src 'none'; connect-src 'self'",
    disposition: 'enforce',
    sourceFile: 'app://twelvejanggi/assets/tray-x.js',
    lineNumber: i,
    columnNumber: 7,
    sample: '',
    statusCode: 200,
    target: { nodeName: '#document' },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete isolated.__tjIsoProbe;
  delete isolated.__tjCspBuffer;
});

describe.each(['', '?smoke'])('브리지 — location.search %j', (search) => {
  it("exposeInMainWorld 를 'tjDesktop' 로 한 번 부르고, 얼린 객체의 키가 TJ_DESKTOP_KEYS 와 같다", () => {
    const { exposeInMainWorld } = runPreload(search);
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld.mock.calls[0]?.[0]).toBe('tjDesktop');
    const bridge = exposedBridge(exposeInMainWorld);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge)).toStrictEqual([...TJ_DESKTOP_KEYS]);
  });

  it("getAppInfo() 는 invoke('tj-app-info') 하나다(인자 없음) — 그 약속을 그대로 돌려준다", async () => {
    const { exposeInMainWorld, invoke } = runPreload(search);
    const getAppInfo = exposedBridge(exposeInMainWorld).getAppInfo as (...args: unknown[]) => Promise<unknown>;
    await expect(getAppInfo('무시되는 인자')).resolves.toBe('invoke 결과');
    expect(invoke.mock.calls).toStrictEqual([['tj-app-info']]);
  });

  it("require 는 'electron' 만 부른다", () => {
    expect(runPreload(search).required).toStrictEqual(['electron']);
  });
});

type Fn = (...args: unknown[]) => unknown;

describe.each(['', '?smoke'])('보내는 쪽 — location.search %j', (search) => {
  it("getState() 는 invoke('tj-get-state') 하나다 — 그 약속을 그대로 돌려준다", async () => {
    const { exposeInMainWorld, invoke } = runPreload(search);
    await expect((exposedBridge(exposeInMainWorld).getState as Fn)()).resolves.toBe('invoke 결과');
    expect(invoke.mock.calls).toStrictEqual([['tj-get-state']]);
  });

  it.each([
    ['setTheme', 'tj-set-theme', 'light'],
    ['setOpacity', 'tj-set-opacity', 55],
    ['setLayout', 'tj-set-layout', 'online'],
    // 값은 preload 에서 고치지 않는다 — 정규화는 main 한 곳이다.
    ['setTheme', 'tj-set-theme', 'purple'],
    ['setOpacity', 'tj-set-opacity', -5],
  ])('%s(%j) → send(%s, 값 그대로)', (name, channel, value) => {
    const { exposeInMainWorld, send } = runPreload(search);
    (exposedBridge(exposeInMainWorld)[name] as Fn)(value);
    expect(send.mock.calls.filter(([c]) => c === channel)).toStrictEqual([[channel, value]]);
  });

  it("hide() 는 send('tj-hide') 하나다(값 없음)", () => {
    const { exposeInMainWorld, send } = runPreload(search);
    (exposedBridge(exposeInMainWorld).hide as Fn)('무시되는 인자');
    expect(send.mock.calls.filter(([c]) => c === 'tj-hide')).toStrictEqual([['tj-hide']]);
  });
});

const SUBSCRIPTIONS = [
  ['onTheme', 'tj-theme', ['light']],
  ['onOpacity', 'tj-opacity', [55]],
  ['onMode', 'tj-mode', ['online']],
  ['onShown', 'tj-shown', []],
  ['onHidden', 'tj-hidden', []],
] as const;

describe.each(['', '?smoke'])('구독 — location.search %j', (search) => {
  it.each(SUBSCRIPTIONS)('%s: on(%s) 한 번 · cb 는 payload 만 받고 · 해제는 removeListener 한 번', (name, channel, payload) => {
    const { exposeInMainWorld, on, removeListener } = runPreload(search);
    const subscribe = exposedBridge(exposeInMainWorld)[name] as (cb: unknown) => () => void;
    const other = vi.fn();
    const cb = vi.fn();
    subscribe(other);
    on.mockClear();
    const unsubscribe = subscribe(cb);

    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe(channel);
    const listener = on.mock.calls[0]?.[1] as Fn;
    const event = { sender: '이벤트 객체' };
    listener(event, ...payload);
    // 이벤트 객체가 페이지로 넘어가지 않는다 — payload 만, 개수 그대로.
    expect(cb.mock.calls).toStrictEqual([[...payload]]);
    expect(other).not.toHaveBeenCalled();

    expect(typeof unsubscribe).toBe('function');
    expect(removeListener).not.toHaveBeenCalled();
    unsubscribe();
    expect(removeListener.mock.calls).toStrictEqual([[channel, listener]]);
  });

  it.each(SUBSCRIPTIONS)('%s: cb 가 함수가 아니면 아무것도 걸지 않고 함수를 돌려준다', (name) => {
    const { exposeInMainWorld, on, removeListener } = runPreload(search);
    const subscribe = exposedBridge(exposeInMainWorld)[name] as (cb: unknown) => () => void;
    for (const bad of [undefined, null, 'x', 3, {}]) {
      const unsubscribe = subscribe(bad);
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    }
    expect(on).not.toHaveBeenCalled();
    expect(removeListener).not.toHaveBeenCalled();
  });
});

describe('채널 집합', () => {
  it('구독이 거는 채널 = Object.keys(PUSH_CHANNELS) — 기록된 on() 도 preload 글자도', () => {
    const { exposeInMainWorld, on } = runPreload('');
    const bridge = exposedBridge(exposeInMainWorld);
    for (const [name] of SUBSCRIPTIONS) (bridge[name] as Fn)(() => {});
    const expected = Object.keys(PUSH_CHANNELS).sort();
    expect(on.mock.calls.map(([channel]) => channel).sort()).toStrictEqual(expected);
    const literals = [...SOURCE.matchAll(/subscribe\('(tj-[a-z-]+)'\)/g)].map((m) => m[1]);
    expect([...new Set(literals)].sort()).toStrictEqual(expected);
  });
});

describe('비스모크', () => {
  // #36 T6-5 — 로드 직후만이 아니라 매크로태스크 하나 뒤에도 보내기 · invoke · 듣기 · 리스너 · 전역 변화가 없다.
  it.each(['', '?smokey', '?x=smoke', '?nosmoke=1'])('로드 뒤 매크로태스크까지 호출 0 · 전역 차이 없음: %j', async (search) => {
    // runPreload 가 stubGlobal 로 더하는 location · document 는 미리 두어 차이에서 뺀다.
    vi.stubGlobal('location', { search });
    vi.stubGlobal('document', {});
    const before = Object.keys(globalThis).sort();
    const { send, invoke, on, removeListener, addEventListener } = runPreload(search);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const fn of [send, invoke, on, removeListener, addEventListener]) expect(fn).not.toHaveBeenCalled();
    expect(Object.keys(globalThis).sort()).toStrictEqual(before);
  });

  it.each(['', '?smokey', '?x=smoke', '?nosmoke=1'])('보내기 0 · 리스너 0 · 격리 world 전역 없음: %j', (search) => {
    const { send, addEventListener } = runPreload(search);
    expect(send).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
    expect('__tjIsoProbe' in globalThis).toBe(false);
    expect('__tjCspBuffer' in globalThis).toBe(false);
  });
});

describe('스모크', () => {
  describe.each(PROCESS_STATES)('process.sandboxed $sandboxed · process.contextIsolated $contextIsolated', (state) => {
    it.each(['?smoke', '?smoke=1', '?a=1&smoke'])(
      "실효 상태를 필드마다 그대로 'tj-smoke-preload' 로 보내고 표식 · 캡처 리스너를 하나씩 둔다: %j",
      (search) => {
        const { send, addEventListener } = runPreload(search, state);
        expect(send.mock.calls).toStrictEqual([['tj-smoke-preload', { sandboxed: state.sandboxed, contextIsolated: state.contextIsolated }]]);
        expect(isolated.__tjIsoProbe).toBe(1);
        expect(isolated.__tjCspBuffer).toStrictEqual([]);
        expect(addEventListener).toHaveBeenCalledTimes(1);
        const [type, listener, options] = addEventListener.mock.calls[0] ?? [];
        expect(type).toBe('securitypolicyviolation');
        expect(typeof listener).toBe('function');
        expect(options === true || (typeof options === 'object' && options !== null && options.capture === true)).toBe(true);
      },
    );
  });

  it("위반 60건 → 'tj-smoke-csp' 50건 · 버퍼 50건, 6필드만 담고 둘의 내용이 같다", () => {
    const { send, addEventListener } = runPreload('?smoke');
    const listener = addEventListener.mock.calls[0]?.[1] as (event: unknown) => void;
    for (let i = 0; i < 60; i++) listener(violation(i));

    const sent = send.mock.calls.filter(([channel]) => channel === 'tj-smoke-csp').map(([, payload]) => payload);
    const buffer = isolated.__tjCspBuffer as unknown[];
    expect(sent).toHaveLength(50);
    expect(buffer).toHaveLength(50);
    expect(sent).toStrictEqual(buffer);
    // 앞의 50건이 차례대로 — 버퍼가 차면 그 뒤는 보내지도 담지도 않는다.
    expect(buffer).toStrictEqual(
      Array.from({ length: 50 }, (_, i) => {
        const { blockedURI, effectiveDirective, originalPolicy, disposition, sourceFile, lineNumber } = violation(i);
        return { blockedURI, effectiveDirective, originalPolicy, disposition, sourceFile, lineNumber };
      }),
    );
  });
});
