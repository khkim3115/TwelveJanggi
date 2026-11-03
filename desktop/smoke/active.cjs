'use strict';
// 능동 검사(설계 §5.10 표) — 실행기(run.cjs)가 수동 검사 뒤에 부른다. 페이지 · 메인에서 요청과 동작을 일으키고, 그 결과와 수집기 · 가드 ·
// 결정 기록에 쌓인 사실로 판정한다. 같은 값을 보는 판정은 lib/smokeChecks.cjs 의 평가기를 쓴다.
// - 순서: cspMeta · cspHeader · protocol · ai · navigation · permissions · (.invalid 빌드) connectAllowed · (--net) net → 실행기의 장벽 →
//   cspViolations · consoleErrors → cspCanary(마지막 단계). noNetwork · loginItem 은 그 뒤에 실행기가 본다.
// - '없었다' 를 보는 판정은 그 사건의 양성 기록(결정 기록 · 탐색의 끝 did-stop-loading · 장벽 표식 · 가드 기록)을 먼저 기다린다.
// - 페이지 호출의 실패(던짐 · 상한)는 그 검사의 실패 단계(check:<이름>)가 된다 — 실행기의 check 가 받는다.
// electron 을 require 하지 않는다 — Electron 객체(net · webContents)는 실행기가 넘긴다.

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { APP_ORIGIN, ENTRY_FILE, ENTRY_URL, MIME } = require('../lib/appProtocol.cjs');
const { isRecord } = require('../lib/guards.cjs');
const { ALLOWED_PERMISSIONS } = require('../lib/permissions.cjs');
const { evaluateCanary, evaluateNoNetwork, evaluateQuiet, normalizePolicy } = require('../lib/smokeChecks.cjs');
const {
  AI_SCRIPT,
  CONNECT_PROBE_SCRIPT,
  CSP_META_SCRIPT,
  ISOLATED_BUFFER_CODE,
  LOCATION_SCRIPT,
  NET_SCRIPT,
  canaryScript,
  headersScript,
  navigateScript,
  permissionsScript,
  protocolScript,
  windowOpenScript,
} = require('./pageScripts.cjs');
const { PAGE_MS, SMOKE_URL, WAIT_MS, isStringList, rejectionText, sameList, settleWithin, show, until, verdictOf } = require('./support.cjs');

/** ai() 의 상한 — 페이지의 ai() 는 스스로 10초에 끊고 결과로 보고한다. 그 보고를 받도록 그보다 길게 둔다. */
const AI_PAGE_MS = 15_000;
/** net() 의 상한 — 설정 GET 은 페이지 안 상한이 없고 join 은 10초, 정리는 라이브러리의 시간 제한까지다. 감시 타이머(60초)만 남지 않게 여기서 끊는다. */
const NET_PAGE_MS = 30_000;
/** 권한 검사의 위치 요청을 페이지가 기다리는 상한. */
const GEOLOCATION_MS = 3_000;
/** 위치 요청이 거부됐을 때 페이지가 돌려주는 값(GeolocationPositionError.PERMISSION_DENIED = 1). */
const GEOLOCATION_DENIED = 'error 1';
/** 탐색 검사 — 허용 목록 밖 · 안의 메인 프레임 탐색과 새 창. 막혀서 요청은 나가지 않는다. */
const BLOCKED_NAVIGATION_URL = 'https://example.invalid/';
const ALLOWED_NAVIGATION_URL = 'https://khkim3115.github.io/';
const BLOCKED_POPUP_URL = 'https://example.invalid/tj-window-open';
const ALLOWED_POPUP_URL = 'https://github.com/khkim3115/TwelveJanggi';
/** 탈출 검사 — 렌더러 루트 바로 위의 실제 파일(개발: <repo>/package.json)을 네 가지 인코딩으로 겨냥한다. */
const ESCAPE_TARGET = 'package.json';
const ESCAPES = Object.freeze(['..%2f', '%2e%2e%5c', '..%5c', '%2e%2e%2f']);
/** 없는 파일 · 디렉터리 · 내주지 않는 빌드 정보 — 모두 404 여야 한다. */
const MISSING_FILE = 'tj-smoke-missing.js';
const DIRECTORY = 'assets';
const TRAY_BUILD_FILE = 'tray-build.json';
/** 다른 호스트 — 페이지에서 fetch 하면 connect-src 가 막아 위반이 되므로 메인 쪽(net.fetch)에서 보낸다. */
const OTHER_HOST_URL = 'app://other/tray.html';
/** canary — CSP 가 막아야 하는 주소(설계 §5.10 cspCanary). */
const CANARY_URL = 'https://example.invalid/tj-csp-canary';
/** canary 단계에서 받아 주는 콘솔 오류 수(설계: 최대 3건). */
const CANARY_MAX_CONSOLE_ERRORS = 3;
/** Chromium 의 CSP 콘솔 줄에 드는 글. */
const CSP_CONSOLE_TEXT = 'Content Security Policy';
/**
 * 권한 검사가 기다리는 결정 기록 — check 경로(permissions.query · Notification.permission)와 request 경로(Notification.requestPermission ·
 * 위치 요청). 클립보드 쓰기 요청은 포커스가 필요해 check 경로만 본다(설계 §5.10).
 * @type {readonly { kind: 'permission-check' | 'permission-request', permission: string, allowed: boolean }[]}
 */
