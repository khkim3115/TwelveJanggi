// desktop/lib/smokeArgs.cjs 시험 — 스모크 인자(설계 §5.5 · §5.10). 런처가 formatSmokeArgs 로 만든 인자를 main 이 parseSmokeArgs 로 읽는다.
// 경로(out · profile)는 절대 경로만 받는다. path.win32 · path.posix 를 넣어 두 플랫폼 규칙을 함께 보고, 한글 · 공백 경로로
// 왕복한다(사용자 폴더가 'C:\Users\홍 길동\' 처럼 한글 · 공백이어도 깨지지 않게). electron 은 import 하지 않는다.
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { formatSmokeArgs, parseSmokeArgs } = require('./smokeArgs.cjs') as typeof import('./smokeArgs.cjs');

/** 스모크가 아닐 때의 결과. */
const OFF = { enabled: false, outDir: null, profile: null, net: false, nonce: null, error: null };
/** 틀린 스모크 인자의 결과 — 요청은 했으므로 enabled 이고, 쓸 수 있는 값은 하나도 내지 않는다. */
function invalid(reason: string) {
  return { enabled: true, outDir: null, profile: null, net: false, nonce: null, error: expect.stringContaining(reason) };
}

const WIN = { outDir: 'C:\\Users\\홍 길동\\out', profile: 'C:\\Users\\홍 길동\\profile' };
const POSIX = { outDir: '/tmp/홍 길동/out', profile: '/tmp/홍 길동/profile' };

/** 실제 process.argv 모양 — 앞의 두 자리(실행 파일 · 앱 폴더) 뒤에 인자가 온다. */
function argv(...args: string[]): string[] {
  return ['electron', '.', ...args];
}
/** 값이 모두 맞는 스모크 인자에서 일부만 바꾼 것(undefined 로 준 인자는 빠진다). */
function smokeArgv(paths: { outDir: string; profile: string }, patch: Partial<Record<'out' | 'profile' | 'nonce', string | undefined>> = {}) {
  const values = { out: paths.outDir, profile: paths.profile, nonce: 'n1', ...patch };
  return argv(
    '--tj-smoke',
    ...(values.out === undefined ? [] : [`--tj-smoke-out=${values.out}`]),
    ...(values.profile === undefined ? [] : [`--tj-profile=${values.profile}`]),
    ...(values.nonce === undefined ? [] : [`--tj-smoke-nonce=${values.nonce}`]),
  );
}

describe('parseSmokeArgs — 스모크 아님', () => {
  it.each([[[]], [argv()], [argv('--remote-debugging-port=9222', '--enable-logging', 'tray.html')], [argv('--TJ-SMOKE')]])(
    '--tj- 인자가 없으면 enabled false · error null: %j',
    (args) => {
      expect(parseSmokeArgs(args)).toStrictEqual(OFF);
    },
  );
});

describe('parseSmokeArgs — path.win32', () => {
  it('한글 · 공백이 든 드라이브 절대 경로를 그대로 받는다', () => {
    expect(parseSmokeArgs(smokeArgv(WIN), win32)).toStrictEqual({ enabled: true, ...WIN, net: false, nonce: 'n1', error: null });
  });

  it.each(['C:/Users/홍 길동/out', '\\\\server\\share\\홍 길동', 'D:\\Google Drive\\홍 길동\\r\\'])('그 밖의 절대 경로도 받는다: %s', (outDir) => {
    expect(parseSmokeArgs(smokeArgv({ ...WIN, outDir }), win32)).toMatchObject({ enabled: true, outDir, error: null });
  });

  // '\x' · '/x' 는 path.win32.isAbsolute 가 참이지만 드라이브가 없다(지금 드라이브 기준) — Chromium 의 절대 경로 규칙으로 거부한다.
  it.each(['rel\\x', 'C:rel', '\\x', '/x', ''])('상대 · 드라이브 기준 경로는 error: %j', (bad) => {
    expect(parseSmokeArgs(smokeArgv({ ...WIN, outDir: bad }), win32)).toStrictEqual(invalid('--tj-smoke-out='));
    expect(parseSmokeArgs(smokeArgv({ ...WIN, profile: bad }), win32)).toStrictEqual(invalid('--tj-profile='));
  });
});

describe('parseSmokeArgs — path.posix', () => {
  it('한글 · 공백이 든 절대 경로를 그대로 받는다', () => {
    expect(parseSmokeArgs(smokeArgv(POSIX), posix)).toStrictEqual({ enabled: true, ...POSIX, net: false, nonce: 'n1', error: null });
  });

  it.each(['C:\\x', 'rel/x', ''])('절대 경로가 아니면 error: %j', (bad) => {
    expect(parseSmokeArgs(smokeArgv({ ...POSIX, outDir: bad }), posix)).toStrictEqual(invalid('--tj-smoke-out='));
    expect(parseSmokeArgs(smokeArgv({ ...POSIX, profile: bad }), posix)).toStrictEqual(invalid('--tj-profile='));
  });
});

