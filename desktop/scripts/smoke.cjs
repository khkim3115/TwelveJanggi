'use strict';
// 스모크 런처(설계 §5.10 '런처') — plain node 로 돈다: npm --prefix desktop run smoke [-- [--net] [--timeout=<10~90>]].
// 스모크의 바깥 절반이다. 이번 실행만의 프로필로 실제 앱(desktop/main.js 를 고정한 electron 바이너리로)을 스모크 모드로 띄우고,
// 하드 타임아웃을 지키고, 끝난 뒤 남은 것을 치우고, 앱이 쓴 결과(desktop/smoke-out/result.json)를 판정기(lib/smokeResult.cjs)로
// 판정한다. 판정 · 정리 · 잠금 · 인자 · 앱 env · 고정한 electron 의 규칙은 lib/ 의 순수 모듈에 있고(시험도 거기서 한다 — 인자 · env ·
// 잠금 주인 · electron 확인은 lib/smokeLaunch.cjs) 이 파일은 순서대로 잇기만 한다:
//   인자(npm 이 가져간 인자 포함) → os.tmpdir() 스냅샷 → 잠금 → smoke-out 비우기 → 트레이 빌드 · ELECTRON_OVERRIDE_DIST_PATH ·
//   고정한 electron 확인(내려받지 않는다) → 지난 tj-smoke-* 정리 → 실행 폴더(profile · tmp) · nonce → 앱(시간 제한 · 신호면 트리 종료) →
//   tmpLeft → 실행 폴더 지우기 → 스냅샷 비교 → 판정 → summary.json · 표 → 잠금 풀기 → exit 0(판정 ok) / 1.
// - 스냅샷은 fs 동작 중 맨 먼저다 — 잠금 파일 · 실행 폴더 · 앱이 만드는 것이 모두 '실행 뒤 새 항목' 에 잡힌다. 인자 검사는 fs 를
//   건드리지 않아 그보다 앞에 둔다(틀린 인자는 아무것도 하지 않고 끝난다).
// - 잠금을 얻은 뒤의 출구는 모두 잠금을 푼다(finally). 얻지 못했으면 풀지 않는다 — 남의 잠금이다.
// - smoke-out 은 잠금 바로 뒤에 비운다(설계의 4단계보다 앞) — 앱을 띄우기 전의 출구(빌드 없음 등)가 지난 실행의 summary.json
//   (verdict ok)을 남겨 이번 실행의 것으로 읽히지 않게. 조기 출구는 summary.json 을 쓰지 않는다 — 이유는 콘솔에 있다.
// - 앱을 띄운 뒤에는 무엇이 잘못돼도(시간 초과 · Ctrl+C · 판정기 예외) 같은 길로 끝난다: 실행 폴더를 지우고, 비교하고, 판정하고,
//   요약을 쓴다. 판정은 파일로 한다 — Windows 의 GUI 앱 stdout 은 믿을 수 없어서, 앱 출력은 접두를 붙여 보여 주기만 한다.
// - 동시 실행은 지원하지 않는다. 잠금은 실수로 겹치는 것을 막는다.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ENTRY_FILE } = require('../lib/appProtocol.cjs');
const { isNonEmptyString, isRecord } = require('../lib/guards.cjs');
const { formatSmokeArgs } = require('../lib/smokeArgs.cjs');
const { acquireLock, diffEntries, releaseLock, removeWithRetry, sweepStale } = require('../lib/smokeFs.cjs');
const { USAGE, checkElectron, childEnv, isAlive, parseArgs } = require('../lib/smokeLaunch.cjs');
const { RESULT_FILE, writeJsonAtomic } = require('../lib/smokeOut.cjs');
const { judgeSmoke, requiredChecks } = require('../lib/smokeResult.cjs');
const { parseTrayBuild } = require('../lib/trayBuildInfo.cjs');

