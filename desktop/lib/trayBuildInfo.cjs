'use strict';
// tray-build.json 검증(설계 §5.3 'main 은 fail-closed') — 앱 main 과 스모크 런처가 같은 함수로 읽는다.
// 모양은 scripts/trayBuild.ts 의 buildTrayBuildInfo 가 쓰는 것이다(계약 시험이 둘을 잇는다). TS 타입은 import 하지 않고
// 아래 @typedef 로 따로 적는다 — desktop 은 루트 TS 없이 plain node · Electron 으로 돈다.
// 하나라도 어긋나면 { ok: false } 다. 값을 고치거나 기본값을 넣지 않는다 — header 에 기본값이 들어가면
// 'undefined' 가 응답 헤더 문자열이 된다(검토 실측). 없는 commit 만 null 로 받는다(git 없는 빌드).

/**
 * @typedef {object} TrayBuildInfo
 * @property {{ meta: string, header: string }} csp 문서 meta 판 · 응답 헤더 판(= meta + frame-ancestors)
 * @property {string | null} supabaseOrigin connect-src 의 Supabase 출처. 값 없는 빌드는 null
 * @property {string | null} workerScript AI 워커 스크립트 출력 경로(assets/<이름>.js). 워커 청크가 없는 빌드는 null — 여기서는
 *   받지만 스모크의 cspHeader 가 실패시킨다(smoke/active.cjs). build:tray 는 경로를 적는다
 * @property {string} builtAt 빌드 시각(ISO)
 * @property {string | null} commit 빌드한 커밋(짧은 해시). git 이 없으면 null
 */
/** @typedef {{ ok: true, value: TrayBuildInfo } | { ok: false, error: string }} TrayBuildParse */

// 값 가드(객체 · 비어 있지 않은 문자열)는 스모크 판정기 · 평가기와 같은 것을 쓴다 — guards.cjs 한 곳에 둔다.
const { isNonEmptyString, isRecord } = require('./guards.cjs');

const FRAME_ANCESTORS = "; frame-ancestors 'none'";
const DEFAULT_SRC_NONE = "default-src 'none'";
/** 응답 헤더에 그대로 실릴 값이라 출력 가능한 ASCII(공백 ~ '~')만 받는다 — 줄바꿈 · 제어 문자는 헤더를 깬다. */
const HEADER_SAFE_RE = /^[\x20-\x7e]+$/;
const WORKER_SCRIPT_RE = /^assets\/[^\/\\]+\.js$/;

/**
 * 정책의 첫 default-src 지시문. 같은 지시문이 여럿이면 CSP 는 첫 것만 쓰고 뒤의 것은 무시한다.
 * @param {string} policy
 * @returns {string | undefined}
 */
function firstDefaultSrc(policy) {
  return policy
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => /^default-src(?:\s|$)/i.test(directive));
}

/**
 * @param {string} error
 * @returns {{ ok: false, error: string }}
 */
function fail(error) {
  return { ok: false, error };
}

/**
 * tray-build.json 본문을 검증해 값으로 돌려준다. throw 하지 않는다. 모르는 키는 값에 싣지 않는다.
 * 검사: csp.meta · csp.header 는 비어 있지 않은 문자열, meta 는 출력 가능한 ASCII 만 · 첫 default-src 는 'none',
 * header === meta + frame-ancestors, workerScript 는 null 이거나 assets/<이름>.js, 나머지는 TrayBuildInfo 의 타입.
 * @param {string} text
 * @returns {TrayBuildParse}
 */
function parseTrayBuild(text) {
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('JSON 이 아니다');
  }
  if (!isRecord(data)) return fail('최상위가 객체가 아니다');
  const csp = data.csp;
  if (!isRecord(csp)) return fail('csp 가 객체가 아니다');
  const { meta, header } = csp;
  if (!isNonEmptyString(meta)) return fail('csp.meta 가 빈 문자열이거나 문자열이 아니다');
  if (!isNonEmptyString(header)) return fail('csp.header 가 빈 문자열이거나 문자열이 아니다');
  if (!HEADER_SAFE_RE.test(meta)) return fail('csp.meta 에 출력 가능한 ASCII 밖 글자(줄바꿈 · 제어 문자 등)가 있다');
  if (firstDefaultSrc(meta) !== DEFAULT_SRC_NONE) {
    return fail(`csp.meta 의 첫 default-src 지시문이 ${DEFAULT_SRC_NONE} 이 아니다`);
  }
  if (header !== meta + FRAME_ANCESTORS) return fail(`csp.header 가 csp.meta + "${FRAME_ANCESTORS}" 와 다르다`);

  const { supabaseOrigin, workerScript, builtAt } = data;
  const commit = data.commit === undefined ? null : data.commit;
  if (supabaseOrigin !== null && typeof supabaseOrigin !== 'string') return fail('supabaseOrigin 이 문자열도 null 도 아니다');
  if (workerScript !== null && !(typeof workerScript === 'string' && WORKER_SCRIPT_RE.test(workerScript))) {
    return fail('workerScript 가 null 도 assets/<이름>.js 도 아니다');
  }
  if (!isNonEmptyString(builtAt)) return fail('builtAt 이 빈 문자열이거나 문자열이 아니다');
  if (commit !== null && typeof commit !== 'string') return fail('commit 이 문자열도 null 도 아니다');
  return { ok: true, value: { csp: { meta, header }, supabaseOrigin, workerScript, builtAt, commit } };
}

module.exports = { parseTrayBuild };
