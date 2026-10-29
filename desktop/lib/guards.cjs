'use strict';
// 값 가드 — 믿을 수 없는 입력(앱이 쓴 result.json · 페이지가 보낸 위반 이벤트 · tray-build.json)을 읽는 모듈들이 같이 쓰는 작은 도우미.
// 판정기(smokeResult) · 평가기(smokeChecks) · 파서(trayBuildInfo)가 '객체' · '비어 있지 않은 문자열' · '표시할 수 있는 값' 을 같은 말로
// 정하도록 한 곳에 둔다 — 복사본이 어긋나면 한쪽은 통과시키고 한쪽은 막는 틈이 생긴다. 다음 모듈(런처 · 앱 안 실행기)도 여기서 가져다 쓴다.
// 의존이 없다 — electron 은 물론 node 내장 모듈도 require 하지 않는다.

/**
 * 객체인가 — null 도 배열도 아니다. 순수 객체만 보는 것이 아니라서 클래스 인스턴스도 객체다.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 비어 있지 않은 문자열인가 — 공백뿐인 글은 비어 있지 않다.
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * 이유 · 설명에 쓰는 값 표현 — JSON 으로 쓰고(문자열은 따옴표가 붙어 '0' 과 0 이 구별된다), JSON 이 못 하는 값(undefined · 함수 ·
 * 순환 객체 · BigInt)은 String() 으로 쓰고, 그것도 못 하면 자리 표시 문구를 낸다. 글이 maxChars 를 넘으면 그 글자 수에서 자르고
 * … 를 붙인다. 어떤 값이든 던지지 않는다(믿을 수 없는 입력이라 getter · Proxy 가 던질 수 있다).
 * 상한은 부르는 쪽이 정한다 — 모듈마다 요약 파일에 싣는 길이가 다르다.
 * @param {unknown} value
 * @param {number} maxChars 줄이기 전에 남기는 글자 수(… 는 더 붙는다)
 * @returns {string}
 */
function repr(value, maxChars) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    try {
      text = String(value);
    } catch {
      text = '(표시할 수 없는 값)';
    }
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

module.exports = { isRecord, isNonEmptyString, repr };
