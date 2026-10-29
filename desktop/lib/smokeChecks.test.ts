// desktop/lib/smokeChecks.cjs 시험 — 스모크 검사 평가(설계 §5.10 표). 앱 안 실행기(desktop/smoke/run.cjs)가 모은 사실을 { ok, detail } 로 판정하는 순수 함수들.
// 함수마다 통과 · 실패 · 빈 입력을 본다 — 입력이 비었거나 모양이 틀리면 ok:false 다(아무것도 없다는 사실이 '통과'가 되지 않는다).
// 거짓처럼 보이는 값('true' · 1 · undefined)은 기대한 값이 아니다. CSP 문자열은 빌드 도구(scripts/trayBuild.ts)가 만든 진짜 정책을 쓴다.
// electron 은 import 하지 않는다.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildTrayCsp } from '../../scripts/trayBuild.ts';

const require = createRequire(import.meta.url);
const {
  MIN_SCREENSHOT_COLORS,
  countDistinctColors,
  evaluateCanary,
  evaluateNoNetwork,
  evaluateQuiet,
  evaluateWebPreferences,
  normalizePolicy,
} = require('./smokeChecks.cjs') as typeof import('./smokeChecks.cjs');

const CSP = buildTrayCsp(undefined);
const META = CSP.meta;
const HEADER = CSP.header;
const SUPABASE_CSP = buildTrayCsp('https://abc.supabase.co');

describe('normalizePolicy', () => {
  it('이미 정리된 정책은 그대로다 — meta 판 · header 판 · connect-src 에 출처가 든 판', () => {
    for (const policy of [META, HEADER, SUPABASE_CSP.meta, SUPABASE_CSP.header]) expect(normalizePolicy(policy)).toBe(policy);
  });

  it('공백 차이를 없앤다 — 줄바꿈 · 탭 · 연속 공백 · 앞뒤 공백 · 세미콜론 둘레', () => {
    const variants = [
      META.replace(/; /g, ';\n'),
      META.replace(/; /g, ' ;  '),
      META.replace(/ /g, '\t'),
      META.replace(/ /g, '   '),
      `  ${META}\n`,
      META.replace(/; /g, ';'),
      `\r\n${META.replace(/; /g, ' ;\r\n  ')}\r\n`,
      `${META} `,
    ];
    for (const variant of variants) {
      expect(normalizePolicy(variant)).toBe(META);
      expect(normalizePolicy(normalizePolicy(variant))).toBe(normalizePolicy(variant)); // 거듭 해도 같다
    }
    expect(normalizePolicy(HEADER.replace(/; /g, ';\n'))).toBe(HEADER);
  });

  it('공백만 다룬다 — 글자 · 대소문자 · 지시문 순서는 그대로다', () => {
    expect(normalizePolicy("Default-Src 'none'")).not.toBe(normalizePolicy("default-src 'none'"));
    expect(normalizePolicy("script-src 'self'")).not.toBe(normalizePolicy("script-src'self'"));
    expect(normalizePolicy("a 'self'; b 'none'")).not.toBe(normalizePolicy("b 'none'; a 'self'"));
    expect(normalizePolicy(META)).not.toBe(normalizePolicy(HEADER));
  });

  it('문자열이 아니면 빈 문자열이다', () => {
    for (const value of [undefined, null, 5, {}, []]) expect(normalizePolicy(value as unknown as string)).toBe('');
    expect(normalizePolicy('')).toBe('');
    expect(normalizePolicy(' \n\t ')).toBe('');
  });
});

