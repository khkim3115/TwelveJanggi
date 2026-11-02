'use strict';
// 스모크 런처의 파일 처리(설계 §5.10 런처 3 · 7 · 8단계) — 임시 폴더를 재시도하며 지우기 · 지난 실행의 잔여 정리 · 폴더 목록 비교 ·
// 동시 실행 잠금. Windows 에서는 Chromium 이 파일을 쥔 채 오래 가면 지우기가 EBUSY 로 실패한다:
// - 그래서 지우기는 기다리며 다시 시도하고(removeWithRetry), 끝내 못 지운 폴더는 다음 실행이 앱을 띄우기 직전에 정리한다(sweepStale —
//   런처가 인자 · 잠금 · smoke-out 비우기 · 빌드 · electron 확인 뒤에 부른다. 그 전에 멈춘 실행은 정리하지 않는다).
//   Node 24.0~24.20 의 Windows rmSync 는 재시도(maxRetries)가 결함이라 fs 의 재시도 옵션을 쓰지 않고 직접 재시도한다.
// - 잠금은 PID 를 적은 파일이다. 죽은 PID 의 잠금(강제 종료가 남긴 것)은 넘겨받고, 읽을 수 없는 잠금은 빼앗지 않는다.
// 던지는 것은 호출한 쪽의 실수(인자)와 예상하지 못한 fs 오류뿐이다 — EBUSY 같은 '못 지움' 은 값으로 돌려준다.
// electron 을 require 하지 않는다.

const fs = require('node:fs');
const path = require('node:path');

/** 지우기를 다시 시도하는 오류 코드 — 다른 프로세스가 쥐고 있거나 바이러스 검사가 잠시 잡고 있는 경우다. */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
/** 첫 재시도 간격(ms) — 이후 두 배씩 늘리다 MAX_DELAY_MS 에서 멈춘다. */
const FIRST_DELAY_MS = 100;
const MAX_DELAY_MS = 2000;
/** 기다리는 시간의 합 상한(ms)의 기본값. */
const DEFAULT_MAX_MS = 20000;
/** 잠금을 넘겨받다 다른 실행과 어긋났을 때 다시 읽어 보는 최대 횟수. */
const MAX_ACQUIRE_ROUNDS = 5;

/**
 * 던져진 값의 code(Node fs 오류의 'EBUSY' 등). 객체가 아니거나 code 가 문자열이 아니면 undefined.
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errorCode(err) {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = /** @type {{ code?: unknown }} */ (err).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 던져진 값을 Error 로. message 가 문자열인 객체는 그대로(다른 realm 의 Error 포함), 그 밖의 값은 글로 감싼다.
 * @param {unknown} err
 * @returns {Error}
 */
function toError(err) {
  if (typeof err === 'object' && err !== null && typeof (/** @type {{ message?: unknown }} */ (err).message) === 'string') {
    return /** @type {Error} */ (err);
  }
  return new Error(String(err));
}

// ── 지우기 ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} RemoveOptions
 * @property {(dir: string) => Promise<void>} [rm] 폴더를 지우는 함수. 기본은 fs.promises.rm(재귀 · force) — maxRetries 는 주지 않는다. 시험이 가짜를 넣는다
 * @property {(ms: number) => Promise<void>} [sleep] ms 만큼 기다리는 함수. 기본은 setTimeout. 시험이 기다리지 않는 가짜를 넣는다
 * @property {number} [maxMs] 기다리는 시간의 합 상한(ms). 기본 20000. 유한한 수가 아니면 기본값이고, 0 이하이면 한 번만 시도한다
 */
/**
 * @typedef {object} RemoveResult
 * @property {boolean} removed 폴더가 이제 없다(지웠거나 원래 없었다)
 * @property {number} attempts rm 을 부른 횟수
 * @property {Error | null} lastError 지우지 못했을 때 마지막 오류. 지워졌으면 null
 */

