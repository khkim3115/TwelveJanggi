'use strict';
// 스모크 런처의 순수 판단(설계 §5.10 '런처') — 런처(desktop/scripts/smoke.cjs)가 부르는 인자 · 앱의 env · 잠금 주인 생존 · 고정한
// electron 확인. 값과 파일만 보고 정한다: 앱을 띄우고 끄는 일(시간 제한 · 트리 종료 · 신호)은 런처에 있고 여기서 시험하지 않는다.
// electron 을 require 하지 않는다 — 고정한 electron 확인도 패키지의 파일과 부르는 쪽이 넘긴 resolve 만 본다.
// env 이름은 대소문자를 가리지 않고 본다. Windows 의 env 는 이름의 대소문자를 가리지 않지만 펼친 복사본(Object.entries)은 원래 글자를
// 지닌다 — 'Temp' 가 새로 넣은 'TEMP' 와 따로 남거나, 'NPM_CONFIG_NET' 으로 적힌 것을 'npm_config_net' 으로 찾다 놓치지 않게.

const fs = require('node:fs');
const path = require('node:path');
const { isRecord } = require('./guards.cjs');

const NET_ARG = '--net';
const TIMEOUT_PREFIX = '--timeout=';
const MIN_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 90;
const DEFAULT_TIMEOUT_SEC = 90;
/** 사용법 한 줄 — 인자가 틀리면 런처가 이유 다음에 찍는다. */
const USAGE = `사용법: npm --prefix desktop run smoke [-- [${NET_ARG}] [${TIMEOUT_PREFIX}<${MIN_TIMEOUT_SEC}~${MAX_TIMEOUT_SEC} 초, 기본 ${DEFAULT_TIMEOUT_SEC}>]] — 인자마다 한 번만`;

/**
 * npm 이 가져간 런처 인자의 env 이름(대문자로 비교한다). -- 없이 `npm --prefix desktop run smoke --net` 이라 쓰면 npm 은 그 플래그를
 * 자기 설정으로 읽어 npm_config_net=true 를 env 에 넣고 스크립트에는 아무것도 넘기지 않는다(경고 없음, npm 10.9.2). 그대로 두면
 * --net 스모크가 기본 스모크로 돌고 ok 로 끝난다. npm 에는 net · timeout 설정이 없어 이 이름은 가져간 인자나 .npmrc 에서만 온다.
 */
const NPM_SWALLOWED = new Set(['NPM_CONFIG_NET', 'NPM_CONFIG_TIMEOUT']);
const NPM_HINT = 'npm 인자는 -- 뒤에 쓴다: npm --prefix desktop run smoke -- --net';

/**
 * 앱 env 에서 빼기만 하는 이름(대문자로 비교한다).
 * - ELECTRON_RUN_AS_NODE: 있으면 electron 이 앱이 아니라 node 로 돈다
 * - ELECTRON_DISABLE_SECURITY_WARNINGS: 보안 경고를 숨긴다 — securityWarnings 검사가 '0건' 으로 거짓 통과한다(45 는 DISABLE 이 이긴다)
 * - TJ_DEVTOOLS: main 이 DevTools 를 연다(개발 실행 전용)
 * - NODE_OPTIONS: 패키지하지 않은 앱의 main 프로세스가 따른다 — 부모 셸의 --require 가 main.js 보다 먼저 돌고, --inspect 는 포트를 연다
 * - ELECTRON_FORCE_IS_PACKAGED: app.isPackaged 를 뒤집는다 — main 이 개발 렌더러 루트(dist-tray) 대신 resources/renderer 를 연다
 * 그 밖(ELECTRON_ENABLE_LOGGING 같은 기록 · 디버그 변수)은 그대로 넘긴다.
 */
const CHILD_ENV_DROP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SECURITY_WARNINGS', 'TJ_DEVTOOLS', 'NODE_OPTIONS', 'ELECTRON_FORCE_IS_PACKAGED'];
/** 앱의 임시 폴더 이름 — 셋 모두 <run>/tmp 로 바꾼다(Windows 는 TMP · TEMP 를, POSIX 는 TMPDIR 을 본다). */
const CHILD_ENV_TMP = ['TMP', 'TEMP', 'TMPDIR'];
/** 보안 경고를 켜는 이름 — 1 로 넣는다(44 는 ENABLE 이 이긴다). */
const SECURITY_WARNINGS = 'ELECTRON_ENABLE_SECURITY_WARNINGS';
/** 앱 env 로 옮기지 않는 이름 전부 — 빼기만 하는 것과 바꿔 넣는 것. */
const CHILD_ENV_REMOVE = new Set([...CHILD_ENV_DROP, ...CHILD_ENV_TMP, SECURITY_WARNINGS]);

