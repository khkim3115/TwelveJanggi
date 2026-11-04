// 트레이 화면의 상태(설계 §5.4) — 테마 · 투명도 · 모드 · 숨김을 담는 작은 외부 스토어(useSyncExternalStore).
// - 값은 main 이 민 것(tj-theme · tj-opacity · tj-mode · tj-shown · tj-hidden)과 스냅샷(getState)으로만 바뀐다. 받은 값은 고치지 않는다
//   — 정규화는 main 한 곳이다(설계 §5.3).
// - 브리지 구독은 main.tsx 가 모듈 최상위에서 한 번만 건다(connectBridge). 처음 상태는 구독을 모두 건 뒤에 묻는다(requestSnapshot):
//   구독보다 먼저 온 send 는 사라지고, 물은 뒤에 일어난 변경은 응답보다 먼저 와서 응답이 최종값이 된다.
// - ☀️ · 슬라이더의 처리 함수(requestThemeToggle · requestOpacity)도 여기 있다 — main 에 청하기만 하고 미리 바꾸지 않는다(토글 흐름은
//   하나). 브리지가 없으면(브라우저 개발 /tray.html) 아무것도 하지 않는다.
// - 받은 테마는 <html data-theme> 과 저장값(tj_theme)에 반영한다(src/lib/theme.ts). 숨김은 <html> 의 tapp-hidden 이다 — 대화상자가
//   #root 밖에 그려져도 덮는다(tray.css 가 그동안 애니메이션을 멈춘다). visibilitychange 는 쓰지 않는다(스로틀을 끄면 숨겨도 visible 이다).
// 불러오기만으로는 document · localStorage 에 쓰지 않는다 — 처음 테마로 저장값을 읽기만 한다(main.tsx 가 첫 페인트에 같은 값을 적용한다).

import { useSyncExternalStore } from 'react';
import { applyTheme, readStoredTheme, storeTheme, type Theme } from '../lib/theme';
import type { TjDesktop, TrayMode, TrayState } from './desktop';

/** 화면이 그리는 상태. hidden 은 창이 숨었는가(tj-hidden · 스냅샷의 visible false). */
export interface TrayView {
  theme: Theme;
  opacity: number;
  mode: TrayMode;
  hidden: boolean;
}

/** 숨긴 동안 <html> 에 다는 클래스. */
const HIDDEN_CLASS = 'tapp-hidden';

// 처음 값 — 테마는 지난 저장값(첫 페인트와 같다), 나머지는 main 의 기본값(투명도 100 · 콜드 스타트 solo · 보임). 스냅샷이 곧 덮는다.
let view: TrayView = { theme: readStoredTheme(), opacity: 100, mode: 'solo', hidden: false };
/** connectBridge 가 받은 브리지 — ☀️ · 슬라이더가 이것으로 청한다. */
let connected: TjDesktop | undefined;
const listeners = new Set<() => void>();

/** patch 를 합친다. 바뀐 값이 없으면 그대로 둔다 — 같은 객체라 구독자에게 알리지 않는다(useSyncExternalStore 가 다시 그리지 않는다). */
function update(patch: Partial<TrayView>): void {
  const keys = Object.keys(patch) as (keyof TrayView)[];
  if (keys.every((key) => patch[key] === view[key])) return;
  view = { ...view, ...patch };
  for (const listener of [...listeners]) listener();
}

/** 받은 테마를 페이지에 반영한다 — <html data-theme> · meta theme-color · 저장값. */
function paintTheme(theme: Theme): void {
  applyTheme(theme);
  storeTheme(theme);
}

/** 숨김 클래스를 <html> 에 달거나 뗀다. */
function paintHidden(hidden: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(HIDDEN_CLASS, hidden);
}

export function getTrayView(): TrayView {
  return view;
}

export function subscribeTrayView(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 지금 화면 상태(바뀔 때 다시 그린다). */
export function useTrayView(): TrayView {
  return useSyncExternalStore(subscribeTrayView, getTrayView);
}

/** 브리지에 붙는다 — 구독 다섯(테마 · 투명도 · 모드 · 보임 · 숨김)만 건다. 묻기는 requestSnapshot 이 따로 한다. 브리지가 없으면 아무것도 하지 않는다. */
export function connectBridge(bridge: TjDesktop | undefined): void {
  connected = bridge;
  if (bridge === undefined) return;
  bridge.onTheme((theme) => {
    paintTheme(theme);
    update({ theme });
  });
  bridge.onOpacity((percent) => update({ opacity: percent }));
  bridge.onMode((mode) => update({ mode }));
  // tj-shown · tj-hidden 은 값 없이 온다.
  bridge.onShown(() => {
    paintHidden(false);
    update({ hidden: false });
  });
  bridge.onHidden(() => {
    paintHidden(true);
    update({ hidden: true });
  });
}

/** 처음 상태를 묻는다 — connectBridge 뒤에 부른다. 실패하면 경고 한 줄만 남긴다(화면은 지금 값 그대로). */
export function requestSnapshot(bridge: TjDesktop | undefined): void {
  bridge?.getState().then(applySnapshot, (err: unknown) => console.warn('[tray] getState', err));
}

/** main 메모리의 스냅샷을 그대로 반영한다(최종값). 테마는 페이지에도, visible false 면 숨김 클래스도. */
export function applySnapshot(s: TrayState): void {
  paintTheme(s.theme);
  paintHidden(!s.visible);
  update({ theme: s.theme, opacity: s.opacity, mode: s.mode, hidden: !s.visible });
}

/** ☀️/🌙 — 지금 테마의 반대를 청한다. 반영은 tj-theme 를 받을 때다. */
export function requestThemeToggle(): void {
  connected?.setTheme(view.theme === 'dark' ? 'light' : 'dark');
}

/** 투명도 슬라이더 — 받은 값을 그대로 청한다(30–100 으로 자르는 것은 main). 반영은 tj-opacity 를 받을 때다. */
export function requestOpacity(percent: number): void {
  connected?.setOpacity(percent);
}
