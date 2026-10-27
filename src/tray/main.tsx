// 트레이 앱 진입점(tray.html) — 웹의 src/main.tsx 와 따로다. 앱 셸 · PWA 를 들이지 않는다(vite.tray.config.ts 의 가드가 막는다).
// CSS 는 index.css(토큰 · 다크 기본) → tray.css 순서다.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TrayApp } from './TrayApp';
import { installTraySmoke } from './smoke';
import '../index.css';
import './tray.css';

// tray.html?smoke 일 때만 window.__tjTraySmoke 를 둔다(앱 안 스모크 실행기가 부른다). 평소에는 아무것도 하지 않는다.
// 렌더보다 먼저 — 실행기가 페이지가 뜬 직후부터 부를 수 있어야 한다.
installTraySmoke(window);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TrayApp />
  </StrictMode>,
);
