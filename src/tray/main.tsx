// 트레이 앱 진입점(tray.html) — 웹의 src/main.tsx 와 따로다. 앱 셸 · PWA 를 들이지 않는다(vite.tray.config.ts 의 가드가 막는다).
// CSS 는 index.css(토큰 · 다크 기본) → tray.css 순서다.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TrayApp } from './TrayApp';
import '../index.css';
import './tray.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TrayApp />
  </StrictMode>,
);
