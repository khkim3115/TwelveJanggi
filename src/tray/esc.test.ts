// Esc 로 창 숨기기의 계약(설계 §5.4) — 판정은 순수 함수 escAction 이고, 대화상자 여부는 그 이벤트가 시작될 때(캡처 단계)의 값이다.
// 같은 Esc 로 닫힌 대화상자 때문에 창까지 숨지 않고, 리스너 등록 순서와 상관없고, 슬라이더에 포커스가 있어도(대상과 상관없이) 숨긴다.
// 가짜 이벤트 · 가짜 window 만 쓴다(node 환경).
import { describe, expect, it, vi } from 'vitest';
import { createEscHandlers, escAction, installEscHandlers, type EscInput } from './esc';

/** 숨겨야 하는 Esc 하나 — 사례마다 한 필드씩 바꾼다. */
const ESC: EscInput = {
  key: 'Escape',
  isComposing: false,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  defaultPrevented: false,
};

/** 가짜 keydown — preventDefault 는 진짜처럼 defaultPrevented 를 세운다. target 은 처리기가 보지 않아야 하는 값이다. */
function keyEvent(over: Partial<EscInput> = {}, target: unknown = null) {
  const event = {
    type: 'keydown',
    target,
    ...ESC,
    ...over,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
  };
  return event;
}

const asKeyboardEvent = (event: ReturnType<typeof keyEvent>) => event as unknown as KeyboardEvent;

type Listener = (event: KeyboardEvent) => void;

/** 가짜 window — 리스너를 캡처 · 버블로 나눠 두고, dispatch 는 캡처 리스너를 모두 부른 뒤 버블 리스너를 부른다(등록 순서대로). */
function fakeWindow() {
  const listeners: { type: string; listener: Listener; capture: boolean }[] = [];
  return {
    listeners,
    addEventListener(type: string, listener: Listener, capture?: boolean) {
      listeners.push({ type, listener, capture: capture === true });
    },
    removeEventListener(type: string, listener: Listener, capture?: boolean) {
      const at = listeners.findIndex((entry) => entry.type === type && entry.listener === listener && entry.capture === (capture === true));
      if (at !== -1) listeners.splice(at, 1);
    },
    dispatch(event: ReturnType<typeof keyEvent>) {
      const matching = listeners.filter((entry) => entry.type === event.type);
      for (const entry of [...matching.filter((e) => e.capture), ...matching.filter((e) => !e.capture)]) entry.listener(asKeyboardEvent(event));
    },
  };
}

