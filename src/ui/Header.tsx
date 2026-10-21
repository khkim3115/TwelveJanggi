// 모든 화면 공통 상단 바: 브랜드 + (홈/화면별 추가요소) + 테마전환·도움말·패치노트·피드백·앱 설치·설정.
import { useEffect, useState, type ReactNode } from 'react';
import { useAppStore } from '../store/appStore';
import { useGameStore } from '../store/gameStore';
import { LATEST_VERSION } from '../data/changelog';
import { SettingsPanel } from './SettingsPanel';
import { HelpPanel } from './HelpPanel';
import { PatchNotesModal } from './PatchNotesModal';
import { FeedbackModal } from './FeedbackModal';
import { InstallButton } from './InstallButton';

const GUIDE_KEY = 'tj_seen_guide';

// 패치노트 자동 노출은 페이지 로드당 1회만 평가(화면 전환에 따른 Header 재마운트에도 중복 방지).
let patchNotesAutoChecked = false;

interface HeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 🏠 메뉴(홈) 버튼 표시. */
  showHome?: boolean;
  /** ⚙️ 설정(난이도·선공) 버튼 표시 — 솔로 화면 전용. */
  showSettings?: boolean;
  /** 최초 방문 시 도움말 자동 표시(솔로 화면만 사용). */
  autoHelp?: boolean;
  /** 공통 버튼 앞에 끼워 넣을 화면별 요소. */
  children?: ReactNode;
}

export function Header({ title, subtitle, showHome, showSettings, autoHelp, children }: HeaderProps) {
  const setScreen = useAppStore((s) => s.setScreen);
  const theme = useGameStore((s) => s.theme);
  const toggleTheme = useGameStore((s) => s.toggleTheme);
  const patchNotesOpen = useAppStore((s) => s.patchNotesOpen);
  const openPatchNotes = useAppStore((s) => s.openPatchNotes);
  const closePatchNotes = useAppStore((s) => s.closePatchNotes);
  const seenVersion = useAppStore((s) => s.seenVersion);
  const feedbackOpen = useAppStore((s) => s.feedbackOpen);
  const setFeedbackOpen = useAppStore((s) => s.setFeedbackOpen);
  const hasUnseen = seenVersion !== LATEST_VERSION;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // 처음 방문한 사용자에게는 도움말(규칙)을 한 번 자동으로 띄운다 — 규칙을 모르는 게임이라 특히 필요.
  useEffect(() => {
    if (!autoHelp) return;
    try {
      if (!localStorage.getItem(GUIDE_KEY)) setHelpOpen(true);
    } catch {
      // localStorage 사용 불가(사파리 사생활 모드 등) — 자동 표시만 생략.
    }
  }, [autoHelp]);

  // 새 버전이 나오면(이전에 확인한 적 있는 사용자 한정) 최초 1회 패치노트를 자동으로 띄운다.
  useEffect(() => {
    if (patchNotesAutoChecked) return;
    patchNotesAutoChecked = true;
    if (autoHelp) {
      try {
        if (!localStorage.getItem(GUIDE_KEY)) return;
      } catch {
        return;
      }
    }
    if (seenVersion !== '' && seenVersion !== LATEST_VERSION) openPatchNotes();
  }, [autoHelp, seenVersion, openPatchNotes]);

  const handleHelpClose = () => {
    setHelpOpen(false);
    try {
      localStorage.setItem(GUIDE_KEY, '1');
    } catch {
      // 저장 실패는 무시(다음 방문에 다시 떠도 무방).
    }
  };

  return (
    <>
      <div className="topbar">
        <div className="brand">
          <h1>{title}</h1>
          {subtitle && <span className="sub">{subtitle}</span>}
        </div>
        <div className="topbar-right">
          {showHome && (
            <button className="theme-btn" onClick={() => setScreen('home')} aria-label="메뉴로" title="메뉴로">
              🏠
            </button>
          )}
          {children}
          <button
            className="theme-btn"
            onClick={toggleTheme}
            aria-label="테마 전환"
            title={theme === 'dark' ? '라이트 모드로' : '다크 모드로'}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button className="help-btn" onClick={() => setHelpOpen(true)} aria-label="도움말" title="규칙·도움말">
            ❓
          </button>
          <button
            className="help-btn pn-btn"
            onClick={openPatchNotes}
            aria-label={hasUnseen ? '패치노트 (새 소식)' : '패치노트'}
            title="패치노트"
          >
            📋
            {hasUnseen && <span className="pn-dot" aria-hidden="true" />}
          </button>
          <button
            className="help-btn"
            onClick={() => setFeedbackOpen(true)}
            aria-label="피드백 보내기"
            title="피드백 보내기"
          >
            💬
          </button>
          <InstallButton compact />
          {showSettings && (
            <button className="gear" onClick={() => setSettingsOpen(true)} aria-label="설정">
              ⚙️
            </button>
          )}
        </div>
      </div>

      {helpOpen && <HelpPanel onClose={handleHelpClose} />}
      {patchNotesOpen && <PatchNotesModal onClose={closePatchNotes} />}
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