/** 앱 폴더(desktop/) — electron 의 첫 인자다(package.json 의 main 을 연다). */
const APP_DIR = path.resolve(__dirname, '..');
/** 렌더러 루트 — main 이 개발 실행에서 여는 곳(desktop/../dist-tray)과 같다. */
const RENDERER_ROOT = path.join(APP_DIR, '..', 'dist-tray');
/** 빌드 정보 파일 — main.js 의 TRAY_BUILD_FILE 과 같은 이름이다. */
const TRAY_BUILD_FILE = 'tray-build.json';
/** 결과 폴더 — 앱이 result.json · screenshot.png 를, 런처가 summary.json 을 쓴다(git 이 무시한다). */
const OUT_DIR = path.join(APP_DIR, 'smoke-out');
const SUMMARY_FILE = 'summary.json';
/** 실행 폴더 이름의 접두사(mkdtemp 가 뒤를 채운다) — 지난 실행의 잔여 정리와 실행 뒤 비교가 이 이름을 본다. */
const RUN_PREFIX = 'tj-smoke-';
/** 동시 실행 잠금 — os.tmpdir() 바로 아래 파일. RUN_PREFIX 로 시작하지 않는다(점) — 잔여 정리가 건드리지 않는다. */
const LOCK_NAME = 'tj-smoke.lock';

/** 트리를 끝낸 뒤 앱이 끝나기를 기다리는 상한(ms). 넘으면 끝나지 않은 채로 정리 · 판정한다(실패). */
const KILL_GRACE_MS = 10000;
/** 앱이 끝난 뒤 남은 출력을 기다리는 상한(ms) — 손자 프로세스가 파이프를 쥐면 출력이 끝나지 않을 수 있다. */
const OUTPUT_DRAIN_MS = 3000;
/** main 이 끝난 뒤에도 남은 핸들이 프로세스를 붙잡으면 이만큼 뒤에 끝낸다(ms). */
const EXIT_SAFETY_MS = 2000;
/** 표의 근거(detail) 글자 수 상한 — 전체는 result.json 에 있다. */
const DETAIL_CHARS = 120;

/**
 * <run>/tmp 에 남은 항목 한 건(summary.tmpLeft) — 정보다. 판정에는 쓰지 않는다.
 * @typedef {object} LeftEntry
 * @property {string} name <run>/tmp 바로 아래 이름
 * @property {'file' | 'dir' | 'other'} kind other 는 링크 · 정션 등(따라가지 않는다)
 * @property {number} size 바이트 — 폴더는 안에 든 파일의 합
 */
/**
 * 앱이 어떻게 끝났는가.
 * @typedef {object} AppExit
 * @property {number | null} exitCode 종료 코드. 신호로 끝났거나 끝나지 않았으면 null
 * @property {string | null} signal 끝낸 신호 이름(POSIX). 아니면 null
 * @property {string | null} problem 런처가 실패 이유로 더할 것(띄우지 못함 · 끝나지 않음). 없으면 null
 */
/**
 * 떠 있는 앱.
 * @typedef {object} AppRun
 * @property {Promise<AppExit>} exited 앱이 끝나면 풀린다. 거부하지 않는다
 * @property {(why: string) => boolean} kill 트리를 끝낸다 — 한 번만 하고, 이미 끝났으면(exit 를 받았으면) 아무것도 하지 않는다.
 *   이번 호출이 끝내기를 시작했으면 true
 */

/** @param {string} message */
function log(message) {
  console.log(`[smoke] ${message}`);
}

/** @param {string} message */
function logError(message) {
  console.error(`[smoke] ${message}`);
}

/**
 * 던져진 값의 code(Node 오류의 'ENOENT' 등). 없으면 undefined.
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errorCode(err) {
  return isRecord(err) && typeof err.code === 'string' ? err.code : undefined;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * desktop/smoke-out 을 빈 폴더로 만든다 — 지난 실행의 result.json · screenshot.png · summary.json 이 이번 실행의 것으로 읽히지 않게.
 * 폴더는 두고 안의 항목만 지운다(재시도 — 막 쓴 파일을 백신이 잠시 잡는 경우). 폴더가 아니면(파일 · 링크 · 정션) 따라가 지우지 않고 거부한다.
 * @param {string} outDir
 * @returns {Promise<string | null>} 비우지 못한 이유. 비웠으면 null
 */
async function emptyOutDir(outDir) {
  /** @type {import('node:fs').Stats | null} */
  let stat = null;
  try {
    stat = fs.lstatSync(outDir);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') return `확인하지 못했다 (${errorText(err)})`;
  }
  if (stat !== null && !stat.isDirectory()) return '폴더가 아니다(파일 · 링크 · 정션) — 따라가 지우지 않는다. 직접 지운 뒤 다시 실행한다';
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const name of fs.readdirSync(outDir)) {
      const removed = await removeWithRetry(path.join(outDir, name));
      if (!removed.removed) return `${name} 을 지우지 못했다 (${errorText(removed.lastError)}) — 그 파일을 연 프로그램을 닫는다`;
    }
  } catch (err) {
    return errorText(err);
  }
  return null;
}