/** @param {string} dir */
function defaultRm(dir) {
  return fs.promises.rm(dir, { recursive: true, force: true });
}

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 폴더를 지운다. EBUSY · EPERM · EACCES · ENOTEMPTY 는 기다렸다 다시 시도한다 — 간격은 100ms 에서 두 배씩 늘어 2초에서 멈추고,
 * 기다린 시간의 합이 maxMs 에 이르면 포기한다(마지막 간격은 남은 시간만큼만). ENOENT 는 이미 없는 것이니 지워진 것이다.
 * 그 밖의 오류는 재시도하지 않고 실패로 돌려준다. rm 이 던지는 것은 모두 값(removed · lastError)으로 돌려주고 던지지 않는다.
 * 상한은 기다리는 시간(sleep 에 준 간격의 합)으로 센다 — 시계에 기대지 않아 가짜 sleep 으로 값까지 시험된다. rm 자체가 걸리는
 * 시간은 세지 않는다(임시 폴더 하나라 수 ms 다).
 * @param {string} dir 지울 폴더(절대 경로)
 * @param {RemoveOptions} [options]
 * @returns {Promise<RemoveResult>}
 */
async function removeWithRetry(dir, options = {}) {
  const { rm = defaultRm, sleep = defaultSleep, maxMs = DEFAULT_MAX_MS } = options;
  // 정수로 내려 쓴다 — NaN · 소수가 남은 시간 계산을 어긋나게 해 끝없이 도는 일이 없도록.
  const budget = Number.isFinite(maxMs) ? Math.max(0, Math.floor(maxMs)) : DEFAULT_MAX_MS;
  let attempts = 0;
  let waited = 0;
  let delay = FIRST_DELAY_MS;
  for (;;) {
    attempts += 1;
    /** @type {Error} */
    let lastError;
    try {
      await rm(dir);
      return { removed: true, attempts, lastError: null };
    } catch (err) {
      const code = errorCode(err);
      if (code === 'ENOENT') return { removed: true, attempts, lastError: null };
      lastError = toError(err);
      if (code === undefined || !RETRYABLE_CODES.has(code)) return { removed: false, attempts, lastError };
    }
    const remaining = budget - waited;
    if (remaining <= 0) return { removed: false, attempts, lastError };
    const wait = Math.min(delay, remaining);
    await sleep(wait);
    waited += wait;
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

// ── 지난 실행의 잔여 정리 ─────────────────────────────────────────────────

/**
 * sweepStale 이 쓰는 fs 의 부분집합(구조 타입) — 시험이 rmSync 를 갈아 끼워 EBUSY 를 흉내 낸다.
 * @typedef {object} SweepFs
 * @property {(dir: string, options: { withFileTypes: true }) => import('node:fs').Dirent[]} readdirSync
 * @property {(target: string, options: { recursive: true, force: true }) => void} rmSync
 */
/**
 * @typedef {object} SweepResult
 * @property {string[]} removed 지운 폴더 이름(tmpRoot 바로 아래 이름) — 정렬해 둔다
 * @property {string[]} failed 지우지 못한 폴더 이름 — EBUSY 등 어떤 오류든. 다음 실행이 다시 지운다
 */

/**
 * 비교용 이름 — Windows 는 대소문자를 가리지 않는다.
 * @param {string} name
 * @returns {string}
 */
function fold(name) {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

/**
 * keepDir 이 tmpRoot 바로 아래 폴더면 그 이름(비교용), 아니면 null.
 * @param {string} tmpRoot
 * @param {string | null | undefined} keepDir
 * @returns {string | null}
 */
function keptName(tmpRoot, keepDir) {
  if (typeof keepDir !== 'string' || keepDir === '') return null;
  const resolved = path.resolve(keepDir);
  return fold(path.dirname(resolved)) === fold(path.resolve(tmpRoot)) ? fold(path.basename(resolved)) : null;
}

/**
 * tmpRoot 바로 아래에서 이름이 prefix 로 시작하는 폴더를 지운다 — 지난 스모크가 강제 종료로 남긴 것이다(런처 3단계).
 * keepDir 은 지키는 폴더의 경로(tmpRoot 바로 아래 폴더)이거나 null 이다. 폴더마다 따로 시도한다: 못 지우면(EBUSY 등) failed 에
 * 담고 던지지 않는다 — 한 폴더가 다른 폴더의 정리를 막지 않고, 다음 실행이 다시 지운다.
 * - 진짜 폴더만 지운다. 파일(잠금 파일 · 로그)과 링크 · 정션은 건드리지 않는다 — 따라가서 지우는 일이 없도록.
 * - prefix 가 비면 던진다 — 모든 폴더가 맞아 임시 폴더 전체를 지우게 된다.
 * - tmpRoot 를 읽지 못하면 던진다. '정리할 것이 없다' 와 '알 수 없다' 는 다르다.
 * @param {string} tmpRoot 임시 폴더(os.tmpdir())
 * @param {string} prefix 지울 폴더 이름의 접두사('tj-smoke-')
 * @param {string | null} keepDir 지킬 폴더의 경로. 없으면 null
 * @param {SweepFs} [fsImpl] 기본은 node:fs. 시험이 rmSync 를 갈아 끼운다
 * @returns {SweepResult}
 */
function sweepStale(tmpRoot, prefix, keepDir, fsImpl = fs) {
  if (typeof tmpRoot !== 'string' || tmpRoot === '') throw new TypeError('sweepStale: tmpRoot 는 비어 있지 않은 문자열이어야 한다');
  if (typeof prefix !== 'string' || prefix === '') throw new TypeError('sweepStale: prefix 는 비어 있지 않은 문자열이어야 한다');
  const kept = keptName(tmpRoot, keepDir);
  const names = fsImpl
    .readdirSync(tmpRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && (kept === null || fold(entry.name) !== kept))
    .map((entry) => entry.name)
    .sort();
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const failed = [];
  for (const name of names) {
    try {
      fsImpl.rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed };
}

/**
 * 폴더 목록 비교 — after 에만 있는 이름을 after 의 순서로(같은 이름은 한 번). 이름은 글자 그대로 비교한다.
 * 배열이 아니면 던진다 — 비교를 못 한 채 '차이 없음' 으로 통과하지 않는다.
 * @param {string[]} before 실행 전 목록
 * @param {string[]} after 실행 뒤 목록
 * @returns {string[]}
 */
function diffEntries(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) throw new TypeError('diffEntries: before · after 는 배열이어야 한다');
  const known = new Set(before);
  return [...new Set(after)].filter((name) => !known.has(name));
}

// ── 동시 실행 잠금 ────────────────────────────────────────────────────────

/**
 * @typedef {object} LockResult
 * @property {boolean} ok 잠금을 얻었는가
 * @property {number | null} holder 잠금을 쥔 다른 프로세스의 PID. 얻었거나, 누가 쥔지 알 수 없으면(파일을 읽지 못함) null
 */

/**
 * 잠금 파일의 주인. 파일이 없으면 missing, 읽지 못하거나 글이 양의 정수 PID 가 아니면 unreadable.
 * @typedef {{ state: 'pid', pid: number } | { state: 'missing' } | { state: 'unreadable' }} Holder
 */

/**
 * @param {string} lockPath
 * @returns {Holder}
 */
function readHolder(lockPath) {
  let text;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    return errorCode(err) === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
  const match = /^\s*(\d+)\s*$/.exec(text);
  const pid = match === null ? NaN : Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? { state: 'pid', pid } : { state: 'unreadable' };
}

/**
 * 잠금 파일을 'wx'(없을 때만 만들기)로 만들고 PID 를 쓴다. 이미 있으면 false. 쓰다 실패하면 빈 파일을 남기지 않고 던진다 —
 * 빈 잠금은 '읽을 수 없는 잠금' 이라 이후 모든 실행이 거부당한다.
 * @param {string} lockPath
 * @param {number} pid
 * @returns {boolean} 만들었으면 true
 */
function createLockFile(lockPath, pid) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, `${pid}\n`);
  } catch (err) {
    // 닫기와 지우기는 따로 시도한다 — 하나가 실패해도 다른 하나는 하고, 어느 쪽이든 원래 오류를 낸다.
    try {
      fs.closeSync(fd);
    } catch {
      // 닫지 못해도 계속한다
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // 치우지 못해도 원래 오류를 낸다
    }
    throw err;
  }
  fs.closeSync(fd);
  return true;
}

