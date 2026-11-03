// desktop/lib/smokeResult.cjs 시험 — 스모크 판정(설계 §5.10). 런처가 앱이 쓴 result.json 과 자식의 종료 상태로 통과 · 실패를 가린다.
// 이 판정은 반목표 1('스모크가 아무것도 증명하지 못한 채 통과')을 막는 마지막 문이다. 그래서 거짓 통과로 새는 틈마다 시험을 하나씩 둔다:
// 거짓처럼 보이는 값(null 종료 코드 · 'true' · 1) · 빈 값끼리의 일치(nonce · electron · 출처) · 앱이 적은 required 를 믿는 것 ·
// 첫 이유에서 멈추는 것. 실패 단계 결과(smokeOut.failureResult)와 틀린 모양의 결과에도 던지지 않고 이유를 낸다.
// electron 은 import 하지 않는다. 페이지와 같은 '.invalid' 규칙인지는 src/tray/smoke 를 불러 맞춰 본다(가짜 의존 — 네트워크 0).
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createTraySmokeApi, type SmokeDeps } from '../../src/tray/smoke';

// 페이지 규칙을 맞춰 보는 시험이 src/tray/smoke 를 불러온다. 진짜 lib/supabase 는 어느 시험에서도 불리지 않는다 — 불리면 여기서 멈춘다.
vi.mock('../../src/lib/supabase', () => {
  throw new Error('smokeResult 시험은 진짜 lib/supabase 를 불러오지 않는다');
});

const require = createRequire(import.meta.url);
const { BASE_REQUIRED, judgeSmoke, requiredChecks } = require('./smokeResult.cjs') as typeof import('./smokeResult.cjs');
const { failureResult } = require('./smokeOut.cjs') as typeof import('./smokeOut.cjs');

type Input = Parameters<typeof judgeSmoke>[0];

/** 설계 §5.10 표의 필수 검사 20개(connectAllowed · net 은 조건부라 뺀다). 순서까지 계약이다. */
const NAMES = [
  'boot',
  'webPreferences',
  'sandboxEffective',
  'bridge',
  'ipc',
  'cspMeta',
  'cspHeader',
  'mime',
  'protocol',
  'ai',
  'navigation',
  'permissions',
  'securityWarnings',
  'noNetwork',
  'loginItem',
  'tray',
  'screenshot',
  'cspViolations',
  'consoleErrors',
  'cspCanary',
];
const VERSIONS = { electron: '44.9.3', chrome: '146.0.0.0', node: '24.11.0', app: '0.1.0' };
const NONCE = 'tj-n-0123abcd';
const ELECTRON = '44.9.3';
const INVALID_ORIGIN = 'https://ci.invalid';

function check(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, ok: true, detail: `${name} 확인`, ...over };
}

/** 필수 검사가 모두 ok 인 성공 결과(SmokeResult 모양). */
function goodResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nonce: NONCE,
    required: [...NAMES],
    checks: NAMES.map((name) => check(name)),
    versions: { ...VERSIONS },
    build: { supabaseOrigin: null, workerScript: 'assets/ai.worker-x.js', builtAt: '2026-10-29T00:00:00.000Z', commit: 'abc1234' },
    boot: true,
    cspViolations: 0,
    aiWorker: 'worker',
    aiAnswered: true,
    ms: 1234,
    ...over,
  };
}

/** 모두 정상인 판정 입력에서 일부만 바꾼다. 값은 일부러 아무 타입이나 넣을 수 있다 — 틀린 값에도 판정은 던지지 않아야 한다. */
function input(over: Record<string, unknown> = {}): Input {
  return {
    result: goodResult(),
    exitCode: 0,
    signal: null,
    timedOut: false,
    nonce: NONCE,
    net: false,
    expectedElectron: ELECTRON,
    expectedSupabaseOrigin: null,
    newSmokeDirs: [],
    ...over,
  } as Input;
}

/** 이유가 정확히 하나이고 그 안에 fragment 가 있다. */
function expectOnly(reasons: string[], fragment: string): void {
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toContain(fragment);
}

const TIMEOUT = '시간 초과';
const SIGNAL = '신호로 끝났다';
const EXIT = '종료 코드';
const NO_RESULT = 'result';
const NONCE_BAD = 'nonce 불일치';
const ELECTRON_BAD = 'electron 불일치';
const ORIGIN_BAD = 'build.supabaseOrigin 불일치';
const MISSING = '필수 검사 누락';
const FAILED = '검사 실패';
const DIRS = '임시 폴더가 남았다';
const REPORTED = '실패를 보고했다';

describe('BASE_REQUIRED', () => {
  it('설계 §5.10 표의 필수 검사 20개 — 이름과 순서가 계약이다', () => {
    expect([...BASE_REQUIRED]).toStrictEqual(NAMES);
    expect(new Set(BASE_REQUIRED).size).toBe(20);
  });

  it('얼려 있다 — 부르는 쪽이 고칠 수 없다', () => {
    expect(Object.isFrozen(BASE_REQUIRED)).toBe(true);
    expect(() => (BASE_REQUIRED as string[]).push('x')).toThrow(TypeError);
    expect(BASE_REQUIRED).toHaveLength(20);
  });
});

