// desktop/lib/smokeFs.cjs 시험 — 스모크 런처의 파일 처리(설계 §5.10 런처 3 · 7 · 8단계): 임시 폴더 재시도 삭제 · 지난 실행의 잔여 정리 ·
// 폴더 목록 비교 · 동시 실행 잠금. Windows 에서 Chromium 이 파일을 쥔 채 오래 가면 지우기가 EBUSY 로 실패한다.
// - 지우기의 재시도 간격 · 상한은 가짜 rm · sleep 으로 값까지 본다(실제로 기다리지 않는다).
// - 폴더 · 잠금 파일은 실제 임시 폴더(한글 · 공백 이름)에서 돈다. 시험마다 mkdtemp 로 만들고 지운다. 정리(sweepStale) 시험의 루트도
//   그 안의 mkdtemp 폴더다 — 진짜 os.tmpdir() 의 tj-smoke-* (돌고 있는 스모크의 프로필일 수 있다)는 건드리지 않는다.
// - 링크의 대상은 같은 mkdtemp 안의 형제 폴더이고, 지울 때는 링크를 먼저 unlink 한다.
// electron 은 import 하지 않는다.
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { acquireLock, diffEntries, releaseLock, removeWithRetry, sweepStale } = require('./smokeFs.cjs') as typeof import('./smokeFs.cjs');

