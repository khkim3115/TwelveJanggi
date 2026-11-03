// 트레이 페이지 스모크 훅의 계약(설계 §5.8) — ?smoke 일 때만 설치 · 브리지 키 보고 · AI 경로 보고 ·
// net() 은 인증 설정 GET 과 Realtime join/leave 만 · connectProbe() 는 .invalid 빌드에서만.
// 가짜 window 와 가짜 의존(fetch · 소켓 · Supabase 클라이언트 · AI 창구)만 쓴다. 네트워크에 나가지 않고, 진짜 lib/supabase 도 불러오지 않는다.
// 의존은 모두 던지는 것으로 시작하고 시험이 필요한 것만 갈아 끼운다 — 빠뜨린 가짜가 조용히 진짜로 가지 않게.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, legalMoves, type GameState, type Move } from '../core/gameState';
import type { Difficulty } from '../engine/ai';
import type { AiAnswer, AiPath } from '../engine/aiClient';
import { TJ_DESKTOP_KEYS } from './desktop';
import {
  createTraySmokeApi,
  installTraySmoke,
  isSmokeLocation,
  type SmokeDeps,
  type SmokeNetResult,
  type TraySmokeApi,
} from './smoke';

// 진짜 모듈이 실수로 불리면(공용 로더의 기본 import 가 돌면) 실서버로 나가는 대신 여기서 멈춘다.
vi.mock('../lib/supabase', () => {
  throw new Error('smoke 시험은 진짜 lib/supabase 를 불러오지 않는다');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 시험이 갈아 끼우지 않은 의존을 쓰면 던진다. */
function untouched(name: string) {
  return (): never => {
    throw new Error(`갈아 끼우지 않은 의존을 썼다: ${name}`);
  };
}

function deps(over: Partial<SmokeDeps> = {}): SmokeDeps {
  return {
    supabaseUrl: undefined,
    supabaseAnonKey: undefined,
    fetch: untouched('fetch'),
    openSocket: untouched('openSocket'),
    loadSupabase: untouched('loadSupabase'),
    ai: {
      requestAiMove: untouched('requestAiMove'),
      getAiPath: untouched('getAiPath'),
      cancelPendingAi: untouched('cancelPendingAi'),
    },
    ...over,
  };
}

type FakeWindow = { location: { search: string }; __tjTraySmoke?: TraySmokeApi };
const windowAt = (search: string): FakeWindow => ({ location: { search } });
const stubApi = (): TraySmokeApi => ({ ai: vi.fn(), net: vi.fn(), connectProbe: vi.fn(), bridge: vi.fn() });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('isSmokeLocation — desktop/preload.js 와 같은 판정(URLSearchParams.has)', () => {
  it.each(['?smoke', '?smoke=1', '?a=1&smoke'])('스모크: %j', (search) => {
    expect(isSmokeLocation(search)).toBe(true);
  });

  it.each(['', '?', '?smokey', '?x=smoke', '?nosmoke=1', '?SMOKE'])('스모크가 아님: %j', (search) => {
    expect(isSmokeLocation(search)).toBe(false);
  });
});

describe('installTraySmoke', () => {
  it('?smoke 이면 받은 api 를 window.__tjTraySmoke 로 설치하고 true 를 돌려준다 — 설치만 하고 아무것도 부르지 않는다', () => {
    const win = windowAt('?smoke');
    const api = stubApi();

    expect(installTraySmoke(win, api)).toBe(true);

    expect(win.__tjTraySmoke).toBe(api);
    for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
  });

  it.each(['', '?smokey', '?x=smoke'])('스모크가 아니면(%j) 설치하지 않고 false 를 돌려준다', (search) => {
    const win = windowAt(search);

    expect(installTraySmoke(win, stubApi())).toBe(false);

    expect('__tjTraySmoke' in win).toBe(false);
  });

  it('api 를 안 주면 기본 api 를 설치한다 — 네 메서드가 있고, 설치만으로는 네트워크 · 워커에 손대지 않는다', () => {
    const fetch = vi.fn();
    const WebSocket = vi.fn();
    const Worker = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebSocket', WebSocket);
    vi.stubGlobal('Worker', Worker);
    const win = windowAt('?smoke');

    expect(installTraySmoke(win)).toBe(true);

    expect(Object.keys(win.__tjTraySmoke ?? {}).sort()).toStrictEqual(['ai', 'bridge', 'connectProbe', 'net']);
    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
    expect(Worker).not.toHaveBeenCalled();
  });

  it('스모크가 아니면 기본 api 도 만들지 않는다 — 평소 실행에는 아무 흔적이 없다', () => {
    const win = windowAt('');

    installTraySmoke(win);

    expect(Object.keys(win)).toStrictEqual(['location']);
  });

  it('모듈을 불러오는 것만으로는 아무것도 하지 않는다 — fetch · WebSocket · Worker 호출 0', async () => {
    vi.resetModules();
    const fetch = vi.fn();
    const WebSocket = vi.fn();
    const Worker = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebSocket', WebSocket);
    vi.stubGlobal('Worker', Worker);

    await import('./smoke');

    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
    expect(Worker).not.toHaveBeenCalled();
  });
});

describe('bridge()', () => {
  it('기본 api 의 bridge() 는 window.tjDesktop 의 키와 계약 상수 TJ_DESKTOP_KEYS 를 돌려준다', () => {
    vi.stubGlobal('window', { tjDesktop: { getAppInfo: () => Promise.resolve({}) } });
    const win = windowAt('?smoke');
    installTraySmoke(win);

    const report = win.__tjTraySmoke?.bridge();

    expect(report).toStrictEqual({ keys: ['getAppInfo'], contract: [...TJ_DESKTOP_KEYS] });
    expect(report?.contract).not.toBe(TJ_DESKTOP_KEYS); // 사본 — 받은 쪽이 고쳐도 계약 상수는 그대로
  });

  it('노출 키가 계약과 다르면 다른 채로 보고한다 — 같은지는 실행기가 판정한다', () => {
    vi.stubGlobal('window', { tjDesktop: { getAppInfo: () => Promise.resolve({}), exposeEverything: () => undefined } });

    expect(createTraySmokeApi(deps()).bridge()).toStrictEqual({
      keys: ['getAppInfo', 'exposeEverything'],
      contract: [...TJ_DESKTOP_KEYS],
    });
  });

  it('브리지가 없으면(브라우저 개발 · preload 실패) keys 는 비어 있다', () => {
    vi.stubGlobal('window', {});
    expect(createTraySmokeApi(deps()).bridge()).toStrictEqual({ keys: [], contract: [...TJ_DESKTOP_KEYS] });

    vi.unstubAllGlobals(); // window 자체가 없다(node)
    expect(createTraySmokeApi(deps()).bridge()).toStrictEqual({ keys: [], contract: [...TJ_DESKTOP_KEYS] });
  });
});

describe('ai()', () => {
  const START = createInitialState();
  const LEGAL: Move = legalMoves(START)[0];
  const ILLEGAL: Move = { from: 0, to: 11, piece: 1, promote: false };

  /** 답이 'never' 면 영영 답하지 않는 AI. */
  function aiPorts(answer: AiAnswer | 'never', path: AiPath) {
    return {
      requestAiMove: vi.fn((_state: GameState, _difficulty: Difficulty): Promise<AiAnswer> => {
        return answer === 'never' ? new Promise<AiAnswer>(() => {}) : Promise.resolve(answer);
      }),
      getAiPath: vi.fn((): AiPath => path),
      cancelPendingAi: vi.fn(),
    };
  }

  it('시작 국면에서 easy 로 한 수를 청하고, 워커가 합법 수로 답하면 경로 · 답 · 합법을 보고한다', async () => {
    expect(legalMoves(START)).toContainEqual(LEGAL);
    expect(legalMoves(START)).not.toContainEqual(ILLEGAL);
    const ai = aiPorts({ move: LEGAL }, 'worker');

    const result = await createTraySmokeApi(deps({ ai })).ai();

    expect(result).toStrictEqual({ aiWorker: 'worker', aiAnswered: true, legal: true, ms: expect.any(Number) });
    expect(Number.isInteger(result.ms) && result.ms >= 0).toBe(true);
    expect(ai.requestAiMove.mock.calls).toStrictEqual([[START, 'easy']]);
    expect(ai.cancelPendingAi).not.toHaveBeenCalled();
  });

  it('동기 폴백으로 답했으면 fallback 그대로 보고한다 — 워커 답으로 보이게 하지 않는다', async () => {
    const result = await createTraySmokeApi(deps({ ai: aiPorts({ move: LEGAL }, 'fallback') })).ai();

    expect(result).toMatchObject({ aiWorker: 'fallback', aiAnswered: true, legal: true });
  });

  it('수가 없다고(null) 답하면 aiAnswered · legal 모두 false 다', async () => {
    const result = await createTraySmokeApi(deps({ ai: aiPorts({ move: null }, 'worker') })).ai();

    expect(result).toMatchObject({ aiWorker: 'worker', aiAnswered: false, legal: false });
  });

  it('답은 왔지만 합법 수가 아니면 aiAnswered true · legal false 다', async () => {
    const result = await createTraySmokeApi(deps({ ai: aiPorts({ move: ILLEGAL }, 'worker') })).ai();

    expect(result).toMatchObject({ aiWorker: 'worker', aiAnswered: true, legal: false });
  });

  it('답이 없으면 10초 뒤 기다림을 끝내고 요청을 버린다 — 멈추지 않고 미응답으로 보고한다', async () => {
    vi.useFakeTimers();
    const ai = aiPorts('never', 'unused');
    let result: Awaited<ReturnType<TraySmokeApi['ai']>> | undefined;
    const pending = createTraySmokeApi(deps({ ai })).ai().then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(result).toBeUndefined();
    expect(ai.cancelPendingAi).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result).toStrictEqual({ aiWorker: 'unused', aiAnswered: false, legal: false, ms: expect.any(Number) });
    expect(ai.cancelPendingAi).toHaveBeenCalledTimes(1);
  });

  it('기본 배선 — 진짜 엔진이 답한다(node 에는 Worker 가 없어 fallback 이다)', async () => {
    const result = await createTraySmokeApi().ai();

    expect(result).toStrictEqual({ aiWorker: 'fallback', aiAnswered: true, legal: true, ms: expect.any(Number) });
  });
});

describe('net()', () => {
  const ORIGIN = 'https://abc.supabase.co';
  const ANON_KEY = 'anon-key-for-test';
  const SETTINGS_URL = `${ORIGIN}/auth/v1/settings`;
  /** 전부 잘 된 결과 — 시험마다 달라지는 필드만 덮어쓴다. */
  const OK: SmokeNetResult = { configured: true, settingsStatus: 200, realtimeConnected: true, joinStatus: 'SUBSCRIBED', error: null };

  /** Proxy 로 감싼 객체 — 읽은 속성 이름을 모은다(then 은 약속이 thenable 을 살피는 것이라 뺀다). */
  function watched<T extends object>(target: T, seen: Set<string>): T {
    return new Proxy(target, {
      get(object, prop, receiver) {
        if (prop !== 'then') seen.add(String(prop));
        return Reflect.get(object, prop, receiver);
      },
    });
  }

  /** net() 이 받는 가짜 세계. 순서가 있는 일은 log 에 쌓고, 건드린 면은 touched 에 모은다. */
  function netRig() {
    const log: string[] = [];
    const touched = { module: new Set<string>(), client: new Set<string>() };
    const forbidden = vi.fn((): never => {
      throw new Error('net() 이 금지된 면을 건드렸다');
    });
    const channel = {
      subscribe: vi.fn((callback: (status: string) => void) => {
        log.push('subscribe');
        queueMicrotask(() => callback('SUBSCRIBED'));
      }),
    };
    const client = {
      channel: vi.fn((name: string) => {
        log.push(`channel ${name}`);
        return channel;
      }),
      removeChannel: vi.fn(async (_channel: unknown) => {
        log.push('removeChannel');
        return 'ok';
      }),
      realtime: {
        isConnected: vi.fn(() => {
          log.push('isConnected');
          return true;
        }),
        disconnect: vi.fn(async () => {
          log.push('disconnect');
          return 'ok';
        }),
      },
      // 아래는 net() 이 쓰는 면(SmokeSupabase)에 없다 — 진짜 클라이언트에는 있고, 부르면 안 된다(익명 가입 · 세션 · REST).
      auth: { signInAnonymously: forbidden, getSession: forbidden, getUser: forbidden },
      rpc: forbidden,
      from: forbidden,
    };
    const fetch = vi.fn(async (url: string, _init?: unknown) => {
      log.push(`fetch ${url}`);
      return { status: 200 };
    });
    const fakeModule = { supabase: watched(client, touched.client), ensureAnonSession: forbidden, isSupabaseConfigured: true };
    const loaded = watched(fakeModule, touched.module);
    const loadSupabase = vi.fn(async () => loaded);
    return {
      log,
      touched,
      forbidden,
      channel,
      client,
      fetch,
      loadSupabase,
      deps: deps({ supabaseUrl: ORIGIN, supabaseAnonKey: ANON_KEY, fetch, loadSupabase }),
    };
  }

  /** 채널 이름의 무작위 부분을 가린다. */
  const anonymous = (entries: string[]) => entries.map((entry) => entry.replace(/(tj:probe-)[0-9a-f]{8}$/, '$1<id>'));

  it.each([
    ['둘 다 없음', undefined, undefined],
    ['URL 만 있음', ORIGIN, undefined],
    ['키만 있음', undefined, ANON_KEY],
    ['빈 문자열', '', ''],
  ])('Supabase 값이 없으면(%s) 아무것도 하지 않고 configured false 다', async (_name, supabaseUrl, supabaseAnonKey) => {
    const result = await createTraySmokeApi(deps({ supabaseUrl, supabaseAnonKey })).net();

    expect(result).toStrictEqual({ configured: false, settingsStatus: null, realtimeConnected: false, joinStatus: null, error: null });
  });

  it('settings GET(apikey 헤더만) → 채널 join → 연결 확인 → 채널 제거 → 소켓 끊기 순서로 하고 결과를 보고한다', async () => {
    const rig = netRig();

    const result = await createTraySmokeApi(rig.deps).net();

    expect(result).toStrictEqual(OK);
    expect(rig.fetch.mock.calls).toStrictEqual([[SETTINGS_URL, { headers: { apikey: ANON_KEY } }]]);
    expect(rig.loadSupabase).toHaveBeenCalledTimes(1);
    expect(rig.client.channel.mock.calls[0]?.[0]).toMatch(/^tj:probe-[0-9a-f]{8}$/);
    expect(anonymous(rig.log)).toStrictEqual([
      `fetch ${SETTINGS_URL}`,
      'channel tj:probe-<id>',
      'subscribe',
      'isConnected',
      'removeChannel',
      'disconnect',
    ]);
    expect(rig.client.removeChannel.mock.calls[0]?.[0]).toBe(rig.channel);
  });

  it('공용 로더의 모듈에서 supabase 만, 클라이언트에서 channel · removeChannel · realtime 만 읽는다 — 익명 로그인 · 세션 · RPC · REST 에는 손대지 않는다', async () => {
    const rig = netRig();

    await createTraySmokeApi(rig.deps).net();

    expect(rig.forbidden).not.toHaveBeenCalled();
    expect([...rig.touched.module]).toStrictEqual(['supabase']);
    expect([...rig.touched.client].sort()).toStrictEqual(['channel', 'realtime', 'removeChannel']);
  });

  it('URL 끝의 슬래시는 떼고 붙인다', async () => {
    const rig = netRig();

    await createTraySmokeApi({ ...rig.deps, supabaseUrl: `${ORIGIN}//` }).net();

    expect(rig.fetch.mock.calls[0]?.[0]).toBe(SETTINGS_URL);
  });

  it('settings 가 200 이 아니어도 상태를 그대로 보고한다', async () => {
    const rig = netRig();
    rig.fetch.mockResolvedValueOnce({ status: 401 });

    const result = await createTraySmokeApi(rig.deps).net();

    expect(result).toMatchObject({ settingsStatus: 401, error: null });
  });

  it('채널 권한 오류(CHANNEL_ERROR)여도 소켓이 붙어 있으면 연결로 보고한다 — 통과 여부는 실행기가 정한다', async () => {
    const rig = netRig();
    rig.channel.subscribe.mockImplementation((callback) => {
      rig.log.push('subscribe');
      queueMicrotask(() => callback('CHANNEL_ERROR'));
    });

    const result = await createTraySmokeApi(rig.deps).net();

    expect(result).toStrictEqual({ ...OK, joinStatus: 'CHANNEL_ERROR' });
  });

  it('소켓이 안 붙으면 realtimeConnected false · join 응답은 그대로 보고하고, 그래도 정리한다', async () => {
    const rig = netRig();
    rig.channel.subscribe.mockImplementation((callback) => {
      rig.log.push('subscribe');
      queueMicrotask(() => callback('TIMED_OUT'));
    });
    rig.client.realtime.isConnected.mockImplementation(() => {
      rig.log.push('isConnected');
      return false;
    });

    const result = await createTraySmokeApi(rig.deps).net();

    expect(result).toStrictEqual({ ...OK, realtimeConnected: false, joinStatus: 'TIMED_OUT' });
    expect(rig.log.slice(-3)).toStrictEqual(['isConnected', 'removeChannel', 'disconnect']);
  });

  it('join 응답이 10초 안에 없으면 기다림을 끝내고 joinStatus null — 그래도 연결 상태를 보고 채널을 제거하고 소켓을 끊는다', async () => {
    vi.useFakeTimers();
    const rig = netRig();
    rig.channel.subscribe.mockImplementation(() => {
      rig.log.push('subscribe'); // 응답이 영영 오지 않는다
    });
    let result: SmokeNetResult | undefined;
    const pending = createTraySmokeApi(rig.deps)
      .net()
      .then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result).toStrictEqual({ ...OK, joinStatus: null });
    expect(rig.log.slice(-3)).toStrictEqual(['isConnected', 'removeChannel', 'disconnect']);
  });

  it('settings GET 이 실패해도 Realtime 은 이어서 본다 — 오류는 단계 이름과 함께 모은다', async () => {
    const rig = netRig();
    rig.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await createTraySmokeApi(rig.deps).net();

    expect(result).toStrictEqual({ ...OK, settingsStatus: null, error: 'settings: Failed to fetch' });
  });

  it('공용 로더가 실패해도 던지지 않고 error 에 담는다 — 만든 채널이 없으니 정리할 것도 없다', async () => {
    const rig = netRig();
    rig.loadSupabase.mockRejectedValueOnce(new Error('client load failed'));

    const result = await createTraySmokeApi(rig.deps).net();

    expect(result).toStrictEqual({ ...OK, realtimeConnected: false, joinStatus: null, error: 'realtime: client load failed' });
    expect(rig.client.channel).not.toHaveBeenCalled();
  });

  it('join 중에 예외가 나도 만든 채널을 제거하고 소켓을 끊는다', async () => {
    const rig = netRig();
    rig.channel.subscribe.mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await createTraySmokeApi(rig.deps).net();

    expect(result).toMatchObject({ realtimeConnected: false, joinStatus: null, error: 'realtime: boom' });
    expect(rig.client.removeChannel.mock.calls[0]?.[0]).toBe(rig.channel);
    expect(rig.client.realtime.disconnect).toHaveBeenCalledTimes(1);
  });

  it('채널 제거가 실패해도 소켓은 끊고, 오류를 단계 이름과 함께 담는다', async () => {
    const rig = netRig();
    rig.client.removeChannel.mockRejectedValueOnce(new Error('timed out'));

    const result = await createTraySmokeApi(rig.deps).net();

    expect(result).toMatchObject({ realtimeConnected: true, joinStatus: 'SUBSCRIBED', error: 'removeChannel: timed out' });
    expect(rig.client.realtime.disconnect).toHaveBeenCalledTimes(1);
  });

  it('removeChannel · disconnect 는 끝까지 기다린다 — 끝나기 전에 결과를 돌려주지 않는다', async () => {
    const rig = netRig();
    rig.client.removeChannel.mockImplementation(async () => {
      rig.log.push('removeChannel');
      await sleep(5);
      rig.log.push('removeChannel 끝');
      return 'ok';
    });
    rig.client.realtime.disconnect.mockImplementation(async () => {
      rig.log.push('disconnect');
      await sleep(5);
      rig.log.push('disconnect 끝');
      return 'ok';
    });

    await createTraySmokeApi(rig.deps).net();

    expect(rig.log.slice(-4)).toStrictEqual(['removeChannel', 'removeChannel 끝', 'disconnect', 'disconnect 끝']);
  });
});

