// desktop/lib/smokeOut.cjs 시험 — 스모크 결과 파일(설계 §5.10). 결과는 임시 파일에 다 쓴 뒤 rename 해서, 런처가 반쯤 쓴 파일을
// 읽지 않는다. 실제 임시 폴더(한글 · 공백 이름)에 쓴다 — 시험마다 mkdtemp 로 만들고 지운다. electron 은 import 하지 않는다.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { RESULT_FILE, failureResult, writeJsonAtomic, writeResultAtomic } = require('./smokeOut.cjs') as typeof import('./smokeOut.cjs');

/** 결과의 versions — SmokeResult.versions 모양({ electron, chrome, node, app }). AppInfo(IPC)의 모양이 아니다. */
const VERSIONS = { electron: '44.9.3', chrome: '146.0.0.0', node: '24.11.0', app: '0.1.0' };

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tj-결과 쓰기 '));
});
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** 결과 파일을 JSON 으로 읽는다. */
function readResult(outDir: string): unknown {
  return JSON.parse(readFileSync(join(outDir, RESULT_FILE), 'utf8'));
}

describe('writeResultAtomic', () => {
  it('결과 파일 하나만 남고(임시 파일 없음) JSON 이 같다', () => {
    const result = { nonce: 'n1', stage: 'done', checks: [{ id: 'boot', ok: true }], versions: VERSIONS, 메모: '십이장기' };
    writeResultAtomic(dir, result);
    expect(RESULT_FILE).toBe('result.json');
    expect(readdirSync(dir)).toStrictEqual([RESULT_FILE]);
    expect(readResult(dir)).toStrictEqual(result);
  });

  it('이미 있는 결과를 통째로 바꾼다 — 여전히 파일 하나', () => {
    writeFileSync(join(dir, RESULT_FILE), '{"nonce":"지난 실행","checks":[1,2,3]}');
    writeResultAtomic(dir, { nonce: '이번 실행' });
    expect(readdirSync(dir)).toStrictEqual([RESULT_FILE]);
    expect(readResult(dir)).toStrictEqual({ nonce: '이번 실행' });
  });

  it('outDir 이 없으면 만든다(한글 · 공백 경로)', () => {
    const outDir = join(dir, '홍 길동', 'smoke out');
    writeResultAtomic(outDir, { nonce: 'x' });
    expect(readdirSync(outDir)).toStrictEqual([RESULT_FILE]);
    expect(readResult(outDir)).toStrictEqual({ nonce: 'x' });
  });

  it('rename 이 실패하면 던지고 임시 파일을 남기지 않는다', () => {
    // 결과 파일 자리에 (비어 있지 않은) 폴더가 있으면 rename 이 실패한다 — Windows EPERM · POSIX EISDIR.
    mkdirSync(join(dir, RESULT_FILE));
    writeFileSync(join(dir, RESULT_FILE, 'keep.txt'), '');
    expect(() => writeResultAtomic(dir, { nonce: 'x' })).toThrow();
    expect(readdirSync(dir)).toStrictEqual([RESULT_FILE]);
  });
});

describe('writeJsonAtomic — 런처의 summary.json 도 같은 함수로 쓴다', () => {
  const SUMMARY_FILE = 'summary.json';

  it('다른 이름으로 쓴다 — 그 파일 하나만 남고(임시 파일 없음) JSON 이 같다', () => {
    const summary = { verdict: 'fail', reasons: ['시간 초과'], net: false, timeoutSec: 15, 메모: '십이장기' };
    writeJsonAtomic(dir, SUMMARY_FILE, summary);
    expect(readdirSync(dir)).toStrictEqual([SUMMARY_FILE]);
    expect(JSON.parse(readFileSync(join(dir, SUMMARY_FILE), 'utf8'))).toStrictEqual(summary);
  });

  it('같은 폴더의 결과 파일은 건드리지 않는다', () => {
    writeResultAtomic(dir, { nonce: '이번 실행' });
    writeJsonAtomic(dir, SUMMARY_FILE, { verdict: 'ok' });
    expect(readdirSync(dir).sort()).toStrictEqual([RESULT_FILE, SUMMARY_FILE]);
    expect(readResult(dir)).toStrictEqual({ nonce: '이번 실행' });
  });

  it('rename 이 실패하면 그 오류를 던지고 임시 파일을 남기지 않는다', () => {
    // 파일 자리에 (비어 있지 않은) 폴더가 있으면 rename 이 실패한다 — Windows EPERM · POSIX EISDIR.
    mkdirSync(join(dir, SUMMARY_FILE));
    writeFileSync(join(dir, SUMMARY_FILE, 'keep.txt'), '');
    let thrown: unknown = null;
    try {
      writeJsonAtomic(dir, SUMMARY_FILE, { verdict: 'ok' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ syscall: 'rename' });
    expect(readdirSync(dir)).toStrictEqual([SUMMARY_FILE]);
  });

  it('JSON 으로 만들지 못하면(BigInt) 그 오류를 던지고 아무것도 남기지 않는다', () => {
    expect(() => writeJsonAtomic(dir, SUMMARY_FILE, { big: 1n })).toThrow(/BigInt/);
    expect(readdirSync(dir)).toStrictEqual([]);
  });
});

describe('failureResult', () => {
  it('모양 — { nonce, stage, error, checks: [], versions }', () => {
    const result = failureResult({ nonce: 'x', stage: 'tray-build', error: 'tray-build.json: 읽지 못했다', versions: VERSIONS });
    expect(result).toStrictEqual({ nonce: 'x', stage: 'tray-build', error: 'tray-build.json: 읽지 못했다', checks: [], versions: VERSIONS });
  });

  it('checks 는 부를 때마다 새 빈 배열이다', () => {
    const input = { nonce: 'x', stage: 'lock', error: 'e', versions: VERSIONS };
    expect(failureResult(input).checks).not.toBe(failureResult(input).checks);
  });

  it('writeResultAtomic 으로 쓴 실패 결과를 그대로 읽는다', () => {
    const result = failureResult({ nonce: 'x', stage: 'lock', error: '잠금', versions: VERSIONS });
    writeResultAtomic(dir, result);
    expect(readResult(dir)).toStrictEqual(result);
  });
});