/** Node 의 fs 오류 모양 — code 로 가른다. */
function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: 시험용 오류`), { code });
}

/** n번째 rm 호출이 script[n] 의 코드로 실패한다(코드가 없거나 script 를 넘으면 성공). */
function scriptedRm(script: ReadonlyArray<string | undefined>) {
  let call = 0;
  return vi.fn(async (_dir: string): Promise<void> => {
    const code = script[call++];
    if (code) throw fsError(code);
  });
}

/** 항상 같은 코드로 실패하는 rm. */
function alwaysFailing(code: string) {
  return vi.fn(async (_dir: string): Promise<void> => {
    throw fsError(code);
  });
}

/**
 * 기다리지 않고 요청한 간격만 적는 sleep. 기본 상한(20초)도 14번이면 끝난다 — 200번을 넘으면 끝나지 않는 재시도라는 뜻이라 던진다.
 * (가짜 sleep 은 곧바로 풀려서 끝없이 도는 루프가 이벤트 루프를 굶겨 시험이 멈춘 채 실패도 못 하게 되는 것을 막는다.)
 */
function recordingSleep() {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number): Promise<void> => {
    delays.push(ms);
    if (delays.length > 200) throw new Error('sleep 을 200번 넘게 불렀다 — 재시도가 끝나지 않는다');
  });
  return { delays, sleep };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** 던진 값을 잡아 돌려준다(던지지 않았으면 undefined). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('removeWithRetry — 재시도 간격 · 상한(가짜 rm · sleep)', () => {
  it('첫 시도에 지워지면 기다리지 않는다', async () => {
    const rm = scriptedRm([]);
    const { delays, sleep } = recordingSleep();
    expect(await removeWithRetry('/run/dir', { rm, sleep })).toStrictEqual({ removed: true, attempts: 1, lastError: null });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith('/run/dir');
    expect(delays).toStrictEqual([]);
  });

  it('EBUSY 3회 뒤 지워진다 — attempts 4, 간격 100 → 200 → 400', async () => {
    const rm = scriptedRm(['EBUSY', 'EBUSY', 'EBUSY']);
    const { delays, sleep } = recordingSleep();
    expect(await removeWithRetry('/run/dir', { rm, sleep })).toStrictEqual({ removed: true, attempts: 4, lastError: null });
    expect(rm).toHaveBeenCalledTimes(4);
    expect(delays).toStrictEqual([100, 200, 400]);
  });

  it.each(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])('%s 는 재시도한다', async (code) => {
    const rm = scriptedRm([code]);
    const { delays, sleep } = recordingSleep();
    expect(await removeWithRetry('/run/dir', { rm, sleep })).toStrictEqual({ removed: true, attempts: 2, lastError: null });
    expect(delays).toStrictEqual([100]);
  });

  it('ENOENT 는 재시도하지 않는다 — 이미 없는 것이니 지워진 것이다(attempts 는 부른 횟수)', async () => {
    const rm = scriptedRm(['ENOENT']);
    const { delays, sleep } = recordingSleep();
    expect(await removeWithRetry('/run/dir', { rm, sleep })).toStrictEqual({ removed: true, attempts: 1, lastError: null });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(delays).toStrictEqual([]);
  });

  it('재시도하던 중 폴더가 사라져 ENOENT 가 나도 지워진 것이다', async () => {
    const rm = scriptedRm(['EBUSY', 'ENOENT']);
    const { delays, sleep } = recordingSleep();
    expect(await removeWithRetry('/run/dir', { rm, sleep })).toStrictEqual({ removed: true, attempts: 2, lastError: null });
    expect(delays).toStrictEqual([100]);
  });

  it.each(['EINVAL', 'EMFILE', 'EIO', 'ENOTDIR'])('그 밖의 오류(%s)는 재시도하지 않고 실패로 돌려준다', async (code) => {
    const rm = scriptedRm([code]);
    const { delays, sleep } = recordingSleep();
    const result = await removeWithRetry('/run/dir', { rm, sleep });
    expect(result).toMatchObject({ removed: false, attempts: 1 });
    expect(result.lastError).toMatchObject({ code });
    expect(delays).toStrictEqual([]);
  });

  it('code 가 없는 오류 · Error 가 아닌 던진 값도 재시도 없이 실패 — lastError 는 Error 다', async () => {
    const noCode = vi.fn(async () => {
      throw new TypeError('코드 없음');
    });
    const { delays, sleep } = recordingSleep();
    const first = await removeWithRetry('/run/dir', { rm: noCode, sleep });
    expect(first).toMatchObject({ removed: false, attempts: 1 });
    expect(first.lastError).toMatchObject({ message: '코드 없음' });

    const text = vi.fn(async () => {
      throw 'EBUSY';
    });
    const second = await removeWithRetry('/run/dir', { rm: text, sleep });
    expect(second).toMatchObject({ removed: false, attempts: 1 });
    expect(second.lastError).toBeInstanceOf(Error);
    expect(second.lastError?.message).toBe('EBUSY');
    expect(delays).toStrictEqual([]);
  });

  it('rm 이 동기로 던져도 같다', async () => {
    const rm = vi.fn((_dir: string): Promise<void> => {
      throw fsError('EBUSY');
    });
    const { sleep } = recordingSleep();
    const result = await removeWithRetry('/run/dir', { rm, sleep, maxMs: 100 });
    expect(result).toMatchObject({ removed: false, attempts: 2 });
  });

  it('계속 EBUSY 면 기본 상한 20초 뒤 removed false — 간격은 100 → ×2 → 상한 2초, 합이 정확히 20초다', async () => {
    const rm = alwaysFailing('EBUSY');
    const { delays, sleep } = recordingSleep();
    const result = await removeWithRetry('/run/dir', { rm, sleep });
    expect(result.removed).toBe(false);
    expect(result.lastError).toMatchObject({ code: 'EBUSY' });
    expect(delays).toStrictEqual([100, 200, 400, 800, 1600, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 900]);
    expect(sum(delays)).toBe(20000);
    expect(result.attempts).toBe(delays.length + 1);
    expect(rm).toHaveBeenCalledTimes(result.attempts);
  });

  it('maxMs 를 줄 수 있다 — 마지막 간격은 남은 시간만큼만 기다린다', async () => {
    for (const [maxMs, expected] of [
      [250, [100, 150]],
      [100, [100]],
      [99, [99]],
      [1000, [100, 200, 400, 300]],
    ] as const) {
      const { delays, sleep } = recordingSleep();
      const result = await removeWithRetry('/run/dir', { rm: alwaysFailing('EPERM'), sleep, maxMs });
      expect(result.removed).toBe(false);
      expect(delays).toStrictEqual(expected);
      expect(result.attempts).toBe(expected.length + 1);
    }
  });

  it('상한이 0 이하이면 한 번만 시도한다', async () => {
    for (const maxMs of [0, -5, -0.5]) {
      const rm = alwaysFailing('EBUSY');
      const { delays, sleep } = recordingSleep();
      const result = await removeWithRetry('/run/dir', { rm, sleep, maxMs });
      expect(result).toMatchObject({ removed: false, attempts: 1 });
      expect(rm).toHaveBeenCalledTimes(1);
      expect(delays).toStrictEqual([]);
    }
  });

  it('소수 상한은 내림한다 — 끝없이 돌지 않는다', async () => {
    const { delays, sleep } = recordingSleep();
    await removeWithRetry('/run/dir', { rm: alwaysFailing('EBUSY'), sleep, maxMs: 250.7 });
    expect(delays).toStrictEqual([100, 150]);
  });

  it.each<[string, unknown]>([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['undefined', undefined],
    ['null', null],
    ["문자열 '5000'", '5000'],
  ])('상한이 숫자가 아니면(%s) 기본 20초로 끝낸다 — 무한 루프가 아니다', async (_name, maxMs) => {
    const { delays, sleep } = recordingSleep();
    const result = await removeWithRetry('/run/dir', { rm: alwaysFailing('EBUSY'), sleep, maxMs: maxMs as number });
    expect(result.removed).toBe(false);
    expect(sum(delays)).toBe(20000);
  });

  it('rm 과 sleep 이 번갈아 불린다 — 기다린 뒤에 다시 지운다', async () => {
    const log: string[] = [];
    let call = 0;
    const rm = async (): Promise<void> => {
      log.push(`rm${++call}`);
      if (call < 3) throw fsError('EBUSY');
    };
    const sleep = async (ms: number): Promise<void> => {
      log.push(`sleep${ms}`);
    };
    await removeWithRetry('/run/dir', { rm, sleep });
    expect(log).toStrictEqual(['rm1', 'sleep100', 'rm2', 'sleep200', 'rm3']);
  });

  it('성공하면 앞의 일시 오류는 남기지 않는다 — lastError 는 지우지 못했을 때만 있다', async () => {
    const result = await removeWithRetry('/run/dir', { rm: scriptedRm(['EBUSY', 'EBUSY']), sleep: recordingSleep().sleep });
    expect(result.lastError).toBeNull();
  });

  describe('기본 sleep', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('실제 타이머로 기다린다 — 100ms 가 지나야 다시 시도한다', async () => {
      vi.useFakeTimers();
      const rm = scriptedRm(['EBUSY']);
      let finished = false;
      const pending = removeWithRetry('/run/dir', { rm }).then((result) => {
        finished = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(finished).toBe(false);
      expect(rm).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toStrictEqual({ removed: true, attempts: 2, lastError: null });
      expect(rm).toHaveBeenCalledTimes(2);
    });
  });
});

describe('removeWithRetry — 실제 폴더', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tj-지우기 시험 '));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('하위 폴더 · 파일이 든 폴더를 지운다(한글 · 공백 이름) — 첫 시도에', async () => {
    const dir = join(root, 'tj-smoke-한글 공백');
    mkdirSync(join(dir, 'profile', 'Cache'), { recursive: true });
    writeFileSync(join(dir, 'profile', 'Cache', 'data_0'), 'x');
    writeFileSync(join(dir, 'result.json'), '{}');

    expect(await removeWithRetry(dir)).toStrictEqual({ removed: true, attempts: 1, lastError: null });

    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(root)).toStrictEqual([]);
  });

  it('이미 없는 폴더는 지워진 것이다', async () => {
    expect(await removeWithRetry(join(root, '없는 폴더'))).toStrictEqual({ removed: true, attempts: 1, lastError: null });
  });

  it('형제 폴더는 건드리지 않는다', async () => {
    mkdirSync(join(root, 'run'));
    mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'other', 'keep.txt'), 'x');
    await removeWithRetry(join(root, 'run'));
    expect(readdirSync(root)).toStrictEqual(['other']);
    expect(existsSync(join(root, 'other', 'keep.txt'))).toBe(true);
  });
});

describe('sweepStale', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tj-정리 시험 '));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 안에 프로필 · 캐시 · 결과 파일이 든 폴더. */
  function makeDir(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, 'profile', 'Cache'), { recursive: true });
    writeFileSync(join(dir, 'profile', 'Cache', 'data_0'), 'x');
    writeFileSync(join(dir, 'result.json'), '{}');
    return dir;
  }
  const listing = () => readdirSync(root).sort();
  /** 이름이 busyName 인 폴더만 지우다 실패하는 fs — 나머지는 실제로 지운다. */
  const busyFs = (busyName: string, code = 'EBUSY') => ({
    readdirSync,
    rmSync: (path: string, options: { recursive: true; force: true }) => {
      if (basename(path) === busyName) throw fsError(code);
      rmSync(path, options);
    },
  });

  it('접두사가 맞는 폴더는 지우고, keep 과 그 밖의 것은 남긴다 — 이름은 정렬해 돌려준다', () => {
    makeDir('tj-smoke-b');
    makeDir('tj-smoke-a');
    makeDir('tj-smoke-한글 공백');
    const keep = makeDir('tj-smoke-keep');
    makeDir('other-dir');
    makeDir('tj-smoke2'); // 접두사에서 '-' 가 모자란다
    makeDir('old-tj-smoke-x'); // 접두사가 이름 앞이 아니라 가운데에 있다
    writeFileSync(join(root, 'tj-smoke.lock'), '1234');
    writeFileSync(join(root, 'tj-smoke-file'), 'x');

    const result = sweepStale(root, 'tj-smoke-', keep);

    expect(result).toStrictEqual({ removed: ['tj-smoke-a', 'tj-smoke-b', 'tj-smoke-한글 공백'], failed: [] });
    expect(listing()).toStrictEqual(['old-tj-smoke-x', 'other-dir', 'tj-smoke-file', 'tj-smoke-keep', 'tj-smoke.lock', 'tj-smoke2']);
    expect(existsSync(join(keep, 'profile', 'Cache', 'data_0'))).toBe(true);
  });

  it('이름순으로 돌려준다 — 목록을 어떤 순서로 줘도 같다(Linux 의 readdir 는 순서가 없다)', () => {
    makeDir('tj-smoke-b');
    makeDir('tj-smoke-c');
    makeDir('tj-smoke-a');
    const reversed = { readdirSync: (dir: string, options: { withFileTypes: true }) => readdirSync(dir, options).reverse(), rmSync };
    const result = sweepStale(root, 'tj-smoke-', null, reversed);
    expect(result).toStrictEqual({ removed: ['tj-smoke-a', 'tj-smoke-b', 'tj-smoke-c'], failed: [] });
  });

  it('keep 이 null 이면 접두사가 맞는 폴더를 모두 지운다', () => {
    makeDir('tj-smoke-a');
    makeDir('tj-smoke-keep');
    makeDir('other-dir');
    expect(sweepStale(root, 'tj-smoke-', null)).toStrictEqual({ removed: ['tj-smoke-a', 'tj-smoke-keep'], failed: [] });
    expect(listing()).toStrictEqual(['other-dir']);
  });

  it('지울 것이 없으면 빈 결과다', () => {
    makeDir('other-dir');
    expect(sweepStale(root, 'tj-smoke-', null)).toStrictEqual({ removed: [], failed: [] });
    expect(listing()).toStrictEqual(['other-dir']);
  });

  it('파일은 지우지 않는다 — 접두사가 맞아도 폴더만 지운다(잠금 파일 · 로그)', () => {
    writeFileSync(join(root, 'tj-smoke-notes.txt'), 'x');
    writeFileSync(join(root, 'tj-smoke-'), 'x');
    expect(sweepStale(root, 'tj-smoke-', null)).toStrictEqual({ removed: [], failed: [] });
    expect(listing()).toStrictEqual(['tj-smoke-', 'tj-smoke-notes.txt']);
  });

  it('EBUSY 로 못 지우는 폴더는 failed 에 담고 던지지 않는다 — 나머지는 계속 지운다', () => {
    makeDir('tj-smoke-0-busy');
    makeDir('tj-smoke-1');
    makeDir('tj-smoke-2');

    const result = sweepStale(root, 'tj-smoke-', null, busyFs('tj-smoke-0-busy'));

    expect(result).toStrictEqual({ removed: ['tj-smoke-1', 'tj-smoke-2'], failed: ['tj-smoke-0-busy'] });
    expect(listing()).toStrictEqual(['tj-smoke-0-busy']);
  });

  it.each(['EPERM', 'EACCES', 'ENOTEMPTY', 'EIO'])('%s 로 실패해도 failed 다', (code) => {
    makeDir('tj-smoke-busy');
    makeDir('tj-smoke-ok');
    expect(sweepStale(root, 'tj-smoke-', null, busyFs('tj-smoke-busy', code))).toStrictEqual({
      removed: ['tj-smoke-ok'],
      failed: ['tj-smoke-busy'],
    });
  });

  it('다음 실행이 다시 지운다 — 잠금이 풀린 폴더는 두 번째 정리에서 removed 다', () => {
    makeDir('tj-smoke-busy');
    expect(sweepStale(root, 'tj-smoke-', null, busyFs('tj-smoke-busy')).failed).toStrictEqual(['tj-smoke-busy']);
    expect(sweepStale(root, 'tj-smoke-', null)).toStrictEqual({ removed: ['tj-smoke-busy'], failed: [] });
    expect(listing()).toStrictEqual([]);
  });

  it('링크 · 정션은 따라가지도 지우지도 않는다 — 접두사가 맞아도 그 대상은 그대로다', () => {
    const target = join(root, 'link-target');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'x');
    const link = join(root, 'tj-smoke-link');
    symlinkSync(target, link, 'junction');
    try {
      const result = sweepStale(root, 'tj-smoke-', null);

      expect(result).toStrictEqual({ removed: [], failed: [] });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(join(target, 'keep.txt'))).toBe(true);
    } finally {
      unlinkSync(link); // 링크를 먼저 끊고 afterEach 가 폴더를 지운다
    }
  });

  it('keep 은 tmpRoot 바로 아래 폴더만 가리킨다 — 다른 곳 · 더 깊은 경로는 아무것도 지키지 않는다', () => {
    const keep = makeDir('tj-smoke-keep');
    const elsewhere = mkdtempSync(join(tmpdir(), 'tj-다른 곳 '));
    try {
      const result = sweepStale(root, 'tj-smoke-', join(elsewhere, 'tj-smoke-keep'));
      expect(result.removed).toStrictEqual(['tj-smoke-keep']);
      expect(existsSync(keep)).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    const deeper = makeDir('tj-smoke-deep');
    expect(sweepStale(root, 'tj-smoke-', join(deeper, 'profile')).removed).toStrictEqual(['tj-smoke-deep']);
  });

  it('keep 끝에 구분자가 있어도 같은 폴더다', () => {
    const keep = makeDir('tj-smoke-keep');
    makeDir('tj-smoke-a');
    expect(sweepStale(root, 'tj-smoke-', `${keep}${process.platform === 'win32' ? '\\' : '/'}`).removed).toStrictEqual(['tj-smoke-a']);
    expect(existsSync(keep)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('Windows 에서는 keep 의 대소문자가 달라도 같은 폴더다', () => {
    const keep = makeDir('tj-smoke-keep');
    makeDir('tj-smoke-a');
    expect(sweepStale(root.toUpperCase(), 'tj-smoke-', keep.toUpperCase()).removed).toStrictEqual(['tj-smoke-a']);
    expect(existsSync(keep)).toBe(true);
  });

  it('접두사가 비어 있으면 던진다 — 임시 폴더 전체를 지우지 않는다', () => {
    makeDir('tj-smoke-a');
    makeDir('other-dir');
    expect(thrownBy(() => sweepStale(root, '', null))).toBeInstanceOf(TypeError);
    expect(thrownBy(() => sweepStale(root, undefined as unknown as string, null))).toBeInstanceOf(TypeError);
    expect(listing()).toStrictEqual(['other-dir', 'tj-smoke-a']);
  });

  it('tmpRoot 가 비었거나 문자열이 아니면 던진다', () => {
    expect(thrownBy(() => sweepStale('', 'tj-smoke-', null))).toBeInstanceOf(TypeError);
    expect(thrownBy(() => sweepStale(undefined as unknown as string, 'tj-smoke-', null))).toBeInstanceOf(TypeError);
  });

  it('tmpRoot 를 읽지 못하면 던진다 — 정리할 것이 없다는 말이 아니라 알 수 없다는 뜻이다', () => {
    expect(thrownBy(() => sweepStale(join(root, '없는 폴더'), 'tj-smoke-', null))).toMatchObject({ code: 'ENOENT' });
  });
});

describe('diffEntries', () => {
  it('after 에만 있는 항목을 after 의 순서로 낸다', () => {
    expect(diffEntries(['a', 'b'], ['b', 'd', 'a', 'c'])).toStrictEqual(['d', 'c']);
  });

  it('사라진 항목(before 에만 있음)은 내지 않는다', () => {
    expect(diffEntries(['a', 'b', 'c'], ['a'])).toStrictEqual([]);
  });

  it('같으면 비어 있다 — 빈 before 면 after 전부다', () => {
    expect(diffEntries(['a', 'b'], ['b', 'a'])).toStrictEqual([]);
    expect(diffEntries([], ['x', 'y'])).toStrictEqual(['x', 'y']);
    expect(diffEntries([], [])).toStrictEqual([]);
  });

  it('after 의 같은 이름은 한 번만 낸다', () => {
    expect(diffEntries(['a'], ['b', 'b', 'a', 'b'])).toStrictEqual(['b']);
  });

  it('이름은 글자 그대로 비교한다 — 대소문자 · 공백 · 한글', () => {
    expect(diffEntries(['tj-smoke-a'], ['TJ-SMOKE-A', 'tj-smoke-a ', 'tj-smoke-한글 공백', 'tj-smoke-a'])).toStrictEqual([
      'TJ-SMOKE-A',
      'tj-smoke-a ',
      'tj-smoke-한글 공백',
    ]);
    // 반대 방향도 — 전에 대문자였던 이름이 소문자로 새로 생겼다.
    expect(diffEntries(['TJ-SMOKE-A'], ['tj-smoke-a'])).toStrictEqual(['tj-smoke-a']);
  });

  it('입력을 고치지 않는다', () => {
    const before = ['a'];
    const after = ['a', 'b'];
    diffEntries(before, after);
    expect(before).toStrictEqual(['a']);
    expect(after).toStrictEqual(['a', 'b']);
  });

  it('배열이 아니면 던진다 — 비교를 못 한 채 빈 차이로 통과하지 않는다', () => {
    expect(thrownBy(() => diffEntries(undefined as unknown as string[], []))).toBeInstanceOf(TypeError);
    expect(thrownBy(() => diffEntries([], null as unknown as string[]))).toBeInstanceOf(TypeError);
    expect(thrownBy(() => diffEntries('a' as unknown as string[], ['a']))).toBeInstanceOf(TypeError);
  });
});

describe('acquireLock · releaseLock', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tj-잠금 시험 '));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const lockPath = () => join(root, 'tj-smoke.lock');
  const holderText = () => readFileSync(lockPath(), 'utf8').trim();
  /** 주어진 PID 만 살아 있다고 답하는 isAlive. */
  const aliveOnly = (...pids: number[]) => vi.fn((pid: number) => pids.includes(pid));

  it('잠금이 없으면 얻는다 — 파일에 내 PID 가 적힌다', () => {
    const isAlive = aliveOnly();
    expect(acquireLock(lockPath(), 4242, isAlive)).toStrictEqual({ ok: true, holder: null });
    expect(holderText()).toBe('4242');
    expect(isAlive).not.toHaveBeenCalled();
    expect(readdirSync(root)).toStrictEqual(['tj-smoke.lock']);
  });

  it('산 PID 가 쥔 잠금은 거부한다 — 쥔 PID 를 알려 주고 파일은 그대로다', () => {
    acquireLock(lockPath(), 4242, aliveOnly());
    const isAlive = aliveOnly(4242);
    expect(acquireLock(lockPath(), 5000, isAlive)).toStrictEqual({ ok: false, holder: 4242 });
    expect(isAlive).toHaveBeenCalledTimes(1);
    expect(isAlive).toHaveBeenCalledWith(4242);
    expect(holderText()).toBe('4242');
  });

  it('죽은 PID 가 쥔 잠금은 넘겨받는다 — 파일에 내 PID 가 적힌다', () => {
    acquireLock(lockPath(), 4242, aliveOnly());
    const isAlive = aliveOnly(); // 4242 는 죽었다
    expect(acquireLock(lockPath(), 5000, isAlive)).toStrictEqual({ ok: true, holder: null });
    expect(isAlive).toHaveBeenCalledWith(4242);
    expect(holderText()).toBe('5000');
    expect(readdirSync(root)).toStrictEqual(['tj-smoke.lock']);
  });

  it.each(['4242', '4242\n', '  4242\r\n'])('파일 글이 %j 여도 PID 로 읽는다', (text) => {
    writeFileSync(lockPath(), text);
    expect(acquireLock(lockPath(), 5000, aliveOnly(4242))).toStrictEqual({ ok: false, holder: 4242 });
  });

  it('산 PID 가 나 자신이어도 거부한다 — 되들어오지 않는다', () => {
    acquireLock(lockPath(), 4242, aliveOnly());
    expect(acquireLock(lockPath(), 4242, aliveOnly(4242))).toStrictEqual({ ok: false, holder: 4242 });
  });

  // isAlive 가 false 를 정확히 돌려줄 때만 죽은 것이다 — 거짓처럼 보이는 값(undefined · 0 · null)은 '모른다' 라서 빼앗지 않는다.
  it.each<[string, unknown]>([
    ['true', true],
    ['1', 1],
    ['undefined', undefined],
    ['null', null],
    ['0', 0],
    ["문자열 'no'", 'no'],
    ['빈 객체', {}],
  ])('isAlive 가 %s 를 돌려주면 산 것으로 보고 거부한다', (_name, answer) => {
    writeFileSync(lockPath(), '4242\n');
    const isAlive = vi.fn(() => answer as boolean);
    expect(acquireLock(lockPath(), 5000, isAlive)).toStrictEqual({ ok: false, holder: 4242 });
    expect(holderText()).toBe('4242');
  });

  it.each(['', 'abc', '12abc', '-5', '0', '1.5', '1 2', '0x10', '9'.repeat(30)])(
    '파일 글이 PID 가 아니면(%j) 누가 쥔지 모르니 거부한다 — holder null, 파일은 그대로다',
    (text) => {
      writeFileSync(lockPath(), text);
      const isAlive = aliveOnly();
      expect(acquireLock(lockPath(), 5000, isAlive)).toStrictEqual({ ok: false, holder: null });
      expect(isAlive).not.toHaveBeenCalled();
      expect(readFileSync(lockPath(), 'utf8')).toBe(text);
    },
  );

  it('잠금 자리가 폴더여도 거부한다 — 읽지 못하는 잠금은 빼앗지 않는다', () => {
    mkdirSync(lockPath());
    writeFileSync(join(lockPath(), 'x.txt'), 'x');
    expect(acquireLock(lockPath(), 5000, aliveOnly())).toStrictEqual({ ok: false, holder: null });
    expect(existsSync(join(lockPath(), 'x.txt'))).toBe(true);
  });

  it('죽은 것으로 판정하는 사이 다른 실행이 넘겨받았으면 지우지 않고 그 새 주인을 돌려준다', () => {
    writeFileSync(lockPath(), '4242\n');
    const isAlive = vi.fn((pid: number) => {
      if (pid === 4242) {
        writeFileSync(lockPath(), '7777\n'); // 판정하는 사이 다른 실행이 넘겨받았다
        return false;
      }
      return pid === 7777;
    });
    expect(acquireLock(lockPath(), 5000, isAlive)).toStrictEqual({ ok: false, holder: 7777 });
    expect(holderText()).toBe('7777');
    expect(isAlive.mock.calls.map(([pid]) => pid)).toStrictEqual([4242, 7777]);
  });

  it('주인을 읽으려는 사이 잠금이 풀렸으면(ENOENT) 판정 없이 새로 얻는다', () => {
    writeFileSync(lockPath(), '4242\n');
    const isAlive = aliveOnly();
    // 잠금이 있다는 것(EEXIST)을 본 뒤 읽기 전에 주인이 풀었다 — 첫 읽기만 그 순간을 흉내 낸다.
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      rmSync(lockPath(), { force: true });
      throw fsError('ENOENT');
    });
    try {
      expect(acquireLock(lockPath(), 5000, isAlive)).toStrictEqual({ ok: true, holder: null });
    } finally {
      read.mockRestore();
    }
    expect(isAlive).not.toHaveBeenCalled();
    expect(holderText()).toBe('5000');
  });

  it('주인을 읽다 ENOENT 가 아닌 오류가 나면 읽을 수 없는 잠금이라 거부한다', () => {
    writeFileSync(lockPath(), '4242\n');
    const isAlive = aliveOnly();
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw fsError('EACCES');
    });
    try {
      expect(acquireLock(lockPath(), 5000, isAlive)).toStrictEqual({ ok: false, holder: null });
    } finally {
      read.mockRestore();
    }
    expect(isAlive).not.toHaveBeenCalled();
    expect(holderText()).toBe('4242');
  });

  it('판정하는 사이 잠금이 풀렸으면 새로 얻는다', () => {
    writeFileSync(lockPath(), '4242\n');
    const isAlive = vi.fn(() => {
      rmSync(lockPath(), { force: true }); // 판정하는 사이 풀렸다
      return false;
    });
    expect(acquireLock(lockPath(), 5000, isAlive)).toStrictEqual({ ok: true, holder: null });
    expect(holderText()).toBe('5000');
  });

  it('넘겨받기가 끝없이 어긋나도 몇 번만 시도하고 멈춘다', () => {
    writeFileSync(lockPath(), '100\n');
    const isAlive = vi.fn((pid: number) => {
      writeFileSync(lockPath(), `${pid + 1}\n`); // 판정할 때마다 다른 죽은 PID 가 다시 넘겨받는다
      return false;
    });
    const result = acquireLock(lockPath(), 5000, isAlive);
    expect(result.ok).toBe(false);
    expect(typeof result.holder).toBe('number');
    expect(isAlive.mock.calls.length).toBeLessThanOrEqual(10);
    expect(holderText()).not.toBe('5000');
  });

  it.each<[string, unknown]>([
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', NaN],
    ['2**53', 2 ** 53],
    ["문자열 '12'", '12'],
    ['undefined', undefined],
    ['null', null],
  ])('pid 가 양의 안전한 정수가 아니면(%s) 던지고 파일을 만들지 않는다', (_name, pid) => {
    expect(thrownBy(() => acquireLock(lockPath(), pid as number, aliveOnly()))).toBeInstanceOf(TypeError);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('폴더가 없으면 던진다 — 삼키지 않는다', () => {
    expect(thrownBy(() => acquireLock(join(root, '없는 폴더', 'x.lock'), 5000, aliveOnly()))).toMatchObject({ code: 'ENOENT' });
  });

  it('PID 를 쓰다 실패하면 빈 잠금을 남기지 않고 그 오류를 던진다 — 빈 잠금은 읽을 수 없어 이후 모든 실행이 거부당한다', () => {
    const write = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw fsError('ENOSPC');
    });
    try {
      expect(thrownBy(() => acquireLock(lockPath(), 5000, aliveOnly()))).toMatchObject({ code: 'ENOSPC' });
    } finally {
      write.mockRestore();
    }
    expect(existsSync(lockPath())).toBe(false);
    expect(acquireLock(lockPath(), 5000, aliveOnly())).toStrictEqual({ ok: true, holder: null }); // 다음 실행은 얻는다
  });

  it('isAlive 가 던지면 그대로 던지고 잠금은 건드리지 않는다', () => {
    writeFileSync(lockPath(), '4242\n');
    const isAlive = vi.fn((): boolean => {
      throw new Error('isAlive 오류');
    });
    expect(thrownBy(() => acquireLock(lockPath(), 5000, isAlive))).toMatchObject({ message: 'isAlive 오류' });
    expect(holderText()).toBe('4242');
  });

  it('releaseLock 은 잠금 파일을 지운다 — 다시 얻을 수 있다', () => {
    acquireLock(lockPath(), 4242, aliveOnly());
    expect(releaseLock(lockPath())).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
    expect(acquireLock(lockPath(), 5000, aliveOnly(4242))).toStrictEqual({ ok: true, holder: null });
    expect(holderText()).toBe('5000');
  });

  it('releaseLock 은 이미 없는 잠금에도 true 다(거듭 불러도 된다)', () => {
    expect(releaseLock(lockPath())).toBe(true);
    acquireLock(lockPath(), 4242, aliveOnly());
    expect(releaseLock(lockPath())).toBe(true);
    expect(releaseLock(lockPath())).toBe(true);
  });

  it('releaseLock 은 지우지 못하면 던지지 않고 false 를 돌려준다 — 판정 뒤 정리가 결과를 뒤집지 않는다', () => {
    mkdirSync(lockPath());
    writeFileSync(join(lockPath(), 'x.txt'), 'x');
    expect(releaseLock(lockPath())).toBe(false);
    expect(existsSync(join(lockPath(), 'x.txt'))).toBe(true);
  });
});