describe('connectProbe()', () => {
  /** 소켓은 behavior 에 따라 곧 error 를 내거나('error') 조용하거나('silent') 만들 때 던진다('throws'). */
  function probeRig(supabaseUrl: string | undefined, behavior: 'error' | 'silent' | 'throws' = 'error') {
    const log: string[] = [];
    const closed = vi.fn();
    const fetch = vi.fn(async (url: string, _init?: unknown): Promise<{ status: number }> => {
      log.push(`fetch ${url}`);
      throw new TypeError('Failed to fetch');
    });
    const openSocket = vi.fn((url: string) => {
      log.push(`socket ${url}`);
      if (behavior === 'throws') throw new Error('SecurityError');
      return {
        addEventListener: (type: string, listener: () => void) => {
          if (type === 'error' && behavior === 'error') queueMicrotask(listener);
        },
        close: closed,
      };
    });
    return { log, closed, fetch, openSocket, deps: deps({ supabaseUrl, fetch, openSocket }) };
  }

  it.each([
    ['값 없음', undefined],
    ['빈 문자열', ''],
    ['URL 이 아님', 'not a url'],
    ['실제 Supabase', 'https://abc.supabase.co'],
    ['로컬 개발', 'http://localhost:54321'],
    ['루프백', 'http://127.0.0.1:54321'],
    ['invalid 가 이름 앞에 있음', 'https://invalid.example.com'],
    ['invalid 로 끝나지만 점이 없음', 'https://notinvalid'],
    ['invalid 가 중간에 있음', 'https://ci.invalid.example'],
  ])('.invalid 호스트가 아니면(%s) 아무것도 보내지 않는다', async (_name, supabaseUrl) => {
    // deps() 의 fetch · openSocket 은 던진다 — 한 번이라도 부르면 attempted 가 비지 않거나 오류가 난다.
    const result = await createTraySmokeApi(deps({ supabaseUrl })).connectProbe();

    expect(result).toStrictEqual({ attempted: [] });
  });

  it('.invalid 호스트면 https fetch 와 wss WebSocket 을 한 번씩 보내고, 시도한 URL 을 돌려준다 — 오류는 무시한다', async () => {
    const rig = probeRig('https://ci.invalid');

    const result = await createTraySmokeApi(rig.deps).connectProbe();

    expect(result).toStrictEqual({
      attempted: ['https://ci.invalid/tj-connect-probe', 'wss://ci.invalid/tj-connect-probe'],
    });
    expect(rig.log).toStrictEqual(['fetch https://ci.invalid/tj-connect-probe', 'socket wss://ci.invalid/tj-connect-probe']);
    expect(rig.closed).toHaveBeenCalledTimes(1);
  });

  it('포트가 있으면 두 URL 에 그대로 남고, 경로 · 쿼리는 버린다', async () => {
    const rig = probeRig('https://ci.invalid:8443/some/path?x=1');

    const result = await createTraySmokeApi(rig.deps).connectProbe();

    expect(result.attempted).toStrictEqual([
      'https://ci.invalid:8443/tj-connect-probe',
      'wss://ci.invalid:8443/tj-connect-probe',
    ]);
  });

  it('소켓을 만들다 던져도 무시한다 — 시도는 한 것으로 돌려준다', async () => {
    const rig = probeRig('https://ci.invalid', 'throws');

    const result = await createTraySmokeApi(rig.deps).connectProbe();

    expect(result.attempted).toHaveLength(2);
    expect(rig.closed).not.toHaveBeenCalled();
  });

  it('소켓이 조용하면 3초까지만 기다리고 닫는다', async () => {
    vi.useFakeTimers();
    const rig = probeRig('https://ci.invalid', 'silent');
    let result: Awaited<ReturnType<TraySmokeApi['connectProbe']>> | undefined;
    const pending = createTraySmokeApi(rig.deps)
      .connectProbe()
      .then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(2_999);
    expect(result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result?.attempted).toHaveLength(2);
    expect(rig.closed).toHaveBeenCalledTimes(1);
  });

  it('fetch 가 끝나지 않아도 3초까지만 기다리고 다음으로 간다', async () => {
    vi.useFakeTimers();
    const rig = probeRig('https://ci.invalid');
    rig.fetch.mockImplementation(() => new Promise(() => {}));
    let result: Awaited<ReturnType<TraySmokeApi['connectProbe']>> | undefined;
    const pending = createTraySmokeApi(rig.deps)
      .connectProbe()
      .then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(2_999);
    expect(rig.openSocket).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(rig.openSocket).toHaveBeenCalledTimes(1);
    expect(result?.attempted).toHaveLength(2);
  });
});
