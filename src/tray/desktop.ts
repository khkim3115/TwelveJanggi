// 트레이 앱(Electron 창)의 preload 가 노출하는 브리지 window.tjDesktop 의 타입과 접근자(#20 설계 §5.6).
// 브리지는 선택적이다 — 브라우저 개발(`npm run dev` → /tray.html)에는 없다(undefined). 그때 브리지를 쓰는 것(버전 · 테마 · 투명도 · 숨기기)은
// 아무것도 하지 않는다 — 브리지 없는 흐름은 따로 두지 않는다(흐름은 하나).
// 키 목록 TJ_DESKTOP_KEYS 는 노출 키를 대조할 기준이다(preload 계약 시험 · 스모크의 브리지 검사).
// 값은 preload 가 고치지 않고 그대로 보낸다 — 정규화는 main 한 곳이다(#21 설계 §5.3).

import type { Theme } from '../lib/theme';

export interface AppInfo {
  /** 데스크톱 앱 버전. */
  version: string;
  electron: string;
  chrome: string;
  platform: string;
}

/** 트레이 화면의 모드 — 혼자 하기 · 온라인. */
export type TrayMode = 'solo' | 'online';
/** 창 크기를 정하는 레이아웃 키. */
export type LayoutKey = 'solo' | 'online' | 'online-chat';

/** getState() 가 돌려주는 main 메모리의 스냅샷. */
export interface TrayState {
  theme: Theme;
  opacity: number;
  mode: TrayMode;
  visible: boolean;
}

/** 구독 함수는 해제 함수를 돌려준다. cb 에는 이벤트 객체 없이 payload 만 간다. */
export interface TjDesktop {
  getAppInfo(): Promise<AppInfo>;
  getState(): Promise<TrayState>;
  setTheme(theme: Theme): void;
  setOpacity(percent: number): void;
  setLayout(key: LayoutKey): void;
  hide(): void;
  onTheme(cb: (theme: Theme) => void): () => void;
  onOpacity(cb: (percent: number) => void): () => void;
  onMode(cb: (mode: TrayMode) => void): () => void;
  onShown(cb: () => void): () => void;
  onHidden(cb: () => void): () => void;
}

/** 브리지가 가진 키. satisfies 가 TjDesktop 에서 빠진 키 · 남는 키를 컴파일에서 막는다 — 메서드를 더하면 여기도 더한다. */
export const TJ_DESKTOP_KEYS: readonly (keyof TjDesktop)[] = Object.keys({
  getAppInfo: true,
  getState: true,
  setTheme: true,
  setOpacity: true,
  setLayout: true,
  hide: true,
  onTheme: true,
  onOpacity: true,
  onMode: true,
  onShown: true,
  onHidden: true,
} satisfies Record<keyof TjDesktop, true>) as (keyof TjDesktop)[];

declare global {
  interface Window {
    tjDesktop?: TjDesktop;
  }
}

/** 브리지. 브라우저 개발이거나 preload 가 없으면 undefined 다 — 부른 쪽은 아무것도 하지 않는다(window 가 없는 node 시험에서도 던지지 않는다). */
export function desktop(): TjDesktop | undefined {
  return typeof window === 'undefined' ? undefined : window.tjDesktop;
}