/**
 * 동시 실행 잠금을 얻는다(런처 3단계). 잠금 파일에 PID 를 적는다.
 * - 없으면 'wx' 로 만들어 얻는다.
 * - 있으면 주인 PID 를 읽는다. isAlive(pid) 가 false 를 **정확히** 돌려줄 때만 죽은 주인이다 — 그 잠금을 지우고 넘겨받는다
 *   (강제 종료가 남긴 잠금). 그 밖의 답(true · undefined 등)은 산 것으로 보고 거부한다.
 * - 읽을 수 없는 잠금(글이 PID 가 아니거나 파일이 아님)은 누가 쥔지 모르니 거부한다(holder null). 사용자가 파일을 지운다.
 * 한계: PID 는 다시 쓰인다 — 죽은 실행의 PID 를 지금 다른 프로세스가 쓰면 산 것으로 보고 거부한다(잠금 파일을 지우면 풀린다).
 * 지우기 직전에 주인을 한 번 더 읽어, 판정하는 사이 다른 실행이 넘겨받았으면 지우지 않는다. 그래도 두 실행이 같은 순간에
 * 같은 죽은 잠금을 넘겨받는 틈은 남는다 — 동시 실행은 지원하지 않고 이 잠금은 실수로 겹치는 것을 막는 용도다.
 * @param {string} lockPath 잠금 파일 경로
 * @param {number} pid 내 PID(양의 정수)
 * @param {(pid: number) => boolean} isAlive PID 가 살아 있는가 — 런처가 process.kill(pid, 0) 으로 답한다
 * @returns {LockResult}
 */
