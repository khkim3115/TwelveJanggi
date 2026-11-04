import { useEffect, useState } from 'react';
import { desktop, type TrayMode } from './desktop';
import { requestOpacity, requestThemeToggle, useTrayView } from './trayState';

/** 모드별 자리표시 문구 — 혼자 하기 · 온라인 대전 화면은 #24 · #25. */
const MODE_TEXT: Readonly<Record<TrayMode, string>> = {
  solo: '곧 이 창에서 혼자 하기를 할 수 있어요.',
  online: '곧 이 창에서 온라인 대전을 할 수 있어요.',
};

/** 투명도 슬라이더 범위(%) — main 이 받는 범위(desktop/lib/opacity.cjs, 30–100)와 같다. */
const OPACITY_MIN = 30;
const OPACITY_MAX = 100;

/**
 * 트레이 앱 창의 화면 — 제목 줄(이름 · 앱 버전 · 🔅 투명도 · ☀️/🌙 테마 · ✕ 숨기기), 🔅 로 펼치는 투명도 덮개, 모드 자리표시 문구.
 * 상태와 처리 함수는 trayState 에 있다 — 이 컴포넌트는 붙이기만 한다(브리지 구독 · tj-mode 의 레이아웃 중계도 trayState 가 한다).
 * 테마 · 투명도는 main 이 민 값으로만 바뀐다(미리 바꾸지 않는다).
 * 버전은 브리지에서 받는다. 브리지가 없으면(브라우저 개발) 버전은 그리지 않고, 브리지를 쓰는 단추(☀️ · 슬라이더 · ✕)는 아무것도 하지 않는다.
 */
export function TrayApp() {
  const view = useTrayView();
  const [version, setVersion] = useState<string | null>(null);
  const [opacityOpen, setOpacityOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    desktop()
      ?.getAppInfo()
      .then(
        (info) => {
          if (alive) setVersion(info.version);
        },
        // 버전은 곁들이는 정보다 — 실패해도 화면은 그대로 두고 한 줄만 남긴다(#36 T3-1).
        (err: unknown) => console.warn('[tray] getAppInfo', err),
      );
    return () => {
      alive = false;
    };
  }, []);

  const toLight = view.theme === 'dark';
  const themeLabel = toLight ? '라이트 모드로' : '다크 모드로';

  return (
    <main className="tapp-app">
      <header className="tapp-bar">
        <div className="tapp-heading">
          <h1 className="tapp-title">십이장기</h1>
          {version && <span className="tapp-version">{version}</span>}
        </div>
        <div className="tapp-actions">
          <button
            type="button"
            className="tapp-btn"
            aria-label="투명도"
            title="투명도"
            aria-expanded={opacityOpen}
            onClick={() => setOpacityOpen((open) => !open)}
          >
            🔅
          </button>
          <button type="button" className="tapp-btn" aria-label={themeLabel} title={themeLabel} onClick={requestThemeToggle}>
            {toLight ? '☀️' : '🌙'}
          </button>
          <button type="button" className="tapp-btn" aria-label="숨기기" title="숨기기 (Esc)" onClick={() => desktop()?.hide()}>
            ✕
          </button>
        </div>
      </header>
      {opacityOpen && <OpacityRow opacity={view.opacity} />}
      <div className="tapp-body">
        <p className="tapp-placeholder">{MODE_TEXT[view.mode]}</p>
      </div>
    </main>
  );
}

/**
 * 투명도 덮개 — 제목 줄 아래에 떠 있다(내용을 밀지 않는다). 슬라이더는 input 마다 setOpacity 를 청한다.
 * 끄는 동안은 슬라이더가 제 값(지역 값)을 갖고, 손을 떼면 받은 값(tj-opacity)으로 다시 맞춘다 — 왕복을 기다리는 동안 손잡이가 옛 값으로
 * 튀지 않게. % 글자는 받은 값만 보인다. 창 투명도는 main 만 바꾼다.
 */
function OpacityRow({ opacity }: { opacity: number }) {
  const [held, setHeld] = useState<number | null>(null);
  const release = () => setHeld(null);

  return (
    <div className="tapp-oprow">
      <label className="tapp-oplabel">
        투명도
        <input
          className="tapp-slider"
          type="range"
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={1}
          value={held ?? opacity}
          onChange={(event) => {
            const percent = event.currentTarget.valueAsNumber;
            setHeld(percent);
            requestOpacity(percent);
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onKeyUp={release}
          onBlur={release}
        />
      </label>
      <span className="tapp-oppct">{opacity}%</span>
    </div>
  );
}
