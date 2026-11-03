// desktop/lib/smokeLaunch.cjs 시험 — 스모크 런처의 순수 판단(설계 §5.10 '런처'): 인자 · 앱의 env · 잠금 주인이 살아 있는가 · 고정한 electron.
// 런처(desktop/scripts/smoke.cjs)를 돌리지 않고 함수를 바로 부른다. 앱을 띄우고 끄는 일(시간 제한 · 트리 종료)은 런처에 있다.
// - 인자 · env 사례는 런처를 가짜 앱으로 돌려 본 CLI 사례에서 옮겼고, npm 이 가져간 인자 · NODE_OPTIONS · ELECTRON_FORCE_IS_PACKAGED ·
//   TMPDIR · 내 PID · 내려받지 않는 electron 확인의 사례를 더했다.
// - env 는 Windows 의 펼친 process.env 처럼 이름의 글자꼴만 다른 것(Temp · tmp …)을 넣어 대소문자를 가리지 않는지 본다.
// - 고정한 electron 은 mkdtemp(한글 · 공백 이름) 안에 가짜 패키지(package.json · path.txt · dist/<실행 파일>)를 깔고 본다.
//   require.resolve 는 가짜를 넣는다 — 진짜 electron 은 import · require · resolve 하지 않는다(루트 검사는 desktop/node_modules 없이 돈다).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { USAGE, checkElectron, childEnv, isAlive, parseArgs } = require('./smokeLaunch.cjs') as typeof import('./smokeLaunch.cjs');

/** npm 이 가져간 인자가 없는 env — npm 이 스크립트에 늘 넣는 값(npm_lifecycle_event 등)은 있다. */
const CLEAN_ENV = { Path: 'C:\\Windows\\system32', npm_lifecycle_event: 'smoke', npm_config_user_agent: 'npm/10.9.2 node/v22.13.0 win32 x64' };
/** npm 이 인자를 가져갔을 때의 안내 — 사용법 줄과 함께 찍힌다. */
const NPM_HINT = 'npm 인자는 -- 뒤에 쓴다: npm --prefix desktop run smoke -- --net';
const CI_HINT = 'npm --prefix desktop ci';
const INSTALL_HINT = 'node desktop/node_modules/electron/install.js';

describe('parseArgs — 받는 인자', () => {
  it.each<[string[], { net: boolean; timeoutSec: number }]>([
    [[], { net: false, timeoutSec: 90 }],
    [['--net'], { net: true, timeoutSec: 90 }],
    [['--timeout=10'], { net: false, timeoutSec: 10 }],
    [['--timeout=90'], { net: false, timeoutSec: 90 }],
    [['--timeout=45', '--net'], { net: true, timeoutSec: 45 }],
    [['--net', '--timeout=15'], { net: true, timeoutSec: 15 }],
  ])('%j → %j', (argv, expected) => {
    expect(parseArgs(argv, CLEAN_ENV)).toStrictEqual({ ok: true, ...expected });
  });
});

