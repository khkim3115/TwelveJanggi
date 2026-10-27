'use strict';
// 스모크 인자(설계 §5.5 · §5.10) — 런처(desktop/scripts/smoke.cjs)가 formatSmokeArgs 로 만들고 main 이 parseSmokeArgs 로 읽는다.
// 두 함수가 한 파일에 있어 형식이 따로 놀지 않는다(왕복 시험). electron 을 require 하지 않는다.
// - argv 를 신뢰 경계로 보지 않는다. Electron 은 이미 더 강한 스위치(--remote-debugging-port 등)를 받는다 — 그래서 패키지에서도 받는다.
// - '--tj-' 로 시작하는 인자가 하나라도 있으면 스모크를 요청한 것이다(enabled). 그때 하나라도 틀리면 쓸 수 있는 값 없이 error 를
//   낸다 — 오타 · 빠뜨림이 조용히 실제 프로필의 정상 실행이 되지 않게(main 은 error 면 아무것도 하지 않고 exit 1 한다).
// - out · profile 은 절대 경로만 받는다. 값은 고치지 않고 그대로 낸다(normalize · resolve 없음 — 실행 위치에 기대지 않는다).

const path = require('node:path');

const SMOKE_FLAG = '--tj-smoke';
const NET_FLAG = '--tj-smoke-net';
const OUT_PREFIX = '--tj-smoke-out=';
const PROFILE_PREFIX = '--tj-profile=';
const NONCE_PREFIX = '--tj-smoke-nonce=';
const TJ_PREFIX = '--tj-';

/**
 * 스모크가 아니다(--tj- 인자가 없다).
 * @typedef {{ enabled: false, outDir: null, profile: null, net: false, nonce: null, error: null }} SmokeOff
 */
/**
 * 검증을 통과한 스모크 — outDir · profile 은 절대 경로, nonce 는 비어 있지 않다.
 * @typedef {{ enabled: true, outDir: string, profile: string, net: boolean, nonce: string, error: null }} SmokeOn
 */
/**
 * 틀린 스모크 인자 — 요청은 했지만 쓸 수 있는 값은 하나도 내지 않는다(out 경로가 틀린 것일 수 있다).
 * @typedef {{ enabled: true, outDir: null, profile: null, net: false, nonce: null, error: string }} SmokeInvalid
 */
/** @typedef {SmokeOff | SmokeOn | SmokeInvalid} SmokeArgs */
/**
 * 런처가 넘기는 값.
 * @typedef {object} SmokeOptions
 * @property {string} outDir 결과(result.json)를 쓸 폴더의 절대 경로
 * @property {string} profile userData 로 쓸 폴더의 절대 경로(이번 실행 전용)
 * @property {boolean} net --net 스모크(실제 Supabase 연결 검사)인가
 * @property {string} nonce 이번 실행의 표식 — 결과에 그대로 실려 지난 실행의 결과와 섞이지 않게 한다
 */

/** @returns {SmokeOff} */
function off() {
  return { enabled: false, outDir: null, profile: null, net: false, nonce: null, error: null };
}

/**
 * @param {string} error
 * @returns {SmokeInvalid}
 */
function invalid(error) {
  return { enabled: true, outDir: null, profile: null, net: false, nonce: null, error };
}

/**
 * 절대 경로인가 — pathImpl 의 isAbsolute 에 더해, win32 에서는 루트가 드라이브(C:\) · UNC(\\server\share\)여야 한다.
 * path.win32.isAbsolute 는 드라이브 없는 '\x' · '/x'(지금 드라이브 기준)도 참이지만 Chromium 의 FilePath 는 이것을 절대 경로로
 * 보지 않는다(app.setPath 가 그 규칙을 쓴다). 그래서 루트가 구분자 하나뿐이면 거부한다.
 * @param {string} value
 * @param {import('node:path').PlatformPath} pathImpl
 * @returns {boolean}
 */
