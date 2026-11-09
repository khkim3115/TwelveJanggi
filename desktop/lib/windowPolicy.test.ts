// desktop/lib/windowPolicy.cjs 시험 — 팝업이 blur 로 숨는 때와 트레이 클릭의 경합 가드(설계 §5.1).
// 시각(now · shownAt · lastBlurHideAt)은 전부 인자다 — 시계 · 타이머 · electron 이 없고 플랫폼에도 기대지 않는다(필수 check 는 ubuntu).
// 경계 사례는 상수의 한 칸 아래 · 위(299/300/301 · 249/250/251)를 모두 본다.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { BLUR_GRACE_MS, CLICK_RACE_MS, deferredBlurAction, shouldHideOnBlur, trayClickAction, trayDoubleClickAction } =
  require('./windowPolicy.cjs') as typeof import('./windowPolicy.cjs');

it('상수 — blur 유예 300ms · 트레이 클릭 경합 가드 250ms', () => {
  expect(BLUR_GRACE_MS).toBe(300);
  expect(CLICK_RACE_MS).toBe(250);
});

describe('shouldHideOnBlur', () => {
  /** 숨겨야 하는 상태(보임 · 고정 아님 · DevTools 닫힘). 사례마다 손잡이 하나만 바꾼다. shownAt 이 0 이라 now 가 곧 '보인 지 지난 ms' 다. */
  const base = { now: 0, shownAt: 0, pinned: false, devToolsOpen: false, visible: true };

  it.each<[number, boolean]>([
    [0, false],
    [100, false],
    [299, false],
    [300, false], // 경계 — 300ms 까지는 유예 안이다(now - shownAt ≤ 300)
    [300.5, true], // performance.now() 는 소수 ms 를 준다
    [301, true],
    [302, true],
    [60_000, true], // 양성 대조 — 아래 '숨기지 않는다' 사례는 이 시각에서 손잡이 하나만 바꾼 것이다
  ])('보인 지 %d ms 뒤의 blur → 숨김 %s', (now, hide) => {
    expect(shouldHideOnBlur({ ...base, now })).toBe(hide);
  });

  it('shownAt 이 0 이 아니어도 차이로 센다', () => {
    expect(shouldHideOnBlur({ ...base, shownAt: 5_000, now: 5_300 })).toBe(false);
    expect(shouldHideOnBlur({ ...base, shownAt: 5_000, now: 5_301 })).toBe(true);
  });

  it.each<[string, Partial<typeof base>]>([
    ['고정했다', { pinned: true }],
    ['DevTools 가 열려 있다', { devToolsOpen: true }],
    ['이미 안 보인다(숨김이 일으킨 blur)', { visible: false }],
    ['셋 다', { pinned: true, devToolsOpen: true, visible: false }],
  ])('유예가 한참 지나도 숨기지 않는다: %s', (_name, patch) => {
    expect(shouldHideOnBlur({ ...base, now: 60_000, ...patch })).toBe(false);
  });
});

describe('deferredBlurAction', () => {
  // 유예 안의 blur 를 삼킨 뒤에만 쓴다 — 삼킨 blur 뒤에는 blur 가 다시 오지 않아서, 그대로 두면 바깥 클릭으로 숨지 않는 팝업이 남는다.
  const base = { visible: true, focused: false, pinned: false, devToolsOpen: false };

  it("보이고 · 포커스가 없고 · 고정이 아니고 · DevTools 가 닫혀 있으면 'hide'", () => {
    expect(deferredBlurAction(base)).toBe('hide');
  });

  it.each<[string, Partial<typeof base>]>([
    ['포커스가 돌아왔다', { focused: true }],
    ['고정했다', { pinned: true }],
    ['DevTools 가 열렸다', { devToolsOpen: true }],
    ['그 사이 숨었다', { visible: false }],
    ['넷 다', { focused: true, pinned: true, devToolsOpen: true, visible: false }],
  ])("%s → 'none'", (_name, patch) => {
    expect(deferredBlurAction({ ...base, ...patch })).toBe('none');
  });
});

