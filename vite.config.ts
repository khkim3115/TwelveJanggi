import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { repoRoot, webGuard } from './scripts/trayBuild';

// 웹 빌드 가드의 루트 = 이 파일이 있는 저장소 루트(트레이 설정 vite.tray.config.ts 와 같은 방식).
const root = repoRoot(import.meta.url);

// base: 상대 경로라 GitHub Pages 하위 경로(/TwelveJanggi/) 게시에서도 그대로 동작.
// vite-plugin-pwa 0.21 은 Vite 6 까지만 지원한다 — Vite 메이저를 올릴 때 함께 확인할 것.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      // 서비스 워커 등록은 src/ui/PwaStatus.tsx 의 useRegisterSW 한 곳에서 한다(새 버전은 사용자가 눌러 적용).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.ico', 'icon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: '십이장기',
        short_name: '십이장기',
        description: '3×4 판 위의 王·將·相·子 — 난이도별 AI 와 혼자, 방 코드로 친구와 온라인 1:1. 설치하면 혼자 하기는 인터넷 없이도 됩니다.',
        lang: 'ko',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        categories: ['games'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // AI 워커·Supabase 청크까지 미리 받아 둔다 — 혼자 하기는 오프라인에서, 온라인 화면은 배포 뒤 옛 탭에서도 열린다.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        navigateFallback: 'index.html',
      },
      // dev 에서는 서비스 워커를 끈다(캐시 혼선 방지). 설치·오프라인은 build + preview 로 확인.
      devOptions: { enabled: false },
    }),
    // 웹 번들에 트레이 모듈(tray.html · src/tray/**)이 들어오면 빌드가 실패한다 — 트레이는 vite.tray.config.ts 로 따로 빌드한다.
    // 가드는 빌드에서만 돈다(dev 에서 켜면 `npm run dev` → /tray.html 개발 흐름이 깨진다).
    webGuard(root),
  ],
  // plugins 의 훅은 워커 하위 빌드를 보지 못해 가드를 worker.plugins 에도 따로 넣는다.
  worker: { format: 'es', plugins: () => [webGuard(root)] },
});
