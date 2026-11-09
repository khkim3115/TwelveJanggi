'use strict';
// 스모크 실행기의 공용 도우미 — 앱 안 실행기(run.cjs)와 능동 검사(active.cjs)가 같이 쓴다: 수집한 사실의 모양 · 대기 상한 · 기다리기 ·
// 상한 걸기 · 값 표현 · 오류 글 · stderr 줄 · 판정 모양. electron 을 require 하지 않는다(Electron 타입은 JSDoc 으로만 가리킨다).

const fs = require('node:fs');
const { ENTRY_URL } = require('../lib/appProtocol.cjs');
const { repr } = require('../lib/guards.cjs');

/** 스모크의 진입 URL — main 이 스모크에서 여는 곳(tray.html?smoke). */
const SMOKE_URL = `${ENTRY_URL}?smoke`;
/** 페이지 호출(executeJavaScript) 한 번의 기본 상한. */
const PAGE_MS = 10_000;
/** 사건(preload 보고 · 장벽 표식 · 결정 기록 · 위반 · 창 보임 · 포커스 · 제목 줄의 버전 …)을 기다리는 상한. */
const WAIT_MS = 5_000;
/** 기다릴 때 다시 보는 간격. */
const POLL_MS = 50;
/** detail 에 싣는 값 표현의 글자 수 상한. */
const MAX_REPR_CHARS = 160;

/**
 * 결정 기록 한 건 — 탐색 결정(navigation.cjs)이거나 권한 결정(main.js)이다. 탐색 · 권한 검사가 읽는다.
 * @typedef {import('../lib/navigation.cjs').NavigationRecord | import('../main.js').PermissionRecord} DecisionRecord
 */
/**
 * console-message 한 건(details 형).
 * @typedef {object} ConsoleEntry
 * @property {string} level 'info' · 'warning' · 'error' · 'debug'
 * @property {string} message
 * @property {string} sourceId
 * @property {number} lineNumber
 */
/**
 * 실패로 치지 않는 불러오기 실패(did-fail-provisional-load · 서브프레임 did-fail-load)의 기록.
 * @typedef {object} LoadFailure
 * @property {'did-fail-load' | 'did-fail-provisional-load'} kind
 * @property {number} errorCode
 * @property {string} errorDescription
 * @property {string} url
 * @property {boolean} isMainFrame
 */
/**
 * 탐색의 시작 · 끝 사건 한 건(일어난 순서로 쌓인다). 막힌 탐색은 did-start-navigation → (main 의 will-frame-navigate 차단) →
 * did-stop-loading 으로 끝난다 — Electron 44.9.3 은 들어가지 않은 탐색에 did-fail-provisional-load 를 내지 않는다(실제 스모크에서 본 순서).
 * @typedef {{ kind: 'did-start-navigation', url: string, isMainFrame: boolean } | { kind: 'did-stop-loading' }} NavigationEvent
 */
/**
 * main 의 창 보이기 · 숨기기 한 건 — 이유와 받은 때. at 은 실행기가 기록을 받을 때의 performance.now() 다(main 이 유예 · 경합 시각을 재는
 * 시계와 같다 — main 이 시각을 잰 뒤에 기록하므로 at 은 그 시각보다 조금 늦다).
 * @typedef {{ action: 'show', reason: import('../main.js').ShowReason, at: number } | { action: 'hide', reason: import('../main.js').HideReason, at: number }} WindowFact
 */
/**
 * main 이 렌더러로 민 채널 한 건(값은 싣지 않는다)과 받은 때(at — WindowFact 와 같은 시계).
 * @typedef {{ channel: import('../main.js').SentRecord['channel'], at: number }} SentFact
 */
/**
 * 실행기가 받은 렌더러의 tj-hide 한 건(main 의 처리기와 같은 채널에 단 수신 기록 — 발신자 검증을 지났다)과 받은 때.
 * @typedef {{ at: number }} HideReceipt
 */
/**
 * 실행기가 받은 렌더러의 tj-set-opacity 한 건 — value 는 받은 값 그대로이고 NaN 만 'NaN' 이다(JSON 은 NaN 을 null 로 바꿔, 상세 · 결과에서
 * NaN 과 null 이 갈리지 않는다).
 * @typedef {{ value: unknown, at: number }} OpacityReceipt
 */
/**
 * 수집한 사실 — 수집기 · IPC · 가드 · 연결점이 채우고(뒤에 쌓기만 한다), 검사가 읽는다.
 * @typedef {object} SmokeFacts
 * @property {ConsoleEntry[]} console
 * @property {unknown[]} preloadReports preload 의 tj-smoke-preload 보고
 * @property {unknown[]} cspEvents preload 의 tj-smoke-csp 위반 이벤트
 * @property {string[]} requests 네트워크 가드가 본 원격 요청 URL(통과시킨 것까지 모두)
 * @property {string[]} passed 그중 가드가 통과시킨 URL(--net 의 두 요청뿐이다)
 * @property {DecisionRecord[]} decisions 권한 · 탐색 결정
 * @property {string[]} opened 허용 목록 주소(열지 않고 기록만 했다)
 * @property {LoadFailure[]} loadFailures
 * @property {NavigationEvent[]} navigation 트레이 창의 탐색 시작 · 로딩 끝
 * @property {WindowFact[]} window main 의 창 보이기 · 숨기기(일어난 차례)
 * @property {SentFact[]} sent main 이 렌더러로 민 채널(일어난 차례)
 * @property {import('../main.js').LoginItemRecord[]} loginItem main 의 로그인 항목 요청 기록(받은 그대로의 사본)
 * @property {HideReceipt[]} hideReceipts 렌더러가 보낸 tj-hide
 * @property {OpacityReceipt[]} opacityReceipts 렌더러가 보낸 tj-set-opacity
 */
