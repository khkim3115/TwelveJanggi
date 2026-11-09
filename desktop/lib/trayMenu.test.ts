// desktop/lib/trayMenu.cjs 시험 — 템플릿 순서 · 라벨 · 체크박스 click 이 item.checked 를 쓰는지(설계 §5.1 trayMenu.cjs).
// electron 없이 템플릿(객체 배열)만 본다.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { TRAY_LABELS, titleLabel, buildTrayMenuTemplate } = require('./trayMenu.cjs') as typeof import('./trayMenu.cjs');

type Item = { type?: string; label?: string; enabled?: boolean; checked?: boolean; click?: (item: { checked: boolean }) => void };

const makeActions = () => ({
  open: vi.fn(),
  solo: vi.fn(),
  online: vi.fn(),
  setAutostart: vi.fn(),
  setLight: vi.fn(),
  setPinned: vi.fn(),
  resetPosition: vi.fn(),
  openWeb: vi.fn(),
  sendFeedback: vi.fn(),
  quit: vi.fn(),
});

const makeState = (over: Record<string, unknown> = {}) => ({
  platform: 'win32',
  version: '0.1.0',
  autostart: { checked: false, enabled: true },
  light: false,
  pinned: false,
  hasCustomPosition: false,
  ...over,
});

const build = (state = makeState(), actions = makeActions()) => buildTrayMenuTemplate(state, actions) as unknown as Item[];
const names = (t: Item[]) => t.map((i) => (i.type === 'separator' ? '─' : i.label));
const find = (t: Item[], label: string) => {
  const item = t.find((i) => i.label === label);
  if (!item) throw new Error(`항목 없음: ${label}`);
  return item;
};

describe('라벨', () => {
  it('TRAY_LABELS 는 얼려 있고 값이 정확하다', () => {
    expect(Object.isFrozen(TRAY_LABELS)).toBe(true);
    expect(TRAY_LABELS).toEqual({
      open: '열기',
      solo: '혼자 하기',
      online: '온라인 대전',
      autostart: '자동 실행',
      light: '라이트 모드',
      pin: '창 고정',
      reset: '위치 초기화',
      web: '웹에서 열기',
      feedback: '의견 보내기',
      quit: '종료',
    });
  });
  it('titleLabel', () => {
    expect(titleLabel('0.1.0')).toBe('십이장기 0.1.0');
  });
});

describe('순서', () => {
  const COMMON = ['혼자 하기', '온라인 대전', '─', '자동 실행', '라이트 모드', '창 고정', '위치 초기화', '─', '웹에서 열기', '의견 보내기', '─', '종료'];
  it('win32', () => {
    expect(names(build())).toEqual(['십이장기 0.1.0', '─', ...COMMON]);
    expect(names(build()).length).toBe(14);
  });
  it.each(['darwin', 'linux', 'freebsd'])('%s 는 버전 줄 다음에 열기', (platform) => {
    const t = names(build(makeState({ platform })));
    expect(t).toEqual(['십이장기 0.1.0', '열기', '─', ...COMMON]);
    expect(t.length).toBe(15);
  });
});

describe('속성', () => {
  it('버전 줄은 enabled false', () => {
    expect(build()[0]).toMatchObject({ label: '십이장기 0.1.0', enabled: false });
  });
  it('체크박스 종류 · checked · enabled 가 state 를 따른다', () => {
    const t = build(makeState({ autostart: { checked: true, enabled: false }, light: true, pinned: true, hasCustomPosition: true }));
    expect(find(t, '자동 실행')).toMatchObject({ type: 'checkbox', checked: true, enabled: false });
    expect(find(t, '라이트 모드')).toMatchObject({ type: 'checkbox', checked: true });
    expect(find(t, '창 고정')).toMatchObject({ type: 'checkbox', checked: true });
    expect(find(t, '위치 초기화').enabled).toBe(true);
    const off = build();
    expect(find(off, '자동 실행')).toMatchObject({ checked: false, enabled: true });
    expect(find(off, '라이트 모드').checked).toBe(false);
    expect(find(off, '창 고정').checked).toBe(false);
    expect(find(off, '위치 초기화').enabled).toBe(false);
  });
});

describe('체크박스 click 은 item.checked 를 원하는 값으로 넘긴다', () => {
  const boxes = [
    ['자동 실행', 'setAutostart', (on: boolean) => ({ autostart: { checked: on, enabled: true } })],
    ['라이트 모드', 'setLight', (on: boolean) => ({ light: on })],
    ['창 고정', 'setPinned', (on: boolean) => ({ pinned: on })],
  ] as const;
  for (const [label, action, stateOf] of boxes) {
    describe(label, () => {
      // 만든 때 상태 × click 때 item.checked 의 네 조합 — 만든 때 상태를 넘기는 처리기도, 상태를 뒤집는 처리기도 떨어진다.
      it.each([
        [true, true],
        [false, false],
        [true, false],
        [false, true],
      ])('만든 때 %s · click 때 checked %s', (built, clicked) => {
        const actions = makeActions();
        const item = find(build(makeState(stateOf(built)), actions), label);
        item.click?.({ checked: clicked });
        expect(actions[action]).toHaveBeenCalledTimes(1);
        expect(actions[action]).toHaveBeenCalledWith(clicked);
      });
    });
  }
});

describe('나머지 항목은 맞는 action 을 한 번 부른다', () => {
  const rows = [
    ['열기', 'open', 'darwin'],
    ['혼자 하기', 'solo', 'win32'],
    ['온라인 대전', 'online', 'win32'],
    ['위치 초기화', 'resetPosition', 'win32'],
    ['웹에서 열기', 'openWeb', 'win32'],
    ['의견 보내기', 'sendFeedback', 'win32'],
    ['종료', 'quit', 'win32'],
  ] as const;
  it.each(rows)('%s → %s', (label, action, platform) => {
    const actions = makeActions();
    find(build(makeState({ platform, hasCustomPosition: true }), actions), label).click?.({ checked: false });
    expect(actions[action]).toHaveBeenCalledTimes(1);
    for (const other of Object.keys(actions) as Array<keyof typeof actions>) {
      if (other !== action) expect(actions[other]).not.toHaveBeenCalled();
    }
  });
});
