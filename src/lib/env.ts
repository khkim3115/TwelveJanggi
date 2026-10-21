// 멀티플레이 서버 설정 여부. Supabase 클라이언트(수백 kB)를 불러오지 않고도 화면이 확인할 수 있게 따로 둔다 —
// 클라이언트는 첫 화면 번들에 넣지 않고 실제로 서버를 쓸 때(온라인 대전·피드백 전송) 동적 import 로 불러온다.
// (서비스 워커가 설치되면서 이 청크도 백그라운드로 미리 받아 둔다 — vite.config.ts 의 workbox.globPatterns.)

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** 환경변수가 주입됐는지(미설정이면 멀티플레이 UI 를 비활성화). */
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
