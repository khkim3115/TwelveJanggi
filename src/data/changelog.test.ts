// 패치노트 데이터 무결성 + 상대시간 표기 헬퍼 테스트.
import { describe, it, expect } from 'vitest';
import { CHANGELOG, LATEST_VERSION, CHANGE_TYPES, relativeTime, unseenCount } from './changelog';

describe('relativeTime', () => {
  const now = Date.UTC(2026, 5, 24); // 2026-06-24 기준

  it('같은 날은 "오늘"', () => {
    expect(relativeTime('2026-06-24', now)).toBe('오늘');
  });
  it('미래 날짜도 "오늘"로 처리', () => {
    expect(relativeTime('2026-07-01', now)).toBe('오늘');
  });
  it('하루 전은 "어제"', () => {
    expect(relativeTime('2026-06-23', now)).toBe('어제');
  });
  it('2~6일은 "N일 전"', () => {
    expect(relativeTime('2026-06-21', now)).toBe('3일 전');
  });
  it('7~29일은 "N주 전"', () => {
    expect(relativeTime('2026-06-10', now)).toBe('2주 전'); // 14일
  });
  it('30~364일은 "N개월 전"', () => {
    expect(relativeTime('2026-05-10', now)).toBe('1개월 전'); // 45일
  });
  it('365일 이상은 "N년 전"', () => {
    expect(relativeTime('2025-06-24', now)).toBe('1년 전');
  });
});

describe('unseenCount', () => {
  it('최신을 확인했으면 0개', () => {
    expect(unseenCount(LATEST_VERSION)).toBe(0);
  });
  it('확인 버전 위(최신)에 있는 항목 수를 센다', () => {
    // index i 를 확인했다면 그 위 i 개가 미확인.
    const i = Math.min(2, CHANGELOG.length - 1);
    expect(unseenCount(CHANGELOG[i].version)).toBe(i);
  });
  it('최초 방문(빈 문자열)은 최신 1개만', () => {
    expect(unseenCount('')).toBe(1);
  });
  it('알 수 없는 버전도 과하지 않게 최신 1개만', () => {
    expect(unseenCount('9.9.9')).toBe(1);
  });
});

describe('CHANGELOG 무결성', () => {
  it('비어있지 않다', () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
  });
  it('LATEST_VERSION 은 맨 위(최신) 항목의 버전과 같다', () => {
    expect(LATEST_VERSION).toBe(CHANGELOG[0].version);
  });
  it('버전은 유일하다', () => {
    const versions = CHANGELOG.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
  it('최신순(날짜 내림차순)으로 정렬돼 있다', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(CHANGELOG[i - 1].date >= CHANGELOG[i].date).toBe(true);
    }
  });
  it('date 는 YYYY-MM-DD 형식이다', () => {
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('각 항목은 제목과 1개 이상의 유효한 변경사항을 갖는다', () => {
    for (const e of CHANGELOG) {
      expect(e.title.trim().length).toBeGreaterThan(0);
      expect(e.changes.length).toBeGreaterThan(0);
      for (const c of e.changes) {
        expect(CHANGE_TYPES).toContain(c.type);
        expect(c.text.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