const EXPECTED_DECISIONS = Object.freeze([
  { kind: 'permission-check', permission: 'notifications', allowed: true },
  { kind: 'permission-check', permission: 'geolocation', allowed: false },
  { kind: 'permission-check', permission: 'clipboard-sanitized-write', allowed: true },
  { kind: 'permission-request', permission: 'notifications', allowed: true },
  { kind: 'permission-request', permission: 'geolocation', allowed: false },
]);

/** @typedef {import('./support.cjs').ConsoleEntry} ConsoleEntry */
/** @typedef {import('./support.cjs').DecisionRecord} DecisionRecord */
/** @typedef {import('../lib/navigation.cjs').NavigationRecord} NavigationRecord */
/** @typedef {import('../main.js').PermissionRecord} PermissionRecord */
/** @typedef {import('../lib/smokeChecks.cjs').CheckVerdict} CheckVerdict */
/**
 * 페이지 호출의 선택.
 * @typedef {object} PageOptions
 * @property {number} [ms] 상한(기본 PAGE_MS)
 * @property {boolean} [userGesture] 사용자 제스처로 돌린다 — 새 창 · 권한 요청을 링크 · 단추를 누른 것과 같은 길로 낸다
 */
/**
 * 장벽 한 번의 결과.
 * @typedef {object} BarrierResult
 * @property {unknown} info getAppInfo() 의 답
 * @property {boolean} markerSeen 표식을 콘솔 수집기가 받았다
 */
/**
 * 능동 검사가 실행기에서 받는 것.
 * @typedef {object} ActiveContext
 * @property {import('./support.cjs').SmokeFacts} facts 수집한 사실
 * @property {import('../lib/trayBuildInfo.cjs').TrayBuildInfo} trayBuild 검증한 tray-build.json
 * @property {string} rendererRoot 렌더러 루트(개발 <repo>/dist-tray)
 * @property {import('electron').Net} net 메인 쪽 요청
 * @property {import('./remote.cjs').RemotePlan} plan 이번 실행의 원격 요청 계획
 * @property {() => import('electron').WebContents} contents 트레이 창의 webContents
 * @property {(code: string, what: string, options?: PageOptions) => Promise<unknown>} page main world 에서 돌린 값(상한이 있다)
 * @property {(code: string, what: string) => Promise<unknown>} isolated preload 의 격리 world 에서 돌린 값(상한이 있다)
 * @property {() => Promise<BarrierResult>} barrier 장벽 — getAppInfo 왕복 뒤 콘솔 표식
 */
/**
 * 결과의 메모 필드 중 능동 검사가 재는 것.
 * @typedef {object} ActiveMemo
 * @property {string} aiWorker ai() 가 보고한 길
 * @property {boolean} aiAnswered
 * @property {number} ms
 * @property {number} cspViolations canary 단계 전의 위반 수
 */

/**
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 파일 이름의 Content-Type — 처리기가 쓰는 확장자 표(appProtocol 의 MIME). 표에 없으면 null.
 * @param {string} file
 * @returns {string | null}
 */
function mimeOf(file) {
  const ext = path.posix.extname(file).toLowerCase();
  return Object.hasOwn(MIME, ext) ? MIME[ext] : null;
}

/**
 * URL 의 호스트(포트 포함). URL 이 아니면 null.
 * @param {unknown} value
 * @returns {string | null}
 */
