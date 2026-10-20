// 커뮤니티 링크(외부) 단일 진실원본의 무결성 + graceful 필터 테스트.
import { describe, it, expect } from 'vitest';
import { COMMUNITY_LINKS, KAKAO_OPEN_CHAT_URL, activeCommunityLinks } from './links';

describe('커뮤니티 링크', () => {
  it('카카오 오픈채팅 URL 상수가 채워져 있다', () => {
    expect(KAKAO_OPEN_CHAT_URL).toMatch(/^https:\/\/open\.kakao\.com\//);
  });

  it('COMMUNITY_LINKS 에 카카오 항목이 있고 같은 URL 을 가리킨다', () => {
    const kakao = COMMUNITY_LINKS.find((l) => l.id === 'kakao');
    expect(kakao).toBeDefined();
    expect(kakao?.url).toBe(KAKAO_OPEN_CHAT_URL);
  });

  it('id 는 유일하다(React key 안정성)', () => {
    const ids = COMMUNITY_LINKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('activeCommunityLinks 는 URL 이 빈 항목을 제외한다(graceful)', () => {
    const active = activeCommunityLinks();
    expect(active.every((l) => l.url.trim().length > 0)).toBe(true);
    // 카카오는 URL 이 있으므로 노출 대상
    expect(active.some((l) => l.id === 'kakao')).toBe(true);
  });

  it('URL 미설정 항목(예: 디스코드)은 노출되지 않는다', () => {
    const active = activeCommunityLinks();
    const inactive = COMMUNITY_LINKS.filter((l) => l.url.trim().length === 0);
    for (const link of inactive) {
      expect(active.some((l) => l.id === link.id)).toBe(false);
    }
  });
});
