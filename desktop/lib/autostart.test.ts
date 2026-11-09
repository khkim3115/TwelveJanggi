// desktop/lib/autostart.cjs 시험 — 로그인 항목 인자 · 판별(설계 §5.1 autostart.cjs 표).
// 시험은 process.platform 에 기대지 않는다: 플랫폼과 실행 파일 경로를 값으로 넘긴다.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  AUTOSTART_NAME,
  HIDDEN_ARG,
  hasHiddenArg,
  loginItemQuery,
  loginItemSettings,
  autostartChecked,
  launchedAtLogin,
  firstRunAutostart,
  canManageLoginItems,
} = require('./autostart.cjs') as typeof import('./autostart.cjs');

describe('상수', () => {
  it('값이 동결 계약과 같다', () => {
    expect(AUTOSTART_NAME).toBe('com.khkim.twelvejanggi');
    expect(HIDDEN_ARG).toBe('--hidden');
  });
});

describe('hasHiddenArg', () => {
  it('정확히 --hidden 인 원소가 있으면 true', () => {
    expect(hasHiddenArg(['x', '--hidden'])).toBe(true);
  });
  it.each([[['--hidden=1']], [['--HIDDEN']], [[]], [['hidden']], [['--hidden ']]])('false: %j', (argv) => {
    expect(hasHiddenArg(argv)).toBe(false);
  });
});

describe('loginItemQuery', () => {
  it('win32 는 args 를 싣고, 나머지는 빈 객체', () => {
    expect(loginItemQuery('win32')).toEqual({ args: ['--hidden'] });
    expect(loginItemQuery('darwin')).toEqual({});
    expect(loginItemQuery('linux')).toEqual({});
  });
});

describe('loginItemSettings', () => {
  it('win32', () => {
    expect(loginItemSettings('win32', true)).toEqual({
      openAtLogin: true,
      name: 'com.khkim.twelvejanggi',
      args: ['--hidden'],
      enabled: true,
    });
    expect(loginItemSettings('win32', false)).toEqual({
      openAtLogin: false,
      name: 'com.khkim.twelvejanggi',
      args: ['--hidden'],
      enabled: true,
    });
  });
  it('darwin', () => {
    expect(loginItemSettings('darwin', false)).toEqual({ openAtLogin: false });
    expect(loginItemSettings('darwin', true)).toEqual({ openAtLogin: true });
  });
  it('linux · 그 밖은 null', () => {
    expect(loginItemSettings('linux', true)).toBeNull();
    expect(loginItemSettings('freebsd', false)).toBeNull();
  });
});

describe('autostartChecked', () => {
  const settings = (autostart: boolean) => ({ autostart });
  it('win32 는 executableWillLaunchAtLogin 이 정확히 true 일 때만(설정은 보지 않는다)', () => {
    expect(autostartChecked({ platform: 'win32', loginItem: { executableWillLaunchAtLogin: true }, settings: settings(false) })).toBe(true);
    expect(autostartChecked({ platform: 'win32', loginItem: { executableWillLaunchAtLogin: false }, settings: settings(true) })).toBe(false);
    expect(autostartChecked({ platform: 'win32', loginItem: {}, settings: settings(true) })).toBe(false);
  });
  it('darwin 은 설정의 autostart 가 true 일 때만(loginItem 은 보지 않는다)', () => {
    expect(autostartChecked({ platform: 'darwin', loginItem: { executableWillLaunchAtLogin: false }, settings: settings(true) })).toBe(true);
    expect(autostartChecked({ platform: 'darwin', loginItem: { executableWillLaunchAtLogin: true }, settings: settings(false) })).toBe(false);
  });
  it('linux 는 늘 false', () => {
    expect(autostartChecked({ platform: 'linux', loginItem: { executableWillLaunchAtLogin: true }, settings: settings(true) })).toBe(false);
  });
});

describe('launchedAtLogin', () => {
  it('win32 는 argv 의 --hidden(loginItem 은 보지 않는다)', () => {
    expect(launchedAtLogin({ platform: 'win32', argv: ['a.exe', '--hidden'], loginItem: { wasOpenedAtLogin: false } })).toBe(true);
    expect(launchedAtLogin({ platform: 'win32', argv: ['a.exe'], loginItem: { wasOpenedAtLogin: true } })).toBe(false);
    expect(launchedAtLogin({ platform: 'win32', argv: ['--hidden=1'], loginItem: {} })).toBe(false);
  });
  it('darwin 은 wasOpenedAtLogin(argv 는 보지 않는다)', () => {
    expect(launchedAtLogin({ platform: 'darwin', argv: [], loginItem: { wasOpenedAtLogin: true } })).toBe(true);
    expect(launchedAtLogin({ platform: 'darwin', argv: ['--hidden'], loginItem: { wasOpenedAtLogin: false } })).toBe(false);
  });
  it('linux 는 늘 false', () => {
    expect(launchedAtLogin({ platform: 'linux', argv: ['--hidden'], loginItem: { wasOpenedAtLogin: true } })).toBe(false);
  });
});

describe('firstRunAutostart', () => {
  it('win32 만 true', () => {
    expect(firstRunAutostart('win32')).toBe(true);
    expect(firstRunAutostart('darwin')).toBe(false);
    expect(firstRunAutostart('linux')).toBe(false);
  });
});

describe('canManageLoginItems — 호스트와 무관하게 같은 결과', () => {
  const WIN = 'C:\\Program Files\\TwelveJanggi\\TwelveJanggi.exe';
  const MAC = '/Applications/TwelveJanggi.app/Contents/MacOS/TwelveJanggi';
  const base = { isPackaged: true, smoke: false, platform: 'win32', execPath: WIN };

  it('패키지된 win32 · darwin 은 true', () => {
    expect(canManageLoginItems(base)).toBe(true);
    expect(canManageLoginItems({ ...base, platform: 'darwin', execPath: MAC })).toBe(true);
  });
  it('패키지가 아니면 false', () => {
    expect(canManageLoginItems({ ...base, isPackaged: false })).toBe(false);
  });
  it('스모크면 false', () => {
    expect(canManageLoginItems({ ...base, smoke: true })).toBe(false);
  });
  it('linux 는 false', () => {
    expect(canManageLoginItems({ ...base, platform: 'linux', execPath: '/opt/TwelveJanggi/twelvejanggi' })).toBe(false);
  });
  it.each(['C:\\x\\electron.exe', 'C:\\x\\Electron.EXE', '/x/electron', 'C:/x/electron.exe', '/x/Electron'])(
    '개발 바이너리 거부: %s',
    (execPath) => {
      expect(canManageLoginItems({ ...base, execPath })).toBe(false);
    },
  );
  it('이름이 electron 으로 시작할 뿐이면 거부하지 않는다', () => {
    expect(canManageLoginItems({ ...base, execPath: 'C:\\x\\electron-tray.exe' })).toBe(true);
  });
});
