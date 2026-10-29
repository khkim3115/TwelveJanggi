'use strict';
// 스모크 검사 평가(설계 §5.10 표) — 앱 안 실행기(desktop/smoke/run.cjs)가 모은 사실을 { ok, detail } 로 판정하는 순수 함수들.
// 사실을 모으는 일(Electron 호출)은 실행기가 하고 여기는 값만 본다 — 그래서 electron 없이 시험된다. electron 을 require 하지 않는다.
// 읽기는 엄격하다(반목표 1 '아무것도 증명하지 못한 채 통과' 를 막는다):
// - 기대한 값과 정확히 같을 때만 ok 다. 거짓처럼 보이는 값('true' · 1 · undefined)은 true/false 가 아니다.
// - 입력이 비었거나 모양이 틀리면 ok:false 다. 증거가 없다는 사실이 '통과' 가 되지 않는다.
// - detail 은 실패한 이유만 풀어 쓴다. 긴 목록은 앞 몇 건만 싣는다(요약 파일이 커지지 않게).

// 값 가드(객체 · 비어 있지 않은 문자열 · 값 표현)는 판정기(smokeResult)와 같은 것을 쓴다 — 복사본이 어긋나지 않게 guards.cjs 한 곳에 둔다.
const guards = require('./guards.cjs');

const { isNonEmptyString, isRecord } = guards;

/**
 * 검사 평가 결과 — 실행기가 { name, ok, detail } 로 checks 에 옮긴다.
 * @typedef {{ ok: boolean, detail: string }} CheckVerdict
 */

/** 스크린샷이 '비어 있지 않다' 고 보는 서로 다른 색의 최소 수. 단색(검은 화면)은 1이다. */
const MIN_SCREENSHOT_COLORS = 8;

/** detail 에 풀어 쓰는 항목 수 상한. */
const MAX_LISTED = 5;
/** 항목 하나를 detail 에 쓰는 글자 수 상한. */
const MAX_ITEM_CHARS = 120;

/** canary(마지막 단계의 막힌 fetch)가 만드는 위반의 모양 — 설계 §5.10 표 `cspCanary`. */
const CANARY_HOST = 'example.invalid';
const CANARY_DIRECTIVE = 'connect-src';
const CANARY_DISPOSITION = 'enforce';

/**
 * 보안 기본선 중 필수 — 설계 §5.10 표 `webPreferences`. 앱이 창을 만들 때 직접 넘기는 값이라 반드시 있고 정확히 같아야 한다(=== 비교).
 * 키가 없어도 실패다.
 * @type {readonly { key: string, value: boolean }[]}
 */
const REQUIRED_WEB_PREFERENCES = Object.freeze([
  { key: 'contextIsolation', value: true },
  { key: 'sandbox', value: true },
  { key: 'nodeIntegration', value: false },
]);

/**
 * 보안 기본선 중 기본값이 안전한 키. 앱은 이 값들을 넘기지 않아 getLastWebPreferences() 에 없을 수 있다 — 없으면 Electron 기본값이라
 * 통과이고, 키가 있으면 value 와 정확히 같아야 한다(=== 비교). value 는 Electron 의 기본값이다(electron.d.ts 44.9.3 의 WebPreferences
 * 문서: webSecurity 는 true, allowRunningInsecureContent · experimentalFeatures · nodeIntegrationInWorker · webviewTag 는 false.
 * nodeIntegrationInSubFrames 는 켜야만 동작하는 실험 옵션이고, enableBlinkFeatures 는 켤 기능의 목록이라 빈 문자열이 '켠 것 없음' 이다).
 * 순서는 통과 detail 의 목록 순서다.
 * @type {readonly { key: string, value: boolean | string }[]}
 */
const DEFAULT_SAFE_WEB_PREFERENCES = Object.freeze([
  { key: 'allowRunningInsecureContent', value: false },
  { key: 'experimentalFeatures', value: false },
  { key: 'enableBlinkFeatures', value: '' },
  { key: 'nodeIntegrationInWorker', value: false },
  { key: 'nodeIntegrationInSubFrames', value: false },
  { key: 'webSecurity', value: true },
  { key: 'webviewTag', value: false },
]);

