// "앱 설치" 버튼. 브라우저가 설치를 제안할 수 있을 때(beforeinstallprompt)만 보인다.
//
// 설치 제안 이벤트는 페이지마다 한 번 일찍 온다. 버튼을 그리는 컴포넌트가 직접 들으면 그 뒤에 그려진 화면
// (홈 → 대국 화면의 헤더 등)은 이벤트를 놓쳐 버튼이 나오지 않으므로, 모듈에서 한 번 받아 두고 모든 버튼이 나눠 쓴다.
import { useSyncExternalStore } from 'react';

// 'beforeinstallprompt' 는 표준 lib.dom 에 아직 없어 직접 선언한다.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 브라우저 기본 안내 대신 우리 버튼에서 띄운다.
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    notify();
  });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** 설치한 앱(독립 창)으로 열렸는가. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

const subscribeDisplayMode = (cb: () => void) => {
  if (typeof window === 'undefined') return () => {};
  const mq = window.matchMedia('(display-mode: standalone)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};

/**
 * isStandalone 을 화면에 쓸 때. 데스크톱 크롬·엣지는 설치하면 지금 탭을 새로고침 없이 앱 창으로 옮기고('Chrome 에서 열기'는
 * 그 반대) — 그때 바로 다시 그린다. 렌더 때 한 번 읽기만 하면 엉뚱한 다음 렌더(판 클릭 등)에 가서야 바뀌어 화면이 그때 움직인다.
 */
export function useStandalone(): boolean {
  return useSyncExternalStore(subscribeDisplayMode, isStandalone, () => false);
}

/**
 * 설치할 수 있을 때만 그린다. 이미 설치한 앱으로 열었거나 브라우저가 제안하지 않으면 아무것도 그리지 않는다.
 * compact: 헤더용 아이콘 버튼(📥) — 옆 아이콘 버튼과 같은 폭이라 솔로 헤더도 한 줄에 들어가고, 좁은 화면에서는 CSS 로 숨긴다.
 */
export function InstallButton({ compact = false }: { compact?: boolean }) {
  const prompt = useSyncExternalStore(subscribe, () => deferred, () => null);
  const done = useSyncExternalStore(subscribe, () => installed || isStandalone(), () => false);
  if (done || !prompt) return null;

  const install = async () => {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    // 제안 이벤트는 한 번만 쓸 수 있다 — 결과와 상관없이 비운다.
    if (outcome === 'accepted') installed = true;
    deferred = null;
    notify();
  };

  if (compact) {
    return (
      <button className="help-btn install-icon" onClick={() => void install()} aria-label="앱 설치" title="앱으로 설치">
        📥
      </button>
    );
  }
  return (
    <button className="install-btn" onClick={() => void install()}>
      ⬇ 앱 설치
    </button>
  );
}
