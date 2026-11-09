// 트레이 앱 진입점(tray.html) — 웹의 src/main.tsx 와 따로다. 앱 셸 · PWA 를 들이지 않는다(vite.tray.config.ts 의 가드가 막는다).
// CSS 는 index.css(토큰 · 다크 기본) → tray.css 순서다.
// 렌더까지 동기로 간다(설계 §5.4 의 1–6). 최상위 await 는 쓰지 않는다 — Vite 6 의 기본 대상(es2020)이 막아 build:tray 가 깨진다.
// 렌더와 Esc 는 IPC 를 기다리지 않는다. 늦게 온 스냅샷은 저장값(tj_theme)이 틀렸을 때만 화면을 바꾼다(창은 ready-to-show 전에 보이지 않는다).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme, readStoredTheme } from '../lib/theme';
import { isDialogOpen } from '../ui/useDialog';
import { TrayApp } from './TrayApp';
import { desktop } from './desktop';
import { installEscHandlers } from './esc';
import { installTraySmoke } from './smoke';
import { connectBridge, requestSnapshot } from './trayState';
import '../index.css';
import './tray.css';

// 1. tray.html?smoke 일 때만 window.__tjTraySmoke 를 둔다(앱 안 스모크 실행기가 부른다). 평소에는 아무것도 하지 않는다.
//    렌더보다 먼저 — 실행기가 페이지가 뜬 직후부터 부를 수 있어야 한다.
installTraySmoke(window);

// 2. 지난 테마로 첫 페인트를 맞춘다.
applyTheme(readStoredTheme());

// 3. 브리지 구독 다섯(테마 · 투명도 · 모드 · 보임 · 숨김) — 여기서 한 번만 건다. 구독보다 먼저 온 send 는 사라진다.
connectBridge(desktop());

// 4. Esc — 캡처 단계에서 대화상자 여부를 찍고 버블 단계에서 숨길지 정한다(등록 순서에 기대지 않는다). ✕ 와 같은 hide 다.
installEscHandlers(window, { isDialogOpen, hide: () => desktop()?.hide() });

// 5. 렌더
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TrayApp />
  </StrictMode>,
);

// 6. 처음 상태 — 구독을 모두 건 뒤에 묻는다. 그 사이에 온 변경은 응답보다 먼저 오고 응답이 최종값이 된다.
requestSnapshot(desktop());
