import { defineConfig } from 'vitest/config';

// 테스트는 순수 TS 로직 대상이라 플러그인 불필요(node 환경).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