describe('trayClickAction', () => {
  const NOW = 10_000;

  it.each<[string, number]>([
    ['바로 직전(0ms)', NOW],
    ['249ms 전', NOW - 249],
    ['250ms 전', NOW - 250],
    ['한참 전', NOW - 100_000],
    ['기록 없음(−Infinity)', -Infinity],
  ])("보이면 숨김 기록과 상관없이 'hide' — %s", (_name, lastBlurHideAt) => {
    expect(trayClickAction({ now: NOW, visible: true, lastBlurHideAt })).toBe('hide');
  });

  it.each<[number, 'ignore' | 'show']>([
    [0, 'ignore'],
    [1, 'ignore'],
    [249, 'ignore'],
    [249.9, 'ignore'],
    [250, 'show'], // 경계 — 250ms 부터 새 클릭이다(now - lastBlurHideAt < 250 만 무시)
    [250.1, 'show'],
    [251, 'show'],
    [1_000, 'show'],
  ])("숨어 있을 때 blur 숨김 %d ms 뒤의 클릭 → '%s'", (elapsed, action) => {
    expect(trayClickAction({ now: NOW, visible: false, lastBlurHideAt: NOW - elapsed })).toBe(action);
  });

  it("바깥 클릭(blur)으로 숨긴 적이 없으면(초기값 −Infinity) 'show'", () => {
    expect(trayClickAction({ now: NOW, visible: false, lastBlurHideAt: -Infinity })).toBe('show');
    expect(trayClickAction({ now: 0, visible: false, lastBlurHideAt: -Infinity })).toBe('show'); // 앱을 켠 직후의 첫 클릭
  });
});

describe('trayDoubleClickAction', () => {
  // 손 확인의 Windows 사건 순서: 숨긴 팝업은 click(보임) → 둘째 누름의 blur → double-click, 열린 팝업은 click(토글로 숨김, 또는 blur 가 먼저 숨겨
  // 무시) → double-click 이다. 둘째 누름에는 click 이 오지 않는다. 판단은 직전 좌클릭의 결과 하나뿐이다 — 시각을 받지 않는다.
  it("직전 좌클릭이 창을 보였으면('show') 'show' — 둘째 누름의 blur 가 창을 숨기지 않게 다시 보인다", () => {
    expect(trayDoubleClickAction({ lastClickAction: 'show' })).toBe('show');
  });

  it.each<['hide' | 'ignore' | null, string]>([
    ['hide', '열린 팝업을 토글로 닫았다 — 닫힌 채 둔다'],
    ['ignore', '열린 팝업을 누른 blur 가 먼저 숨겼고 click 은 경합 가드가 삼켰다 — 닫힌 채 둔다'],
    [null, '직전 좌클릭이 없다(이미 썼거나 창이 없었다)'],
  ])("직전 좌클릭 %s → 'none': %s", (lastClickAction) => {
    expect(trayDoubleClickAction({ lastClickAction })).toBe('none');
  });
});

describe('열린 팝업의 트레이 아이콘을 누를 때 — blur 와 click 의 두 순서', () => {
  // main 이 하는 기록(보임 · lastBlurHideAt)을 흉내 낸다. 어느 순서로 와도 팝업은 닫히고 다시 열리지 않아야 한다(Review Focus 1).
  // 실제 Windows 순서는 손 확인이다(설계 §8).
  const state = { shownAt: 1_000, pinned: false, devToolsOpen: false };

  it('blur 가 먼저: blur 숨김을 기록하면 바로 오는 click 은 무시한다 — 다시 열리지 않는다', () => {
    let visible = true;
    let lastBlurHideAt = -Infinity;
    if (shouldHideOnBlur({ ...state, now: 5_000, visible })) {
      visible = false;
      lastBlurHideAt = 5_000;
    }
    expect(visible).toBe(false);
    expect(trayClickAction({ now: 5_004, visible, lastBlurHideAt })).toBe('ignore');
    expect(trayClickAction({ now: 5_000 + CLICK_RACE_MS, visible, lastBlurHideAt })).toBe('show'); // 가드는 250ms 뿐이다
  });

  it("click 이 먼저: 보이는 동안의 click 은 닫고('hide'), 그 뒤에 오는 blur 는 안 보이니 숨길 것이 없다 — 기록도 없다", () => {
    let visible = true;
    const lastBlurHideAt = -Infinity;
    expect(trayClickAction({ now: 5_000, visible, lastBlurHideAt })).toBe('hide');
    visible = false; // hideWindow('toggle') — blur 숨김이 아니니 lastBlurHideAt 은 그대로다
    expect(shouldHideOnBlur({ ...state, now: 5_002, visible })).toBe(false);
    expect(trayClickAction({ now: 5_010, visible, lastBlurHideAt })).toBe('show'); // 곧바로 다시 누르면 열린다
  });
});