function isAbsolutePath(value, pathImpl) {
  if (value === '' || !pathImpl.isAbsolute(value)) return false;
  return pathImpl.sep !== '\\' || pathImpl.parse(value).root.length > 1;
}

/**
 * process.argv 에서 스모크 인자를 읽는다. throw 하지 않는다. --tj- 로 시작하지 않는 인자(실행 파일 · 앱 폴더 · Chromium 스위치)는
 * 어디에 있든 보지 않는다. 같은 인자가 두 번이거나 모르는 --tj- 인자가 있으면 틀린 것이다(첫 오류 하나를 낸다).
 * @param {readonly string[]} argv
 * @param {import('node:path').PlatformPath} [pathImpl] 경로 규칙 — 시험이 path.win32 · path.posix 를 넣어 본다
 * @returns {SmokeArgs}
 */
function parseSmokeArgs(argv, pathImpl = path) {
  const tjArgs = argv.filter((arg) => typeof arg === 'string' && arg.startsWith(TJ_PREFIX));
  if (tjArgs.length === 0) return off();

  let smoke = false;
  let net = false;
  /** @type {string | null} */
  let outDir = null;
  /** @type {string | null} */
  let profile = null;
  /** @type {string | null} */
  let nonce = null;
  for (const arg of tjArgs) {
    if (arg === SMOKE_FLAG) {
      if (smoke) return invalid(`${SMOKE_FLAG} 가 두 번 있다`);
      smoke = true;
    } else if (arg === NET_FLAG) {
      if (net) return invalid(`${NET_FLAG} 가 두 번 있다`);
      net = true;
    } else if (arg.startsWith(OUT_PREFIX)) {
      if (outDir !== null) return invalid(`${OUT_PREFIX} 가 두 번 있다`);
      outDir = arg.slice(OUT_PREFIX.length);
    } else if (arg.startsWith(PROFILE_PREFIX)) {
      if (profile !== null) return invalid(`${PROFILE_PREFIX} 가 두 번 있다`);
      profile = arg.slice(PROFILE_PREFIX.length);
    } else if (arg.startsWith(NONCE_PREFIX)) {
      if (nonce !== null) return invalid(`${NONCE_PREFIX} 가 두 번 있다`);
      nonce = arg.slice(NONCE_PREFIX.length);
    } else {
      return invalid(`모르는 인자다: ${arg}`);
    }
  }

  if (!smoke) return invalid(`${SMOKE_FLAG} 없이 스모크 인자가 있다`);
  if (outDir === null) return invalid(`${OUT_PREFIX} 가 없다`);
  if (!isAbsolutePath(outDir, pathImpl)) return invalid(`${OUT_PREFIX} 는 절대 경로여야 한다: ${JSON.stringify(outDir)}`);
  if (profile === null) return invalid(`${PROFILE_PREFIX} 가 없다`);
  if (!isAbsolutePath(profile, pathImpl)) return invalid(`${PROFILE_PREFIX} 는 절대 경로여야 한다: ${JSON.stringify(profile)}`);
  if (nonce === null || nonce === '') return invalid(`${NONCE_PREFIX} 가 없거나 비어 있다`);
  return { enabled: true, outDir, profile, net, nonce, error: null };
}

/**
 * 런처가 Electron 에 넘길 스모크 인자. 값은 검사하지 않는다 — 받는 쪽(parseSmokeArgs)이 검사한다.
 * 값 하나가 인자 하나다: 공백 · 한글 경로를 따옴표로 감싸지 않는다(spawn 이 인자 경계를 지킨다).
 * @param {SmokeOptions} options
 * @returns {string[]}
 */
function formatSmokeArgs({ outDir, profile, net, nonce }) {
  const args = [SMOKE_FLAG, OUT_PREFIX + outDir, PROFILE_PREFIX + profile, NONCE_PREFIX + nonce];
  if (net) args.push(NET_FLAG);
  return args;
}

module.exports = { parseSmokeArgs, formatSmokeArgs };
