// 화면 전환(라이트 라우팅). 정적 SPA 라 react-router 대신 뷰 상태로 충분.
// + 헤더의 창(도움말·설정·패치노트·피드백) 열림과 패치노트 마지막 확인 버전(seen)도 앱 전역 상태로 보관
//   (헤더가 모든 화면에서 공유하고, 결과 창은 창 열림을 보고 자기를 미룬다).
import { create } from 'zustand';
import { LATEST_VERSION } from '../data/changelog';

export type Screen = 'home' | 'solo' | 'lobby' | 'mpgame';

const SEEN_KEY = 'tj_seen_version';

/** 마지막으로 확인한 패치노트 버전. 미저장(최초 방문)이면 빈 문자열. */
function readSeenVersion(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function persistSeenVersion(v: string) {
  try {
    localStorage.setItem(SEEN_KEY, v);
  } catch {
    // 저장 불가(사파리 사생활 모드 등) — 상태만 갱신.
  }
}

export interface AppState {
  screen: Screen;
  /** 화면을 바꾼다. 도움말·설정은 함께 닫는다 — 헤더가 화면마다 새로 뜨며 닫히던 동작(대기실 → 대국 자동 전환 등). */
  setScreen: (s: Screen) => void;

  /** 도움말 창. */
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  /** 설정 창(혼자 하기 화면 전용). */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  /** 패치노트 모달 표시 여부. */
  patchNotesOpen: boolean;
  /** 마지막으로 확인한 버전('' = 최초 방문). seenVersion !== LATEST_VERSION 이면 미확인. */
  seenVersion: string;
  openPatchNotes: () => void;
  /** 닫으면서 최신 버전을 '확인함'으로 기록 → NEW 배지 제거 + 자동 재노출 방지. */
  closePatchNotes: () => void;

  /** 인앱 피드백 모달. */
  feedbackOpen: boolean;
  setFeedbackOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  screen: 'home',
  setScreen: (screen) => set({ screen, helpOpen: false, settingsOpen: false }),

  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  patchNotesOpen: false,
  seenVersion: readSeenVersion(),
  openPatchNotes: () => set({ patchNotesOpen: true }),
  closePatchNotes: () => {
    persistSeenVersion(LATEST_VERSION);
    set({ patchNotesOpen: false, seenVersion: LATEST_VERSION });
  },

  feedbackOpen: false,
  setFeedbackOpen: (feedbackOpen) => set({ feedbackOpen }),
}));

/**
 * 헤더의 창(도움말·설정·패치노트·피드백) 중 하나라도 열려 있는가. 결과 창은 이것이 false 가 된 뒤에 뜬다 —
 * aria-modal 대화상자가 둘이 되지 않게, 쓰던 피드백이 날아가지 않게. 창을 더하면 여기에도 더한다(appStore.test 가 지킨다).
 */
export function isPanelOpen(s: AppState): boolean {
  return s.helpOpen || s.settingsOpen || s.patchNotesOpen || s.feedbackOpen;
}
