'use strict';
// 스모크 판정(설계 §5.10) — 런처(desktop/scripts/smoke.cjs)가 앱이 쓴 result.json 과 자식 프로세스의 종료 상태를 보고 통과 · 실패를 가린다.
// 이 판정은 반목표 1('스모크가 아무것도 증명하지 못한 채 통과')을 막는 마지막 문이라 읽기가 엄격하다:
// - 통과는 값이 정확히 기대와 같을 때만이다. 거짓처럼 보이는 값('true' · 1) · null 종료 코드 · 빈 값끼리의 일치(nonce · 버전 · 출처가
//   둘 다 비어 같아 보임)는 통과가 아니다 — truthiness 로 읽지 않는다.
// - 필수 검사는 런처가 정한다(requiredChecks). result.required 는 앱이 적은 참고라 판정에 쓰지 않는다 — 앱이 요구를 줄일 수 없다.
// - 적용되는 이유는 모두 낸다(첫 하나에서 멈추지 않는다). 던지지 않는다: 어떤 입력이 와도 { ok, reasons } 를 돌려준다.
//   앱이 실패 단계에서 쓴 결과(smokeOut.failureResult — stage · error, checks 빈 목록)도 이유로 풀어 낸다.
// electron 을 require 하지 않는다.

// 값 가드(객체 · 비어 있지 않은 문자열 · 값 표현)는 검사 평가기(smokeChecks)와 같은 것을 쓴다 — 복사본이 어긋나지 않게 guards.cjs 한 곳에 둔다.
const guards = require('./guards.cjs');

const { isNonEmptyString, isRecord } = guards;

/**
 * 검사 한 건 — 앱 안 실행기가 검사마다 하나씩 checks 에 적는다.
 * @typedef {object} SmokeCheck
 * @property {string} name 검사 이름(BASE_REQUIRED 의 것 · connectAllowed · net)
 * @property {boolean} ok 통과했는가
 * @property {string} detail 사람이 읽는 근거 한 줄
 */
/**
 * 빌드 요약 — dist-tray/tray-build.json 에서 csp 를 뺀 것.
 * @typedef {object} SmokeBuild
 * @property {string | null} supabaseOrigin connect-src 의 Supabase 출처. 값 없는 빌드는 null
 * @property {string | null} workerScript AI 워커 스크립트 출력 경로
 * @property {string} builtAt 빌드 시각(ISO)
 * @property {string | null} commit 빌드한 커밋. git 이 없으면 null
 */
/**
 * 앱 안 실행기가 쓰는 결과 파일(desktop/smoke-out/result.json)의 성공 모양. 실패 단계의 결과(smokeOut.failureResult)는
 * { nonce, stage, error, checks: [], versions } 만 가진 부분집합이다 — judgeSmoke 는 두 모양 모두 받는다.
 * stage · error 는 앱이 실패를 보고할 때만 쓴다: 있으면(null 이 아니면) 나머지가 정상이어도 통과하지 못한다.
 * @typedef {object} SmokeResult
 * @property {string} nonce 런처가 준 이번 실행의 표식 — 지난 실행의 결과와 섞이지 않게 한다
 * @property {string[]} required 앱이 요구한 검사 이름. 참고용이다 — 판정의 필수는 런처가 requiredChecks 로 정한다
 * @property {SmokeCheck[]} checks 검사 결과
 * @property {import('./smokeOut.cjs').SmokeVersions} versions 실행한 바이너리의 버전
 * @property {SmokeBuild} build 빌드 요약
 * @property {boolean} boot 메모 필드: 앱이 떴는가
 * @property {number} cspViolations 메모 필드: CSP 위반 수
 * @property {string} aiWorker 메모 필드: AI 가 돈 길('worker' · 'fallback' · 'unused')
 * @property {boolean} aiAnswered 메모 필드: AI 가 수를 냈는가
 * @property {number} ms 메모 필드: 걸린 시간(ms)
 * @property {string} [stage] 실패한 단계
 * @property {string} [error] 실패 이유
 */

