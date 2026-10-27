import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { repoRoot, trayCsp, trayGuard } from './scripts/trayBuild';

// 트레이 앱(Electron 이 app://twelvejanggi/tray.html 로 여는 정적 파일 한 벌)의 빌드 설정 — 웹 설정(vite.config.ts)과 따로 둔다.
// 웹은 PWA(서비스 워커 · 매니페스트 · public/ 복사)를 얹은 GitHub Pages 하위 경로 게시고, 트레이는 자기 출처에서 뜨고
// CSP 가 인라인 스크립트 · 스타일을 막는다. 진입(tray.html) · 출력(dist-tray) · 플러그인이 달라서 한 설정에 섞지 않는다.
// - VitePWA 없음, publicDir false: public/ 의 PWA 자원 · 아이콘이 복사돼 들어오지 않게(NMM 4a7536a 사고)
// - trayGuard: 웹 전용 모듈(앱 셸 · PWA)이 트레이 빌드에 들어오면 빌드가 스스로 실패한다. plugins 의 훅은 워커 하위 빌드를
//   보지 못하므로 worker.plugins 에도 넣는다(웹 설정의 webGuard 가 반대 방향을 지킨다)
// - trayCsp: CSP meta · tray-build.json · 출력 검사. 워커 번들마다 돌면 안 되므로 worker.plugins 에는 넣지 않는다
// root 는 이 파일이 있는 저장소 루트다 — 가드 루트와 같은 값이라 실행 위치(cwd)와 무관하게 같은 판정을 한다.
// 진입도 root 에서 절대 경로로 푼다: 상대 'tray.html' 은 Rollup 이 cwd 기준으로 풀어 다른 폴더에서 돌리면 진입을 못 찾는다.
const root = repoRoot(import.meta.url);

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  plugins: [react(), trayGuard(root), trayCsp()],
  // es 워커 — AI 모듈 워커의 형식이다(웹 설정과 같다)
  worker: { format: 'es', plugins: () => [trayGuard(root)] },
  build: { outDir: 'dist-tray', emptyOutDir: true, rollupOptions: { input: resolve(root, 'tray.html') } },
});
