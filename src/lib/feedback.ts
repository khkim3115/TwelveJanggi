// 사용자 피드백(버그/건의/기타) 제출 + 보조 'GitHub 에 직접 신고' 링크.
// 쓰기는 tj_submit_feedback RPC(서버 검증·허니팟·레이트리밋) 만 거친다 — 클라 검증은 UX 용일 뿐 최종 게이트가 아니다.
// 모든 방문자가 이미 가진 익명 세션(ensureAnonSession)으로 동작하므로 계정/로그인 불필요.
// 모듈 최상위는 순수(=Supabase 클라 비의존)로 유지한다. submitFeedback 만 호출 시점에 ./supabase 를 동적 import
// → 순수 헬퍼(검증·링크·인자변환)는 node 테스트에서 Supabase 그래프 없이 단위 테스트 가능.

export type FeedbackKind = 'bug' | 'feature' | 'other';

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  bug: '버그',
  feature: '건의',
  other: '기타',
};

/** 서버(supabase/schema.sql)의 CHECK/검증과 반드시 일치시킬 것. */
export const MAX_FEEDBACK_MESSAGE = 2000;
export const MAX_FEEDBACK_CONTACT = 200;

/** 유저가 설명 못 하는 컨텍스트(버전·화면·헬퍼·환경)를 조용히 첨부. */
export interface FeedbackMeta {
  app_version?: string;
  screen?: string;
  /** 힌트(최선수 제안)를 쓴 판인지. */
  hint_used?: boolean;
  user_agent?: string;
  locale?: string;
  viewport?: string;
}

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  contact?: string;
  /** 허니팟(숨김 필드). 사람은 비워둠 — 채워지면 서버가 성공인 척 조용히 무시. */
  honeypot?: string;
  meta?: FeedbackMeta;
}

/** 클라 입력 검증(UX 용). 서버 tj_submit_feedback 가 최종 게이트. null = 통과. */
export function validateFeedbackMessage(message: string): string | null {
  const t = message.trim();
  if (t.length === 0) return '내용을 입력해 주세요.';
  if (t.length > MAX_FEEDBACK_MESSAGE) return `내용은 ${MAX_FEEDBACK_MESSAGE}자 이내로 입력해 주세요.`;
  return null;
}

const REPO_URL = 'https://github.com/khkim3115/TwelveJanggi';

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim();
}

function metaLines(meta?: FeedbackMeta): string {
  if (!meta) return '';
  const rows: string[] = [];
  if (meta.app_version) rows.push(`- 버전: ${meta.app_version}`);
  if (meta.screen) rows.push(`- 화면: ${meta.screen}`);
  if (meta.hint_used !== undefined) rows.push(`- 힌트 사용: ${meta.hint_used ? '예' : '아니오'}`);
  if (meta.locale) rows.push(`- 언어: ${meta.locale}`);
  if (meta.viewport) rows.push(`- 화면 크기: ${meta.viewport}`);
  if (meta.user_agent) rows.push(`- UA: ${meta.user_agent}`);
  return rows.join('\n');
}

/**
 * 보조 'GitHub 에 직접 신고' 링크(파워유저용, GitHub 로그인 필요).
 * title + body 만 prefill — labels/assignees/milestone 은 권한 없는 사용자에게 404 를 유발하므로 넣지 않는다.
 */
export function buildGithubIssueUrl(kind: FeedbackKind, message: string, meta?: FeedbackMeta): string {
  const title = `[${FEEDBACK_KIND_LABEL[kind]}] ${firstLine(message).slice(0, 50)}`.trim();
  const ctx = metaLines(meta);
  const body = ctx ? `${message}\n\n---\n${ctx}` : message;
  const params = new URLSearchParams({ title, body });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}

/** FeedbackInput → submit_feedback RPC 인자(트림·캡·빈 연락처 null·허니팟 전달). */
export function buildFeedbackArgs(input: FeedbackInput) {
  const contact = input.contact?.trim();
  return {
    p_kind: input.kind,
    p_message: input.message.trim().slice(0, MAX_FEEDBACK_MESSAGE),
    p_contact: contact ? contact.slice(0, MAX_FEEDBACK_CONTACT) : null,
    p_meta: (input.meta ?? {}) as Record<string, unknown>,
    p_hp: input.honeypot ?? '',
  };
}

/** 현재 런타임 컨텍스트 메타 자동 수집(브라우저 전용 필드는 가드). */
export function collectFeedbackMeta(extra?: Partial<FeedbackMeta>): FeedbackMeta {
  const meta: FeedbackMeta = { ...extra };
  if (typeof navigator !== 'undefined') {
    if (navigator.userAgent) meta.user_agent = navigator.userAgent.slice(0, 500);
    if (navigator.language) meta.locale = navigator.language;
  }
  if (typeof window !== 'undefined') {
    meta.viewport = `${window.innerWidth}x${window.innerHeight}`;
  }
  return meta;
}

/** 피드백 제출. 익명 세션 보장 후 tj_submit_feedback RPC 호출(서버가 검증·레이트리밋). */
export async function submitFeedback(input: FeedbackInput): Promise<void> {
  const { supabase, isSupabaseConfigured, ensureAnonSession } = await import('./supabase');
  if (!isSupabaseConfigured) throw new Error('피드백 서버가 설정되지 않았습니다.');
  await ensureAnonSession();
  const { error } = await supabase.rpc('tj_submit_feedback', buildFeedbackArgs(input));
  if (error) throw error;
}
