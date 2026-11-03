// Supabase 클라이언트의 공용 동적 로더(#20 D6). 온라인 대전 스토어(multiplayerStore)와 트레이 스모크(tray/smoke.ts)가
// 이 모듈의 약속 하나를 나눠 쓴다 — 동적 import 를 새로 만들 때도 여기서 받는다(lib/supabase 를 따로 import() 하지 않는다).
// lib/supabase 는 불러오는 순간 클라이언트를 만든다 — 첫 화면 번들에 정적으로 들이지 않고, 이 모듈만 그 import 를 쥔다.

type SupabaseModule = typeof import('./supabase');

/**
 * Supabase 클라이언트를 불러온다. 청크를 못 받으면(오프라인·배포 뒤 남은 옛 탭) 브라우저마다 다른 영문 오류 대신
 * 정해 둔 문구로 바꿀 수 있게 표시를 단다 — 실패한 동적 import 는 브라우저가 기억해서 새로고침해야 풀린다.
 */
export function createSupabaseLoader(importer: () => Promise<SupabaseModule>): () => Promise<SupabaseModule> {
  /**
   * Supabase 클라이언트 모듈(동적 import — 첫 화면 번들에서 뺀다). 약속을 하나만 만들어 나눠 쓴다: 동시에 여러 번
   * import 하면 vitest 의 모듈 mock 이 그중 하나에 진짜 모듈을 돌려주어 단위 테스트가 실서버로 나간 일이 있었다(#11).
   * 불러오지 못하면 비워 두어 다음 호출이 다시 시도한다.
   */
  let supabaseModule: Promise<SupabaseModule> | null = null;
  return () =>
    (supabaseModule ??= importer().catch(() => {
      supabaseModule = null;
      throw new Error('client load failed');
    }));
}

/** 앱이 쓰는 로더 — 스토어와 스모크가 이 하나의 약속을 나눠 쓴다. */
export const loadSupabase = createSupabaseLoader(() => import('./supabase'));
