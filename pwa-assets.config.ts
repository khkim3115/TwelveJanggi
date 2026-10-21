// PWA 아이콘 생성 설정(npm run generate-pwa-assets). 원본은 public/icon.svg 하나다.
// 마스커블·애플 아이콘은 여백을 흰색(기본값) 대신 아이콘 바탕색으로 채운다 — OS 가 모양을 잘라 내도 흰 테가 남지 않게.
import { defineConfig, minimal2023Preset as preset } from '@vite-pwa/assets-generator/config';

const onDark = { fit: 'contain', background: '#0d1117' } as const;

export default defineConfig({
  preset: {
    ...preset,
    maskable: { ...preset.maskable, padding: 0.3, resizeOptions: onDark },
    apple: { ...preset.apple, padding: 0.3, resizeOptions: onDark },
  },
  images: ['public/icon.svg'],
});
