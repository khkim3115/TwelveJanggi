// desktop/lib/links.cjs 시험 — 시스템 브라우저로 여는 외부 주소 허용 목록(설계 §5.7).
// 거부 사례는 허용 사례에서 한 곳만 어긋나게 고른 것이다(호스트 접두 · 접미 · 포트 · 사용자 정보 · 경로 접두 · 대소문자).
// 마지막 묶음은 소스(src/data/links.ts · src/lib/feedback.ts)의 외부 주소가 허용 목록이거나 '트레이 제외' 목록에 있는지 본다(drift).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { externalHref } = require('./links.cjs') as typeof import('./links.cjs');

const HUB = 'https://khkim3115.github.io/';
const REPO = 'https://github.com/khkim3115/TwelveJanggi';

describe('externalHref — 허용', () => {
  it.each([
    HUB,
    `${HUB}TwelveJanggi/`,
    `${HUB}any/other/page?x=1#top`, // khkim3115.github.io 는 경로 무관
    REPO,
    `${REPO}/`,
    `${REPO}/issues/1`,
    `${REPO}/issues/new?title=%5B%EB%B2%84%EA%B7%B8%5D&body=a+b`,
    `${REPO}?tab=readme-ov-file`,
  ])('입력과 같은 href 를 돌려준다: %s', (url) => {
    expect(externalHref(url)).toBe(url);
  });

  it('feedback.ts 가 만드는 이슈 신고 주소 모양(한글 · 줄바꿈이 든 쿼리)을 받는다', () => {
    const params = new URLSearchParams({ title: '[버그] 판이 멈춰요', body: '내용\n\n---\n- 버전: 0.1.0' });
    const url = `${REPO}/issues/new?${params.toString()}`;
    expect(externalHref(url)).toBe(url);
  });

  // 여는 값은 입력 문자열이 아니라 URL 파서가 만든 href 다 — 거른 값과 여는 값이 같다.
  it.each<[string, string]>([
    ['https://khkim3115.github.io', HUB],
    ['https://khkim3115.github.io:443/', HUB],
    ['HTTPS://KHKIM3115.GITHUB.IO/TwelveJanggi/', `${HUB}TwelveJanggi/`],
    ['https://github.com/khkim3115/TwelveJanggi/./issues/../issues/2', `${REPO}/issues/2`],
  ])('정규화한 href 를 돌려준다: %s', (url, href) => {
    expect(externalHref(url)).toBe(href);
  });
});

describe('externalHref — null', () => {
  it.each([
    'http://khkim3115.github.io/', // https 만
    'https://u:p@khkim3115.github.io/', // 사용자 정보
    'https://user@khkim3115.github.io/',
    'https://:secret@khkim3115.github.io/', // 비밀번호만 있어도 사용자 정보다
    'https://khkim3115.github.io:8443/', // 포트는 host 에 든다
    'https://github.com:8443/khkim3115/TwelveJanggi',
    `${REPO}X`, // 경로 접두 — 저장소 이름이 다름
    `${REPO}X/issues`,
    'https://github.com/KHKIM3115/TwelveJanggi', // 경로는 대소문자 그대로
    'https://github.com/khkim3115/twelvejanggi',
    'https://github.com/khkim3115/',
    'https://github.com/khkim3115',
    'https://github.com/',
    'https://github.com/khkim3115/other-repo',
    'https://github.com/other/khkim3115/TwelveJanggi',
    `${REPO}/../other`, // 점 세그먼트가 접히면 저장소 밖이다
    `${REPO}/%2e%2e/other`,
    'https://evil.com/',
    'https://evil.com/https://khkim3115.github.io/',
    'https://khkim3115.github.io.evil.com/', // 호스트 접미 · 접두 · 하위
    'https://evilkhkim3115.github.io/',
    'https://sub.khkim3115.github.io/',
    'https://khkim3115.github.io./',
    'https://khkim3115.github.io@evil.com/', // 앞부분은 사용자 이름이다
    'https://www.github.com/khkim3115/TwelveJanggi',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/System32/calc.exe',
    'ftp://khkim3115.github.io/',
    'app://twelvejanggi/tray.html',
    'mailto:a@b.c',
    '//khkim3115.github.io/', // 상대 주소는 URL 이 아니다
    'khkim3115.github.io',
    'nope',
    '',
  ])('거부: %s', (url) => {
    expect(externalHref(url)).toBeNull();
  });

  it('문자열이 아니면 거부한다(배열은 문자열로 바뀌어 통과하지 못한다)', () => {
    for (const value of [undefined, null, 1, {}, [HUB], { toString: () => HUB }]) {
      expect(externalHref(value as unknown as string)).toBeNull();
    }
  });
});

describe('소스의 외부 주소 — 허용 목록과 어긋나지 않는다(drift)', () => {
  /** 트레이 화면이 쓰지 않아 허용 목록에 넣지 않는 주소와 그 이유. 새 주소가 소스에 생기면 여기든 허용 목록이든 정해야 한다. */
  const TRAY_EXCLUDED: Record<string, string> = {
    'https://open.kakao.com/o/sR8A9fBi': '트레이 화면이 쓰지 않는다',
  };
  /** 이 시험 파일 기준 상대 경로 → 저장소 루트의 소스(실행 위치와 무관). */
  const SOURCES = ['../../src/data/links.ts', '../../src/lib/feedback.ts'];
  const found: Array<[string, string]> = SOURCES.flatMap((source) => {
    const text = readFileSync(new URL(source, import.meta.url), 'utf8');
    // 따옴표 · 공백 · 괄호 앞에서 끊는다. http 도 잡는다 — 허용 목록은 https 만 받으므로 http 리터럴은 결정을 요구한다.
    return (text.match(/https?:\/\/[^\s'"`<>)\\]+/g) ?? []).map((url): [string, string] => [source, url]);
  });

  it('소스에서 외부 주소를 찾았다(경로 · 정규식이 어긋나 빈 채로 통과하지 않게)', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(found)('%s 의 %s — 허용이거나 트레이 제외 목록에 있다', (_source, url) => {
    expect(externalHref(url) !== null || Object.hasOwn(TRAY_EXCLUDED, url)).toBe(true);
  });

  it('제외 목록의 주소는 허용 목록에 없고 소스에 실제로 있다(낡은 항목이 남지 않게)', () => {
    const urls = new Set(found.map(([, url]) => url));
    for (const url of Object.keys(TRAY_EXCLUDED)) {
      expect(externalHref(url)).toBeNull();
      expect(urls.has(url)).toBe(true);
    }
  });
});
