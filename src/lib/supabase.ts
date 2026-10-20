// Supabase 클라이언트 + 익명 세션. 피드백 전송·멀티플레이에서만 쓴다(솔로 대국은 네트워크 불필요).
// anon 키는 공개용이며 보안은 DB 의 RLS + SECURITY DEFINER RPC 가 담당한다.

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from './env';

export { isSupabaseConfigured };

export const supabase = createClient(SUPABASE_URL ?? 'http://localhost', SUPABASE_ANON_KEY ?? 'public-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

let sessionPromise: Promise<string | null> | null = null;

/**
 * 익명 로그인 보장(멱등). 기존 세션이 있으면 그 user.id, 없으면 새 익명 가입.
 * 같은 브라우저는 새로고침 후에도 같은 user.id 를 유지(→ 같은 좌석 재접속).
 * 익명 가입이 꺼져 있으면 throw → 재시도 가능하도록 캐시를 비운다.
 */
export function ensureAnonSession(): Promise<string | null> {
  if (!isSupabaseConfigured) return Promise.resolve(null);
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const { data: existing } = await supabase.auth.getSession();
    if (existing.session?.user) return existing.session.user.id;
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) {
      sessionPromise = null;
      throw error;
    }
    return data.user?.id ?? null;
  })();
  return sessionPromise;
}