/**
 * 모든 스모크가 요구하는 검사 — 설계 §5.10 표에서 조건부 둘(connectAllowed · net)을 뺀 20개. 순서는 표를 따른다.
 * 얼려 있다 — 부르는 쪽이 고칠 수 없다(requiredChecks 는 복사본을 낸다).
 * @type {readonly string[]}
 */
const BASE_REQUIRED = Object.freeze([
  'boot',
  'webPreferences',
  'sandboxEffective',
  'bridge',
  'ipc',
  'cspMeta',
  'cspHeader',
  'mime',
  'protocol',
  'ai',
  'navigation',
  'permissions',
  'securityWarnings',
  'noNetwork',
  'loginItem',
  'tray',
  'screenshot',
  'cspViolations',
  'consoleErrors',
  'cspCanary',
]);

/** detail · 값 표현을 이유에 쓸 때의 글자 수 상한 — 전체는 result.json 에 있다. */
const MAX_REPR_CHARS = 200;
const MAX_DETAIL_CHARS = 300;

/**
 * 값이 있는가 — undefined · null 이 아니다. 빈 문자열은 있는 것이다.
 * @param {unknown} value
 * @returns {boolean}
 */
function present(value) {
  return value !== undefined && value !== null;
}

/**
 * 출처 값의 종류 — 문자열이거나 null(값 없는 빌드). undefined 는 아니다.
 * @param {unknown} value
 * @returns {value is string | null}
 */
function isOriginValue(value) {
  return value === null || typeof value === 'string';
}

/**
 * 이유에 쓰는 값 표현 — JSON 으로 쓰고 MAX_REPR_CHARS 에서 줄인다. 문자열은 따옴표가 붙어 '0' 과 0 이 구별된다. 어떤 값이든 던지지 않는다.
 * @param {unknown} value
 * @returns {string}
 */
function repr(value) {
  return guards.repr(value, MAX_REPR_CHARS);
}

/**
 * 이유에 그대로 싣는 글 — 문자열은 그대로, 그 밖의 값은 repr.
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value : repr(value);
}

/**
 * 빌드의 Supabase 출처가 .invalid 호스트(CI 의 가짜 값)인가 — src/tray/smoke.ts 의 invalidOrigins 와 같은 규칙이다:
 * URL 로 해석되고, 프로토콜이 https: 또는 http: 이고, 호스트 이름이 '.invalid' 로 끝난다. 페이지가 이 빌드에서 connectProbe 로
 * 요청을 시도하는지와 런처가 connectAllowed 를 요구하는지를 둘이 같은 말로 정한다. URL 이 호스트를 소문자로 만들고,
 * 끝에 점이 붙은 'ci.invalid.' 나 맨몸 'invalid' 는 '.invalid' 로 끝나지 않는다.
 * @param {unknown} value
 * @returns {boolean}
 */
