import { defineConfig } from 'vitest/config';

// 테스트는 순수 TS 로직 대상이라 플러그인 불필요(node 환경).
export default defineConfig({
  // .env* 를 읽지 않는다(없는 폴더를 가리킨다) — 스토어 테스트의 Supabase mock 이 새면 .env.local 의 실서버 값으로
  // 공유 프로젝트에 요청이 나가므로(#11), 단위 테스트에는 처음부터 실서버 값을 주지 않는다(src/lib/env.test.ts 가 지킨다).
  envDir: 'node_modules/.vitest-no-env',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
