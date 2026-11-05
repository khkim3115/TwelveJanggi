// desktop/lib/settings.cjs 시험 — 정규화 · 읽기 상태 · 원자적 쓰기 · 재시도 판별(설계 §5.1 settings.cjs).
// 시험은 호스트에 기대지 않는다: rename 실패는 Windows 에서 EPERM, linux 에서 EISDIR 이라 syscall 로만 본다.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { DEFAULT_SETTINGS, SETTINGS_FILE, isRetryableWriteError, normalizeSettings, readSettings, writeSettings } =
  require('./settings.cjs') as typeof import('./settings.cjs');
type Settings = import('./settings.cjs').Settings;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tj-settings-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const DEFAULTS: Settings = {
  theme: 'dark',
  opacity: 100,
  pinned: false,
  position: null,
  autostart: false,
  autostartDefaultApplied: false,
};

describe('DEFAULT_SETTINGS · SETTINGS_FILE', () => {
  it('설계 표의 기본값이고 얼려 있다', () => {
    expect(SETTINGS_FILE).toBe('settings.json');
    expect(DEFAULT_SETTINGS).toStrictEqual(DEFAULTS);
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });
});

describe('normalizeSettings', () => {
  it('빈 객체는 기본값이다', () => {
    expect(normalizeSettings({})).toStrictEqual(DEFAULTS);
  });

  it('돌려주는 객체는 새 것이다(기본값 객체를 바꿀 수 없다)', () => {
    const a = normalizeSettings({});
    expect(a).not.toBe(DEFAULT_SETTINGS);
    a.pinned = true;
    expect(DEFAULT_SETTINGS.pinned).toBe(false);
  });

  it.each([undefined, null, 42, 'x', [], true])('객체가 아닌 %j 는 기본값이다', (raw) => {
    expect(normalizeSettings(raw)).toStrictEqual(DEFAULTS);
  });

  const GOOD = { theme: 'light', opacity: 64, pinned: true, position: { x: 10, y: -20 }, autostart: true, autostartDefaultApplied: true };

  it('올바른 값은 그대로 둔다', () => {
    expect(normalizeSettings(GOOD)).toStrictEqual(GOOD);
  });

  it.each([
    ['theme', 'purple'],
    ['opacity', '70'],
    ['opacity', NaN],
    ['pinned', 'true'],
    ['pinned', 1],
    ['position', { x: '1', y: 2 }],
    ['position', { x: Infinity, y: 0 }],
    ['position', { x: 1 }],
    ['position', []],
    ['position', null],
    ['autostart', 1],
    ['autostartDefaultApplied', 'yes'],
  ])('틀린 %s = %j 는 그 키만 기본값이다', (key, bad) => {
    const got = normalizeSettings({ ...GOOD, [key]: bad }) as unknown as Record<string, unknown>;
    const want: Record<string, unknown> = { ...GOOD, [key]: (DEFAULTS as unknown as Record<string, unknown>)[key] };
    expect(got).toStrictEqual(want);
  });

  it('position 은 반올림한 정수가 된다(-0 도 0 으로)', () => {
    expect(normalizeSettings({ position: { x: 1.6, y: -2.4 } }).position).toStrictEqual({ x: 2, y: -2 });
    expect(normalizeSettings({ position: { x: -0.2, y: 0 } }).position).toStrictEqual({ x: 0, y: 0 });
  });

  // 손으로 고친 파일의 int32 밖 좌표는 Electron 의 Rectangle(정수)로 바꾸지 못해 보일 때마다 screen.getDisplayMatching 이 던진다 —
  // 저장 위치가 없는 것(기본값 — 아이콘 쪽 배치)으로 본다
  it.each([
    ['1e10', { x: 1e10, y: 0 }],
    ['2**31', { x: 2 ** 31, y: 0 }],
    ['-(2**31)-1', { x: -(2 ** 31) - 1, y: 0 }],
    ['y 가 2**31', { x: 0, y: 2 ** 31 }],
    ['반올림하면 2**31', { x: 2 ** 31 - 0.5, y: 0 }],
  ])('반올림한 좌표가 int32 밖(%s)이면 position 만 null 이다', (_label, position) => {
    expect(normalizeSettings({ ...GOOD, position })).toStrictEqual({ ...GOOD, position: null });
  });

  it.each([
    { x: 2 ** 31 - 1, y: -(2 ** 31 - 1) },
    { x: -(2 ** 31 - 1), y: 2 ** 31 - 1 },
    { x: -(2 ** 31), y: 0 },
  ])('int32 경계 안(%j)은 그대로다', (position) => {
    expect(normalizeSettings({ position }).position).toStrictEqual(position);
  });

  it('opacity 는 범위 안으로 들어온다', () => {
    expect(normalizeSettings({ opacity: 150 }).opacity).toBe(100);
    expect(normalizeSettings({ opacity: 5 }).opacity).toBe(30);
  });

  it('모르는 키는 사라진다', () => {
    const got = normalizeSettings({ extra: 1, theme: 'light' });
    expect(Object.keys(got)).toStrictEqual(Object.keys(DEFAULTS));
    expect(got.theme).toBe('light');
  });
});

