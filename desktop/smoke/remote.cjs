'use strict';
// 스모크의 원격 요청 계획(설계 §5.10 noNetwork · connectAllowed · net) — 이번 실행에서 네트워크 가드가 볼 원격 요청과 그 처리를 빌드 값
// (tray-build.json 의 supabaseOrigin)과 --net 하나로 정한다. 실행기(run.cjs)의 가드 · noNetwork 와 능동 검사(active.cjs)의 connectAllowed ·
// net · consoleErrors 가 같은 계획을 읽는다 — 셋이 다른 말을 하지 않게.
// - 기대 목록(noNetwork): 늘 가드 탐침 + (.invalid 빌드면) connectProbe 의 두 주소 + (--net 이고 빌드에 실제 값이 있으면) 인증 설정 · Realtime
//   소켓. 기록이 이 목록과 같아야 한다(evaluateNoNetwork — 프로토콜 + 호스트 + 경로).
// - 가드가 통과시키는 것은 --net 의 그 두 요청뿐이다 — 출처(프로토콜 + 호스트 + 포트)와 경로로 맞추고 쿼리는 보지 않는다. 메서드는 GET 이고,
//   인증 설정만 그 CORS 사전 요청(OPTIONS)도 받는다: net() 의 fetch 는 apikey 머리글(CORS 안전 목록 밖)을 실어 브라우저가 사전 요청을 먼저
//   보내고, Electron 의 webRequest 는 그 사전 요청도 본다. 그 밖은 모두 기록하고 취소한다(로그인 · 토큰 갱신 · REST · 쓰기).
// - .invalid 빌드인지는 판정기의 규칙(requiredChecks 가 connectAllowed 를 요구하는가)으로 가른다 — 페이지 · 런처와 같은 규칙이다.
// electron 을 require 하지 않는다.

const { requiredChecks } = require('../lib/smokeResult.cjs');

/**
 * 네트워크 가드의 양성 대조 — 메인 쪽에서 창의 세션으로 보내는 요청 하나. 가드가 기록하고 취소해야 한다. 취소는 탐침이
 * ERR_BLOCKED_BY_CLIENT 로 거부되는 것으로만 확인한다 — .invalid 는 어디에도 없어서 가드가 취소하지 않아도 DNS 에서 거부된다.
 */
const GUARD_PROBE_URL = 'https://example.invalid/tj-net-guard-probe';
/** connectProbe() 가 두는 경로(src/tray/smoke.ts 의 PROBE_PATH) — 어느 서버에도 없다. */
const CONNECT_PROBE_PATH = '/tj-connect-probe';
/** net() 의 인증 설정 GET 경로(src/tray/smoke.ts). */
const SETTINGS_PATH = '/auth/v1/settings';
/** supabase-js 가 여는 Realtime 소켓의 경로(쿼리 apikey · vsn 은 보지 않는다). */
const SOCKET_PATH = '/realtime/v1/websocket';
/** 다시 빌드하라는 안내. */
const REBUILD = '실제 VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY 로 npm run build:tray 를 다시 한 뒤 --net 을 돌린다';

/**
 * 가드가 통과시키는 요청 하나 — 프로토콜 · 호스트(포트 포함) · 경로가 같고 메서드가 목록에 있을 때.
 * @typedef {object} PassRule
 * @property {string} protocol 'https:' · 'wss:' …
 * @property {string} host
 * @property {string} pathname
 * @property {readonly string[]} methods
 */
/**
 * 이번 실행의 원격 요청 계획.
 * @typedef {object} RemotePlan
 * @property {string[]} expected noNetwork 의 기대 목록 — 기록이 이것과 같아야 한다
 * @property {string[] | null} connectProbe .invalid 빌드에서 connectProbe() 가 시도해야 하는 두 주소([https, wss]). 아니면 null
 * @property {{ settings: string, socket: string } | null} net --net 이 내보내는 두 요청. --net 이 아니거나 그럴 수 없는 빌드면 null
 * @property {string | null} netProblem --net 인데 net 을 할 수 없는 이유(다시 빌드하라는 안내). 그 밖에는 null
 * @property {readonly PassRule[]} pass 가드가 통과시키는 요청 — --net 의 두 요청뿐이다
 */