/**
 * 트레이 빌드를 확인한다(설계 §5.10 런처 1단계) — tray-build.json 을 main 과 같은 parseTrayBuild 로 읽고, tray.html 이 파일인지 본다.
 * @returns {{ ok: true, value: import('../lib/trayBuildInfo.cjs').TrayBuildInfo } | { ok: false, error: string }}
 */
function loadBuild() {
  const buildFile = path.join(RENDERER_ROOT, TRAY_BUILD_FILE);
  /** @type {string} */
  let text;
  try {
    text = fs.readFileSync(buildFile, 'utf8');
  } catch (err) {
    return { ok: false, error: `${buildFile}: 읽지 못했다 (${errorText(err)})` };
  }
  const parsed = parseTrayBuild(text);
  if (!parsed.ok) return { ok: false, error: `${buildFile}: ${parsed.error}` };
  const entry = path.join(RENDERER_ROOT, ENTRY_FILE);
  let isFile = false;
  try {
    isFile = fs.statSync(entry).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return { ok: false, error: `${entry}: 없다` };
  return parsed;
}

/**
 * 고정한 electron — 실행 파일 경로와 패키지 버전. plain node 에서 require('electron') 은 electron 패키지가 정한 실행 파일 경로다.
 * 그 require 는 바이너리가 없으면 내려받는다 — 그래서 부르기 전에 checkElectron 이 패키지 · 바이너리 · 풀리는 곳을 확인하고,
 * ELECTRON_OVERRIDE_DIST_PATH(이 경로를 바꾼다)를 거부한다. 그래도 던지면 설치 명령을 안내한다.
 * @returns {{ ok: true, executable: string, version: string } | { ok: false, error: string }}
 */
function resolveElectron() {
  try {
    const executable = /** @type {string} */ (/** @type {unknown} */ (require('electron')));
    // electron 안에서 이 파일을 돌리면 require('electron') 은 경로가 아니라 API 객체다.
    if (!isNonEmptyString(executable)) return { ok: false, error: 'electron 실행 파일 경로를 얻지 못했다 — 이 스크립트는 plain node 로 실행한다' };
    const { version } = require('electron/package.json');
    return { ok: true, executable, version };
  } catch (err) {
    const fix =
      errorCode(err) === 'MODULE_NOT_FOUND'
        ? 'npm --prefix desktop ci 로 desktop 의존성을 설치한다'
        : 'node desktop/node_modules/electron/install.js 로 바이너리를 받는다';
    return { ok: false, error: `electron 을 쓸 수 없다 (${errorText(err)}) — ${fix}` };
  }
}

/**
 * 자식의 출력 흐름을 줄 단위로 out 에 옮긴다(줄마다 prefix). 흐름이 끝나면(끝 · 닫힘 · 오류) 남은 조각을 한 줄로 내보내고 풀린다.
 * 거부하지 않는다.
 * @param {import('node:stream').Readable | null} stream
 * @param {NodeJS.WritableStream} out
 * @param {string} prefix
 * @returns {Promise<void>}
 */
function pipeLines(stream, out, prefix) {
  return new Promise((resolve) => {
    if (stream === null) {
      resolve();
      return;
    }
    let pending = '';
    const end = () => {
      if (pending !== '') out.write(`${prefix}${pending}\n`);
      pending = '';
      resolve();
    };
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = `${pending}${chunk}`.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${line}\n`);
    });
    stream.once('end', end);
    stream.once('close', end);
    stream.on('error', end);
  });
}

/**
 * 앱과 그 아래 프로세스(렌더러 · GPU 등)를 모두 끝낸다. Windows 는 PID 로 taskkill /T /F 한다 — 이미지 이름(electron.exe)으로 끄면
 * 사용자의 다른 electron 앱도 꺼진다. POSIX 는 SIGKILL 이다(Chromium 의 자식들은 부모가 사라지면 스스로 끝난다).
 * @param {import('node:child_process').ChildProcess} child
 * @returns {string | null} 실패했으면 그 이유
 */
function killTree(child) {
  if (child.pid === undefined) return null;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (result.error !== undefined) return `taskkill 을 실행하지 못했다: ${errorText(result.error)}`;
    return result.status === 0 ? null : `taskkill 이 실패했다(종료 코드 ${result.status}) — 이미 끝났을 수 있다`;
  }
  return child.kill('SIGKILL') ? null : 'kill 이 실패했다 — 이미 끝났을 수 있다';
}

/**
 * 앱을 띄운다 — stdin 은 닫고 stdout · stderr 는 파이프로 받아 줄마다 접두([app] · [app:err])를 붙여 그대로 내보낸다.
 * exited 는 거부하지 않는다: 띄우지 못했으면 problem 과 함께, 끝났으면 종료 코드 · 신호와 함께(남은 출력을 OUTPUT_DRAIN_MS 까지
 * 기다린 뒤), kill 뒤 KILL_GRACE_MS 안에 끝나지 않으면 problem 과 함께 풀린다.
 * @param {string} executable
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {AppRun}
 */
function startApp(executable, args, env) {
  /** @type {(value: AppExit) => void} */
  let resolveExit = () => {};
  /** @type {Promise<AppExit>} */
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let settled = false;
  let exitSeen = false;
  let killed = false;
  /** @type {NodeJS.Timeout | undefined} */
  let graceTimer;
  /** @param {AppExit} value */
  const settle = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(graceTimer);
    resolveExit(value);
  };

  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    // windowsHide 는 켜지 않는다 — 첫 ShowWindow 가 숨김을 물려받아 창이 보이지 않을 수 있다(스크린샷 검사).
    child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  } catch (err) {
    settle({ exitCode: null, signal: null, problem: `앱을 띄우지 못했다: ${errorText(err)}` });
    return { exited, kill: () => false };
  }
  if (child.pid !== undefined) log(`앱 PID ${child.pid}`);
  const output = Promise.all([pipeLines(child.stdout, process.stdout, '[app] '), pipeLines(child.stderr, process.stderr, '[app:err] ')]);
  /** 앱의 파이프를 놓는다 — 손자 프로세스가 쥐고 있어도 이 프로세스가 끝날 수 있게. */
  const release = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  child.on('error', (err) => {
    // 띄우기 실패(ENOENT 등)면 pid 가 없고 'exit' 가 오지 않을 수 있다. 띄운 뒤의 오류(POSIX 의 kill 실패 등)는 알리기만 한다.
    if (child.pid === undefined) {
      release();
      settle({ exitCode: null, signal: null, problem: `앱을 띄우지 못했다: ${errorText(err)}` });
    } else {
      logError(`앱 프로세스 오류: ${errorText(err)}`);
    }
  });
  child.once('exit', (code, signal) => {
    exitSeen = true;
    const finish = () => {
      clearTimeout(drainTimer);
      release();
      settle({ exitCode: code, signal, problem: null });
    };
    const drainTimer = setTimeout(finish, OUTPUT_DRAIN_MS);
    output.then(finish, finish);
  });
  return {
    exited,
    kill(why) {
      if (killed || exitSeen || settled) return false;
      killed = true;
      log(`${why} — 앱 트리를 끝낸다(PID ${child.pid})`);
      const failure = killTree(child);
      if (failure !== null) logError(failure);
      graceTimer = setTimeout(() => {
        release();
        child.unref();
        settle({
          exitCode: null,
          signal: null,
          problem: `앱이 끝나지 않았다 — 트리를 끝내고 ${KILL_GRACE_MS / 1000}초를 기다렸다. 직접 끝낸다: taskkill /PID ${child.pid} /T /F`,
        });
      }, KILL_GRACE_MS);
      return true;
    },
  };
}

/**
 * 폴더 안 파일 크기의 합(바이트). 링크 · 정션은 따라가지 않고, 읽지 못하는 항목은 세지 않는다.
 * @param {string} dir
 * @returns {number}
 */
function treeSize(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) total += treeSize(target);
    else if (entry.isFile()) total += fileSize(target);
  }
  return total;
}

/**
 * @param {string} file
 * @returns {number}
 */
function fileSize(file) {
  try {
    return fs.lstatSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * @param {string} dir
 * @param {import('node:fs').Dirent} entry
 * @returns {LeftEntry}
 */
function leftEntry(dir, entry) {
  const target = path.join(dir, entry.name);
  if (entry.isDirectory()) return { name: entry.name, kind: 'dir', size: treeSize(target) };
  if (entry.isFile()) return { name: entry.name, kind: 'file', size: fileSize(target) };
  return { name: entry.name, kind: 'other', size: 0 };
}

/**
 * <run>/tmp 에 남은 것 — 바로 아래 항목의 이름 · 종류 · 크기(이름순). 앱이 끝난 뒤, 실행 폴더를 지우기 전에 본다(설계 §5.10 런처
 * 7단계 — 정보다). 폴더가 없으면 빈 목록, 읽지 못하면 null.
 * @param {string} dir
 * @returns {LeftEntry[] | null}
 */
function listLeft(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return errorCode(err) === 'ENOENT' ? [] : null;
  }
  return entries.map((entry) => leftEntry(dir, entry)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 앱이 쓴 result.json. 없으면 value null 이다(판정기가 '없다' 고 한다). 있는데 읽지 못했거나 JSON 이 아니면 value null 과 그 이유.
 * @param {string} file
 * @returns {{ value: unknown, note: string | null }}
 */
function readResult(file) {
  /** @type {string} */
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { value: null, note: errorCode(err) === 'ENOENT' ? null : `${RESULT_FILE} 를 읽지 못했다 (${errorText(err)})` };
  }
  try {
    return { value: JSON.parse(text), note: null };
  } catch (err) {
    return { value: null, note: `${RESULT_FILE} 가 JSON 이 아니다 (${errorText(err)})` };
  }
}

/**
 * 표에 쓰는 한 줄 — 공백을 하나로 접고 DETAIL_CHARS 에서 자른다.
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS)}…` : flat;
}

/**
 * 검사 표 · 판정 · 이유를 출력한다(형식은 빌더 몫 — 설계 §6). 줄은 이번 실행의 필수 검사 순서이고, 결과에만 있는 검사가 뒤에
 * 붙는다. 상태는 ok · FAIL(ok 가 true 가 아닌 항목이 있다) · MISSING(보고되지 않았다). 판정은 judgeSmoke 가 하고 표는 보여 줄 뿐이다.
 * @param {unknown} result result.json 을 읽은 값(없으면 null)
 * @param {readonly string[]} required
 * @param {'ok' | 'fail'} verdict
 * @param {readonly string[]} reasons
 * @returns {void}
 */
function printReport(result, required, verdict, reasons) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byName = new Map();
  const checks = isRecord(result) && Array.isArray(result.checks) ? result.checks : [];
  for (const entry of checks) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue;
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  }
  const names = [...required, ...[...byName.keys()].filter((name) => !required.includes(name))];
  const width = Math.max(0, ...names.map((name) => name.length));
  log(`검사 ${names.length}개(필수 ${required.length}개)`);
  for (const name of names) {
    const entries = byName.get(name) ?? [];
    const bad = entries.find((entry) => entry.ok !== true);
    const status = entries.length === 0 ? 'MISSING' : bad === undefined ? 'ok' : 'FAIL';
    const shown = bad ?? entries[0];
    const detail = shown !== undefined && typeof shown.detail === 'string' ? oneLine(shown.detail) : '';
    console.log(`  ${name.padEnd(width)}  ${status.padEnd(7)}  ${detail}`.trimEnd());
  }
  log(`판정: ${verdict}`);
  for (const reason of reasons) console.log(`  - ${reason}`);
}

/**
 * 잠금을 쥔 동안의 실행 — smoke-out 비우기부터 summary.json 까지. 조기 출구는 1 을 돌려준다(잠금은 부른 쪽이 푼다).
 * @param {import('../lib/smokeLaunch.cjs').CliArgs} args
 * @param {string} tmpRoot os.tmpdir()
 * @param {string[]} before 실행 전 os.tmpdir() 목록
 * @returns {Promise<number>} 종료 코드
 */
async function runLocked(args, tmpRoot, before) {
  // 신호 처리기 · 타이머가 바꾸는 값 — 콜백이 바꾸는 지역 변수는 TS 흐름 분석이 놓쳐서 한 객체에 둔다.
  const state = {
    /** @type {string[]} 런처가 더하는 실패 이유(판정기의 이유 뒤에 붙는다) */
    reasons: [],
    /** @type {string | null} 받은 신호 */
    interrupted: null,
    /** @type {AppRun | null} 떠 있는 앱 */
    running: null,
    timedOut: false,
  };
  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    if (state.interrupted !== null) {
      log(`${signal} — 이미 정리 중이다`);
      return;
    }
    state.interrupted = signal;
    state.reasons.push(`신호 ${signal} 를 받아 실행을 멈췄다`);
    // 앱이 떠 있으면 트리를 끝낸다. 띄우기 전이면 띄우지 않고, 끝난 뒤면 하던 정리를 마친다 — 어느 쪽이든 실패로 끝난다.
    if (state.running === null || !state.running.kill(`신호 ${signal}`)) log(`${signal} — 정리를 마치고 끝낸다`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    // smoke-out 비우기 — 설계는 4단계(실행 폴더와 같이)지만 앞당겼다(파일 머리말).
    const cleared = await emptyOutDir(OUT_DIR);
    if (cleared !== null) {
      logError(`${OUT_DIR} 를 비우지 못했다: ${cleared}`);
      return 1;
    }

    // 트레이 빌드(설계 1단계) — main 과 같은 검증. 앱의 fail-closed 보다 먼저 이유를 알린다.
    const build = loadBuild();
    if (!build.ok) {
      logError(`${build.error} — 저장소 루트에서 npm run build:tray 로 트레이 빌드를 만든다`);
      return 1;
    }

    // ELECTRON_OVERRIDE_DIST_PATH(설계 2단계) — electron 패키지가 이 변수로 실행 파일을 바꾼다. require('electron') 보다 먼저 본다.
    // Windows 의 process.env 는 이름의 대소문자를 가리지 않으므로 어떤 글자로 적었든 여기서 잡힌다.
    if (process.env.ELECTRON_OVERRIDE_DIST_PATH !== undefined) {
      logError('ELECTRON_OVERRIDE_DIST_PATH 가 설정돼 있다 — 스모크는 고정한 바이너리(desktop/node_modules/electron)로만 돈다. 변수를 지우고 다시 실행한다');
      return 1;
    }
    // 고정한 electron — require('electron') 은 바이너리가 없으면 내려받는다. 런처는 내려받지 않는다: 먼저 확인하고 설치 명령을 안내한다.
    const pinned = checkElectron(APP_DIR, require.resolve);
    if (!pinned.ok) {
      logError(pinned.error);
      return 1;
    }
    const electron = resolveElectron();
    if (!electron.ok) {
      logError(electron.error);
      return 1;
    }

    // 지난 실행의 잔여 정리(설계 3단계) — 못 지운 폴더(다른 프로세스가 쥠)는 failed 로 남기고 계속한다. 다음 실행이 다시 지운다.
    /** @type {import('../lib/smokeFs.cjs').SweepResult} */
    let sweep;
    try {
      sweep = sweepStale(tmpRoot, RUN_PREFIX, null);
    } catch (err) {
      logError(`지난 ${RUN_PREFIX}* 를 정리하지 못했다: ${tmpRoot} (${errorText(err)})`);
      return 1;
    }
    if (sweep.removed.length > 0) log(`지난 실행 정리: ${sweep.removed.length}개 지움`);
    if (sweep.failed.length > 0) logError(`지난 실행 정리: ${sweep.failed.length}개 못 지움(${sweep.failed.join(', ')}) — 다음 실행이 다시 지운다`);

    // 실행 폴더 · nonce(설계 4단계).
    /** @type {string} */
    let runRoot;
    try {
      runRoot = fs.mkdtempSync(path.join(tmpRoot, RUN_PREFIX));
    } catch (err) {
      logError(`실행 폴더를 만들지 못했다: ${tmpRoot} (${errorText(err)})`);
      return 1;
    }
    const profile = path.join(runRoot, 'profile');
    const runTmp = path.join(runRoot, 'tmp');
    try {
      fs.mkdirSync(profile);
      fs.mkdirSync(runTmp);
    } catch (err) {
      logError(`실행 폴더를 준비하지 못했다: ${runRoot} (${errorText(err)})`);
      await removeWithRetry(runRoot);
      return 1;
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    log(`electron ${electron.version} · 시간 제한 ${args.timeoutSec}초${args.net ? ' · --net' : ''} · 실행 폴더 ${runRoot}`);

    // 앱(설계 5 · 6단계) — 하드 타임아웃을 넘거나 신호를 받으면 트리를 끝낸다. 띄우기 전에 신호를 받았으면 띄우지 않고 같은 길로 정리한다.
    /** @type {AppExit} */
    let exit = { exitCode: null, signal: null, problem: null };
    if (state.interrupted === null) {
      const app = startApp(
        electron.executable,
        [APP_DIR, ...formatSmokeArgs({ outDir: OUT_DIR, profile, net: args.net, nonce })],
        childEnv(process.env, runTmp),
      );
      state.running = app;
      // 시간 초과는 이 타이머가 실제로 트리를 끝냈을 때만이다 — 그 직전에 스스로 끝나 출력을 기다리던 앱은 시간 초과가 아니다.
      const hardTimer = setTimeout(() => {
        if (app.kill(`시간 초과(${args.timeoutSec}초)`)) state.timedOut = true;
      }, args.timeoutSec * 1000);
      exit = await app.exited;
      clearTimeout(hardTimer);
      state.running = null;
    }
    if (exit.problem !== null) state.reasons.push(exit.problem);

    // 남은 것(설계 7단계) — <run>/tmp 의 이름 · 크기(정보)를 적고 실행 폴더를 지운다(재시도). 끝내 못 지우면 다음 실행이 지운다.
    const tmpLeft = listLeft(runTmp);
    const run = await removeWithRetry(runRoot);

    // 실행 전과 비교(설계 8단계) — 이 런처의 잠금 파일은 뺀다. 새 tj-smoke-* 는 판정이 실패시키고, 그 밖의 새 항목은 경고다.
    /** @type {string[]} */
    let fresh = [];
    try {
      fresh = diffEntries(before, fs.readdirSync(tmpRoot)).filter((name) => name !== LOCK_NAME);
    } catch (err) {
      state.reasons.push(`실행 뒤 임시 폴더를 읽지 못해 비교하지 못했다: ${tmpRoot} (${errorText(err)})`);
    }
    const newSmokeDirs = fresh.filter((name) => name.startsWith(RUN_PREFIX));
    const tempNew = fresh.filter((name) => !name.startsWith(RUN_PREFIX));

    // 판정(설계 9단계) — 판정기는 던지지 않게 만들었지만, 던져도 요약 · 잠금 풀기까지 간다.
    const result = readResult(path.join(OUT_DIR, RESULT_FILE));
    if (result.note !== null) state.reasons.push(result.note);
    /** @type {import('../lib/smokeResult.cjs').Verdict} */
    let judged;
    try {
      judged = judgeSmoke({
        result: result.value,
        exitCode: exit.exitCode,
        signal: exit.signal,
        timedOut: state.timedOut,
        nonce,
        net: args.net,
        expectedElectron: electron.version,
        expectedSupabaseOrigin: build.value.supabaseOrigin,
        newSmokeDirs,
      });
    } catch (err) {
      judged = { ok: false, reasons: [`판정기가 던졌다: ${errorText(err)}`] };
    }
    const reasons = [...judged.reasons, ...state.reasons];
    /** @type {'ok' | 'fail'} */
    const verdict = judged.ok && state.reasons.length === 0 ? 'ok' : 'fail';

    // summary.json(원자적) 을 쓰고 표를 출력한다. 이번 실행의 정체(nonce · 끝난 시각 · --net · 시간 제한)도 적는다 — 지난 실행의 요약이나
    // npm 이 인자를 가져가 기본 스모크로 돈 실행을 파일만 보고 가를 수 있게.
    const summary = {
      verdict,
      reasons,
      tmpLeft,
      tempNew,
      sweep,
      run: { removed: run.removed, attempts: run.attempts, lastError: run.lastError === null ? null : errorText(run.lastError) },
      nonce,
      finishedAt: new Date().toISOString(),
      net: args.net,
      timeoutSec: args.timeoutSec,
    };
    /** @type {string | null} */
    let writeError = null;
    try {
      writeJsonAtomic(OUT_DIR, SUMMARY_FILE, summary);
    } catch (err) {
      writeError = errorText(err);
    }
    printReport(result.value, requiredChecks({ net: args.net, supabaseOrigin: build.value.supabaseOrigin }), verdict, reasons);
    if (tmpLeft === null) logError(`정보: ${runTmp} 를 읽지 못해 남은 것을 적지 못했다`);
    else if (tmpLeft.length > 0) log(`정보: 앱의 TMP 에 남았던 것 ${tmpLeft.length}개 — ${tmpLeft.map((e) => `${e.name}${e.kind === 'dir' ? '/' : ''} ${e.size}B`).join(', ')}`);
    if (!run.removed) logError(`경고: 실행 폴더를 지우지 못했다 — 다음 실행이 정리한다: ${runRoot} (${errorText(run.lastError)})`);
    if (tempNew.length > 0) logError(`경고: ${tmpRoot} 에 새 항목 ${tempNew.length}개 — ${tempNew.join(', ')}`);
    if (writeError !== null) {
      logError(`${SUMMARY_FILE} 를 쓰지 못했다: ${writeError}`);
      return 1;
    }
    log(`요약: ${path.join(OUT_DIR, SUMMARY_FILE)}`);
    return verdict === 'ok' ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    // 예상하지 못한 오류로 여기 왔는데 앱이 떠 있으면 끝낸다 — 고아로 남지 않게.
    state.running?.kill('런처 오류');
  }
}

/**
 * @param {readonly string[]} argv process.argv.slice(2)
 * @returns {Promise<number>} 종료 코드 — 판정이 ok 이고 요약을 썼을 때만 0
 */
async function main(argv) {
  // 인자 — fs 를 건드리지 않는다. 틀리면(npm 이 -- 없는 인자를 가져간 경우 포함) 이유 · 사용법을 알리고 끝낸다(잠금 전).
  const args = parseArgs(argv, process.env);
  if (!args.ok) {
    logError(args.error);
    console.error(USAGE);
    return 1;
  }

  // os.tmpdir() 스냅샷 — fs 동작 중 맨 먼저.
  const tmpRoot = os.tmpdir();
  /** @type {string[]} */
  let before;
  try {
    before = fs.readdirSync(tmpRoot);
  } catch (err) {
    logError(`임시 폴더를 읽지 못해 실행 전후를 비교할 수 없다: ${tmpRoot} (${errorText(err)})`);
    return 1;
  }

  // 동시 실행 잠금(설계 3단계 '동시 실행은 지원하지 않는다').
  const lockPath = path.join(tmpRoot, LOCK_NAME);
  /** @type {import('../lib/smokeFs.cjs').LockResult} */
  let lock;
  try {
    lock = acquireLock(lockPath, process.pid, isAlive);
  } catch (err) {
    logError(`잠금을 얻지 못했다: ${lockPath} (${errorText(err)})`);
    return 1;
  }
  if (!lock.ok) {
    logError(
      lock.holder === null
        ? `잠금 파일을 읽을 수 없다 — 다른 스모크가 돌고 있지 않으면 지우고 다시 실행한다: ${lockPath}`
        : `다른 스모크가 실행 중이다(PID ${lock.holder}) — 끝난 뒤 다시 실행한다. 그 PID 가 스모크가 아니면 잠금 파일을 지운다: ${lockPath}`,
    );
    return 1;
  }
  try {
    return await runLocked({ net: args.net, timeoutSec: args.timeoutSec }, tmpRoot, before);
  } finally {
    // 잠금을 풀고 파일이 없어졌는지 본다. 판정이 끝난 뒤의 정리라 결과를 뒤집지 않는다 — 남은 잠금은 이 PID 가 끝난 뒤 다음 실행이
    // 넘겨받는다.
    if (!releaseLock(lockPath) || fs.existsSync(lockPath)) logError(`경고: 잠금 파일이 남았다: ${lockPath}`);
  }
}

/**
 * 종료 코드를 정하고 이벤트 루프가 비면 끝난다. 남은 핸들(끝나지 않은 앱의 파이프 등)이 붙잡으면 EXIT_SAFETY_MS 뒤에 끝낸다 —
 * 판정 · 요약 · 잠금 풀기는 이미 끝났다.
 * @param {number} code
 * @returns {void}
 */
function exitWith(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), EXIT_SAFETY_MS).unref();
}

main(process.argv.slice(2)).then(exitWith, (err) => {
  logError(`런처 오류: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  exitWith(1);
});
