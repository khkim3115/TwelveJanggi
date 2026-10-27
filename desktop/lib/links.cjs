'use strict';
// 시스템 브라우저로 여는 외부 주소의 허용 목록(설계 §5.7). 탐색 가드와 window.open 처리기가 같은 함수로 거른다.
// - https 만, 사용자 정보 없음. 호스트는 URL 파서가 정규화한 url.host(포트 포함)와 정확히 같아야 한다.
//   khkim3115.github.io 는 경로 무관, github.com 은 이 저장소(/khkim3115/TwelveJanggi 와 그 아래)만이다. 경로는 대소문자 그대로 본다.
// - 여는 값은 입력 문자열이 아니라 파서가 만든 href 다 — 거른 값과 여는 값이 같다.
// - src/data/links.ts · src/lib/feedback.ts 의 외부 주소가 여기 있는지(또는 트레이 제외로 적혔는지)는 links.test.ts 가 본다.
// 이 파일은 electron 을 require 하지 않는다.

const HUB_HOST = 'khkim3115.github.io';
const GITHUB_HOST = 'github.com';
const REPO_PATH = '/khkim3115/TwelveJanggi';

/**
 * 시스템 브라우저로 열어도 되는 주소면 그 href 를, 아니면 null.
 * @param {string} url
 * @returns {string | null}
 */
function externalHref(url) {
  if (typeof url !== 'string') return null;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null; // 상대 주소 · 깨진 주소
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.host === HUB_HOST) return parsed.href;
  // '/khkim3115/TwelveJanggiX' 는 저장소가 아니다 — 같거나 '/' 로 이어질 때만. 점 세그먼트는 파서가 이미 접었다.
  if (parsed.host === GITHUB_HOST && (parsed.pathname === REPO_PATH || parsed.pathname.startsWith(`${REPO_PATH}/`))) {
    return parsed.href;
  }
  return null;
}

module.exports = { externalHref };