/**
 * @param {string} detail
 * @returns {CheckVerdict}
 */
function pass(detail) {
  return { ok: true, detail };
}

/**
 * @param {string} detail
 * @returns {CheckVerdict}
 */
function fail(detail) {
  return { ok: false, detail };
}

/**
 * detail 에 쓰는 값 표현 — 문자열은 따옴표로 감싸고, 길면 MAX_ITEM_CHARS 에서 줄인다. 어떤 값이든 던지지 않는다.
 * @param {unknown} value
 * @returns {string}
 */
function repr(value) {
  return guards.repr(value, MAX_ITEM_CHARS);
}

/**
 * 항목 목록을 detail 에 쓸 글로 — 앞 MAX_LISTED 건만, 문자열은 그대로 · 그 밖은 JSON 으로.
 * @param {readonly unknown[]} items
 * @returns {string}
 */
function list(items) {
  const shown = items.slice(0, MAX_LISTED).map((item) => {
    if (typeof item !== 'string') return repr(item);
    return item.length > MAX_ITEM_CHARS ? `${item.slice(0, MAX_ITEM_CHARS)}…` : item;
  });
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} … 외 ${rest}건` : shown.join(', ');
}

// ── 정책 문자열 ───────────────────────────────────────────────────────────

/**
 * CSP 정책 문자열의 공백을 정리한다 — 연속 공백(줄바꿈 · 탭 포함)은 하나로, 앞뒤 공백은 없애고, 세미콜론 둘레는 '; ' 로 맞춘다.
 * securitypolicyviolation 의 originalPolicy 는 전달된 글(meta 속성 · 응답 헤더 값)이라 tray-build.json 의 글과 공백만 다를 수
 * 있다. 공백만 다룬다 — 글자 · 대소문자 · 지시문 순서는 그대로다. 문자열이 아니면 빈 문자열.
 * @param {string} s
 * @returns {string}
 */
function normalizePolicy(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').replace(/ ?; ?/g, '; ').trim();
}

// ── 검사 평가 ─────────────────────────────────────────────────────────────

/**
 * 값이 기대와 다른 키 하나를 detail 에 쓸 글로 — 키가 있으면 `키=값(기대 …)`, 없으면 `키 없음(기대 …)`.
 * 값이 undefined 로 있는 키와 키 자체가 없는 것을 가른다.
 * @param {Record<string, unknown>} prefs
 * @param {string} key
 * @param {boolean | string} expected
 * @returns {string}
 */
function describeWrongPreference(prefs, key, expected) {
  const actual = key in prefs ? `=${repr(prefs[key])}` : ' 없음';
  return `${key}${actual}(기대 ${repr(expected)})`;
}

/**
 * `webPreferences` — 창을 만들 때 쓴 설정(getLastWebPreferences)이 보안 기본선인가. 키를 두 갈래로 본다(값은 모두 === 로 비교한다):
 * - 필수(REQUIRED_WEB_PREFERENCES): contextIsolation · sandbox 는 true, nodeIntegration 은 false 여야 한다. 키가 없어도 실패다.
 * - 기본값이 안전한 키(DEFAULT_SAFE_WEB_PREFERENCES): 앱이 넘기지 않으므로 없으면 Electron 기본값이라 통과다. 키가 있으면
 *   값이 undefined 여도 안전한 값과 정확히 같아야 한다 — 없는 키만 기본값으로 본다.
 * 표에 없는 키는 보지 않는다. 실패하면 detail 에 틀린 키를 값과 함께 모두 싣는다. 통과하면 기본값 키 중 있는 것과 없는 것을 싣는다 —
 * getLastWebPreferences() 의 실제 모양(Electron 이 기본값을 채워 주는지)을 요약 파일에서 읽는 근거다.
 * @param {unknown} prefs getLastWebPreferences() 의 결과
 * @returns {CheckVerdict}
 */
function evaluateWebPreferences(prefs) {
  if (!isRecord(prefs)) return fail(`webPreferences 가 비었거나 객체가 아니다: ${repr(prefs)}`);

  /** @type {string[]} */
  const wrong = [];
  for (const { key, value } of REQUIRED_WEB_PREFERENCES) {
    if (prefs[key] !== value) wrong.push(describeWrongPreference(prefs, key, value));
  }
  /** @type {string[]} 있고 안전한 기본값 키 — `키=값` */
  const present = [];
  /** @type {string[]} 없는 기본값 키 */
  const missing = [];
  for (const { key, value } of DEFAULT_SAFE_WEB_PREFERENCES) {
    if (!(key in prefs)) missing.push(key);
    else if (prefs[key] === value) present.push(`${key}=${repr(value)}`);
    else wrong.push(describeWrongPreference(prefs, key, value));
  }
  if (wrong.length > 0) return fail(`webPreferences 가 기대와 다르다: ${wrong.join(', ')}`);

  const required = REQUIRED_WEB_PREFERENCES.map(({ key, value }) => `${key}=${repr(value)}`).join(' · ');
  return pass(`${required}; 기본값 키 — 있는 것: ${present.join(', ') || '없음'}; 없는 것(Electron 기본값): ${missing.join(', ') || '없음'}`);
}

/**
 * blockedURI 의 호스트 이름. URL 이 아니면 null.
 * @param {unknown} value
 * @returns {string | null}
 */
function hostOf(value) {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * 막힌 canary fetch 가 만드는 위반인가 — 호스트가 example.invalid 와 정확히 같고(부분 문자열 · 서브도메인 아님),
 * effectiveDirective 가 connect-src, disposition 이 enforce(보고 전용 아님).
 * @param {unknown} event
 * @returns {event is Record<string, unknown>}
 */
function isCanaryViolation(event) {
  return (
    isRecord(event) &&
    event.effectiveDirective === CANARY_DIRECTIVE &&
    event.disposition === CANARY_DISPOSITION &&
    hostOf(event.blockedURI) === CANARY_HOST
  );
}

/**
 * 위반 한 건을 이유에 쓸 글로 — 막힌 주소 · 지시문 · 처리.
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function describeViolation(event) {
  return `${repr(event.blockedURI)} (${repr(event.effectiveDirective)} · ${repr(event.disposition)})`;
}

/**
 * `cspCanary` — 마지막 단계에서 fetch('https://example.invalid/…') 를 CSP 로 막았을 때 받은 위반 이벤트들을 본다.
 * 문서 meta 와 응답 헤더, 두 전달 경로가 **둘 다** 집행돼야 하므로 위반은 정확히 2건이고(example.invalid · connect-src · enforce),
 * originalPolicy 가 한 건은 csp.meta · 한 건은 csp.header(공백 정규화)여야 한다. events 는 canary 단계에서 모은 위반 전부다 —
 * canary 가 아닌 위반이 끼어 있으면 그것도 실패다(그 단계의 위반은 이 둘뿐이어야 한다). csp.meta 와 csp.header 가 정규화하면
 * 같으면 두 경로를 가를 수 없어 실패다.
 * @param {unknown} events preload 가 모은 위반 이벤트 목록(blockedURI · effectiveDirective · originalPolicy · disposition 필드)
 * @param {unknown} csp tray-build.json 의 csp({ meta, header })
 * @returns {CheckVerdict}
 */
function evaluateCanary(events, csp) {
  if (!Array.isArray(events)) return fail(`events 가 배열이 아니다: ${repr(events)}`);
  if (!isRecord(csp) || !isNonEmptyString(csp.meta) || !isNonEmptyString(csp.header)) {
    return fail(`csp 가 비어 있지 않은 문자열 meta · header 를 가진 객체가 아니다: ${repr(csp)}`);
  }
  const metaPolicy = normalizePolicy(csp.meta);
  const headerPolicy = normalizePolicy(csp.header);
  if (metaPolicy === '' || headerPolicy === '') return fail('csp.meta · csp.header 가 공백뿐이다');
  if (metaPolicy === headerPolicy) return fail('csp.meta 와 csp.header 가 (공백을 정규화하면) 같다 — 두 전달 경로를 가를 수 없다');

  /** @type {unknown[]} */
  const unexpected = [];
  let metaCount = 0;
  let headerCount = 0;
  let otherCount = 0;
  for (const event of events) {
    if (!isCanaryViolation(event)) {
      // 무엇이 끼어들었는지 보이게 — 객체면 막힌 주소 · 지시문 · 처리, 객체가 아니면 그 값 자체.
      unexpected.push(isRecord(event) ? describeViolation(event) : event);
      continue;
    }
    const delivered = event.originalPolicy;
    const policy = typeof delivered === 'string' ? normalizePolicy(delivered) : '';
    if (policy === metaPolicy) metaCount += 1;
    else if (policy === headerPolicy) headerCount += 1;
    else otherCount += 1;
  }

  const problems = [];
  if (events.length !== 2) problems.push(`위반이 정확히 2건이어야 한다: ${events.length}건`);
  if (unexpected.length > 0) problems.push(`canary 가 아닌 위반 ${unexpected.length}건: ${list(unexpected)}`);
  if (metaCount !== 1) problems.push(`meta 정책의 위반이 ${metaCount}건이다(1건이어야 한다)`);
  if (headerCount !== 1) problems.push(`header 정책의 위반이 ${headerCount}건이다(1건이어야 한다)`);
  if (otherCount > 0) problems.push(`meta · header 어느 쪽도 아닌 정책의 위반 ${otherCount}건`);
  if (problems.length > 0) return fail(problems.join('; '));
  return pass(`${CANARY_HOST} 의 ${CANARY_DIRECTIVE} 위반 2건 — meta · header 정책이 한 건씩 집행됐다`);
}

/**
 * 요청 하나를 가르는 키 — 프로토콜 + 호스트 + 경로. 쿼리 · 해시 · 사용자 정보는 버리고(Supabase 소켓 URL 의 ?apikey=… 가
 * 요약에 남지 않는다), 기본 포트와 호스트의 대소문자는 URL 이 정리한다. URL 이 아니면 null.
 * Node 의 URL.origin 은 app: 같은 비특수 스킴에서 'null' 이라 쓰지 않는다 — 호스트가 다른 주소가 섞이면 안 된다.
 * @param {unknown} value
 * @returns {string | null}
 */
function endpointKey(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * `noNetwork` — 네트워크 가드가 기록한 요청이 기대 목록과 같은가. 기록한 키의 집합과 기대한 키의 집합이 같아야 통과다
 * (키 = 프로토콜 + 호스트 + 경로). 기본 기대 목록은 비어 있어 기록 0건이 통과이고, 한 건이라도 있으면 실패다. 기대한 요청이
 * 빠져도 실패다 — 가드가 기대한 요청을 못 봤다면 아무것도 증명하지 못한 것이다(부분집합이면 통과인 읽기가 아니다).
 * records 가 배열이 아니거나 URL 문자열이 아닌 기록이 있으면 실패다. 같은 요청이 여러 번 기록돼도 한 번으로 센다.
 * @param {unknown} records 가드가 기록한 요청 URL 들
 * @param {unknown} [expectedUrls] 기록돼야 하는 요청 URL 들(예: .invalid 빌드의 connectProbe 두 주소). 기본 빈 목록
 * @returns {CheckVerdict}
 */
function evaluateNoNetwork(records, expectedUrls = []) {
  if (!Array.isArray(records)) return fail(`records 가 배열이 아니다: ${repr(records)}`);
  if (!Array.isArray(expectedUrls)) return fail(`기대 목록이 배열이 아니다: ${repr(expectedUrls)}`);
  const badRecords = records.filter((record) => endpointKey(record) === null);
  if (badRecords.length > 0) return fail(`URL 이 아닌 기록이 ${badRecords.length}건 있다: ${list(badRecords)}`);
  const badExpected = expectedUrls.filter((url) => endpointKey(url) === null);
  if (badExpected.length > 0) return fail(`기대 목록에 URL 이 아닌 값이 있다: ${list(badExpected)}`);

  const seen = new Set(records.map((record) => /** @type {string} */ (endpointKey(record))));
  const expected = new Set(expectedUrls.map((url) => /** @type {string} */ (endpointKey(url))));
  const unexpected = [...seen].filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !seen.has(key));
  if (unexpected.length === 0 && missing.length === 0) {
    return pass(expected.size === 0 ? '네트워크 요청 0건' : `기대한 요청 ${expected.size}종만 기록됐다(${records.length}건)`);
  }
  const problems = [];
  if (unexpected.length > 0) problems.push(`기대 밖 요청 ${unexpected.length}종: ${list(unexpected)}`);
  if (missing.length > 0) problems.push(`기대했지만 기록되지 않은 요청 ${missing.length}종: ${list(missing)}`);
  return fail(problems.join('; '));
}

/**
 * '없었다' 를 보는 검사(securityWarnings · cspViolations · consoleErrors)의 공통 판정. 먼저 그 사건의 양성 기록을 봤어야 한다
 * (positiveSeen === true) — 수집기가 붙지 않았거나 사건이 아직 안 왔는데 음성이 0건인 것은 통과가 아니다(빈 통과 금지).
 * 그다음 음성 기록(negatives)이 0건이어야 한다.
 * @param {unknown} input `{ positiveSeen: boolean, negatives: unknown[] }`
 * @returns {CheckVerdict}
 */
function evaluateQuiet(input) {
  if (!isRecord(input)) return fail(`입력이 객체가 아니다: ${repr(input)}`);
  const { positiveSeen, negatives } = input;
  const problems = [];
  if (positiveSeen !== true) problems.push("양성 기록이 없다 — 그 사건이 일어난 것을 본 뒤에만 '없었다' 를 판정한다");
  if (!Array.isArray(negatives)) problems.push(`negatives 가 배열이 아니다: ${repr(negatives)}`);
  else if (negatives.length > 0) problems.push(`음성 기록 ${negatives.length}건: ${list(negatives)}`);
  if (problems.length > 0) return fail(problems.join('; '));
  return pass('양성 기록 확인 · 음성 0건');
}

/**
 * 비트맵에서 서로 다른 색의 수를 센다 — `screenshot` 검사가 검은 화면(단색)을 거르는 데 쓴다(MIN_SCREENSHOT_COLORS 와 견준다).
 * 비트맵은 픽셀마다 4바이트(Electron NativeImage.toBitmap() 의 BGRA)이고, 네 바이트 전부가 색이다(알파만 달라도 다른 색).
 * 4의 배수가 아닌 끝 바이트는 무시한다. step 은 픽셀 간격이다(기본 1 = 모든 픽셀) — 1 이상의 정수가 아니면 1 로 센다.
 * 바이트 배열이 아니거나 비어 있으면 0 이다.
 * @param {Uint8Array} bitmap
 * @param {number} [step] 센 픽셀 사이의 간격. 기본 1
 * @returns {number}
 */
function countDistinctColors(bitmap, step = 1) {
  if (!ArrayBuffer.isView(bitmap)) return 0;
  const stride = Number.isInteger(step) && step >= 1 ? step : 1;
  const pixels = Math.floor(bitmap.byteLength / 4);
  // Buffer 는 큰 풀의 일부일 수 있어 byteOffset 이 4의 배수가 아니다 — Uint32Array 가 아니라 DataView 로 읽는다.
  const view = new DataView(bitmap.buffer, bitmap.byteOffset, pixels * 4);
  /** @type {Set<number>} */
  const colors = new Set();
  for (let pixel = 0; pixel < pixels; pixel += stride) colors.add(view.getUint32(pixel * 4, true));
  return colors.size;
}

module.exports = {
  MIN_SCREENSHOT_COLORS,
  normalizePolicy,
  evaluateWebPreferences,
  evaluateCanary,
  evaluateNoNetwork,
  evaluateQuiet,
  countDistinctColors,
};
