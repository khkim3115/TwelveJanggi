// 커뮤니티/외부 링크의 단일 진실원본. 순수 데이터 모듈 — React/DOM 의존 없음.
// 변경은 여기 한 곳에서 끝난다(하드코딩 분산 금지). URL 이 비어있는 항목은 노출되지 않음(graceful)
// — 채널이 생기면 url 만 채우면 자동으로 버튼이 노출된다(디스코드 등도 같은 패턴으로 끼움).

export interface CommunityLink {
  /** 안정적 식별자(React key). */
  id: string;
  /** 버튼/링크 라벨. */
  label: string;
  /** 앞에 붙는 이모지(선택). */
  emoji?: string;
  /** 초대/공유 URL. 빈 문자열이면 미노출. */
  url: string;
}

/** 카카오 오픈채팅 초대 링크. 변경은 여기 한 곳만. */
export const KAKAO_OPEN_CHAT_URL = 'https://open.kakao.com/o/sR8A9fBi';

// 디스코드는 이번 범위 아님(#54). 채널을 만들면 아래 url 만 채우면 자동 노출된다.
const DISCORD_INVITE_URL = '';

/** 커뮤니티 링크 목록(확장 가능). url 이 채워진 항목만 노출된다. */
export const COMMUNITY_LINKS: CommunityLink[] = [
  { id: 'kakao', label: '카카오 오픈채팅으로 소통', emoji: '🗨️', url: KAKAO_OPEN_CHAT_URL },
  { id: 'discord', label: '디스코드로 소통', emoji: '🎮', url: DISCORD_INVITE_URL },
];

/** 실제로 노출할(= url 이 채워진) 커뮤니티 링크만 추린다. */
export function activeCommunityLinks(): CommunityLink[] {
  return COMMUNITY_LINKS.filter((l) => l.url.trim().length > 0);
}