const CI_FIX = 'npm --prefix desktop ci 로 desktop 의존성을 설치한다';
const INSTALL_FIX = 'node desktop/node_modules/electron/install.js 로 바이너리를 받는다';

/**
 * 검사를 지난 인자.
 * @typedef {object} CliArgs
 * @property {boolean} net --net(실제 Supabase 연결 검사)인가
 * @property {number} timeoutSec 하드 타임아웃(초)
 */

/**
 * 런처 인자 — --net 과 --timeout=<10~90 의 정수>(초) 뿐이고 각각 한 번만 받는다. 그 밖의 인자 · 되풀이 · 틀린 값은 오류다.
 * 시간은 0 으로 시작하지 않는 십진수만 받는다('015' · '1.5' · '-10' 은 틀린 값).
 * env 에 npm 이 가져간 인자(npm_config_net · npm_config_timeout — 이름의 대소문자 무시, 값 무관)가 있으면 argv 와 상관없이 오류다.
 * 던지지 않고 fs 를 건드리지 않는다 — 런처는 잠금 전에 부르고, 오류면 이유와 사용법만 찍고 끝난다.
 * @param {readonly string[]} argv process.argv.slice(2)
 * @param {NodeJS.ProcessEnv} env 런처의 env(process.env)
 * @returns {({ ok: true } & CliArgs) | { ok: false, error: string }}
 */
function parseArgs(argv, env) {
  const swallowed = Object.keys(env).filter((name) => NPM_SWALLOWED.has(name.toUpperCase()));
  if (swallowed.length > 0) return { ok: false, error: `npm 이 런처 인자를 가져갔다(${swallowed.join(' · ')}) — ${NPM_HINT}` };
  let net = false;
  /** @type {number | null} */
  let timeoutSec = null;
  for (const arg of argv) {
    if (arg === NET_ARG) {
      if (net) return { ok: false, error: `${NET_ARG} 가 두 번 있다` };
      net = true;
    } else if (arg.startsWith(TIMEOUT_PREFIX)) {
      if (timeoutSec !== null) return { ok: false, error: `${TIMEOUT_PREFIX} 가 두 번 있다` };
      const value = arg.slice(TIMEOUT_PREFIX.length);
      const seconds = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
      if (!(seconds >= MIN_TIMEOUT_SEC && seconds <= MAX_TIMEOUT_SEC)) {
        return { ok: false, error: `--timeout 은 ${MIN_TIMEOUT_SEC}~${MAX_TIMEOUT_SEC} 의 정수(초)여야 한다: ${JSON.stringify(value)}` };
      }
      timeoutSec = seconds;
    } else {
      return { ok: false, error: `모르는 인자다: ${JSON.stringify(arg)}` };
    }
  }
  return { ok: true, net, timeoutSec: timeoutSec ?? DEFAULT_TIMEOUT_SEC };
}

/**
 * 앱의 env — env 를 옮겨 담되 CHILD_ENV_REMOVE 의 이름은 대소문자를 가리지 않고 뺀 뒤, 임시 폴더 셋(TMP · TEMP · TMPDIR)을 tmpDir 로,
 * ELECTRON_ENABLE_SECURITY_WARNINGS 를 1 로 넣는다. 바꿔 넣는 이름도 모든 글자꼴을 먼저 뺀다 — 같은 이름이 글자만 달리 둘이면 앱이
 * 어느 값을 읽을지 모른다. env 는 바꾸지 않고 새 객체를 돌려준다.
 * @param {NodeJS.ProcessEnv} env 런처의 env(process.env)
 * @param {string} tmpDir <run>/tmp
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv(env, tmpDir) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (!CHILD_ENV_REMOVE.has(name.toUpperCase())) out[name] = value;
  }
  for (const name of CHILD_ENV_TMP) out[name] = tmpDir;
  out[SECURITY_WARNINGS] = '1';
  return out;
}

/**
 * 잠금 주인 PID 가 살아 있는가(smokeFs.acquireLock 의 isAlive). kill(pid, 0) 은 신호를 보내지 않고 있는지만 본다:
 * 성공 · EPERM(남의 프로세스) → 산 것, ESRCH → 죽은 것. 그 밖의 오류는 알 수 없는 것이라 산 것으로 본다 — 남의 잠금을 빼앗지 않는다.
 * 내 PID 는 묻지 않고 죽은 것이다(kill(내 PID, 0) 은 늘 성공한다). acquireLock 은 내 'wx' 만들기가 실패한 뒤에만 묻는다 — 그 잠금은
 * 내가 만든 것이 아니라, 강제로 끝난 지난 실행의 PID 를 이 프로세스가 다시 받은 것이다.
 * @param {number} pid
 * @param {(pid: number, signal: 0) => unknown} [kill] 기본은 process.kill — 시험이 가짜를 넣는다
 * @returns {boolean}
 */