/** [설명, Supabase 출처, .invalid 빌드로 보는가] — 페이지(src/tray/smoke.ts invalidOrigins)와 같은 규칙이다. */
const INVALID_RULE: Array<[string, string | null | undefined, boolean]> = [
  ['.invalid 호스트(https)', INVALID_ORIGIN, true],
  ['http 도 같다', 'http://ci.invalid', true],
  ['포트 · 경로 · 쿼리는 상관없다', 'https://ci.invalid:8443/some/path?x=1', true],
  ['대문자는 URL 이 소문자로 바꾼다', 'HTTPS://CI.INVALID', true],
  ['여러 단계 서브도메인', 'https://a.b.ci.invalid', true],
  ['사용자 정보가 있어도 호스트가 .invalid 면 같다', 'https://user:pw@ci.invalid', true],
  ['null', null, false],
  ['undefined', undefined, false],
  ['빈 문자열', '', false],
  ['URL 이 아님', 'not a url', false],
  ['스킴 없는 .invalid 글', 'ci.invalid', false],
  ['실제 Supabase', 'https://abc.supabase.co', false],
  ['로컬 개발', 'http://localhost:54321', false],
  ['루프백', 'http://127.0.0.1:54321', false],
  ['끝에 점이 붙은 호스트', 'https://ci.invalid.', false],
  ['맨몸 invalid', 'https://invalid', false],
  ['invalid 가 이름 앞에 있음', 'https://invalid.example.com', false],
  ['invalid 로 끝나지만 점이 없음', 'https://notinvalid', false],
  ['invalid 가 중간에 있음', 'https://ci.invalid.example', false],
  ['wss 는 https · http 가 아니다', 'wss://ci.invalid', false],
  ['ftp', 'ftp://ci.invalid', false],
  ['file', 'file:///ci.invalid', false],
];

describe('requiredChecks', () => {
  it('기본은 20개 그대로 — connectAllowed · net 이 없다', () => {
    expect(requiredChecks({ net: false, supabaseOrigin: null })).toStrictEqual(NAMES);
  });

  it('.invalid 호스트의 Supabase 출처면 connectAllowed 를 20개 뒤에 더한다', () => {
    expect(requiredChecks({ net: false, supabaseOrigin: INVALID_ORIGIN })).toStrictEqual([...NAMES, 'connectAllowed']);
  });

  it('--net 이면 net 을 더한다', () => {
    expect(requiredChecks({ net: true, supabaseOrigin: null })).toStrictEqual([...NAMES, 'net']);
  });

  it('둘 다면 connectAllowed 다음에 net 이다', () => {
    expect(requiredChecks({ net: true, supabaseOrigin: INVALID_ORIGIN })).toStrictEqual([...NAMES, 'connectAllowed', 'net']);
  });

  it('실제 출처는 추가가 없다 — net 이어도 net 하나만 더한다', () => {
    expect(requiredChecks({ net: false, supabaseOrigin: 'https://abc.supabase.co' })).toStrictEqual(NAMES);
    expect(requiredChecks({ net: true, supabaseOrigin: 'https://abc.supabase.co' })).toStrictEqual([...NAMES, 'net']);
  });

  it('인자를 빠뜨려도 던지지 않는다 — 기본 20개', () => {
    expect(requiredChecks()).toStrictEqual(NAMES);
    expect(requiredChecks({})).toStrictEqual(NAMES);
  });

  it('net 은 true 일 때만 net 을 더한다 — 참처럼 보이는 값은 --net 이 아니다(judgeSmoke 는 불리언이 아닌 net 을 따로 실패로 본다)', () => {
    for (const net of [false, undefined, 1, 'true', 'yes', {}, []]) {
      expect(requiredChecks({ net: net as boolean, supabaseOrigin: null })).toStrictEqual(NAMES);
    }
    expect(requiredChecks({ net: true, supabaseOrigin: null })).toStrictEqual([...NAMES, 'net']);
  });

  it.each(INVALID_RULE)('.invalid 규칙: %s (%j)', (_name, supabaseOrigin, invalid) => {
    const names = requiredChecks({ net: false, supabaseOrigin });
    expect(names.includes('connectAllowed')).toBe(invalid);
    expect(names.slice(0, 20)).toStrictEqual(NAMES);
  });

  it('호출마다 새 배열이다 — 받은 쪽이 고쳐도 BASE_REQUIRED 와 다음 호출은 그대로다', () => {
    const first = requiredChecks({ net: true, supabaseOrigin: INVALID_ORIGIN });
    first.length = 0;
    first.push('아무거나');
    expect([...BASE_REQUIRED]).toStrictEqual(NAMES);
    expect(requiredChecks({ net: false, supabaseOrigin: null })).toStrictEqual(NAMES);
    expect(requiredChecks({ net: false, supabaseOrigin: null })).not.toBe(requiredChecks({ net: false, supabaseOrigin: null }));
  });
});