describe('parseSmokeArgs — 빠뜨림 · 틀린 인자', () => {
  it('nonce 가 없거나 비어 있으면 error', () => {
    expect(parseSmokeArgs(smokeArgv(WIN, { nonce: undefined }), win32)).toStrictEqual(invalid('--tj-smoke-nonce='));
    expect(parseSmokeArgs(smokeArgv(WIN, { nonce: '' }), win32)).toStrictEqual(invalid('--tj-smoke-nonce='));
  });

  it('out · profile 이 없으면 error', () => {
    expect(parseSmokeArgs(smokeArgv(WIN, { out: undefined }), win32)).toStrictEqual(invalid('--tj-smoke-out='));
    expect(parseSmokeArgs(smokeArgv(WIN, { profile: undefined }), win32)).toStrictEqual(invalid('--tj-profile='));
  });

  it('--tj-smoke-net 이 있으면 net', () => {
    expect(parseSmokeArgs([...smokeArgv(WIN), '--tj-smoke-net'], win32)).toStrictEqual({ enabled: true, ...WIN, net: true, nonce: 'n1', error: null });
  });

  it('인자 순서는 상관없다 — 스위치가 앱 폴더보다 앞에 와도 읽는다', () => {
    const args = ['electron', '--tj-smoke-nonce=n1', '--tj-smoke-net', `--tj-profile=${WIN.profile}`, '.', `--tj-smoke-out=${WIN.outDir}`, '--tj-smoke'];
    expect(parseSmokeArgs(args, win32)).toStrictEqual({ enabled: true, ...WIN, net: true, nonce: 'n1', error: null });
  });

  // 오타 · 빠뜨림이 조용히 실제 프로필의 정상 실행이 되지 않게 — --tj- 인자가 하나라도 있으면 스모크를 요청한 것이다.
  it.each([[argv(`--tj-profile=${WIN.profile}`)], [argv('--tj-smoke-net')], [argv(`--tj-smoke-out=${WIN.outDir}`, '--tj-smoke-nonce=n1')]])(
    '--tj-smoke 없이 다른 스모크 인자만 있으면 error: %j',
    (args) => {
      expect(parseSmokeArgs(args, win32)).toStrictEqual(invalid('--tj-smoke 없이'));
    },
  );

  it.each(['--tj-smokey', '--tj-smoke=1', '--tj-smoke-out', '--tj-profile', '--tj-'])('모르는 --tj- 인자는 error: %s', (unknown) => {
    expect(parseSmokeArgs([...smokeArgv(WIN), unknown], win32)).toStrictEqual(invalid(unknown));
  });

  // 두 번째 값이 첫 값을 조용히 덮지 않는다 — 어느 쪽을 쓸지 모르는 인자는 틀린 것이다.
  it.each([
    ['--tj-smoke', '--tj-smoke'],
    ['--tj-smoke-net', '--tj-smoke-net'],
    [`--tj-smoke-out=${WIN.outDir}`, '--tj-smoke-out='],
    [`--tj-profile=${WIN.profile}`, '--tj-profile='],
    ['--tj-smoke-nonce=n2', '--tj-smoke-nonce='],
  ])('같은 인자가 두 번이면 error: %s', (again, flag) => {
    const valid = [...smokeArgv(WIN), '--tj-smoke-net'];
    expect(parseSmokeArgs(valid, win32)).toMatchObject({ enabled: true, error: null });
    expect(parseSmokeArgs([...valid, again], win32)).toStrictEqual(invalid(flag));
  });

  it('값의 첫 = 뒤는 모두 값이다', () => {
    const outDir = 'C:\\a=b\\홍 길동';
    expect(parseSmokeArgs(smokeArgv({ ...WIN, outDir }, { nonce: 'k=v' }), win32)).toMatchObject({ outDir, nonce: 'k=v', error: null });
  });
});

describe('formatSmokeArgs', () => {
  it('값 하나가 인자 하나다 — 따옴표로 감싸지 않는다(spawn 이 인자 경계를 지킨다)', () => {
    expect(formatSmokeArgs({ ...WIN, net: false, nonce: 'n1' })).toStrictEqual([
      '--tj-smoke',
      `--tj-smoke-out=${WIN.outDir}`,
      `--tj-profile=${WIN.profile}`,
      '--tj-smoke-nonce=n1',
    ]);
    expect(formatSmokeArgs({ ...WIN, net: true, nonce: 'n1' })).toContain('--tj-smoke-net');
  });

  it.each([false, true])('왕복 — 이 플랫폼의 한글 · 공백 절대 경로(net %s)', (net) => {
    const x = { outDir: join(tmpdir(), 'tj-홍 길동', 'smoke out'), profile: join(tmpdir(), 'tj-홍 길동', 'pro file'), net, nonce: '3f0c-논스' };
    expect(parseSmokeArgs(['electron', '.', ...formatSmokeArgs(x)])).toStrictEqual({ enabled: true, error: null, ...x });
  });

  it.each<[string, typeof win32, { outDir: string; profile: string }]>([
    ['win32', win32, { outDir: 'D:\\Google Drive\\홍 길동\\smoke-out', profile: 'C:\\Users\\홍 길동\\AppData\\Local\\Temp\\tj-smoke-x\\profile' }],
    ['posix', posix, { outDir: '/Users/홍 길동/smoke out', profile: '/var/folders/홍 길동/tj-smoke-x/profile' }],
  ])('왕복 — %s 경로', (_name, pathImpl, paths) => {
    const x = { ...paths, net: true, nonce: 'x' };
    expect(parseSmokeArgs(['electron', '.', ...formatSmokeArgs(x)], pathImpl)).toStrictEqual({ enabled: true, error: null, ...x });
  });
});
