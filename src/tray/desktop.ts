// 트레이 앱(Electron 창)의 preload 가 노출하는 브리지 window.tjDesktop 의 타입과 접근자(설계 §5.6).
// 브리지는 선택적이다 — 브라우저 개발(`npm run dev` → /tray.html)에는 없고, 그때 화면은 스텁으로 동작한다.
// 키 목록 TJ_DESKTOP_KEYS 는 노출 키를 대조할 기준이다(preload 계약 시험 · 스모크의 브리지 검사).

export interface AppInfo {
  /** 데스크톱 앱 버전. */
  version: string;
  electron: string;
  chrome: string;
  platform: string;
}

export interface TjDesktop {
  getAppInfo(): Promise<AppInfo>;
}

/** 브리지가 가진 키. satisfies 가 TjDesktop 에서 빠진 키 · 남는 키를 컴파일에서 막는다 — 메서드를 더하면 여기도 더한다. */
export const TJ_DESKTOP_KEYS: readonly (keyof TjDesktop)[] = Object.keys({
  getAppInfo: true,
} satisfies Record<keyof TjDesktop, true>) as (keyof TjDesktop)[];

declare global {
  interface Window {
    tjDesktop?: TjDesktop;
  }
}

/** 브리지. 브라우저 개발이거나 preload 가 없으면 undefined 다 — 부른 쪽이 스텁으로 동작한다(window 가 없는 node 시험에서도 던지지 않는다). */
export function desktop(): TjDesktop | undefined {
  return typeof window === 'undefined' ? undefined : window.tjDesktop;
}