describe('requiredChecks — 페이지(src/tray/smoke.ts)와 같은 .invalid 규칙', () => {
  /** 페이지가 이 값으로 빌드된 앱에서 connectProbe 로 요청을 시도하는가 — 가짜 의존이라 네트워크로 나가지 않는다. */
  async function pageProbes(supabaseUrl: string | undefined): Promise<boolean> {
    const untouched = (name: string) => (): never => {
      throw new Error(`쓰지 않는 의존이다: ${name}`);
    };
    const deps: SmokeDeps = {
      supabaseUrl,
      supabaseAnonKey: undefined,
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      openSocket: () => ({
        addEventListener: (type, listener) => {
          if (type === 'error') queueMicrotask(listener);
        },
        close: () => undefined,
      }),
      loadSupabase: untouched('loadSupabase'),
      ai: {
        requestAiMove: untouched('requestAiMove'),
        getAiPath: untouched('getAiPath'),
        cancelPendingAi: untouched('cancelPendingAi'),
      },
    };
    return (await createTraySmokeApi(deps).connectProbe()).attempted.length > 0;
  }

  // 둘이 어긋나면 .invalid 빌드가 아닌데 connectAllowed 를 기다리거나(항상 실패), .invalid 빌드인데 요구하지 않는다(거짓 통과).
  it.each(INVALID_RULE)('%s (%j) — 페이지가 요청을 시도하는 빌드 ⇔ connectAllowed 를 요구', async (_name, supabaseOrigin, invalid) => {
    const probes = await pageProbes(supabaseOrigin ?? undefined);
    expect(probes).toBe(invalid);
    expect(requiredChecks({ net: false, supabaseOrigin }).includes('connectAllowed')).toBe(probes);
  });
});

describe('judgeSmoke — 통과', () => {
  it('모두 정상이면 { ok: true, reasons: [] }', () => {
    expect(judgeSmoke(input())).toStrictEqual({ ok: true, reasons: [] });
  });

  it('필수 아닌 검사가 더 있고 ok 여도 상관없다', () => {
    const checks = [...NAMES.map((name) => check(name)), check('정보용 검사')];
    expect(judgeSmoke(input({ result: goodResult({ checks }) }))).toStrictEqual({ ok: true, reasons: [] });
  });

  it('result.required 는 참고일 뿐이다 — 짧아도 길어도 판정은 같다', () => {
    expect(judgeSmoke(input({ result: goodResult({ required: [] }) })).ok).toBe(true);
    expect(judgeSmoke(input({ result: goodResult({ required: ['boot', '없는 검사'] }) })).ok).toBe(true);
    expect(judgeSmoke(input({ result: goodResult({ required: undefined }) })).ok).toBe(true);
  });

  it('--net 이면 net 검사까지 있어야 통과한다', () => {
    const checks = [...NAMES, 'net'].map((name) => check(name));
    expect(judgeSmoke(input({ net: true, result: goodResult({ checks }) }))).toStrictEqual({ ok: true, reasons: [] });
  });

  it('.invalid 빌드면 connectAllowed 까지 있어야 통과한다', () => {
    const checks = [...NAMES, 'connectAllowed'].map((name) => check(name));
    const result = goodResult({ checks, build: { supabaseOrigin: INVALID_ORIGIN, workerScript: null, builtAt: 'x', commit: null } });
    expect(judgeSmoke(input({ expectedSupabaseOrigin: INVALID_ORIGIN, result }))).toStrictEqual({ ok: true, reasons: [] });
  });

  it('실제 Supabase 출처는 같기만 하면 된다(connectAllowed 없음)', () => {
    const origin = 'https://abc.supabase.co';
    const result = goodResult({ build: { supabaseOrigin: origin, workerScript: null, builtAt: 'x', commit: null } });
    expect(judgeSmoke(input({ expectedSupabaseOrigin: origin, result }))).toStrictEqual({ ok: true, reasons: [] });
  });

  it('돌려주는 reasons 는 호출마다 새 배열이다', () => {
    expect(judgeSmoke(input()).reasons).not.toBe(judgeSmoke(input()).reasons);
  });
});