function isInvalidHostOrigin(value) {
  if (!isNonEmptyString(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.endsWith('.invalid');
}

/**
 * @typedef {object} RequiredOptions
 * @property {boolean} [net] --net 실행인가 — true 일 때만 net 검사를 요구한다
 * @property {string | null} [supabaseOrigin] 빌드의 Supabase 출처(tray-build.json). .invalid 호스트면 connectAllowed 를 요구한다
 */

/**
 * 이번 실행이 요구하는 검사 이름 — BASE_REQUIRED 20개 + (.invalid 빌드면) connectAllowed + (--net 이면) net. 런처가 자기 값으로
 * 정한다. 호출마다 새 배열이다.
 * @param {RequiredOptions} [options]
 * @returns {string[]}
 */
function requiredChecks({ net, supabaseOrigin } = {}) {
  const names = [...BASE_REQUIRED];
  if (isInvalidHostOrigin(supabaseOrigin)) names.push('connectAllowed');
  if (net === true) names.push('net');
  return names;
}

/**
 * @typedef {object} JudgeInput
 * @property {unknown} result 앱이 쓴 result.json 을 읽은 값. 파일이 없거나 읽지 못했으면 null
 * @property {number | null} exitCode 자식의 종료 코드. 신호로 끝났으면 null
 * @property {string | null} signal 자식을 끝낸 신호 이름. 신호가 아니면 null
 * @property {boolean} timedOut 하드 타임아웃을 넘겨 런처가 끝냈는가
 * @property {string} nonce 런처가 이번 실행에 정한 표식
 * @property {boolean} net --net 실행인가
 * @property {string} expectedElectron 런처가 설치된 electron 패키지에서 읽은 버전(require('electron/package.json').version)
 * @property {string | null} expectedSupabaseOrigin 런처가 dist-tray/tray-build.json 에서 읽은 supabaseOrigin
 * @property {readonly string[]} newSmokeDirs 실행 뒤 os.tmpdir() 에 새로 생긴 tj-smoke-* 폴더 이름
 */
/**
 * @typedef {object} Verdict
 * @property {boolean} ok 통과인가 — 이유가 하나도 없을 때만 true
 * @property {string[]} reasons 실패 이유. 적용되는 것을 모두 담는다
 */

/**
 * 한 검사 항목이 ok 가 아닐 때의 이유.
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function describeFailure(entry) {
  const note = entry.ok === false ? '' : ` (ok=${repr(entry.ok)}, true 가 아니다)`;
  const detail = typeof entry.detail === 'string' && entry.detail !== '' ? entry.detail : null;
  const shown = detail === null ? '' : ` — ${detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail}`;
  return `검사 실패: ${text(entry.name)}${note}${shown}`;
}

/**
 * 결과 객체를 런처가 아는 값과 맞춰 본다 — 이유를 reasons 에 더한다.
 * @param {Record<string, unknown>} result
 * @param {Record<string, unknown>} given judgeSmoke 의 입력
 * @param {string[]} reasons
 * @returns {void}
 */
function judgeResult(result, given, reasons) {
  // 앱이 스스로 실패를 보고했다(실패 단계의 결과 · 실행기의 fail). 나머지가 정상이어도 통과가 아니다.
  if (present(result.stage) || present(result.error)) {
    const stage = present(result.stage) ? text(result.stage) : '(없음)';
    const error = present(result.error) ? text(result.error) : '(없음)';
    reasons.push(`앱이 실패를 보고했다: stage=${stage}, error=${error}`);
  }

  // 이번 실행의 결과인가 — 지난 실행의 result.json 이 남아 있어도 nonce 가 다르다. 양쪽이 비어 있으면 같아 보여도 불일치다.
  if (!(isNonEmptyString(given.nonce) && result.nonce === given.nonce)) {
    reasons.push(`nonce 불일치: 런처 ${repr(given.nonce)}, 결과 ${repr(result.nonce)}`);
  }

  // 고정한 바이너리로 돌았는가.
  const electron = isRecord(result.versions) ? result.versions.electron : undefined;
  if (!(isNonEmptyString(given.expectedElectron) && electron === given.expectedElectron)) {
    reasons.push(`electron 불일치: 기대 ${repr(given.expectedElectron)}, 결과 ${repr(electron)}`);
  }

  // 런처가 읽은 빌드로 돌았는가. null(값 없는 빌드)끼리는 같지만 undefined(빠짐)는 아니다.
  const expectedOrigin = given.expectedSupabaseOrigin;
  const origin = isRecord(result.build) ? result.build.supabaseOrigin : undefined;
  if (!(isOriginValue(expectedOrigin) && origin === expectedOrigin)) {
    reasons.push(`build.supabaseOrigin 불일치: 기대 ${repr(expectedOrigin)}, 결과 ${repr(origin)}`);
  }

  // 필수 검사는 런처 값으로 정한다 — result.required 는 보지 않는다.
  const required = requiredChecks({
    net: given.net === true,
    supabaseOrigin: typeof expectedOrigin === 'string' ? expectedOrigin : null,
  });
  const checks = result.checks;
  if (!Array.isArray(checks)) reasons.push(`checks 가 배열이 아니다: ${repr(checks)}`);
  /** @type {Set<string>} 이름이 있는 항목의 이름 */
  const named = new Set();
  /** @type {number[]} */
  const malformed = [];
  /** @type {string[]} */
  const failed = [];
  (Array.isArray(checks) ? checks : []).forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      malformed.push(index);
      return;
    }
    named.add(entry.name);
    // 통과는 불리언 true 뿐이다 — 'true' · 1 · 빠진 ok 는 실패다. 필수가 아닌 검사도 같다.
    if (entry.ok !== true) failed.push(describeFailure(entry));
  });
  if (malformed.length > 0) reasons.push(`검사 항목의 모양이 틀렸다(이름이 있는 객체가 아니다): #${malformed.join(', #')}`);
  const missing = required.filter((name) => !named.has(name));
  if (missing.length > 0) reasons.push(`필수 검사 누락 ${missing.length}개: ${missing.join(', ')}`);
  reasons.push(...failed);
}

