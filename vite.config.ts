import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: 상대 경로라 GitHub Pages 하위 경로(/TwelveJanggi/) 게시에서도 그대로 동작.
// PWA(vite-plugin-pwa)는 배포 단계(#5)에서 붙인다.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
});