describe('evaluateWebPreferences', () => {
  const GOOD = {
    preload: 'C:\\Users\\홍 길동\\app\\preload.js',
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    enableBlinkFeatures: '',
    webSecurity: true,
  };

  it('여섯 값이 정확히 기대와 같으면 통과다 — 그 밖의 키는 상관없다', () => {
    const verdict = evaluateWebPreferences(GOOD);
    expect(verdict.ok).toBe(true);
    expect(typeof verdict.detail).toBe('string');
    expect(verdict.detail).not.toBe('');
  });

  it.each<[string, unknown]>([
    ['contextIsolation', false],
    ['contextIsolation', undefined],
    ['contextIsolation', 'true'],
    ['contextIsolation', 1],
    ['sandbox', false],
    ['sandbox', undefined],
    ['sandbox', 'true'],
    ['sandbox', 1],
    ['nodeIntegration', true],
    ['nodeIntegration', undefined],
    ['nodeIntegration', 0],
    ['nodeIntegration', 'false'],
    ['nodeIntegration', null],
    ['allowRunningInsecureContent', true],
    ['allowRunningInsecureContent', undefined],
    ['allowRunningInsecureContent', 0],
    ['experimentalFeatures', true],
    ['experimentalFeatures', undefined],
    ['experimentalFeatures', null],
    ['enableBlinkFeatures', 'CSSContainerQueries'],
    ['enableBlinkFeatures', undefined],
    ['enableBlinkFeatures', null],
    ['enableBlinkFeatures', ' '],
  ])('%s 가 %j 이면 실패하고 그 이름을 detail 에 싣는다', (key, value) => {
    const verdict = evaluateWebPreferences({ ...GOOD, [key]: value });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain(key);
  });

  it('여러 값이 틀리면 모두 detail 에 싣는다', () => {
    const verdict = evaluateWebPreferences({ ...GOOD, sandbox: false, nodeIntegration: true, enableBlinkFeatures: 'X' });
    expect(verdict.ok).toBe(false);
    for (const key of ['sandbox', 'nodeIntegration', 'enableBlinkFeatures']) expect(verdict.detail).toContain(key);
    expect(verdict.detail).not.toContain('contextIsolation');
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['빈 객체', {}],
    ['배열', []],
    ['문자열', 'sandbox'],
    ['숫자', 1],
    ['true', true],
  ])('빈 입력 · 객체가 아닌 입력은 실패다: %s', (_name, prefs) => {
    const verdict = evaluateWebPreferences(prefs);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).not.toBe('');
  });
});

