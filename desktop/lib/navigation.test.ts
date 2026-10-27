// desktop/lib/navigation.cjs 시험 — 탐색 · 새 창 · webview 가드(설계 §5.7 체크리스트 13 · 14 · 15).
// 모든 결정은 한 규칙이다: app://twelvejanggi 밖은 막고, 허용 목록(links.cjs) 주소만 시스템 브라우저로 연다. open 은 주입받는다.
// fail-closed 순서: 막는 결정(preventDefault · deny)을 먼저 내고 그 뒤에 record · open 을 부른다 — 콜백이 던져도 차단은 이미 걸려 있다.
// 가짜 객체만 쓴다(electron 은 import 하지 않는다).
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createNavigationGuards } = require('./navigation.cjs') as typeof import('./navigation.cjs');
type NavigationRecord = import('./navigation.cjs').NavigationRecord;

const HUB = 'https://khkim3115.github.io/';
const REPO = 'https://github.com/khkim3115/TwelveJanggi';
const OUTSIDE = 'https://example.invalid/';

/** 앱 밖이고 허용 목록에도 없는 주소 — 막고 열지 않는다. 앞의 네 개는 앱 출처 · 허용 목록과 글자가 닮은 것이다. */
const BLOCKED = [
  'app://twelvejanggi.evil/',
  'app://twelvejanggiX/tray.html',
  'http://khkim3115.github.io/',
  `${REPO}X`,
  OUTSIDE,
  'app://other/',
  'APP://twelvejanggi/',
  'javascript:alert(1)',
  'file:///C:/Windows/System32/calc.exe',
  'data:text/html,x',
  'about:blank',
  '',
];
/** 앱 안 주소 — 탐색은 막지 않는다. */
const IN_APP = ['app://twelvejanggi', 'app://twelvejanggi/', 'app://twelvejanggi/tray.html', 'app://twelvejanggi/tray.html?smoke', 'app://twelvejanggi/#top'];

type NavMethod = 'willNavigate' | 'willFrameNavigate' | 'willRedirect';
/** 같은 규칙을 쓰는 세 탐색 처리기 — [record 의 kind, 가드의 메서드]. */
const NAV_HANDLERS: Array<[NavigationRecord['kind'], NavMethod]> = [
  ['will-navigate', 'willNavigate'],
  ['will-frame-navigate', 'willFrameNavigate'],
  ['will-redirect', 'willRedirect'],
];

interface Hooks {
  record?: (entry: NavigationRecord) => void;
  open?: (href: string) => void;
}

/** 가드 한 벌 — record · open 이 불린 순서를 한 줄로 남기고(calls) 인자도 따로 본다. hooks 로 던지게 만들 수 있다. */
function setup(hooks: Hooks = {}) {
  const calls: string[] = [];
  const open = vi.fn((href: string) => {
    calls.push(`open ${href}`);
    hooks.open?.(href);
  });
  const record = vi.fn((entry: NavigationRecord) => {
    calls.push(`record ${entry.kind} blocked=${entry.blocked}`);
    hooks.record?.(entry);
  });
  return { calls, open, record, guards: createNavigationGuards({ open, record }) };
}

/** 탐색 처리기가 받는 Event 흉내 — url 과 preventDefault(호출 순서 기록 calls 에 끼운다). */
function navEvent(url: string, calls: string[] = []) {
  return {
    url,
    preventDefault: vi.fn(() => {
      calls.push('preventDefault');
    }),
  };
}