describe('readSettings', () => {
  const file = (): string => path.join(dir, SETTINGS_FILE);

  it('파일이 없으면 기본값과 missing', () => {
    expect(readSettings(file())).toStrictEqual({ settings: DEFAULTS, status: 'missing' });
  });

  it('폴더가 없어도 missing', () => {
    expect(readSettings(path.join(dir, 'nope', SETTINGS_FILE)).status).toBe('missing');
  });

  it.each(['{bad', 'null', '[]', '42', '"x"', '', '   '])('%j 는 unreadable 이고 autostartDefaultApplied 가 true 다', (text) => {
    fs.writeFileSync(file(), text);
    expect(readSettings(file())).toStrictEqual({ settings: { ...DEFAULTS, autostartDefaultApplied: true }, status: 'unreadable' });
  });

  it('파일 자리가 폴더이면(읽을 수 없음) unreadable 이다', () => {
    fs.mkdirSync(file());
    const got = readSettings(file());
    expect(got.status).toBe('unreadable');
    expect(got.settings.autostartDefaultApplied).toBe(true);
  });

  it('올바른 파일은 정규화한 값과 ok', () => {
    fs.writeFileSync(file(), JSON.stringify({ theme: 'light', opacity: 500, pinned: true, junk: 1 }));
    expect(readSettings(file())).toStrictEqual({ settings: { ...DEFAULTS, theme: 'light', opacity: 100, pinned: true }, status: 'ok' });
  });

  it('손으로 고친 int32 밖 위치는 기본값(null)으로 읽고 나머지는 그대로 ok', () => {
    fs.writeFileSync(file(), JSON.stringify({ theme: 'light', position: { x: 1e10, y: 5 } }));
    expect(readSettings(file())).toStrictEqual({ settings: { ...DEFAULTS, theme: 'light' }, status: 'ok' });
  });

  it('주입한 fs 로 읽는다', () => {
    const fake = { readFileSync: () => JSON.stringify({ pinned: true }) } as unknown as typeof fs;
    expect(readSettings('/x/settings.json', fake)).toStrictEqual({ settings: { ...DEFAULTS, pinned: true }, status: 'ok' });
  });
});

describe('writeSettings', () => {
  const sample: Settings = { ...DEFAULTS, theme: 'light', opacity: 64, pinned: true, position: { x: 3, y: -4 }, autostart: true };

  it('쓰고 읽으면 같은 값이고, 임시 파일이 남지 않는다', () => {
    const file = path.join(dir, SETTINGS_FILE);
    expect(writeSettings(file, sample)).toBeNull();
    expect(readSettings(file)).toStrictEqual({ settings: sample, status: 'ok' });
    expect(fs.readdirSync(dir)).toStrictEqual([SETTINGS_FILE]);
  });

  it('덮어쓴다', () => {
    const file = path.join(dir, SETTINGS_FILE);
    expect(writeSettings(file, sample)).toBeNull();
    expect(writeSettings(file, { ...sample, pinned: false })).toBeNull();
    expect(readSettings(file).settings.pinned).toBe(false);
  });

  it('없는 폴더도 만든다', () => {
    const file = path.join(dir, 'a', 'b', SETTINGS_FILE);
    expect(writeSettings(file, sample)).toBeNull();
    expect(readSettings(file).status).toBe('ok');
  });

  it('한글 · 공백 경로로 왕복한다', () => {
    const file = path.join(dir, '홍 길동', 'TwelveJanggi-dev', SETTINGS_FILE);
    expect(writeSettings(file, sample)).toBeNull();
    expect(readSettings(file)).toStrictEqual({ settings: sample, status: 'ok' });
    expect(fs.readdirSync(path.dirname(file))).toStrictEqual([SETTINGS_FILE]);
  });

  it('rename 이 실패하면 던지지 않고 Error 를 돌려주며 임시 파일을 남기지 않는다', () => {
    const file = path.join(dir, SETTINGS_FILE);
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'keep'), 'x'); // 비지 않은 폴더 — 덮어쓸 수 없다
    const err = writeSettings(file, sample);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).syscall).toBe('rename');
    expect(fs.readdirSync(dir)).toStrictEqual([SETTINGS_FILE]);
  });

  it('폴더 자리에 파일이 있으면(mkdir 실패) 던지지 않고 Error 를 돌려준다', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const err = writeSettings(path.join(blocker, SETTINGS_FILE), sample);
    expect(err).toBeInstanceOf(Error);
    expect(fs.readdirSync(dir)).toStrictEqual(['blocker']);
  });

  it('fs 는 모듈 객체로 부른다(renameSync 를 바꿔 끼울 수 있다)', () => {
    const file = path.join(dir, SETTINGS_FILE);
    const boom = Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'rename' });
    const wrapped = {
      ...fs,
      renameSync: () => {
        throw boom;
      },
    } as unknown as typeof fs;
    expect(writeSettings(file, sample, wrapped)).toBe(boom);
    expect(fs.readdirSync(dir)).toStrictEqual([]);
  });
});

describe('isRetryableWriteError', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('%s 는 다시 해 볼 만하다', (code) => {
    expect(isRetryableWriteError(Object.assign(new Error('x'), { code }))).toBe(true);
  });

  it.each([
    Object.assign(new Error('x'), { code: 'ENOENT' }),
    Object.assign(new Error('x'), { code: 'EISDIR' }),
    new Error('no code'),
    null,
    undefined,
    'EPERM',
    { code: 7 },
  ])('%j 는 아니다', (err) => {
    expect(isRetryableWriteError(err)).toBe(false);
  });
});