describe('evaluateCanary', () => {
  const CANARY_URL = 'https://example.invalid/tj-csp-canary';
  /** securitypolicyviolation 한 건 — preload 가 옮기는 6필드 모양이다. 기본은 canary fetch 의 meta 정책 위반. */
  function violation(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      blockedURI: CANARY_URL,
      effectiveDirective: 'connect-src',
      originalPolicy: META,
      disposition: 'enforce',
      sourceFile: '',
      lineNumber: 0,
      ...over,
    };
  }
  const metaEvent = (over: Record<string, unknown> = {}) => violation({ originalPolicy: META, ...over });
  const headerEvent = (over: Record<string, unknown> = {}) => violation({ originalPolicy: HEADER, ...over });

  it('meta · header 정책으로 한 건씩 정확히 2건이면 통과다 — 순서는 상관없다', () => {
    expect(evaluateCanary([metaEvent(), headerEvent()], CSP).ok).toBe(true);
    expect(evaluateCanary([headerEvent(), metaEvent()], CSP).ok).toBe(true);
  });

  it('기대 정책은 csp 에서 온다 — Supabase 출처가 든 정책이면 그 정책의 위반이어야 통과다(csp 의 다른 키는 상관없다)', () => {
    const supabaseEvents = [metaEvent({ originalPolicy: SUPABASE_CSP.meta }), headerEvent({ originalPolicy: SUPABASE_CSP.header })];
    expect(evaluateCanary(supabaseEvents, SUPABASE_CSP).ok).toBe(true);
    expect(evaluateCanary(supabaseEvents, CSP).ok).toBe(false); // 출처 없는 정책을 기대하면 다른 정책이다
    expect(evaluateCanary([metaEvent(), headerEvent()], SUPABASE_CSP).ok).toBe(false);
  });

  it('전달된 정책의 공백이 달라도 통과다 — 줄바꿈 · 탭 · 앞뒤 공백', () => {
    const messyMeta = metaEvent({ originalPolicy: META.replace(/; /g, ';\n  ') });
    const messyHeader = headerEvent({ originalPolicy: `  ${HEADER.replace(/ /g, '\t')}\n` });
    expect(evaluateCanary([messyMeta, messyHeader], CSP).ok).toBe(true);
  });

  it('csp 쪽 공백이 달라도 같다(양쪽을 정규화한다)', () => {
    const csp = { meta: META.replace(/; /g, ';\n'), header: HEADER.replace(/; /g, ' ; ') };
    expect(evaluateCanary([metaEvent(), headerEvent()], csp).ok).toBe(true);
  });

  it('위반이 1건이면 실패다 — 두 경로 중 하나만 집행됐다', () => {
    for (const events of [[metaEvent()], [headerEvent()]]) {
      const verdict = evaluateCanary(events, CSP);
      expect(verdict.ok).toBe(false);
      expect(verdict.detail).toContain('1건');
    }
  });

  it('위반이 3건이면 실패다 — 정책이 겹쳐 집행됐다', () => {
    const verdict = evaluateCanary([metaEvent(), headerEvent(), headerEvent()], CSP);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('3건');
  });

  it('정책이 한쪽뿐인 2건은 실패다 — meta 둘 · header 둘', () => {
    const bothMeta = evaluateCanary([metaEvent(), metaEvent()], CSP);
    expect(bothMeta.ok).toBe(false);
    expect(bothMeta.detail).toContain('header');
    const bothHeader = evaluateCanary([headerEvent(), headerEvent()], CSP);
    expect(bothHeader.ok).toBe(false);
    expect(bothHeader.detail).toContain('meta');
  });

  it('두 건 중 하나가 meta · header 어느 쪽도 아닌 정책이면 실패다 — 그 건을 따로 말한다', () => {
    const verdict = evaluateCanary([metaEvent(), violation({ originalPolicy: "default-src 'none'" })], CSP);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('header');
    expect(verdict.detail).toContain('어느 쪽도 아닌 정책의 위반 1건');
  });

  it('위반이 없으면 실패다(빈 입력)', () => {
    const verdict = evaluateCanary([], CSP);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('0건');
  });

  it.each<[string, Record<string, unknown>]>([
    ['호스트가 다르다', { blockedURI: 'https://example.com/tj-csp-canary' }],
    ['다른 호스트의 서브도메인', { blockedURI: 'https://a.example.invalid/tj-csp-canary' }],
    ['example.invalid 로 시작하지만 다른 호스트', { blockedURI: 'https://example.invalid.evil.com/x' }],
    ['example.invalid 로 끝나지만 다른 호스트', { blockedURI: 'https://evil-example.invalid/x' }],
    ['경로에만 example.invalid', { blockedURI: 'https://evil.test/example.invalid' }],
    ['URL 이 아님', { blockedURI: 'inline' }],
    ['blockedURI 없음', { blockedURI: undefined }],
    ['지시문이 connect-src 가 아니다', { effectiveDirective: 'script-src' }],
    ['지시문이 default-src 다', { effectiveDirective: 'default-src' }],
    ['지시문 없음', { effectiveDirective: undefined }],
    ['집행이 아니라 보고 전용이다', { disposition: 'report' }],
    ['disposition 없음', { disposition: undefined }],
  ])('조건이 안 맞는 위반은 canary 로 세지 않는다: %s', (_name, over) => {
    const verdict = evaluateCanary([metaEvent(over), headerEvent()], CSP);
    expect(verdict.ok).toBe(false);
  });

  it('canary 단계에 끼어든 다른 위반이 있으면 실패다 — 위반은 이 둘뿐이어야 한다', () => {
    const stray = violation({ blockedURI: 'inline', effectiveDirective: 'script-src' });
    const verdict = evaluateCanary([metaEvent(), headerEvent(), stray], CSP);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('script-src');
  });

  it('blockedURI 가 포트 · 쿼리가 붙은 example.invalid 여도 호스트로 가른다', () => {
    const events = [
      metaEvent({ blockedURI: 'https://example.invalid:8443/tj-csp-canary?x=1' }),
      headerEvent({ blockedURI: 'HTTPS://EXAMPLE.INVALID/tj-csp-canary' }),
    ];
    expect(evaluateCanary(events, CSP).ok).toBe(true);
  });

  it('위반 항목이 객체가 아니면 실패다', () => {
    for (const bad of [null, 'violation', 7, [], undefined]) {
      expect(evaluateCanary([metaEvent(), headerEvent(), bad], CSP).ok).toBe(false);
      expect(evaluateCanary([metaEvent(), bad], CSP).ok).toBe(false);
    }
  });

  it('originalPolicy 가 문자열이 아니면 그 위반은 어느 정책도 아니다', () => {
    expect(evaluateCanary([metaEvent(), headerEvent({ originalPolicy: undefined })], CSP).ok).toBe(false);
    expect(evaluateCanary([metaEvent(), headerEvent({ originalPolicy: 5 })], CSP).ok).toBe(false);
  });

  it('meta 와 header 가 정규화하면 같은 정책이면 두 경로를 가를 수 없어 실패다', () => {
    const csp = { meta: META, header: `${META}\n` };
    const verdict = evaluateCanary([metaEvent(), headerEvent({ originalPolicy: META })], csp);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('같');
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['빈 객체', {}],
    ['meta 가 빈 문자열', { meta: '', header: HEADER }],
    ['header 가 빈 문자열', { meta: META, header: '' }],
    ['meta 가 없다', { header: HEADER }],
    ['header 가 문자열이 아니다', { meta: META, header: 5 }],
    ['문자열', META],
  ])('csp 가 비었거나 모양이 틀리면 실패다: %s', (_name, csp) => {
    const verdict = evaluateCanary([metaEvent(), headerEvent()], csp);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('csp');
    expect(verdict.detail).toContain('객체가 아니다');
  });

  it('정책이 공백뿐이면 실패다 — 정규화하면 빈 정책이 되는 meta · header', () => {
    for (const csp of [
      { meta: '  ', header: ' \n' },
      { meta: ' ', header: HEADER },
      { meta: META, header: '\t' },
    ]) {
      const verdict = evaluateCanary([metaEvent(), headerEvent()], csp);
      expect(verdict.ok).toBe(false);
      expect(verdict.detail).toContain('공백뿐');
    }
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['객체', { 0: metaEvent(), 1: headerEvent(), length: 2 }],
    ['문자열', 'events'],
    ['숫자', 2],
  ])('events 가 배열이 아니면 실패다: %s', (_name, events) => {
    const verdict = evaluateCanary(events, CSP);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('events');
  });
});

