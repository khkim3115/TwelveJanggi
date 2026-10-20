// 멀티플레이 서버 설정 여부. Supabase 클라이언트(수백 kB)를 불러오지 않고도 화면이 확인할 수 있게 따로 둔다 —
// 솔로만 하는 사용자는 클라이언트를 받지 않고, 실제로 서버를 쓸 때(피드백 전송 등) 동적 import 로 불러온다.

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** 환경변수가 주입됐는지(미설정이면 멀티플레이 UI 를 비활성화). */
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