/**
 * 약속이 끝난 모양 — 값(resolved) · 거부(rejected) · 상한 안에 끝나지 않음(timeout).
 * @template T
 * @typedef {{ kind: 'resolved', value: T } | { kind: 'rejected', error: unknown } | { kind: 'timeout' }} Settled
 */
/** @typedef {import('../lib/smokeChecks.cjs').CheckVerdict} CheckVerdict */

/**
 * @param {unknown} value
 * @returns {string}
 */
function show(value) {
  return repr(value, MAX_REPR_CHARS);
}

/**
 * 오류의 글 — Error 는 message, 문자열은 그대로, 그 밖은 값 표현. 던지지 않는다.
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : show(err);
}

/**
 * 거부의 글 — 오류의 글에, cause 가 있으면 그 글을 붙인다(fetch 는 원인을 cause 에 단다). 던지지 않는다.
 * @param {unknown} err
 * @returns {string}
 */
function rejectionText(err) {
  const cause = err instanceof Error && err.cause !== undefined ? ` (cause: ${errorText(err.cause)})` : '';
  return `${errorText(err)}${cause}`;
}

/**
 * stderr 에 '[tj] …' 를 동기로 쓴다(main.js 의 logError 와 같은 줄 모양 — 런처가 [app:err] 로 보여 준다). 쓸 곳이 없으면 버린다.
 * @param {string} message
 */
function logError(message) {
  try {
    fs.writeSync(2, `[tj] ${message}\n`);
  } catch {
    // 쓸 곳이 없다
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * predicate 가 참이 될 때까지 ms 까지 기다린다 — 참이 됐으면 true, 시간이 다 됐으면 false.
 * @param {() => boolean} predicate
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
async function until(predicate, ms) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}

/**
 * 비동기 predicate(페이지 호출처럼 기다리는 일)가 참이 될 때까지 ms 까지 기다린다 — until 과 같은 모양이다: 참(=== true)이 됐으면 true,
 * 시간이 다 됐으면 false 이고 던지지 않는다. 한 번의 predicate 가 남은 시간 안에 끝나지 않아도 false 다(기다림이 ms 를 넘지 않는다 —
 * 늦게 끝난 그 약속은 버린다). predicate 가 던지거나 거부하면 '<what>: <이유>' 로 거부한다(그 단계의 실패 글 — what 은 이 글에만 쓴다).
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} ms
 * @param {string} what 기다리는 것(실패 글에 쓴다)
 * @returns {Promise<boolean>}
 */
async function untilAsync(predicate, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const outcome = await settleWithin(async () => predicate(), Math.max(deadline - Date.now(), 0));
    if (outcome.kind === 'rejected') throw new Error(`${what}: ${errorText(outcome.error)}`, { cause: outcome.error });
    if (outcome.kind === 'resolved' && outcome.value === true) return true;
    if (outcome.kind === 'timeout' || Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
}

/**
 * since(performance.now() 의 한 시각 — 기록의 at)에서 ms 가 지날 때까지 기다린다. 타이머가 조금 일찍 깨면(정수 ms 로 자른다) 다시 잰다.
 * 이미 지났으면 곧바로 돌아온다.
 * @param {number} since
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function waitElapsed(since, ms) {
  for (let left = since + ms - performance.now(); left > 0; left = since + ms - performance.now()) await delay(left);
}

/**
 * work 를 ms 까지만 기다린다. 넘으면 '<what>: <ms>ms 안에 끝나지 않았다' 로 거부한다. 어느 쪽이든 타이머는 남기지 않는다.
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
function within(work, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: ${ms}ms 안에 끝나지 않았다`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * start() 의 약속이 ms 안에 어떻게 끝났는지 본다 — within 과 달리 거부하지 않고 세 갈래로 돌려준다(start 가 동기로 던져도 거부다).
 * 어느 쪽이든 타이머는 남기지 않는다.
 * @template T
 * @param {() => Promise<T>} start
 * @param {number} ms
 * @returns {Promise<Settled<T>>}
 */
function settleWithin(start, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    Promise.resolve()
      .then(start)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve({ kind: 'resolved', value });
        },
        (error) => {
          clearTimeout(timer);
          resolve({ kind: 'rejected', error });
        },
      );
  });
}

/**
 * 문제 목록으로 판정한다 — 없으면 통과(passDetail), 있으면 실패(문제를 '; ' 로 이은 것).
 * @param {readonly string[]} problems
 * @param {string} passDetail
 * @returns {CheckVerdict}
 */
function verdictOf(problems, passDetail) {
  return problems.length === 0 ? { ok: true, detail: passDetail } : { ok: false, detail: problems.join('; ') };
}

/**
 * 문자열 목록인가.
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * 두 목록이 같은 순서로 같은가.
 * @param {readonly unknown[]} a
 * @param {readonly unknown[]} b
 * @returns {boolean}
 */
function sameList(a, b) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

module.exports = {
  SMOKE_URL,
  PAGE_MS,
  WAIT_MS,
  POLL_MS,
  show,
  errorText,
  rejectionText,
  logError,
  delay,
  until,
  untilAsync,
  waitElapsed,
  within,
  settleWithin,
  verdictOf,
  isStringList,
  sameList,
};