describe('parseArgs — 틀린 인자(런처는 잠금 전에 이유 · 사용법을 찍고 exit 1)', () => {
  it.each<[string[], string]>([
    [['--bogus'], '모르는 인자다: "--bogus"'],
    [['--timeout=9'], '--timeout 은 10~90 의 정수(초)여야 한다: "9"'],
    [['--timeout=91'], '"91"'],
    [['--timeout=0'], '"0"'],
    [['--timeout=abc'], '"abc"'],
    [['--timeout='], '""'],
    [['--timeout=015'], '"015"'],
    [['--timeout=010'], '"010"'],
    [['--timeout=1.5'], '"1.5"'],
    [['--timeout=1e1'], '"1e1"'],
    [['--timeout=-10'], '"-10"'],
    [['--timeout= 15'], '" 15"'],
    [['--timeout=15', '--timeout=20'], '--timeout= 가 두 번 있다'],
    [['--timeout=10', '--timeout=10'], '--timeout= 가 두 번 있다'],
    [['--net', '--net'], '--net 가 두 번 있다'],
    [['--timeout=15', 'x'], '모르는 인자다: "x"'],
    [['--'], '모르는 인자다: "--"'],
    [['net'], '모르는 인자다: "net"'],
    [['--NET'], '모르는 인자다: "--NET"'],
    [['--net=1'], '모르는 인자다: "--net=1"'],
    [['--timeout'], '모르는 인자다: "--timeout"'],
  ])('%j → 오류: %s', (argv, reason) => {
    expect(parseArgs(argv, CLEAN_ENV)).toStrictEqual({ ok: false, error: expect.stringContaining(reason) });
  });

  it('사용법 줄은 -- 뒤에 쓰는 두 인자와 시간 범위 · 기본값을 적는다', () => {
    expect(USAGE).toContain('npm --prefix desktop run smoke [-- [--net] [--timeout=<10~90 초, 기본 90>]]');
  });
});