describe('evaluateNoNetwork', () => {
  const PROBE_HTTP = 'https://ci.invalid/tj-connect-probe';
  const PROBE_WSS = 'wss://ci.invalid/tj-connect-probe';

  it('기본 기대 목록은 비어 있다 — 기록 0건이 통과다', () => {
    const verdict = evaluateNoNetwork([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain('0');
    expect(evaluateNoNetwork([], []).ok).toBe(true);
  });

  it('기록이 하나라도 있으면 실패다 — 어떤 주소인지 detail 에 싣는다', () => {
    const verdict = evaluateNoNetwork(['https://abcd.supabase.co/rest/v1/x']);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('https://abcd.supabase.co/rest/v1/x');
  });

  it('기록이 기대 목록과 집합으로 같으면 통과다 — 쿼리 · 해시는 보지 않는다', () => {
    const expected = [PROBE_HTTP, 'wss://abc.supabase.co/realtime/v1/websocket'];
    const records = [`${PROBE_HTTP}?x=1#frag`, 'wss://abc.supabase.co/realtime/v1/websocket?apikey=KEY&vsn=1.0.0'];
    expect(evaluateNoNetwork(records, expected).ok).toBe(true);
  });

  it('같은 요청이 여러 번 기록돼도 집합이 같으면 통과다', () => {
    expect(evaluateNoNetwork([PROBE_HTTP, PROBE_HTTP, PROBE_WSS], [PROBE_HTTP, PROBE_WSS]).ok).toBe(true);
  });

  it('기대한 요청이 빠지면 실패다 — 기대 목록의 일부만 본 가드는 통과가 아니다', () => {
    const verdict = evaluateNoNetwork([PROBE_HTTP], [PROBE_HTTP, PROBE_WSS]);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain(PROBE_WSS);
  });

  it('기록이 0건인데 기대 목록이 있으면 실패다 — 가드가 기대한 요청을 못 봤다', () => {
    const verdict = evaluateNoNetwork([], [PROBE_HTTP, PROBE_WSS]);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain(PROBE_HTTP);
    expect(verdict.detail).toContain(PROBE_WSS);
  });

  it('기대 밖 요청이 끼면 실패다 — 기대한 요청이 다 있어도', () => {
    const verdict = evaluateNoNetwork([PROBE_HTTP, PROBE_WSS, 'https://evil.test/x'], [PROBE_HTTP, PROBE_WSS]);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('https://evil.test/x');
    expect(verdict.detail).not.toContain('tj-connect-probe');
  });

  it('기대 밖 요청과 빠진 요청을 둘 다 이름으로 싣는다', () => {
    const verdict = evaluateNoNetwork(['https://ci.invalid/other'], [PROBE_HTTP]);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('https://ci.invalid/other');
    expect(verdict.detail).toContain(PROBE_HTTP);
  });

  it('키는 프로토콜 + 호스트 + 경로다 — 기본 포트와 대소문자 호스트는 같고, 다른 경로 · 프로토콜 · 포트 · 대소문자 경로는 다르다', () => {
    expect(evaluateNoNetwork(['https://CI.invalid:443/tj-connect-probe'], [PROBE_HTTP]).ok).toBe(true);
    expect(evaluateNoNetwork(['https://user:pw@ci.invalid/tj-connect-probe'], [PROBE_HTTP]).ok).toBe(true);
    expect(evaluateNoNetwork(['https://ci.invalid'], ['https://ci.invalid/']).ok).toBe(true);
    for (const other of [
      'https://ci.invalid/tj-connect-probe/',
      'https://ci.invalid/TJ-CONNECT-PROBE',
      'http://ci.invalid/tj-connect-probe',
      'wss://ci.invalid/tj-connect-probe',
      'https://ci.invalid:8443/tj-connect-probe',
      'https://other.invalid/tj-connect-probe',
    ]) {
      expect(evaluateNoNetwork([other], [PROBE_HTTP]).ok).toBe(false);
    }
  });

  it('app:// 주소도 호스트까지 가른다 — 비특수 스킴의 origin 이 모두 null 이어도 섞이지 않는다', () => {
    expect(evaluateNoNetwork(['app://twelvejanggi/tray.html'], ['app://twelvejanggi/tray.html']).ok).toBe(true);
    expect(evaluateNoNetwork(['app://evil/tray.html'], ['app://twelvejanggi/tray.html']).ok).toBe(false);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['문자열', 'https://x.invalid/'],
    ['객체', { length: 0 }],
    ['숫자', 0],
  ])('records 가 배열이 아니면 실패다(빈 입력): %s', (_name, records) => {
    const verdict = evaluateNoNetwork(records);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('records');
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['숫자', 7],
    ['객체', { url: 'https://x.invalid/' }],
    ['빈 문자열', ''],
    ['URL 이 아닌 글', 'not a url'],
    ['스킴 없는 주소', 'x.invalid/path'],
  ])('기록에 URL 문자열이 아닌 것이 있으면 실패다: %s', (_name, bad) => {
    const verdict = evaluateNoNetwork([PROBE_HTTP, bad], [PROBE_HTTP]);
    expect(verdict.ok).toBe(false);
  });

  it.each<[string, unknown]>([
    ['문자열', PROBE_HTTP],
    ['객체', {}],
    ['null', null],
    ['URL 이 아닌 값이 든 배열', ['not a url']],
    ['숫자가 든 배열', [5]],
  ])('기대 목록이 배열이 아니거나 URL 이 아닌 값이 있으면 실패다: %s', (_name, expected) => {
    expect(evaluateNoNetwork([], expected).ok).toBe(false);
  });
});

describe('evaluateQuiet', () => {
  it('양성 기록이 있고 음성이 0건이면 통과다', () => {
    const verdict = evaluateQuiet({ positiveSeen: true, negatives: [] });
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain('0');
  });

  it('음성이 있으면 실패다 — 건수와 내용을 detail 에 싣는다', () => {
    const verdict = evaluateQuiet({ positiveSeen: true, negatives: ['Electron Security Warning: 연결', { text: '두 번째' }] });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('2건');
    expect(verdict.detail).toContain('Electron Security Warning: 연결');
    expect(verdict.detail).toContain('두 번째');
  });

  it('양성 기록이 없으면 음성이 0건이어도 실패다 — 빈 통과 금지', () => {
    const verdict = evaluateQuiet({ positiveSeen: false, negatives: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('양성');
  });

  it('양성도 없고 음성도 있으면 둘 다 말한다', () => {
    const verdict = evaluateQuiet({ positiveSeen: false, negatives: ['x'] });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('양성');
    expect(verdict.detail).toContain('1건');
  });

  it.each<[string, unknown]>([
    ["문자열 'true'", 'true'],
    ['숫자 1', 1],
    ['undefined', undefined],
    ['null', null],
    ['빈 객체', {}],
  ])('positiveSeen 이 true 가 아니면(%s) 실패다', (_name, positiveSeen) => {
    expect(evaluateQuiet({ positiveSeen, negatives: [] }).ok).toBe(false);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['숫자 0', 0],
    ['문자열', ''],
    ['객체', { length: 0 }],
  ])('negatives 가 배열이 아니면(%s) 실패다 — 음성 0 을 확인하지 못했다', (_name, negatives) => {
    const verdict = evaluateQuiet({ positiveSeen: true, negatives });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('negatives');
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['빈 객체', {}],
    ['배열', []],
    ['문자열', 'ok'],
    ['true', true],
  ])('입력 자체가 비었거나 객체가 아니면(%s) 실패다', (_name, whole) => {
    expect(evaluateQuiet(whole).ok).toBe(false);
  });

  it('음성이 많거나 길어도 detail 은 짧게 줄인다 — 앞 5건만, 한 건은 120자까지', () => {
    const negatives = Array.from({ length: 200 }, (_, i) => `경고 ${i} ${'x'.repeat(400)}`);
    const verdict = evaluateQuiet({ positiveSeen: true, negatives });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('200건');
    expect(verdict.detail).toContain('경고 0 ');
    expect(verdict.detail).toContain('경고 4 ');
    expect(verdict.detail).not.toContain('경고 5 ');
    expect(verdict.detail).toContain('외 195건');
    expect(verdict.detail.length).toBeLessThan(1000);
  });

  it('객체 음성도 줄인다', () => {
    const verdict = evaluateQuiet({ positiveSeen: true, negatives: [{ text: 'y'.repeat(1000) }] });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail.length).toBeLessThan(400);
  });
});

describe('countDistinctColors · MIN_SCREENSHOT_COLORS', () => {
  /** BGRA 비트맵 — 색마다 네 바이트. */
  const bitmapOf = (pixels: Array<[number, number, number, number]>) => Buffer.from(pixels.flat());
  /** 서로 다른 색 n 개(파랑 · 초록 채널이 달라진다 — 한 바이트를 넘는 n 도 겹치지 않는다). */
  const colors = (n: number): Array<[number, number, number, number]> =>
    Array.from({ length: n }, (_, i): [number, number, number, number] => [i % 256, Math.floor(i / 256), 0, 255]);

  it('통과 기준은 8색이다', () => {
    expect(MIN_SCREENSHOT_COLORS).toBe(8);
  });

  it('단색 비트맵은 색 1개다 — 검은 화면은 기준에 못 미친다', () => {
    const black = Buffer.alloc(340 * 400 * 4, 0);
    expect(countDistinctColors(black)).toBe(1);
    expect(countDistinctColors(black)).toBeLessThan(MIN_SCREENSHOT_COLORS);
    const flat = Buffer.alloc(340 * 400 * 4, 0x20);
    expect(countDistinctColors(flat)).toBe(1);
  });

  it('서로 다른 색의 수를 센다 — 같은 색이 되풀이돼도 한 번이다', () => {
    expect(countDistinctColors(bitmapOf([...colors(5), ...colors(5), ...colors(3)]))).toBe(5);
    expect(countDistinctColors(bitmapOf(colors(300)))).toBe(300);
  });

  it('기준 경계 — 7색은 모자라고 8색은 충분하다', () => {
    expect(countDistinctColors(bitmapOf(colors(7)))).toBeLessThan(MIN_SCREENSHOT_COLORS);
    expect(countDistinctColors(bitmapOf(colors(8)))).toBeGreaterThanOrEqual(MIN_SCREENSHOT_COLORS);
  });

  it('네 바이트가 모두 색이다 — 알파만 달라도 다른 색이고, 채널 순서가 달라도 다른 색이다', () => {
    expect(countDistinctColors(bitmapOf([[1, 2, 3, 255], [1, 2, 3, 0]]))).toBe(2);
    expect(countDistinctColors(bitmapOf([[1, 2, 3, 255], [3, 2, 1, 255]]))).toBe(2);
    expect(countDistinctColors(bitmapOf([[1, 2, 3, 255], [1, 2, 3, 255]]))).toBe(1);
  });

  it('픽셀이 되지 못하는 끝 바이트는 무시한다', () => {
    expect(countDistinctColors(Buffer.from([1, 2, 3, 255, 9, 9, 9]))).toBe(1);
    expect(countDistinctColors(Buffer.from([1, 2, 3]))).toBe(0);
  });

  it('빈 입력 · 비트맵이 아닌 입력은 0 이다 — 기준에 못 미쳐 실패한다', () => {
    expect(countDistinctColors(Buffer.alloc(0))).toBe(0);
    for (const bad of [undefined, null, 'abcd', 5, {}, [1, 2, 3, 4]]) expect(countDistinctColors(bad as unknown as Buffer)).toBe(0);
    expect(countDistinctColors(Buffer.alloc(0))).toBeLessThan(MIN_SCREENSHOT_COLORS);
  });

  it('step 은 픽셀 간격이다 — 건너뛴 픽셀의 색은 세지 않는다', () => {
    const alternating = bitmapOf([
      [1, 0, 0, 255],
      [2, 0, 0, 255],
      [1, 0, 0, 255],
      [2, 0, 0, 255],
      [1, 0, 0, 255],
      [2, 0, 0, 255],
    ]);
    expect(countDistinctColors(alternating)).toBe(2);
    expect(countDistinctColors(alternating, 1)).toBe(2);
    expect(countDistinctColors(alternating, 2)).toBe(1); // 0 · 2 · 4번째만
    expect(countDistinctColors(alternating, 3)).toBe(2); // 0 · 3번째
    expect(countDistinctColors(alternating, 100)).toBe(1); // 0번째만
  });

  it.each<[string, unknown]>([
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ["문자열 '2'", '2'],
    ['null', null],
  ])('step 이 1 이상의 정수가 아니면(%s) 모든 픽셀을 센다', (_name, step) => {
    const pixels = bitmapOf([...colors(4)]);
    expect(countDistinctColors(pixels, step as number)).toBe(4);
  });

  it('Buffer 가 큰 풀의 일부(오프셋이 4의 배수가 아님)여도 · Uint8Array 여도 센다', () => {
    const pool = Buffer.alloc(64);
    const view = pool.subarray(5, 5 + 16);
    view.set([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 1, 1, 1, 255]);
    expect(countDistinctColors(view)).toBe(3);
    expect(countDistinctColors(new Uint8Array([1, 1, 1, 255, 2, 2, 2, 255]))).toBe(2);
  });

  it('큰 비트맵도 바로 센다(3배율 창 1020×1200)', () => {
    const big = Buffer.alloc(1020 * 1200 * 4, 0x33);
    big.writeUInt32LE(0xff0000ff, 0);
    expect(countDistinctColors(big)).toBe(2);
  });
});