/**
 * 빌드의 Supabase 출처 → https(또는 로컬 http) 출처와 그 소켓 출처(wss · ws). 출처로 읽을 수 없으면 null.
 * @param {string | null} supabaseOrigin
 * @returns {{ http: string, ws: string } | null}
 */
function originPair(supabaseOrigin) {
  if (typeof supabaseOrigin !== 'string') return null;
  /** @type {URL} */
  let url;
  try {
    url = new URL(supabaseOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return { http: `${url.protocol}//${url.host}`, ws: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` };
}

/**
 * 주소와 메서드로 통과 규칙 하나를 만든다.
 * @param {string} href
 * @param {readonly string[]} methods
 * @returns {PassRule}
 */
function passRule(href, methods) {
  const url = new URL(href);
  return { protocol: url.protocol, host: url.host, pathname: url.pathname, methods };
}

/**
 * 이번 실행의 원격 요청 계획을 정한다(던지지 않는다). connectAllowed · net 을 돌지는 판정기의 requiredChecks 와 같은 규칙이다.
 * @param {{ net: boolean, supabaseOrigin: string | null }} input --net 인가 · tray-build.json 의 supabaseOrigin
 * @returns {RemotePlan}
 */
function planRemote({ net, supabaseOrigin }) {
  const required = requiredChecks({ net, supabaseOrigin });
  const invalidBuild = required.includes('connectAllowed');
  const origins = originPair(supabaseOrigin);
  const connectProbe = invalidBuild && origins !== null ? [`${origins.http}${CONNECT_PROBE_PATH}`, `${origins.ws}${CONNECT_PROBE_PATH}`] : null;

  /** @type {string | null} */
  let netProblem = null;
  /** @type {RemotePlan['net']} */
  let netTargets = null;
  if (required.includes('net')) {
    if (supabaseOrigin === null) netProblem = `빌드에 Supabase 값이 없다(supabaseOrigin null) — ${REBUILD}`;
    else if (invalidBuild) netProblem = `빌드의 Supabase 출처 ${supabaseOrigin} 는 CI 의 가짜 값(.invalid)이다 — ${REBUILD}`;
    else if (origins === null) netProblem = `빌드의 Supabase 출처 ${JSON.stringify(supabaseOrigin)} 를 출처로 읽지 못했다 — ${REBUILD}`;
    else netTargets = { settings: `${origins.http}${SETTINGS_PATH}`, socket: `${origins.ws}${SOCKET_PATH}` };
  }

  const pass = netTargets === null ? [] : [passRule(netTargets.settings, ['GET', 'OPTIONS']), passRule(netTargets.socket, ['GET'])];
  const expected = [GUARD_PROBE_URL, ...(connectProbe ?? []), ...(netTargets === null ? [] : [netTargets.settings, netTargets.socket])];
  return { expected, connectProbe, net: netTargets, netProblem, pass: Object.freeze(pass) };
}

/**
 * 가드가 이 요청을 통과시키는가 — 계획의 통과 규칙 하나와 프로토콜 · 호스트 · 경로 · 메서드가 모두 맞을 때만. 던지지 않는다(URL 이
 * 아니거나 메서드가 글이 아니면 통과가 아니다).
 * @param {RemotePlan} plan
 * @param {string} url
 * @param {unknown} method
 * @returns {boolean}
 */
function passesGuard(plan, url, method) {
  if (plan.pass.length === 0 || typeof method !== 'string') return false;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return plan.pass.some(
    (rule) => rule.protocol === parsed.protocol && rule.host === parsed.host && rule.pathname === parsed.pathname && rule.methods.includes(method),
  );
}

module.exports = { GUARD_PROBE_URL, planRemote, passesGuard };