describe('parseArgs — npm 이 가져간 인자(-- 없이 쓴 npm run smoke --net · --timeout=15)', () => {
  // npm 은 -- 앞의 플래그를 자기 설정으로 읽어 npm_config_<이름> 으로 env 에 넣고 스크립트에는 넘기지 않는다(경고 없음, npm 10.9.2).
  it.each<[string, Record<string, string>]>([
    ['npm_config_net=true', { npm_config_net: 'true' }],
    ['npm_config_timeout=15', { npm_config_timeout: '15' }],
    ['대문자 NPM_CONFIG_NET', { NPM_CONFIG_NET: 'true' }],
    ['섞인 글자 Npm_Config_Timeout', { Npm_Config_Timeout: '15' }],
    ['빈 값', { npm_config_net: '' }],
    ['둘 다', { npm_config_net: 'true', npm_config_timeout: '15' }],
  ])('%s → argv 와 상관없이 거부하고 -- 를 안내한다', (_name, swallowed) => {
    for (const argv of [[], ['--net'], ['--timeout=15'], ['--net', '--timeout=15']]) {
      expect(parseArgs(argv, { ...CLEAN_ENV, ...swallowed })).toStrictEqual({ ok: false, error: expect.stringContaining(NPM_HINT) });
    }
  });

  it('이유에 가져간 이름을 적는다', () => {
    const result = parseArgs([], { ...CLEAN_ENV, npm_config_net: 'true', npm_config_timeout: '15' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/npm_config_net.*npm_config_timeout/);
  });

  it('이름이 정확히 같을 때만이다 — npm_config_network · npm_config_net_x · npm_config_fetch_timeout 은 그대로 받는다', () => {
    const env = { ...CLEAN_ENV, npm_config_network: 'x', npm_config_net_x: '1', npm_config_fetch_timeout: '30000', npm_config_timeout_x: '1' };
    expect(parseArgs(['--net'], env)).toStrictEqual({ ok: true, net: true, timeoutSec: 90 });
  });
});

describe('childEnv', () => {
  const RUN_TMP = 'C:\\Users\\홍 길동\\AppData\\Local\\Temp\\tj-smoke-abc123\\tmp';
  /** 런처 셸의 env — Windows 의 펼친 process.env 처럼 이름의 글자꼴이 제각각이다. */
  const PARENT = {
    Path: 'C:\\Windows\\system32',
    USERPROFILE: 'C:\\Users\\홍 길동',
    tmp: 'C:\\Users\\홍 길동\\AppData\\Local\\Temp',
    Temp: 'C:\\Users\\홍 길동\\AppData\\Local\\Temp',
    TmpDir: '/tmp',
    Electron_Run_As_Node: '1',
    electron_disable_security_warnings: 'true',
    Tj_DevTools: '1',
    electron_enable_security_warnings: '0',
    Node_Options: '--require C:\\hook.cjs --inspect',
    electron_force_is_packaged: 'true',
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_LOG_FILE: 'C:\\Users\\홍 길동\\electron.log',
    ELECTRON_ENABLE_STACK_DUMPING: '1',
    npm_config_user_agent: 'npm/10.9.2',
  };

  /** env 에서 이름(대소문자 무시)이 name 인 [이름, 값] 들. */
  function entriesNamed(env: NodeJS.ProcessEnv, name: string): Array<[string, string | undefined]> {
    return Object.entries(env).filter(([key]) => key.toUpperCase() === name);
  }
  /** 이름의 글자꼴 셋 — 대문자 · 소문자 · 단어 첫 글자만 대문자. */
  function variants(name: string): string[] {
    const title = name
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('_');
    return [name, name.toLowerCase(), title];
  }

  it('지울 다섯을 빼고 임시 폴더 셋 · 보안 경고를 넣는다 — 그 밖(기록 · 디버그 변수 포함)은 이름 · 값 그대로', () => {
    expect(childEnv(PARENT, RUN_TMP)).toStrictEqual({
      Path: PARENT.Path,
      USERPROFILE: PARENT.USERPROFILE,
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_LOG_FILE: PARENT.ELECTRON_LOG_FILE,
      ELECTRON_ENABLE_STACK_DUMPING: '1',
      npm_config_user_agent: 'npm/10.9.2',
      TMP: RUN_TMP,
      TEMP: RUN_TMP,
      TMPDIR: RUN_TMP,
      ELECTRON_ENABLE_SECURITY_WARNINGS: '1',
    });
  });

  it.each(['ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SECURITY_WARNINGS', 'TJ_DEVTOOLS', 'NODE_OPTIONS', 'ELECTRON_FORCE_IS_PACKAGED'])(
    '%s 는 어떤 글자꼴로 와도 없다',
    (name) => {
      for (const variant of variants(name)) {
        expect(entriesNamed(childEnv({ ...CLEAN_ENV, [variant]: '1' }, RUN_TMP), name), variant).toStrictEqual([]);
      }
    },
  );

  it.each<[string, string]>([
    ['TMP', RUN_TMP],
    ['TEMP', RUN_TMP],
    ['TMPDIR', RUN_TMP],
    ['ELECTRON_ENABLE_SECURITY_WARNINGS', '1'],
  ])('%s 는 글자꼴만 다른 것이 몇이 와도 하나뿐이고 값은 %s', (name, value) => {
    const parent = Object.fromEntries(variants(name).map((variant) => [variant, '0']));
    expect(entriesNamed(childEnv(parent, RUN_TMP), name)).toStrictEqual([[name, value]]);
    expect(entriesNamed(childEnv({}, RUN_TMP), name)).toStrictEqual([[name, value]]); // 없던 env 에도 넣는다
  });

  it('넘긴 env 는 바꾸지 않고 새 객체를 돌려준다', () => {
    const before = { ...PARENT };
    const env = childEnv(PARENT, RUN_TMP);
    expect(PARENT).toStrictEqual(before);
    expect(env).not.toBe(PARENT);
  });

  it('실제 process.env(Windows 는 이름의 대소문자를 가리지 않는 객체)에서도 TEMP · TMP 가 하나씩이다', () => {
    const env = childEnv(process.env, RUN_TMP);
    expect(entriesNamed(env, 'TEMP')).toStrictEqual([['TEMP', RUN_TMP]]);
    expect(entriesNamed(env, 'TMP')).toStrictEqual([['TMP', RUN_TMP]]);
    expect(env).not.toBe(process.env);
  });
});

describe('isAlive — acquireLock 의 isAlive(잠금 주인 PID)', () => {
  /** 내 PID 가 아닌 아무 값 — 가짜 kill 이 답한다. */
  const OTHER = process.pid + 4;
  /** Node 의 kill 오류 모양 — code 로 가른다. */
  const killError = (code: string) => Object.assign(new Error(`kill ${code}`), { code });

  it('kill(pid, 0) 이 성공하면 산 것이다', () => {
    const kill = vi.fn(() => true);
    expect(isAlive(OTHER, kill)).toBe(true);
    expect(kill.mock.calls).toStrictEqual([[OTHER, 0]]);
  });

  it('EPERM(남의 프로세스라 신호를 보낼 권한이 없다)은 산 것이다', () => {
    expect(
      isAlive(OTHER, () => {
        throw killError('EPERM');
      }),
    ).toBe(true);
  });

  it('ESRCH(그런 프로세스가 없다)는 죽은 것이다', () => {
    expect(
      isAlive(OTHER, () => {
        throw killError('ESRCH');
      }),
    ).toBe(false);
  });

  it.each<[string, unknown]>([
    ['EINVAL', killError('EINVAL')],
    ['code 없는 Error', new Error('알 수 없음')],
    ['문자열', 'ESRCH'],
    ['null', null],
  ])('그 밖의 오류(%s)는 알 수 없는 것이라 산 것이다 — 남의 잠금을 빼앗지 않는다', (_name, thrown) => {
    expect(
      isAlive(OTHER, () => {
        throw thrown;
      }),
    ).toBe(true);
  });

  it('내 PID 는 죽은 것이다 — 묻지 않는다(acquireLock 은 내 wx 만들기가 실패한 뒤에만 묻는다)', () => {
    const kill = vi.fn(() => true);
    expect(isAlive(process.pid, kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('기본 kill 은 process.kill 이다 — 내 부모는 산 것, 내 PID 는 죽은 것, 있을 수 없는 PID 는 죽은 것', () => {
    expect(isAlive(process.ppid)).toBe(true);
    expect(isAlive(process.pid)).toBe(false);
    expect(isAlive(2 ** 30)).toBe(false); // Windows · Linux 모두 이만큼 큰 PID 를 주지 않는다 → ESRCH
  });
});

describe('checkElectron — 고정한 electron(desktop/node_modules/electron)을 require 전에 확인', () => {
  let base = '';
  let appDir = '';
  let electronDir = '';
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'tj-고정 electron '));
    appDir = join(base, 'desktop');
    electronDir = join(appDir, 'node_modules', 'electron');
    mkdirSync(join(electronDir, 'dist'), { recursive: true });
    writeFileSync(join(electronDir, 'package.json'), '{"name":"electron","version":"44.9.3"}\n');
    writeFileSync(join(electronDir, 'path.txt'), 'electron.exe');
    writeFileSync(join(electronDir, 'dist', 'electron.exe'), '');
  });
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
    base = '';
  });

  /** 런처의 require.resolve 흉내 — 'electron/package.json' 을 to 로 푼다(기본은 desktop/node_modules/electron 의 것). */
  function resolver(to?: string) {
    return vi.fn((request: string): string => {
      if (request !== 'electron/package.json') throw new Error(`모르는 요청: ${request}`);
      return to ?? join(electronDir, 'package.json');
    });
  }

  it('패키지 · path.txt · dist 의 실행 파일이 있고 desktop/node_modules/electron 으로 풀리면 ok', () => {
    const resolve = resolver();
    expect(checkElectron(appDir, resolve)).toStrictEqual({ ok: true });
    expect(resolve.mock.calls).toStrictEqual([['electron/package.json']]);
  });

  it('path.txt 가 적은 이름을 dist 아래에서 찾는다(한글 · 공백 · 하위 폴더도 그대로)', () => {
    rmSync(join(electronDir, 'dist', 'electron.exe'));
    mkdirSync(join(electronDir, 'dist', '홍 길동'));
    writeFileSync(join(electronDir, 'dist', '홍 길동', 'Electron 앱'), '');
    writeFileSync(join(electronDir, 'path.txt'), join('홍 길동', 'Electron 앱'));
    expect(checkElectron(appDir, resolver())).toStrictEqual({ ok: true });
  });

  it('패키지(package.json)가 없으면 npm --prefix desktop ci 를 안내한다 — resolve 는 부르지 않는다', () => {
    rmSync(join(electronDir, 'package.json'));
    const resolve = resolver();
    expect(checkElectron(appDir, resolve)).toStrictEqual({ ok: false, error: expect.stringContaining(CI_HINT) });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each<[string, () => string]>([
    ['위 폴더의 node_modules', () => join(base, 'node_modules', 'electron', 'package.json')],
    ['NODE_PATH · 링크의 대상', () => join(base, '다른 곳', 'electron', 'package.json')],
    ['desktop/node_modules/electron 아래의 다른 패키지', () => join(electronDir, 'node_modules', 'electron', 'package.json')],
  ])('electron/package.json 이 다른 곳(%s)으로 풀리면 npm --prefix desktop ci 를 안내한다', (_name, to) => {
    expect(checkElectron(appDir, resolver(to()))).toStrictEqual({ ok: false, error: expect.stringContaining(CI_HINT) });
  });

  it('resolve 가 던지면 npm --prefix desktop ci 를 안내한다', () => {
    const resolve = () => {
      throw Object.assign(new Error("Cannot find module 'electron/package.json'"), { code: 'MODULE_NOT_FOUND' });
    };
    expect(checkElectron(appDir, resolve)).toStrictEqual({ ok: false, error: expect.stringContaining(CI_HINT) });
  });

  /** 파일을 같은 이름의 빈 폴더로 바꾼다. */
  function replaceWithDir(file: string): void {
    rmSync(file);
    mkdirSync(file);
  }

  // electron 44 의 index.js 는 이 경우마다 바이너리를 내려받는다(네트워크) — 런처는 내려받지 않고 install.js 를 안내한다.
  it.each<[string, () => void]>([
    ['path.txt 가 없다', () => rmSync(join(electronDir, 'path.txt'))],
    ['path.txt 가 비었다', () => writeFileSync(join(electronDir, 'path.txt'), '')],
    ['path.txt 끝에 줄바꿈이 있다(그 이름의 파일은 없다)', () => writeFileSync(join(electronDir, 'path.txt'), 'electron.exe\n')],
    ['path.txt 가 폴더다', () => replaceWithDir(join(electronDir, 'path.txt'))],
    ['dist 에 실행 파일이 없다', () => rmSync(join(electronDir, 'dist', 'electron.exe'))],
    ['dist 가 없다', () => rmSync(join(electronDir, 'dist'), { recursive: true })],
    ['실행 파일 자리에 폴더가 있다', () => replaceWithDir(join(electronDir, 'dist', 'electron.exe'))],
    [
      'path.txt 가 dist 밖을 가리킨다(그 파일은 있다)',
      () => {
        writeFileSync(join(electronDir, 'evil.exe'), '');
        writeFileSync(join(electronDir, 'path.txt'), join('..', 'evil.exe'));
      },
    ],
    ['path.txt 가 dist 자체를 가리킨다', () => writeFileSync(join(electronDir, 'path.txt'), '.')],
  ])('%s → node desktop/node_modules/electron/install.js 를 안내한다', (_name, breakIt) => {
    breakIt();
    const result = checkElectron(appDir, resolver());
    expect(result).toStrictEqual({ ok: false, error: expect.stringContaining(INSTALL_HINT) });
    expect(result.ok ? '' : result.error).not.toContain(CI_HINT);
  });

  it.runIf(process.platform === 'win32')('Windows 는 경로의 대소문자를 가리지 않는다 — 글자꼴만 다른 resolve 결과도 ok', () => {
    expect(checkElectron(appDir, resolver(join(electronDir, 'package.json').toUpperCase()))).toStrictEqual({ ok: true });
  });
});