describe('escAction', () => {
  it('Escape · 조합 아님 · 반복 아님 · 조합키 없음 · 처리 전 · 시작 때 대화상자 없음 → hide', () => {
    expect(escAction(ESC, false)).toBe('hide');
  });

  it.each([
    ['IME 조합 중', { isComposing: true }],
    ['키 반복', { repeat: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Alt', { altKey: true }],
    ['Meta', { metaKey: true }],
    ['이미 처리함(defaultPrevented)', { defaultPrevented: true }],
    ["옛 이름 'Esc'", { key: 'Esc' }],
    ['다른 키', { key: 'Enter' }],
  ] as const)('%s → none', (_name, over) => {
    expect(escAction({ ...ESC, ...over }, false)).toBe('none');
  });

  it('시작 때 대화상자가 있었으면 → none', () => {
    expect(escAction(ESC, true)).toBe('none');
  });
});

describe('createEscHandlers — 캡처 단계에서 대화상자 여부를 찍고 버블 단계에서 정한다', () => {
  it('캡처 때 대화상자가 있었으면 그 사이 닫혀도(같은 Esc 로 닫힘) 버블에서 숨기지 않는다', () => {
    let dialog = true;
    const hide = vi.fn();
    const esc = createEscHandlers({ isDialogOpen: () => dialog, hide });
    const event = keyEvent();

    esc.onCapture(asKeyboardEvent(event));
    dialog = false; // 대화상자의 Esc 처리기가 캡처와 버블 사이에 닫았다
    esc.onBubble(asKeyboardEvent(event));

    expect(hide).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('캡처 때 대화상자가 없으면 버블에서 preventDefault 하고 한 번 숨긴다', () => {
    const hide = vi.fn();
    const esc = createEscHandlers({ isDialogOpen: () => false, hide });
    const event = keyEvent();

    esc.onCapture(asKeyboardEvent(event));
    esc.onBubble(asKeyboardEvent(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('대상이 투명도 슬라이더(range 입력)여도 숨긴다 — 대상은 보지 않는다', () => {
    const hide = vi.fn();
    const esc = createEscHandlers({ isDialogOpen: () => false, hide });
    const event = keyEvent({}, { tagName: 'INPUT', type: 'range' });

    esc.onCapture(asKeyboardEvent(event));
    esc.onBubble(asKeyboardEvent(event));

    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('캡처와 버블 사이에 다른 처리기가 preventDefault 했으면 숨기지 않는다', () => {
    const hide = vi.fn();
    const esc = createEscHandlers({ isDialogOpen: () => false, hide });
    const event = keyEvent();

    esc.onCapture(asKeyboardEvent(event));
    event.preventDefault(); // 안쪽 처리기가 이 Esc 를 썼다
    esc.onBubble(asKeyboardEvent(event));

    expect(hide).not.toHaveBeenCalled();
  });

  it('이벤트마다 따로 찍는다 — 대화상자를 닫은 Esc 의 기록이 다음 Esc 에 남지 않는다', () => {
    let dialog = true;
    const hide = vi.fn();
    const esc = createEscHandlers({ isDialogOpen: () => dialog, hide });
    const first = keyEvent();
    const second = keyEvent();

    esc.onCapture(asKeyboardEvent(first));
    dialog = false;
    esc.onBubble(asKeyboardEvent(first));
    esc.onCapture(asKeyboardEvent(second));
    esc.onBubble(asKeyboardEvent(second));

    expect(hide).toHaveBeenCalledTimes(1);
    expect(first.preventDefault).not.toHaveBeenCalled();
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('installEscHandlers', () => {
  it('window 에 keydown 을 캡처 하나 · 버블 하나로 걸고, 돌려준 함수가 둘 다 뗀다', () => {
    const win = fakeWindow();
    const hide = vi.fn();

    const uninstall = installEscHandlers(win as unknown as Window, { isDialogOpen: () => false, hide });

    expect(win.listeners.map(({ type, capture }) => [type, capture])).toEqual([
      ['keydown', true],
      ['keydown', false],
    ]);
    win.dispatch(keyEvent());
    expect(hide).toHaveBeenCalledTimes(1);

    uninstall();
    expect(win.listeners).toEqual([]);
    win.dispatch(keyEvent());
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['먼저', 'before'],
    ['나중에', 'after'],
  ] as const)('대화상자를 닫는 window 리스너가 우리 것보다 %s 걸려도 그 Esc 로는 숨지 않고, 다음 Esc 로 숨는다', (_name, order) => {
    const win = fakeWindow();
    let dialog = true;
    const hide = vi.fn();
    // useDialog 처럼 window 버블 단계에서 Esc 로 대화상자를 닫는다(동기로 — React 커밋 대신)
    const closeDialog: Listener = (event) => {
      if (event.key === 'Escape') dialog = false;
    };
    if (order === 'before') win.addEventListener('keydown', closeDialog);
    installEscHandlers(win as unknown as Window, { isDialogOpen: () => dialog, hide });
    if (order === 'after') win.addEventListener('keydown', closeDialog);

    win.dispatch(keyEvent());
    expect(dialog).toBe(false); // 양성 기록 — 닫는 리스너가 돌았다
    expect(hide).not.toHaveBeenCalled();

    win.dispatch(keyEvent()); // 이제 대화상자가 없다
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('결정은 버블 단계에서 한다 — install 보다 먼저 건 window 버블 리스너가 preventDefault 한 Esc 로는 숨지 않는다', () => {
    const win = fakeWindow();
    const hide = vi.fn();
    let preventing = true;
    // 안쪽 처리기가 이 Esc 를 쓴 것과 같다 — 기록 처리기(캡처)보다 늦고 결정 처리기(버블)보다 먼저 돈다
    win.addEventListener('keydown', (event) => {
      if (preventing && event.key === 'Escape') event.preventDefault();
    });
    installEscHandlers(win as unknown as Window, { isDialogOpen: () => false, hide });

    const prevented = keyEvent();
    win.dispatch(prevented);
    expect(prevented.defaultPrevented).toBe(true); // 양성 기록 — 앞선 리스너가 돌았다
    expect(prevented.preventDefault).toHaveBeenCalledTimes(1); // 우리 처리기는 숨기지도, 다시 막지도 않았다
    expect(hide).not.toHaveBeenCalled();

    preventing = false; // 같은 배선에서 막지 않은 Esc 는 숨긴다 — 처리기가 걸려 있다(헛통과가 아니다)
    win.dispatch(keyEvent());
    expect(hide).toHaveBeenCalledTimes(1);
  });
});