describe('judgeSmoke — 실패 이유 하나씩', () => {
  it('시간 초과', () => {
    const verdict = judgeSmoke(input({ timedOut: true }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, TIMEOUT);
  });

  it.each(['SIGTERM', 'SIGINT', 'SIGKILL', ''])('신호로 끝남(%j) — null · undefined 만 신호 없음이다', (signal) => {
    const verdict = judgeSmoke(input({ signal }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, SIGNAL);
  });

  it('신호가 undefined 여도 신호 없음으로 본다(Node 가 주지 않은 경우)', () => {
    expect(judgeSmoke(input({ signal: undefined })).ok).toBe(true);
  });

  it.each<[string, unknown]>([
    ['1', 1],
    ['-1', -1],
    ['null — 신호로 죽어 코드가 없다', null],
    ['undefined', undefined],
    ["문자열 '0'", '0'],
    ['false', false],
    ['NaN', NaN],
    ['0.5', 0.5],
  ])('종료 코드가 0 이 아니다: %s', (_name, exitCode) => {
    const verdict = judgeSmoke(input({ exitCode }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, EXIT);
  });

  it('신호로 죽으면 신호와 종료 코드 이유가 둘 다 나온다', () => {
    const verdict = judgeSmoke(input({ signal: 'SIGTERM', exitCode: null }));
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons.join('\n')).toContain('SIGTERM');
    expect(verdict.reasons.join('\n')).toContain(EXIT);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
  ])('result 가 없다(파일이 없거나 읽지 못함): %s', (_name, result) => {
    const verdict = judgeSmoke(input({ result }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, NO_RESULT);
    expect(verdict.reasons[0]).toContain('없다');
    expect(verdict.reasons[0]).not.toContain('객체가 아니다');
  });

  it.each<[string, unknown, string]>([
    ['빈 배열', [], '배열'],
    ['검사가 든 배열', [goodResult()], '배열'],
    ['문자열', 'ok', 'string'],
    ['숫자', 7, 'number'],
    ['true', true, 'boolean'],
  ])('result 가 객체가 아니다: %s', (_name, result, kind) => {
    const verdict = judgeSmoke(input({ result }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, NO_RESULT);
    expect(verdict.reasons[0]).toContain('객체가 아니다');
    expect(verdict.reasons[0]).toContain(kind);
  });

  it.each<[string, unknown]>([
    ['다른 값', 'tj-n-다른-실행'],
    ['없음', undefined],
    ['빈 문자열', ''],
    ['null', null],
    ['숫자', 123],
    ['앞뒤 공백', ` ${NONCE} `],
    ['대소문자', NONCE.toUpperCase()],
  ])('result.nonce 가 런처의 것과 다르다: %s', (_name, nonce) => {
    const verdict = judgeSmoke(input({ result: goodResult({ nonce }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, NONCE_BAD);
  });

  it.each<[string, unknown, unknown]>([
    ['둘 다 빈 문자열', '', ''],
    ['둘 다 없음', undefined, undefined],
    ['둘 다 null', null, null],
    ['런처만 빈 문자열', '', NONCE],
    ['런처 nonce 가 숫자', 123, 123],
  ])('nonce 가 비어 있으면 같아 보여도 불일치다: %s', (_name, launcherNonce, resultNonce) => {
    const verdict = judgeSmoke(input({ nonce: launcherNonce, result: goodResult({ nonce: resultNonce }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, NONCE_BAD);
  });

  it.each<[string, unknown]>([
    ['다른 버전', { ...VERSIONS, electron: '43.0.0' }],
    ['versions 없음', undefined],
    ['versions 가 null', null],
    ['versions 가 문자열', '44.9.3'],
    ['electron 키 없음', { chrome: '1', node: '2', app: '3' }],
    ['electron 이 숫자', { ...VERSIONS, electron: 44 }],
    ['electron 이 빈 문자열', { ...VERSIONS, electron: '' }],
  ])('electron 버전이 기대와 다르다: %s', (_name, versions) => {
    const verdict = judgeSmoke(input({ result: goodResult({ versions }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, ELECTRON_BAD);
  });

  it.each<[string, unknown, unknown]>([
    ['둘 다 undefined', undefined, undefined],
    ['둘 다 빈 문자열', '', ''],
    ['런처가 undefined 를 줌', undefined, { ...VERSIONS, electron: undefined }],
    ['런처가 null 을 줌', null, { ...VERSIONS, electron: null }],
  ])('기대 electron 이 비어 있으면 같아 보여도 불일치다: %s', (_name, expectedElectron, versions) => {
    const verdict = judgeSmoke(input({ expectedElectron, result: goodResult({ versions }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, ELECTRON_BAD);
  });

  it.each<[string, unknown, unknown]>([
    ['런처는 null, 결과는 출처가 있다', null, 'https://abc.supabase.co'],
    ['런처는 출처가 있고, 결과는 null', 'https://abc.supabase.co', null],
    ['다른 출처', 'https://abc.supabase.co', 'https://xyz.supabase.co'],
    ['런처는 null, 결과는 빈 문자열', null, ''],
    // 빈 값끼리의 일치는 통과가 아니다 — 손으로 고친 tray-build.json 의 '' 를 parseTrayBuild 는 받는다(build:tray 는 null 을 쓴다)
    ['둘 다 빈 문자열', '', ''],
    ['결과에 키가 없다(런처 null)', null, undefined],
    ['런처가 undefined 를 줌(결과 null)', undefined, null],
    ['둘 다 undefined', undefined, undefined],
  ])('build.supabaseOrigin 이 기대와 다르다: %s', (_name, expectedSupabaseOrigin, supabaseOrigin) => {
    const build = { supabaseOrigin, workerScript: null, builtAt: 'x', commit: null };
    const verdict = judgeSmoke(input({ expectedSupabaseOrigin, result: goodResult({ build }) }));
    expect(verdict.ok).toBe(false);
    // 출처가 .invalid 로 보이는 값(위 표에는 없다)이 아니므로 다른 이유는 없다.
    expectOnly(verdict.reasons, ORIGIN_BAD);
  });

  it.each<[string, unknown]>([
    ['build 없음', undefined],
    ['build 가 null', null],
    ['build 가 숫자', 7],
    ['build 가 문자열', 'https://abc.supabase.co'],
  ])('build 가 없거나 객체가 아니면 출처 불일치다(런처 null): %s', (_name, build) => {
    const verdict = judgeSmoke(input({ result: goodResult({ build }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, ORIGIN_BAD);
  });

  it.each(NAMES)('필수 검사 %s 가 빠졌다', (name) => {
    const checks = NAMES.filter((n) => n !== name).map((n) => check(n));
    const verdict = judgeSmoke(input({ result: goodResult({ checks }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, MISSING);
    expect(verdict.reasons[0]).toContain(name);
  });

  it('빠진 필수 검사는 이름을 모두 낸다', () => {
    const checks = NAMES.filter((n) => n !== 'ai' && n !== 'tray').map((n) => check(n));
    const reason = judgeSmoke(input({ result: goodResult({ checks }) })).reasons[0];
    expect(reason).toContain(MISSING);
    expect(reason).toContain('ai');
    expect(reason).toContain('tray');
  });

  it.each<[string, unknown]>([
    ['없음', undefined],
    ['null', null],
    ['객체', { boot: true }],
    ['문자열', 'boot'],
    ['숫자', 20],
  ])('checks 가 배열이 아니다: %s — 필수 20개가 모두 빠진 것으로 본다', (_name, checks) => {
    const verdict = judgeSmoke(input({ result: goodResult({ checks }) }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join('\n')).toContain('checks 가 배열이 아니다');
    expect(verdict.reasons.join('\n')).toContain(MISSING);
    for (const name of NAMES) expect(verdict.reasons.join('\n')).toContain(name);
  });

  it('필수 검사 하나가 ok:false 다 — 이름과 detail 을 이유에 싣는다', () => {
    const checks = NAMES.map((name) => (name === 'ai' ? check(name, { ok: false, detail: 'aiWorker=fallback' }) : check(name)));
    const verdict = judgeSmoke(input({ result: goodResult({ checks }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, FAILED);
    expect(verdict.reasons[0]).toContain('ai');
    expect(verdict.reasons[0]).toContain('aiWorker=fallback');
  });

  it('검사 detail 이 아주 길면 이유에서는 300자로 줄인다(전체는 result.json 에 있다) — 300자까지는 그대로다', () => {
    const reasonFor = (detail: string): string => {
      const checks = NAMES.map((name) => (name === 'ai' ? check(name, { ok: false, detail }) : check(name)));
      return judgeSmoke(input({ result: goodResult({ checks }) })).reasons[0];
    };
    const long = reasonFor('d'.repeat(1000));
    expect(long).toContain('d'.repeat(300));
    expect(long).not.toContain('d'.repeat(301));
    expect(long).toContain('…');
    const exact = reasonFor('e'.repeat(300));
    expect(exact).toContain('e'.repeat(300));
    expect(exact).not.toContain('…');
  });

  it('받은 값을 이유에 쓸 때의 상한은 이 모듈 몫의 200자다 — JSON 글 200자(따옴표 1자 + x 199자)에서 자르고 … 를 붙인다', () => {
    // 공용 가드(guards.repr)는 상한을 부르는 쪽이 정한다 — 이 모듈이 200 을 넘기는지 여기서 못 박는다. 검사 detail 의 300자와는 다른 상한이다.
    const verdict = judgeSmoke(input({ exitCode: 'x'.repeat(500) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, EXIT);
    expect(verdict.reasons[0]).toContain(`"${'x'.repeat(199)}…`);
    expect(verdict.reasons[0]).not.toContain('x'.repeat(200));
  });

  it('필수가 아닌 검사가 ok:false 여도 실패다 — 보고된 검사는 모두 통과해야 한다', () => {
    const checks = [...NAMES.map((name) => check(name)), check('정보용 검사', { ok: false, detail: '실패했다' })];
    const verdict = judgeSmoke(input({ result: goodResult({ checks }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, FAILED);
    expect(verdict.reasons[0]).toContain('정보용 검사');
    expect(verdict.reasons[0]).toContain('실패했다');
  });

  // 거짓처럼 보이는 값 — truthiness 로 읽으면 통과해 버리는 것들. ok 는 불리언 true 여야 한다.
  it.each<[string, (name: string) => Record<string, unknown>, string | null]>([
    ["문자열 'true'", (name) => ({ name, detail: 'x', ok: 'true' }), 'ok="true"'],
    ["문자열 'false'", (name) => ({ name, detail: 'x', ok: 'false' }), 'ok="false"'],
    ['숫자 1', (name) => ({ name, detail: 'x', ok: 1 }), 'ok=1'],
    ['빈 객체', (name) => ({ name, detail: 'x', ok: {} }), 'ok={}'],
    ['빈 배열', (name) => ({ name, detail: 'x', ok: [] }), 'ok=[]'],
    ['null', (name) => ({ name, detail: 'x', ok: null }), 'ok=null'],
    ['undefined', (name) => ({ name, detail: 'x', ok: undefined }), 'ok=undefined'],
    ['ok 키 없음', (name) => ({ name, detail: 'x' }), 'ok=undefined'],
    ['false', (name) => ({ name, detail: 'x', ok: false }), null],
  ])('ok 가 true 가 아닌 필수 검사: %s', (_label, make, note) => {
    const checks = NAMES.map((name) => (name === 'boot' ? make(name) : check(name)));
    const verdict = judgeSmoke(input({ result: goodResult({ checks }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, FAILED);
    expect(verdict.reasons[0]).toContain('boot');
    expect(verdict.reasons[0]).toContain('— x'); // detail
    // ok 가 불리언 false 가 아니면 어떤 값이었는지 보여 준다 — 'true' 문자열이 통과로 보이지 않게.
    if (note === null) expect(verdict.reasons[0]).not.toContain('true 가 아니다');
    else {
      expect(verdict.reasons[0]).toContain(note);
      expect(verdict.reasons[0]).toContain('true 가 아니다');
    }
  });

  it('같은 이름이 둘이고 하나만 ok:false 여도 실패다(앞이 ok 든 뒤가 ok 든)', () => {
    const base = NAMES.map((name) => check(name));
    for (const extra of [[check('boot', { ok: false })], [check('boot', { ok: false, detail: '두 번째' })]]) {
      const verdict = judgeSmoke(input({ result: goodResult({ checks: [...base, ...extra] }) }));
      expect(verdict.ok).toBe(false);
      expectOnly(verdict.reasons, FAILED);
    }
    const first = [check('boot', { ok: false }), ...base];
    const verdict = judgeSmoke(input({ result: goodResult({ checks: first }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, FAILED);
  });

  it('같은 이름이 둘이어도 모두 ok 면 통과한다', () => {
    const checks = [...NAMES.map((name) => check(name)), check('boot')];
    expect(judgeSmoke(input({ result: goodResult({ checks }) })).ok).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['숫자', 7],
    ['문자열', 'boot'],
    ['배열', ['boot', true]],
    ['name 없음', { ok: true }],
    ['name 이 숫자', { name: 5, ok: true }],
    ['name 이 null', { name: null, ok: true }],
  ])('검사 항목의 모양이 틀렸다(이름이 있는 객체가 아니다): %s', (_name, entry) => {
    const checks = [...NAMES.map((name) => check(name)), entry];
    const verdict = judgeSmoke(input({ result: goodResult({ checks }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, '모양이 틀렸다');
  });

  it('모양이 틀린 항목은 필수 이름을 채우지 못한다 — 빠진 것으로도 센다', () => {
    const checks = NAMES.map((name) => (name === 'boot' ? { nom: 'boot', ok: true } : check(name)));
    const verdict = judgeSmoke(input({ result: goodResult({ checks }) }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join('\n')).toContain(MISSING);
    expect(verdict.reasons.join('\n')).toContain('모양이 틀렸다');
  });

  it('--net 인데 net 검사가 없다', () => {
    const verdict = judgeSmoke(input({ net: true }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, MISSING);
    expect(verdict.reasons[0]).toContain('net');
  });

  it('--net 인데 net 검사가 ok:false 다', () => {
    const checks = [...NAMES.map((name) => check(name)), check('net', { ok: false, detail: 'settings 401' })];
    const verdict = judgeSmoke(input({ net: true, result: goodResult({ checks }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, FAILED);
    expect(verdict.reasons[0]).toContain('settings 401');
  });

  it('.invalid 빌드인데 앱이 connectAllowed 를 보고하지 않았다(페이지가 아무것도 보내지 않은 경우)', () => {
    const result = goodResult({ build: { supabaseOrigin: INVALID_ORIGIN, workerScript: null, builtAt: 'x', commit: null } });
    const verdict = judgeSmoke(input({ expectedSupabaseOrigin: INVALID_ORIGIN, result }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, MISSING);
    expect(verdict.reasons[0]).toContain('connectAllowed');
  });

  it('앱이 required 를 줄여 적어도 필수는 런처가 정한다', () => {
    const checks = NAMES.filter((n) => n !== 'cspCanary').map((n) => check(n));
    const verdict = judgeSmoke(input({ result: goodResult({ checks, required: checks.map((c) => c.name) }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, MISSING);
    expect(verdict.reasons[0]).toContain('cspCanary');
  });

  it('새 tj-smoke-* 폴더가 남았다 — 이름을 싣는다', () => {
    const verdict = judgeSmoke(input({ newSmokeDirs: ['tj-smoke-x'] }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, DIRS);
    expect(verdict.reasons[0]).toContain('tj-smoke-x');
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['문자열', 'tj-smoke-x'],
    ['객체', {}],
  ])('newSmokeDirs 가 배열이 아니면 비교를 못 한 것이라 실패다: %s', (_name, newSmokeDirs) => {
    const verdict = judgeSmoke(input({ newSmokeDirs }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, 'newSmokeDirs');
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ["문자열 'false'", 'false'],
    ['숫자 0', 0],
  ])('timedOut 이 false 가 아니면 모른다는 것이라 실패다: %s', (_name, timedOut) => {
    const verdict = judgeSmoke(input({ timedOut }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, 'timedOut');
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ["문자열 'true'", 'true'],
    ['숫자 1', 1],
  ])('net 이 boolean 이 아니면 실패다: %s', (_name, net) => {
    const verdict = judgeSmoke(input({ net }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, 'net 이 boolean');
  });
});

describe('judgeSmoke — 적용되는 이유를 모두 낸다', () => {
  it('여러 이유가 겹치면 하나씩 모두 나온다', () => {
    const checks = NAMES.filter((n) => n !== 'ai').map((n) => (n === 'boot' ? check(n, { ok: false, detail: '빈 화면' }) : check(n)));
    const verdict = judgeSmoke(
      input({
        timedOut: true,
        signal: 'SIGKILL',
        exitCode: null,
        nonce: 'tj-n-런처',
        newSmokeDirs: ['tj-smoke-a', 'tj-smoke-b'],
        result: goodResult({ checks, nonce: 'tj-n-지난 실행', versions: { ...VERSIONS, electron: '1.0.0' } }),
      }),
    );
    const all = verdict.reasons.join('\n');
    expect(verdict.ok).toBe(false);
    for (const fragment of [TIMEOUT, SIGNAL, EXIT, NONCE_BAD, ELECTRON_BAD, MISSING, FAILED, DIRS]) expect(all).toContain(fragment);
    expect(all).toContain('빈 화면');
    expect(all).toContain('tj-smoke-a');
    expect(all).toContain('tj-smoke-b');
    expect(verdict.reasons.every((reason) => typeof reason === 'string' && reason !== '')).toBe(true);
  });

  it('ok:false 인 검사가 여럿이면 검사마다 이유 하나씩이다', () => {
    const checks = NAMES.map((n) => (n === 'boot' || n === 'tray' ? check(n, { ok: false, detail: `${n} 실패` }) : check(n)));
    const verdict = judgeSmoke(input({ result: goodResult({ checks }) }));
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toContain('boot 실패');
    expect(verdict.reasons[1]).toContain('tray 실패');
  });

  it('ok 는 이유가 없을 때만 true 다', () => {
    for (const over of [{}, { timedOut: true }, { exitCode: 2 }, { newSmokeDirs: ['tj-smoke-x'] }]) {
      const verdict = judgeSmoke(input(over));
      expect(verdict.ok).toBe(verdict.reasons.length === 0);
    }
  });
});

describe('judgeSmoke — 실패 단계 결과(smokeOut.failureResult)', () => {
  const FAILURE = failureResult({ nonce: NONCE, stage: 'tray-build', error: 'tray-build.json: 읽지 못했다', versions: VERSIONS });

  it('던지지 않고 stage 와 error 를 이유에 그대로 싣는다 — 종료 코드 1', () => {
    const verdict = judgeSmoke(input({ exitCode: 1, result: FAILURE }));
    expect(verdict.ok).toBe(false);
    const all = verdict.reasons.join('\n');
    expect(all).toContain(REPORTED);
    expect(all).toContain('tray-build');
    expect(all).toContain('tray-build.json: 읽지 못했다');
    expect(all).toContain(EXIT);
    expect(all).toContain(MISSING);
  });

  it('앱이 0 으로 끝났어도 실패 보고가 있으면 실패다', () => {
    const verdict = judgeSmoke(input({ exitCode: 0, result: FAILURE }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join('\n')).toContain(REPORTED);
  });

  it('실패 단계 결과는 필수 검사가 없다고도 말한다 — 검사는 하나도 돌지 않았다', () => {
    const reasons = judgeSmoke(input({ exitCode: 1, result: FAILURE })).reasons;
    const missing = reasons.find((reason) => reason.includes(MISSING)) ?? '';
    for (const name of NAMES) expect(missing).toContain(name);
  });

  it('versions 가 맞아도 build 가 없으니 출처 불일치도 같이 나온다', () => {
    const all = judgeSmoke(input({ exitCode: 1, result: FAILURE })).reasons.join('\n');
    expect(all).toContain(ORIGIN_BAD);
    expect(all).not.toContain(ELECTRON_BAD);
    expect(all).not.toContain(NONCE_BAD);
  });

  it('nonce 가 다른 실패 결과(지난 실행의 것)는 불일치도 말한다', () => {
    const stale = failureResult({ nonce: '지난-실행', stage: 'lock', error: '잠금', versions: VERSIONS });
    const all = judgeSmoke(input({ exitCode: 1, result: stale })).reasons.join('\n');
    expect(all).toContain(NONCE_BAD);
    expect(all).toContain(REPORTED);
  });

  it('성공 모양 결과에 stage 만 있어도 · error 만 있어도 실패다 — 앱이 실패를 보고한 것이다', () => {
    const onlyStage = judgeSmoke(input({ result: goodResult({ stage: 'lock' }) }));
    expect(onlyStage.ok).toBe(false);
    expectOnly(onlyStage.reasons, REPORTED);
    expect(onlyStage.reasons[0]).toContain('lock');
    const onlyError = judgeSmoke(input({ result: goodResult({ error: '터졌다' }) }));
    expect(onlyError.ok).toBe(false);
    expectOnly(onlyError.reasons, REPORTED);
    expect(onlyError.reasons[0]).toContain('터졌다');
  });

  it('null 인 stage · error 는 없는 것과 같다', () => {
    expect(judgeSmoke(input({ result: goodResult({ stage: null, error: null }) })).ok).toBe(true);
  });

  it('문자열이 아닌 stage · error 도 던지지 않고 값을 싣는다', () => {
    const verdict = judgeSmoke(input({ result: goodResult({ stage: { a: 1 }, error: ['x', 2] }) }));
    expect(verdict.ok).toBe(false);
    expectOnly(verdict.reasons, REPORTED);
    expect(verdict.reasons[0]).toContain('{"a":1}');
    expect(verdict.reasons[0]).toContain('["x",2]');
  });

  it('빈 문자열 error 도 실패 보고다', () => {
    expect(judgeSmoke(input({ result: goodResult({ error: '' }) })).ok).toBe(false);
  });
});

describe('judgeSmoke — 어떤 입력에도 던지지 않는다', () => {
  const JUNK: Array<[string, unknown]> = [
    ['checks 가 문자열', goodResult({ checks: 'boot' })],
    ['checks 가 객체', goodResult({ checks: { boot: true } })],
    ['checks 항목이 null · 숫자 · 문자열 · 배열 · 빈 객체', goodResult({ checks: [null, 1, 'boot', [], {}] })],
    ['versions 가 null', goodResult({ versions: null })],
    ['versions 가 문자열', goodResult({ versions: '44.9.3' })],
    ['build 가 숫자', goodResult({ build: 7 })],
    ['stage · error 가 객체', goodResult({ stage: { a: 1 }, error: ['x'] })],
    ['값이 모두 null', { nonce: null, checks: null, versions: null, build: null }],
    ['빈 객체', {}],
    ['빈 배열', []],
    // 이유를 펼쳐 넣으면(push(...목록)) 인자 수가 호출 스택을 넘는 크기(Node 22 에서 약 13만 건부터 RangeError)
    [
      '실패한 검사 200,000건',
      goodResult({ checks: Array.from({ length: 200_000 }, (_, i) => ({ name: `x${i}`, ok: false, detail: '실패' })) }),
    ],
  ];

  it.each(JUNK)('result: %s', (_name, result) => {
    let verdict: ReturnType<typeof judgeSmoke> | undefined;
    expect(() => {
      verdict = judgeSmoke(input({ result }));
    }).not.toThrow();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.reasons.every((reason) => typeof reason === 'string')).toBe(true);
  });

  it('입력을 고치지 않는다 — 얼린 입력(result · checks · newSmokeDirs 까지)에도 던지지 않고 같은 판정을 낸다', () => {
    const deepFreeze = <T>(value: T): T => {
      if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
      }
      return value;
    };
    const make = () => {
      const checks = [...NAMES.filter((n) => n !== 'ai').map((n) => check(n)), check('boot', { ok: false }), { name: 'x', ok: 'true' }];
      return input({ newSmokeDirs: ['tj-smoke-x'], result: goodResult({ checks }) });
    };
    const frozen = deepFreeze(make());
    let verdict: ReturnType<typeof judgeSmoke> | undefined;
    expect(() => {
      verdict = judgeSmoke(frozen);
    }).not.toThrow();
    expect(verdict).toStrictEqual(judgeSmoke(make()));
    expect(verdict?.ok).toBe(false);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['문자열', 'x'],
    ['빈 객체', {}],
  ])('판정 입력 자체가 틀려도(%s) 실패 이유를 낸다', (_name, whole) => {
    let verdict: ReturnType<typeof judgeSmoke> | undefined;
    expect(() => {
      verdict = judgeSmoke(whole as Input);
    }).not.toThrow();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.reasons.length).toBeGreaterThan(0);
  });
});
