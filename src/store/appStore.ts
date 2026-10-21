// 화면 전환(라이트 라우팅). 정적 SPA 라 react-router 대신 뷰 상태로 충분.
// + 패치노트 모달 열림/마지막 확인 버전(seen) 도 앱 전역 상태로 보관(헤더가 모든 화면에서 공유).
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

interface AppState {
  screen: Screen;
  setScreen: (s: Screen) => void;

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
  setScreen: (screen) => set({ screen }),

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