/** setImmediate 로 미룬 일이 돌 때까지 기다린다(미룬 쪽이 먼저 줄을 섰으므로 먼저 돈다). */
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe.each(NAV_HANDLERS)('%s', (kind, method) => {
  it('허용 목록 주소 — 앱 안 탐색을 막고, 정규화한 href 로 시스템 브라우저를 한 번 연다', () => {
    const { calls, open, record, guards } = setup();
    const e = navEvent('https://khkim3115.github.io', calls); // 끝 '/' 없는 입력 — 여는 값은 파서가 만든 href 다
    guards[method](e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(HUB);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ kind, url: 'https://khkim3115.github.io', blocked: true, href: HUB });
    // 결정(막기)이 기록 · 열기보다 먼저다.
    expect(calls).toStrictEqual(['preventDefault', `record ${kind} blocked=true`, `open ${HUB}`]);
  });

  it(`저장소 주소(${REPO}/issues/1)도 허용 목록이다`, () => {
    const { open, guards } = setup();
    const e = navEvent(`${REPO}/issues/1`);
    guards[method](e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(`${REPO}/issues/1`);
  });

  it.each(BLOCKED)('허용 목록 밖(%j) — 막고 열지 않는다', (url) => {
    const { open, record, guards } = setup();
    const e = navEvent(url);
    guards[method](e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ kind, url, blocked: true, href: null });
  });

  it.each(IN_APP)('앱 안(%s) — 막지 않고 열지 않는다(기록은 한다)', (url) => {
    const { open, record, guards } = setup();
    const e = navEvent(url);
    guards[method](e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ kind, url, blocked: false, href: null });
  });

  it('url 이 문자열이 아니면 막는다(기록의 url 은 빈 글)', () => {
    const { open, record, guards } = setup();
    for (const url of [undefined, null, 1, {}]) {
      const e = navEvent('x');
      (e as { url: unknown }).url = url;
      guards[method](e);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenLastCalledWith({ kind, url: '', blocked: true, href: null });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('record 는 선택이다 — 없어도 결정은 같다', () => {
    const open = vi.fn();
    const guards = createNavigationGuards({ open });
    const allowed = navEvent(HUB);
    const blocked = navEvent(OUTSIDE);
    const inApp = navEvent('app://twelvejanggi/tray.html');
    guards[method](allowed);
    guards[method](blocked);
    guards[method](inApp);
    expect([allowed, blocked, inApp].map((e) => e.preventDefault.mock.calls.length)).toStrictEqual([1, 1, 0]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(HUB);
  });

  it('record 가 던져도 이미 막았고 열기도 한다 — 오류는 동기가 아니라 다음 tick 에 다시 던져진다', () => {
    vi.useFakeTimers({ toFake: ['setImmediate'] });
    const { calls, open, guards } = setup({
      record: () => {
        throw new Error('record boom');
      },
    });
    const e = navEvent(HUB, calls);
    expect(() => guards[method](e)).not.toThrow();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(() => vi.runAllTimers()).toThrow('record boom'); // 묻히지 않는다
  });

  it('open 이 던져도 이미 막았다 — 오류는 동기가 아니라 다음 tick 에 다시 던져진다', () => {
    vi.useFakeTimers({ toFake: ['setImmediate'] });
    const { calls, record, guards } = setup({
      open: () => {
        throw new Error('open boom');
      },
    });
    const e = navEvent(HUB, calls);
    expect(() => guards[method](e)).not.toThrow();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(() => vi.runAllTimers()).toThrow('open boom');
  });
});

describe('windowOpen', () => {
  it('늘 deny 한다 — 허용 목록 주소는 같은 tick 이 아니라 다음 tick 에 한 번 연다', async () => {
    const { calls, open, record, guards } = setup();
    expect(guards.windowOpen({ url: HUB })).toStrictEqual({ action: 'deny' });
    expect(open).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ kind: 'window-open', url: HUB, blocked: true, href: HUB });
    await nextTick();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(HUB);
    expect(calls).toStrictEqual(['record window-open blocked=true', `open ${HUB}`]);
  });

  it('여는 값은 정규화한 href 다', async () => {
    const { open, guards } = setup();
    guards.windowOpen({ url: `${REPO}/./issues/../issues/3` });
    await nextTick();
    expect(open).toHaveBeenCalledWith(`${REPO}/issues/3`);
  });

  // 허용 목록 밖과 앱 주소 모두 — 트레이는 자식 창을 만들지 않는다.
  it.each([...BLOCKED, ...IN_APP])('deny 하고 열지 않는다: %j', async (url) => {
    const { open, record, guards } = setup();
    expect(guards.windowOpen({ url })).toStrictEqual({ action: 'deny' });
    expect(record).toHaveBeenCalledWith({ kind: 'window-open', url, blocked: true, href: null });
    await nextTick();
    expect(open).not.toHaveBeenCalled();
  });

  it('이상한 details 에도 던지지 않고 deny 한다', async () => {
    const { open, guards } = setup();
    for (const details of [undefined, null, {}, { url: 1 }, { url: null }]) {
      expect(guards.windowOpen(details as unknown as { url: string })).toStrictEqual({ action: 'deny' });
    }
    await nextTick();
    expect(open).not.toHaveBeenCalled();
  });

  it('record 가 던져도 deny 를 돌려주고 허용 목록 주소는 연다 — 오류는 다음 tick 에 다시 던져진다', () => {
    vi.useFakeTimers({ toFake: ['setImmediate'] });
    const { open, guards } = setup({
      record: () => {
        throw new Error('record boom');
      },
    });
    expect(guards.windowOpen({ url: HUB })).toStrictEqual({ action: 'deny' });
    expect(() => vi.runAllTimers()).toThrow('record boom');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(HUB);
  });

  it('record 는 선택이다', async () => {
    const open = vi.fn();
    const guards = createNavigationGuards({ open });
    expect(guards.windowOpen({ url: HUB })).toStrictEqual({ action: 'deny' });
    expect(guards.windowOpen({ url: OUTSIDE })).toStrictEqual({ action: 'deny' });
    await nextTick();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(HUB);
  });
});