/**
 * 스모크 한 번의 통과 · 실패를 가린다. 아래가 **모두 참**일 때만 ok 다:
 * - 시간 초과가 아니고, 신호로 끝나지 않았고, 종료 코드가 0 이다(null · '0' · NaN 은 0 이 아니다).
 * - result 가 객체이고, 앱이 실패(stage · error)를 보고하지 않았다.
 * - result.nonce 가 런처의 nonce 와 같고(양쪽 다 비어 있지 않다), versions.electron 이 기대와 같고,
 *   build.supabaseOrigin 이 런처가 읽은 값과 같다.
 * - 필수 검사(requiredChecks)가 모두 있고, 보고된 검사는 모두 ok === true 다(필수가 아닌 것도).
 * - 실행 뒤 새 tj-smoke-* 폴더가 없다.
 * 실패 이유는 적용되는 것을 모두 낸다. 던지지 않는다.
 * @param {JudgeInput} input
 * @returns {Verdict}
 */
function judgeSmoke(input) {
  // 호출 실수(입력이 객체가 아님)에도 던지지 않고 이유를 낸다.
  const given = /** @type {Record<string, unknown>} */ (isRecord(input) ? input : {});
  /** @type {string[]} */
  const reasons = [];

  // 자식이 어떻게 끝났는가. 런처가 주는 값도 기대한 모양(불리언 · 0)이 아니면 모른다는 뜻이라 실패다.
  if (given.timedOut === true) reasons.push('시간 초과: 하드 타임아웃을 넘겨 런처가 앱을 끝냈다');
  else if (given.timedOut !== false) reasons.push(`timedOut 이 boolean 이 아니다: ${repr(given.timedOut)}`);
  if (present(given.signal)) reasons.push(`신호로 끝났다: ${text(given.signal)}`);
  if (given.exitCode !== 0) reasons.push(`종료 코드가 0 이 아니다: ${repr(given.exitCode)}`);
  if (given.net !== true && given.net !== false) reasons.push(`net 이 boolean 이 아니다: ${repr(given.net)}`);

  // 앱이 쓴 결과.
  const result = given.result;
  if (isRecord(result)) {
    judgeResult(result, given, reasons);
  } else if (!present(result)) {
    reasons.push('result 가 없다: result.json 이 없거나 읽을 수 없었다');
  } else {
    reasons.push(`result 가 객체가 아니다: ${Array.isArray(result) ? '배열' : typeof result}`);
  }

  // 실행 뒤 임시 폴더 — 비교를 못 했으면(배열이 아님) 없다고 말할 수 없다.
  const leftover = given.newSmokeDirs;
  if (!Array.isArray(leftover)) reasons.push(`newSmokeDirs 가 배열이 아니다: ${repr(leftover)}`);
  else if (leftover.length > 0) reasons.push(`실행 뒤 임시 폴더가 남았다(새 tj-smoke-*): ${leftover.map((name) => text(name)).join(', ')}`);

  return { ok: reasons.length === 0, reasons };
}

module.exports = { BASE_REQUIRED, requiredChecks, judgeSmoke };