function hostOf(value) {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * 위반 한 건을 이유에 쓸 글로 — 막힌 주소 · 지시문.
 * @param {unknown} event
 * @returns {string}
 */
function violationText(event) {
  return isRecord(event) ? `위반 ${show(event.blockedURI)} (${show(event.effectiveDirective)})` : `위반 ${show(event)}`;
}

/**
 * @param {DecisionRecord} entry
 * @returns {entry is NavigationRecord}
 */
function isNavigationRecord(entry) {
  return entry.kind !== 'permission-check' && entry.kind !== 'permission-request';
}

/**
 * @param {DecisionRecord} entry
 * @returns {entry is PermissionRecord}
 */
function isPermissionRecord(entry) {
  return entry.kind === 'permission-check' || entry.kind === 'permission-request';
}

/**
 * 막는 결정이어야 하는 기록 중 틀린 것 — 막지 않았거나 여는 값(href)이 기대와 다르다.
 * @param {readonly NavigationRecord[]} records
 * @param {string | null} href 허용 목록 주소면 그 href, 아니면 null
 * @returns {string[]}
 */
function wrongDecisions(records, href) {
  return records
    .filter((record) => record.blocked !== true || record.href !== href)
    .map((record) => `${record.kind} ${record.url} 의 결정이 ${show({ blocked: record.blocked, href: record.href })} 다(기대 blocked true · href ${show(href)})`);
}

/**
 * 능동 검사 한 벌을 만든다. 검사마다 판정({ ok, detail })을 돌려주는 함수이고, memo() 는 결과의 메모 필드다.
 * @param {ActiveContext} ctx
 */
function createActiveChecks(ctx) {
  const { facts, trayBuild, rendererRoot, plan } = ctx;
  const state = {
    /** @type {ActiveMemo['aiWorker']} */
    aiWorker: 'unused',
    aiAnswered: false,
    ms: 0,
    /** @type {number | null} canary 단계를 시작할 때의 위반 수 */
    canaryMark: null,
  };

  /**
   * 콘솔 error 가 .invalid 빌드의 connectProbe 가 시도한(가드가 취소한) 요청의 오류인가 — 줄에 두 주소 중 하나가 든다.
   * @param {ConsoleEntry} entry
   * @returns {boolean}
   */
  function isProbeError(entry) {
    const probes = plan.connectProbe;
    return probes !== null && probes.some((url) => entry.message.includes(url));
  }

  /**
   * 격리 world 를 읽어 preload 가 보낸 위반 목록과 맞춰 본다 — 표식(__tjIsoProbe === 1)이 있고, 버퍼(__tjCspBuffer)가 보낸 목록과 같아야
   * 한다(유실 없음). 문제 목록을 돌려준다.
   * @returns {Promise<string[]>}
   */
  async function bufferProblems() {
    const seen = await ctx.isolated(ISOLATED_BUFFER_CODE, 'CSP 버퍼');
    if (!isRecord(seen)) return [`격리 world 사실이 객체가 아니다: ${show(seen)}`];
    /** @type {string[]} */
    const problems = [];
    if (seen.probe !== 1) problems.push(`격리 world 표식 __tjIsoProbe 가 ${show(seen.probe)} 다(기대 1 — preload 의 격리 world 를 읽지 못했다)`);
    if (!Array.isArray(seen.buf)) problems.push(`격리 world 버퍼 __tjCspBuffer 가 배열이 아니다: ${show(seen.buf)}`);
    else if (!isDeepStrictEqual(seen.buf, facts.cspEvents)) {
      problems.push(`격리 world 버퍼(${seen.buf.length}건)가 preload 가 보낸 목록(${facts.cspEvents.length}건)과 다르다 — 유실`);
    }
    return problems;
  }

  /**
   * cspMeta — 문서의 CSP meta 가 하나이고 <head> 안에 있으며, content 가 tray-build.json 의 csp.meta 와 같다(공백 정규화).
   * @returns {Promise<CheckVerdict>}
   */
  async function cspMeta() {
    const seen = await ctx.page(CSP_META_SCRIPT, 'CSP meta');
    if (!isRecord(seen) || !isStringList(seen.contents) || !Array.isArray(seen.inHead)) {
      return verdictOf([`페이지 사실이 { contents, inHead } 가 아니다: ${show(seen)}`], '');
    }
    const { contents, inHead } = seen;
    /** @type {string[]} */
    const problems = [];
    if (contents.length !== 1) problems.push(`CSP meta 가 ${contents.length}개다(1개여야 한다): ${show(contents)}`);
    else if (normalizePolicy(contents[0]) !== normalizePolicy(trayBuild.csp.meta)) problems.push(`CSP meta 의 content 가 csp.meta 와 다르다: ${show(contents[0])}`);
    if (inHead.some((inside) => inside !== true)) problems.push('CSP meta 가 <head> 밖에 있다');
    return verdictOf(problems, '문서의 CSP meta 1개(<head>) = tray-build.json 의 csp.meta(공백 정규화)');
  }

  /**
   * cspHeader — tray.html 과 AI 워커 스크립트(workerScript)를 페이지에서 같은 출처 fetch 로 받아 응답 헤더를 본다: 200 ·
   * Content-Security-Policy = csp.header(공백 정규화) · X-Content-Type-Options nosniff · Content-Type = 처리기의 확장자 표 값. 워커는 문서의
   * meta 를 물려받지 않고 자기 응답 헤더를 따르므로 둘 다 본다. workerScript 가 null 이면 실패다.
   * @returns {Promise<CheckVerdict>}
   */
  async function cspHeader() {
    const { workerScript } = trayBuild;
    if (workerScript === null) return verdictOf(['tray-build.json 의 workerScript 가 null 이다 — AI 워커 스크립트의 응답 헤더를 볼 수 없다'], '');
    const targets = [
      { url: ENTRY_URL, contentType: mimeOf(ENTRY_FILE) },
      { url: `${APP_ORIGIN}/${workerScript}`, contentType: mimeOf(workerScript) },
    ];
    const seen = await ctx.page(headersScript(targets.map((target) => target.url)), '응답 헤더');
    if (!Array.isArray(seen)) return verdictOf([`페이지 사실이 응답 목록이 아니다: ${show(seen)}`], '');
    const header = normalizePolicy(trayBuild.csp.header);
    /** @type {string[]} */
    const problems = [];
    for (const { url, contentType } of targets) {
      const response = seen.find((entry) => isRecord(entry) && entry.url === url);
      if (!isRecord(response)) {
        problems.push(`${url}: 응답이 없다`);
        continue;
      }
      if (response.error !== undefined) {
        problems.push(`${url}: fetch 가 실패했다(${show(response.error)})`);
        continue;
      }
      if (response.status !== 200) problems.push(`${url}: 상태가 ${show(response.status)} 다(기대 200)`);
      if (typeof response.csp !== 'string' || normalizePolicy(response.csp) !== header) {
        problems.push(`${url}: Content-Security-Policy 가 csp.header 와 다르다(${show(response.csp)})`);
      }
      if (response.nosniff !== 'nosniff') problems.push(`${url}: X-Content-Type-Options 가 ${show(response.nosniff)} 다(기대 "nosniff")`);
      if (response.contentType !== contentType) problems.push(`${url}: Content-Type 이 ${show(response.contentType)} 다(기대 ${show(contentType)})`);
    }
    return verdictOf(
      problems,
      `${targets.map(({ url, contentType }) => `${url}(${contentType})`).join(' · ')} — 200 · Content-Security-Policy = csp.header(공백 정규화) · nosniff`,
    );
  }

  /**
   * protocol — app:// 처리기가 루트 밖을 내주지 않는다. 전제: 렌더러 루트 바로 위에 실제 파일(package.json)이 있고, 디렉터리 · tray-build.json 은
   * 있고, 없는 파일은 없다(없는 것을 겨냥한 404 는 아무것도 증명하지 못한다). 페이지의 같은 출처 fetch: 그 파일을 겨냥한 인코딩 탈출 넷 ·
   * 없는 파일 · 디렉터리 · tray-build.json → 404, tray.html 에 POST → 405. 메인의 net.fetch(app://other/tray.html) → 404.
   * @returns {Promise<CheckVerdict>}
   */
  async function protocol() {
    /** @type {string[]} */
    const problems = [];
    const target = path.join(path.dirname(rendererRoot), ESCAPE_TARGET);
    if (!isFile(target)) problems.push(`탈출 검사가 겨냥할 파일이 없다: ${target} — 렌더러 루트 바로 위의 실제 파일이어야 404 가 탈출을 막았다는 뜻이 된다`);
    if (!isDirectory(path.join(rendererRoot, DIRECTORY))) problems.push(`디렉터리 검사가 겨냥할 ${path.join(rendererRoot, DIRECTORY)} 가 디렉터리가 아니다`);
    if (!isFile(path.join(rendererRoot, TRAY_BUILD_FILE))) problems.push(`${TRAY_BUILD_FILE} 검사가 겨냥할 파일이 렌더러 루트에 없다`);
    if (fs.existsSync(path.join(rendererRoot, MISSING_FILE))) problems.push(`없어야 할 ${MISSING_FILE} 가 렌더러 루트에 있다`);
    const cases = [
      ...ESCAPES.map((escape) => ({ label: `${escape}${ESCAPE_TARGET}`, url: `${APP_ORIGIN}/${escape}${ESCAPE_TARGET}`, method: 'GET', status: 404 })),
      { label: '없는 파일', url: `${APP_ORIGIN}/${MISSING_FILE}`, method: 'GET', status: 404 },
      { label: '디렉터리', url: `${APP_ORIGIN}/${DIRECTORY}`, method: 'GET', status: 404 },
      { label: TRAY_BUILD_FILE, url: `${APP_ORIGIN}/${TRAY_BUILD_FILE}`, method: 'GET', status: 404 },
      { label: 'POST', url: ENTRY_URL, method: 'POST', status: 405 },
    ];
    const seen = await ctx.page(protocolScript(cases.map(({ url, method }) => ({ url, method }))), 'app:// 요청');
    if (!Array.isArray(seen)) {
      problems.push(`페이지 사실이 응답 목록이 아니다: ${show(seen)}`);
    } else {
      for (const { label, url, method, status } of cases) {
        const got = seen.find((entry) => isRecord(entry) && entry.url === url && entry.method === method);
        if (isRecord(got) && got.error === undefined && got.status === status) continue;
        const actual = !isRecord(got) ? '응답 없음' : got.error !== undefined ? got.error : got.status;
        problems.push(`${label}: ${method} ${url} 의 상태가 ${show(actual)} 다(기대 ${status})`);
      }
    }
    const other = await settleWithin(() => ctx.net.fetch(OTHER_HOST_URL), PAGE_MS);
    if (other.kind === 'resolved') {
      if (other.value.status !== 404) problems.push(`메인 net.fetch(${OTHER_HOST_URL}) 의 상태가 ${other.value.status} 다(기대 404)`);
    } else if (other.kind === 'rejected') {
      problems.push(`메인 net.fetch(${OTHER_HOST_URL}) 가 거부됐다: ${rejectionText(other.error)}`);
    } else {
      problems.push(`메인 net.fetch(${OTHER_HOST_URL}) 가 ${PAGE_MS}ms 안에 끝나지 않았다`);
    }
    return verdictOf(
      problems,
      `루트 위 ${target} 를 겨냥한 ${ESCAPES.join(' · ')} → 404 · 없는 파일 · 디렉터리 · ${TRAY_BUILD_FILE} → 404 · POST → 405 · 메인 net.fetch(${OTHER_HOST_URL}) → 404`,
    );
  }

  /**
   * ai — 페이지의 ai() 가 시작 국면에서 'easy' 한 수를 청한다: 모듈 워커가 답했고(aiWorker 'worker' — 조용한 동기 폴백이 아니다), 수를 냈고,
   * 그 수가 합법이다. ms 는 정보다(시간으로 판정하지 않는다). 받은 값은 결과의 메모 필드가 된다.
   * @returns {Promise<CheckVerdict>}
   */
  async function ai() {
    const seen = await ctx.page(AI_SCRIPT, 'ai()', { ms: AI_PAGE_MS });
    if (!isRecord(seen)) return verdictOf([`ai() 가 객체가 아니다: ${show(seen)}`], '');
    const ms = typeof seen.ms === 'number' && Number.isFinite(seen.ms) && seen.ms >= 0 ? seen.ms : null;
    state.aiWorker = typeof seen.aiWorker === 'string' ? seen.aiWorker : 'unused';
    state.aiAnswered = seen.aiAnswered === true;
    state.ms = ms ?? 0;
    /** @type {string[]} */
    const problems = [];
    if (seen.aiWorker !== 'worker') problems.push(`aiWorker 가 ${show(seen.aiWorker)} 다(기대 "worker" — 모듈 워커가 답해야 한다)`);
    if (seen.aiAnswered !== true) problems.push(`aiAnswered 가 ${show(seen.aiAnswered)} 다(AI 가 수를 내지 않았다)`);
    if (seen.legal !== true) problems.push(`legal 이 ${show(seen.legal)} 다(낸 수가 시작 국면의 합법 수가 아니다)`);
    if (ms === null) problems.push(`ms 가 ${show(seen.ms)} 다(0 이상의 수여야 한다)`);
    return verdictOf(problems, `AI 모듈 워커가 답했다(aiWorker "worker") · 합법 수 · ${ms}ms`);
  }

  /**
   * navigation — 새 창은 늘 deny 다: 허용 목록 밖은 deny 기록 · 열기 0번, 안은 deny 기록 · 열기 1번(다음 바퀴). 메인 프레임 탐색은
   * will-frame-navigate 가 막는다: 밖(example.invalid)은 차단 기록, 허용 목록 안(허브)은 차단 기록 + 열기가 will-frame-navigate · will-navigate 를
   * 통틀어 한 번. 둘 다 그 탐색이 끝났다는 기록(그 탐색의 did-start-navigation 뒤의 did-stop-loading)을 기다린 뒤 URL 이 그대로인지 본다 —
   * Electron 44.9.3 은 막혀서 들어가지 않은 탐색에 did-fail-provisional-load 를 내지 않는다(실제 스모크: did-start-navigation →
   * will-frame-navigate → did-stop-loading). 허용 목록 안의 열기가 왔으면 그보다 먼저 결정된 밖의 열기도 이미 왔을 것이다.
   * @returns {Promise<CheckVerdict>}
   */
  async function navigation() {
    const marks = { decisions: facts.decisions.length, opened: facts.opened.length, navigation: facts.navigation.length };
    /**
     * @param {NavigationRecord['kind']} kind
     * @param {string} url
     */
    const decisionsFor = (kind, url) =>
      facts.decisions
        .slice(marks.decisions)
        .filter(isNavigationRecord)
        .filter((entry) => entry.kind === kind && entry.url === url);
    /** @param {string} href */
    const opensOf = (href) => facts.opened.slice(marks.opened).filter((entry) => entry === href).length;
    /**
     * 메인 프레임의 url 탐색이 시작된 자리(마지막 것) — 없으면 -1.
     * @param {string} url
     */
    const startOf = (url) => {
      const events = facts.navigation.slice(marks.navigation);
      const at = events.findLastIndex((event) => event.kind === 'did-start-navigation' && event.isMainFrame && event.url === url);
      return at === -1 ? -1 : marks.navigation + at;
    };
    /**
     * url 탐색이 끝났다 — 그 시작 뒤에 did-stop-loading 이 왔다.
     * @param {string} url
     */
    const ended = (url) => {
      const start = startOf(url);
      return start !== -1 && facts.navigation.slice(start + 1).some((event) => event.kind === 'did-stop-loading');
    };
    /** @type {string[]} */
    const problems = [];

    for (const { url, href } of [
      { url: BLOCKED_POPUP_URL, href: null },
      { url: ALLOWED_POPUP_URL, href: ALLOWED_POPUP_URL },
    ]) {
      const denied = await ctx.page(windowOpenScript(url), `window.open(${url})`, { userGesture: true });
      if (denied !== true) problems.push(`window.open(${url}) 이 창을 돌려줬다(null 이 아니다)`);
      if (!(await until(() => decisionsFor('window-open', url).length > 0, WAIT_MS))) problems.push(`window.open(${url}) 의 deny 기록이 없다`);
      problems.push(...wrongDecisions(decisionsFor('window-open', url), href));
    }
    await until(() => opensOf(ALLOWED_POPUP_URL) > 0, WAIT_MS);

    for (const { url, href } of [
      { url: BLOCKED_NAVIGATION_URL, href: null },
      { url: ALLOWED_NAVIGATION_URL, href: ALLOWED_NAVIGATION_URL },
    ]) {
      await ctx.page(navigateScript(url), `location.href = ${url}`);
      await until(() => decisionsFor('will-frame-navigate', url).length > 0 && ended(url), WAIT_MS);
      const blocked = decisionsFor('will-frame-navigate', url);
      if (blocked.length === 0) problems.push(`${url}: will-frame-navigate 차단 기록이 없다`);
      problems.push(...wrongDecisions(blocked, href));
      if (startOf(url) === -1) problems.push(`${url}: did-start-navigation 을 받지 못했다`);
      else if (!ended(url)) problems.push(`${url}: 탐색이 끝나지 않았다(did-start-navigation 뒤 did-stop-loading 을 받지 못했다)`);
    }

    for (const url of [BLOCKED_POPUP_URL, BLOCKED_NAVIGATION_URL]) {
      const count = opensOf(url);
      if (count > 0) problems.push(`허용 목록 밖 ${url} 를 열었다(${count}번)`);
    }
    for (const url of [ALLOWED_POPUP_URL, ALLOWED_NAVIGATION_URL]) {
      const count = opensOf(url);
      if (count !== 1) problems.push(`${url} 열기 기록이 ${count}번이다(기대 1번)`);
    }
    const known = [BLOCKED_POPUP_URL, BLOCKED_NAVIGATION_URL, ALLOWED_POPUP_URL, ALLOWED_NAVIGATION_URL];
    const others = facts.opened.slice(marks.opened).filter((href) => !known.includes(href));
    if (others.length > 0) problems.push(`기대 밖 열기 기록: ${show(others)}`);

    const url = ctx.contents().getURL();
    if (url !== SMOKE_URL) problems.push(`getURL() 이 ${show(url)} 다(기대 ${SMOKE_URL})`);
    const location = await ctx.page(LOCATION_SCRIPT, 'location.href');
    if (location !== SMOKE_URL) problems.push(`페이지의 location.href 가 ${show(location)} 다(기대 ${SMOKE_URL})`);
    return verdictOf(
      problems,
      `새 창: ${BLOCKED_POPUP_URL} deny · 열기 0 / ${ALLOWED_POPUP_URL} deny · 열기 1 — 탐색: ${BLOCKED_NAVIGATION_URL} 를 막았고 ${ALLOWED_NAVIGATION_URL} 를 막고 한 번 열었다(둘 다 did-start-navigation → will-frame-navigate 차단 → did-stop-loading) — URL 그대로 ${SMOKE_URL}`,
    );
  }

  /**
   * permissions — 페이지가 check 경로(permissions.query 알림 · 위치 · 클립보드 쓰기, Notification.permission)와 request 경로
   * (Notification.requestPermission · 위치 요청)를 돈다. 감싼 처리기(main 의 request · check 처리기)의 결정 기록 다섯 가지를 먼저 기다린 뒤,
   * 결정이 기대와 같고(알림 · 클립보드 쓰기 허락, 위치 거부), 허용 목록 밖 권한을 허락한 기록이 없고, 페이지가 본 상태가 그 결정과 같은지 본다.
   * Electron 은 처리기가 없으면 모두 허락하므로 'granted' 만으로는 처리기가 걸렸다는 근거가 되지 않는다 — 기록이 근거다.
   * @returns {Promise<CheckVerdict>}
   */
  async function permissions() {
    const mark = facts.decisions.length;
    const seen = await ctx.page(permissionsScript(GEOLOCATION_MS), '권한', { userGesture: true });
    const records = () => facts.decisions.slice(mark).filter(isPermissionRecord);
    /** @param {{ kind: string, permission: string }} expected */
    const recorded = ({ kind, permission }) => records().some((record) => record.kind === kind && record.permission === permission);
    await until(() => EXPECTED_DECISIONS.every(recorded), WAIT_MS);
    /** @type {string[]} */
    const problems = [];
    const missing = EXPECTED_DECISIONS.filter((expected) => !recorded(expected));
    if (missing.length > 0) {
      problems.push(`감싼 처리기의 결정 기록이 오지 않았다: ${missing.map(({ kind, permission }) => `${kind} ${permission}`).join(', ')}`);
    }
    for (const { kind, permission, allowed } of EXPECTED_DECISIONS) {
      const wrong = records().filter((record) => record.kind === kind && record.permission === permission && record.allowed !== allowed);
      if (wrong.length > 0) problems.push(`${kind} ${permission} 결정이 ${show(wrong[0].allowed)} 다(기대 ${show(allowed)})`);
    }
    const leaked = records().filter((record) => record.allowed === true && !ALLOWED_PERMISSIONS.includes(record.permission));
    if (leaked.length > 0) problems.push(`허용 목록 밖 권한을 허락했다: ${[...new Set(leaked.map((record) => `${record.kind} ${record.permission}`))].join(', ')}`);
    if (!isRecord(seen) || !isRecord(seen.checks)) {
      problems.push(`페이지 사실이 { checks, notificationPermission, requested, geolocation } 가 아니다: ${show(seen)}`);
    } else {
      /** @type {Array<[string, unknown, string]>} */
      const states = [
        ['permissions.query(notifications)', seen.checks.notifications, 'granted'],
        ['permissions.query(geolocation)', seen.checks.geolocation, 'denied'],
        ['permissions.query(clipboard-write)', seen.checks.clipboardWrite, 'granted'],
        ['Notification.permission', seen.notificationPermission, 'granted'],
        ['Notification.requestPermission()', seen.requested, 'granted'],
        ['getCurrentPosition', seen.geolocation, GEOLOCATION_DENIED],
      ];
      for (const [what, actual, expected] of states) {
        if (actual !== expected) problems.push(`${what} 이 ${show(actual)} 다(기대 ${show(expected)})`);
      }
    }
    return verdictOf(
      problems,
      `감싼 처리기의 결정 ${EXPECTED_DECISIONS.length}가지를 받았다 — check: 알림 · 클립보드 쓰기 허락 · 위치 거부, request: 알림 허락 · 위치 거부 · 페이지 상태도 같다(query granted · denied · granted, Notification.permission granted, requestPermission granted, 위치 요청 PERMISSION_DENIED)`,
    );
  }

  /**
   * connectAllowed — .invalid 빌드에서 페이지의 connectProbe() 가 빌드 출처(tray-build.json 의 supabaseOrigin)로 만든 두 주소
   * ([https, wss] + /tj-connect-probe)를 그 순서로 시도했고, CSP 가 막지 않았고(그 호스트의 위반 0건), 가드가 둘 다 기록하고 취소했다.
   * 페이지가 스스로 정한 목록이 아니라 빌드 값으로 만든 목록과 견준다. 가드의 기록을 먼저 기다린 뒤 판정한다.
   * @returns {Promise<CheckVerdict>}
   */
  async function connectAllowed() {
    const expected = plan.connectProbe;
    if (expected === null) return verdictOf(['빌드 출처에서 connectProbe 주소를 만들지 못했다 — .invalid 빌드가 아니다'], '');
    const host = hostOf(expected[0]);
    /** @param {unknown} url */
    const onProbeHost = (url) => host !== null && hostOf(url) === host;
    const recorded = () => facts.requests.filter(onProbeHost);
    const seen = await ctx.page(CONNECT_PROBE_SCRIPT, 'connectProbe()');
    await until(() => evaluateNoNetwork(recorded(), expected).ok, WAIT_MS);
    /** @type {string[]} */
    const problems = [];
    const attempted = isRecord(seen) ? seen.attempted : undefined;
    if (!isStringList(attempted)) problems.push(`connectProbe() 의 attempted 가 문자열 목록이 아니다: ${show(seen)}`);
    else if (!sameList(attempted, expected)) problems.push(`attempted ${show(attempted)} 가 빌드 출처로 만든 ${show(expected)} 와 다르다`);
    const guarded = evaluateNoNetwork(recorded(), expected);
    if (!guarded.ok) problems.push(`가드 기록(${host} 의 요청): ${guarded.detail}`);
    const passed = facts.passed.filter(onProbeHost);
    if (passed.length > 0) problems.push(`가드가 취소하지 않고 통과시켰다: ${show(passed)}`);
    const blocked = facts.cspEvents.filter((event) => isRecord(event) && onProbeHost(event.blockedURI));
    if (blocked.length > 0) problems.push(`CSP 위반 ${blocked.length}건: ${blocked.map((event) => show(isRecord(event) ? event.blockedURI : event)).join(', ')}`);
    return verdictOf(problems, `connectProbe 가 빌드 출처로 만든 ${expected.join(' · ')} 를 시도했다 · CSP 위반 0건 · 가드가 둘 다 기록하고 취소했다`);
  }

  /**
   * net — --net: 페이지의 net() 이 인증 설정 GET 200 을 받고 Realtime 소켓이 붙었다(join 응답 · 오류 · 가드가 통과시킨 요청 수는 정보).
   * 빌드에 Supabase 값이 없거나 CI 의 가짜(.invalid) 값이면 net() 을 부르지 않고 다시 빌드하라는 실패다. 페이지 호출은 실행기가 NET_PAGE_MS 에서
   * 끊는다(설정 GET 은 페이지 안 상한이 없다).
   * @returns {Promise<CheckVerdict>}
   */
  async function net() {
    const targets = plan.net;
    if (targets === null) return verdictOf([plan.netProblem ?? '--net 의 두 요청을 정하지 못했다'], '');
    const seen = await ctx.page(NET_SCRIPT, 'net()', { ms: NET_PAGE_MS });
    if (!isRecord(seen)) return verdictOf([`net() 이 객체가 아니다: ${show(seen)}`], '');
    const info = `join ${show(seen.joinStatus)} · error ${show(seen.error)} · 가드가 통과시킨 요청 ${facts.passed.length}건`;
    /** @type {string[]} */
    const problems = [];
    if (seen.configured !== true) problems.push(`configured 가 ${show(seen.configured)} 다 — 페이지 번들에 Supabase 값이 없다`);
    if (seen.settingsStatus !== 200) problems.push(`인증 설정 GET 의 상태가 ${show(seen.settingsStatus)} 다(기대 200)`);
    if (seen.realtimeConnected !== true) problems.push(`Realtime 소켓이 붙지 않았다(realtimeConnected ${show(seen.realtimeConnected)})`);
    return verdictOf(problems.length === 0 ? [] : [...problems, info], `${targets.settings} 200 · Realtime 소켓 연결(${new URL(targets.socket).host}) · ${info}`);
  }

  /**
   * cspViolations — 장벽 뒤에 판정한다(markerSeen 이 양성 기록). preload 가 보낸 위반 0건 · 콘솔의 'Content Security Policy' 줄 0건이고,
   * 격리 world 의 표식과 버퍼가 preload 가 보낸 목록과 같다.
   * @param {boolean} markerSeen 능동 검사 뒤 장벽의 표식을 받았다
   * @returns {Promise<CheckVerdict>}
   */
  async function cspViolations(markerSeen) {
    const consoleCsp = facts.console.filter((entry) => entry.message.includes(CSP_CONSOLE_TEXT)).map((entry) => entry.message);
    const quiet = evaluateQuiet({ positiveSeen: markerSeen, negatives: [...facts.cspEvents.map(violationText), ...consoleCsp] });
    const problems = [...(quiet.ok ? [] : [quiet.detail]), ...(await bufferProblems())];
    return verdictOf(problems, `장벽 뒤 · preload 위반 0건 · 콘솔 '${CSP_CONSOLE_TEXT}' 0건 · 격리 world 표식 1 · 버퍼 = preload 목록(${facts.cspEvents.length}건)`);
  }

  /**
   * consoleErrors — 장벽 뒤에 판정한다. 콘솔 error 가 0건이다 — .invalid 빌드에서 connectProbe 가 시도한(가드가 취소한) 요청의 오류만
   * 뺀다(줄에 두 주소 중 하나가 든다). 그 밖의 error 는 모두 실패다.
   * @param {boolean} markerSeen
   * @returns {CheckVerdict}
   */
  function consoleErrors(markerSeen) {
    const errors = facts.console.filter((entry) => entry.level === 'error');
    const excused = errors.filter(isProbeError);
    const quiet = evaluateQuiet({ positiveSeen: markerSeen, negatives: errors.filter((entry) => !isProbeError(entry)).map((entry) => entry.message) });
    if (!quiet.ok) return quiet;
    const note = excused.length > 0 ? ` · connectProbe 의 취소된 요청 오류 ${excused.length}건은 뺐다` : '';
    return { ok: true, detail: `장벽 뒤 · 콘솔 error 0건${note} · 콘솔 ${facts.console.length}줄` };
  }

  /**
   * cspCanary — 마지막 단계. 페이지가 CSP 가 막아야 하는 fetch 를 하나 보내고, 위반 2건을 기다린 뒤 장벽으로 늦은 사건까지 받는다. 이 단계에서
   * 받은 위반만 evaluateCanary 로 판정한다(정확히 2건 — meta · header 두 전달 경로가 한 건씩 집행). 이 단계의 콘솔 오류는 최대 3건까지 받고,
   * 격리 world 버퍼가 preload 가 보낸 목록(이제 canary 위반이 든다)과 같아야 한다.
   * @returns {Promise<CheckVerdict>}
   */
  async function cspCanary() {
    const cspMark = facts.cspEvents.length;
    const consoleMark = facts.console.length;
    state.canaryMark = cspMark;
    const outcome = await ctx.page(canaryScript(CANARY_URL), 'canary fetch');
    await until(() => facts.cspEvents.length - cspMark >= 2, WAIT_MS);
    const flushed = await ctx.barrier();
    const canary = evaluateCanary(facts.cspEvents.slice(cspMark), trayBuild.csp);
    const stageErrors = facts.console.slice(consoleMark).filter((entry) => entry.level === 'error');
    /** @type {string[]} */
    const problems = canary.ok ? [] : [canary.detail];
    if (!flushed.markerSeen) problems.push('canary 뒤 장벽의 표식을 받지 못했다 — 이 단계의 위반 · 콘솔 오류를 다 셌다고 할 수 없다');
    if (stageErrors.length > CANARY_MAX_CONSOLE_ERRORS) {
      problems.push(`이 단계의 콘솔 오류가 ${stageErrors.length}건이다(최대 ${CANARY_MAX_CONSOLE_ERRORS}건): ${show(stageErrors.map((entry) => entry.message))}`);
    }
    problems.push(...(await bufferProblems()));
    return verdictOf(
      problems,
      `${canary.detail} · 페이지 fetch ${show(outcome)} · 이 단계의 콘솔 오류 ${stageErrors.length}건(최대 ${CANARY_MAX_CONSOLE_ERRORS}건) · 격리 world 버퍼 = preload 목록(${facts.cspEvents.length}건)`,
    );
  }

  /**
   * 결과의 메모 필드 — ai() 가 낸 값(aiWorker · aiAnswered · ms)과 canary 단계 전의 위반 수(canary 를 돌기 전이면 지금까지의 수).
   * @returns {ActiveMemo}
   */
  function memo() {
    return { aiWorker: state.aiWorker, aiAnswered: state.aiAnswered, ms: state.ms, cspViolations: state.canaryMark ?? facts.cspEvents.length };
  }

  return { cspMeta, cspHeader, protocol, ai, navigation, permissions, connectAllowed, net, cspViolations, consoleErrors, cspCanary, memo };
}

module.exports = { createActiveChecks };
