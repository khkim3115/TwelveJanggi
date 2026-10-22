// 단위 테스트는 .env* 를 읽지 않는다(vitest.config.ts 의 envDir). 스토어 테스트의 Supabase mock 이 새면
// .env.local 의 실서버 값으로 공유 프로젝트에 요청이 나간다 — #11 에서 실제로 그랬다.
import { describe, expect, it } from 'vitest';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from './env';

describe('테스트 환경', () => {
  it('단위 테스트는 .env.local 의 Supabase 값을 보지 않는다', () => {
    expect(SUPABASE_URL).toBeFalsy();
    expect(SUPABASE_ANON_KEY).toBeFalsy();
    expect(isSupabaseConfigured).toBe(false);
  });
});