describe('willAttachWebview', () => {
  it('늘 막는다 — 허용 목록 주소여도 열지 않는다', async () => {
    const { calls, open, record, guards } = setup();
    const e = { preventDefault: vi.fn(() => calls.push('preventDefault')) };
    guards.willAttachWebview(e, { nodeIntegration: true }, { src: HUB });
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ kind: 'will-attach-webview', url: HUB, blocked: true, href: null });
    expect(calls).toStrictEqual(['preventDefault', 'record will-attach-webview blocked=true']);
    await nextTick();
    expect(open).not.toHaveBeenCalled();
  });

  it('params 가 없거나 src 가 문자열이 아니어도 막는다(url 은 빈 글)', () => {
    const { record, guards } = setup();
    for (const params of [undefined, {}, { src: 1 }, null]) {
      const e = { preventDefault: vi.fn() };
      guards.willAttachWebview(e, undefined, params as unknown as Record<string, string>);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
    }
    expect(record).toHaveBeenCalledTimes(4);
    for (const [entry] of record.mock.calls) expect(entry).toStrictEqual({ kind: 'will-attach-webview', url: '', blocked: true, href: null });
  });

  it('record 가 던져도 이미 막았다 — 오류는 다음 tick 에 다시 던져진다', () => {
    vi.useFakeTimers({ toFake: ['setImmediate'] });
    const { guards } = setup({
      record: () => {
        throw new Error('record boom');
      },
    });
    const e = { preventDefault: vi.fn() };
    expect(() => guards.willAttachWebview(e)).not.toThrow();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(() => vi.runAllTimers()).toThrow('record boom');
  });

  it('record 는 선택이다', () => {
    const guards = createNavigationGuards({ open: vi.fn() });
    const e = { preventDefault: vi.fn() };
    guards.willAttachWebview(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('createNavigationGuards', () => {
  it('처리기는 다섯 개뿐이다', () => {
    expect(Object.keys(setup().guards).sort()).toStrictEqual(['willAttachWebview', 'willFrameNavigate', 'willNavigate', 'willRedirect', 'windowOpen']);
  });

  it('record 는 결정마다 한 번씩, 처리기에 맞는 kind 로 불린다', async () => {
    const { record, guards } = setup();
    guards.willNavigate(navEvent(OUTSIDE));
    guards.willFrameNavigate(navEvent('app://twelvejanggi/tray.html'));
    guards.willRedirect(navEvent(HUB));
    guards.windowOpen({ url: OUTSIDE });
    guards.willAttachWebview({ preventDefault: vi.fn() }, {}, { src: HUB });
    await nextTick();
    expect(record.mock.calls.map(([entry]) => entry.kind)).toStrictEqual([
      'will-navigate',
      'will-frame-navigate',
      'will-redirect',
      'window-open',
      'will-attach-webview',
    ]);
  });

  it('Electron 은 처리기를 this 를 바꿔 부른다 — 떼어 써도 같다', () => {
    const { willNavigate, windowOpen, willAttachWebview } = setup().guards;
    const e = navEvent(OUTSIDE);
    willNavigate(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(windowOpen({ url: OUTSIDE })).toStrictEqual({ action: 'deny' });
    const w = { preventDefault: vi.fn() };
    willAttachWebview(w);
    expect(w.preventDefault).toHaveBeenCalledTimes(1);
  });
});