function isAlive(pid, kill = (target, signal) => process.kill(target, signal)) {
  if (pid === process.pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return !(isRecord(err) && err.code === 'ESRCH');
  }
}

/**
 * 파일인가(링크는 따라간다). 없거나 읽지 못하면 false.
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
 * 고정한 electron(appDir/node_modules/electron)을 쓸 수 있는가 — 런처가 require('electron') 보다 먼저 본다. electron 44 의 index.js 는
 * 바이너리가 없으면(path.txt 가 없거나 비었거나 dist/<그 이름> 이 없으면) 묻지 않고 내려받는다(install.js — 네트워크). 런처는 내려받지
 * 않는다: 그 경우를 모두 여기서 막고 설치 명령을 안내한다.
 * - package.json 이 없으면 → npm --prefix desktop ci
 * - 'electron/package.json' 이 이 폴더가 아닌 곳(위 폴더의 node_modules · NODE_PATH · 링크의 대상)으로 풀리면 → npm --prefix desktop ci.
 *   그대로 두면 실행 파일과 기대 버전(expectedElectron)이 함께 엉뚱한 패키지에서 와서 버전 검사도 통과한다.
 * - path.txt 를 읽지 못하거나, 그 이름이 dist 안의 파일이 아니면(빈 이름 · dist 밖 · 없음 · 폴더) → install.js
 * ELECTRON_OVERRIDE_DIST_PATH 는 부르는 쪽이 먼저 거부한다(그 변수가 path.txt 보다 앞서 실행 파일을 바꾼다).
 * 경로는 path.relative 로 비교한다 — Windows 에서는 대소문자를 가리지 않는다.
 * @param {string} appDir desktop/ 의 절대 경로
 * @param {(request: string) => string} resolve 런처의 require.resolve — 런처가 require 할 'electron/package.json' 이 어디서 오는지 본다
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function checkElectron(appDir, resolve) {
  const electronDir = path.join(appDir, 'node_modules', 'electron');
  const manifest = path.join(electronDir, 'package.json');
  if (!isFile(manifest)) return { ok: false, error: `electron 패키지가 없다: ${manifest} — ${CI_FIX}` };
  /** @type {string} */
  let resolved;
  try {
    resolved = resolve('electron/package.json');
  } catch (err) {
    return { ok: false, error: `electron/package.json 을 찾지 못했다 (${err instanceof Error ? err.message : String(err)}) — ${CI_FIX}` };
  }
  if (path.relative(electronDir, path.dirname(resolved)) !== '') {
    return { ok: false, error: `electron 이 고정한 ${electronDir} 가 아닌 곳에서 풀린다: ${resolved} — ${CI_FIX}` };
  }
  const pathFile = path.join(electronDir, 'path.txt');
  /** @type {string} */
  let name;
  try {
    name = fs.readFileSync(pathFile, 'utf8');
  } catch (err) {
    return { ok: false, error: `${pathFile} 를 읽지 못했다 (${err instanceof Error ? err.message : String(err)}) — ${INSTALL_FIX}` };
  }
  const distDir = path.join(electronDir, 'dist');
  const executable = path.join(distDir, name);
  const inside = path.relative(distDir, executable);
  if (inside === '' || inside === '..' || inside.startsWith(`..${path.sep}`) || !isFile(executable)) {
    return { ok: false, error: `electron 바이너리가 없다: ${executable} (path.txt ${JSON.stringify(name)}) — ${INSTALL_FIX}` };
  }
  return { ok: true };
}

module.exports = { USAGE, parseArgs, childEnv, isAlive, checkElectron };