function acquireLock(lockPath, pid, isAlive) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('acquireLock: pid 는 양의 정수여야 한다');
  /** @type {number | null} */
  let lastHolder = null;
  for (let round = 0; round < MAX_ACQUIRE_ROUNDS; round += 1) {
    if (createLockFile(lockPath, pid)) return { ok: true, holder: null };
    const holder = readHolder(lockPath);
    if (holder.state === 'missing') continue; // 그 사이 풀렸다 — 다시 얻어 본다
    if (holder.state === 'unreadable') return { ok: false, holder: null };
    lastHolder = holder.pid;
    if (isAlive(holder.pid) !== false) return { ok: false, holder: holder.pid };
    // 죽은 주인이다. 판정하는 사이 다른 실행이 넘겨받지 않았는지 한 번 더 읽고, 그대로일 때만 지운다.
    const again = readHolder(lockPath);
    if (again.state === 'pid' && again.pid === holder.pid) fs.rmSync(lockPath, { force: true });
  }
  return { ok: false, holder: lastHolder };
}

/**
 * 잠금 파일을 지운다. 없으면 이미 푼 것이다(true). 지우지 못해도 던지지 않고 false 를 돌려준다 — 판정이 끝난 뒤의 정리가 결과를
 * 뒤집지 않는다(남은 잠금은 내 PID 가 죽은 뒤 다음 실행이 넘겨받는다).
 * @param {string} lockPath
 * @returns {boolean} 잠금 파일이 이제 없으면 true
 */
function releaseLock(lockPath) {
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { removeWithRetry, sweepStale, diffEntries, acquireLock, releaseLock };
