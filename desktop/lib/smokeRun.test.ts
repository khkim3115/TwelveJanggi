// desktop/smoke/run.cjs(앱 안 스모크 실행기) 시험 — createSmokeRun 에 구조 타입의 가짜 Electron 객체를 넘겨, main 의 순서(가드 →
// registerIpc → beforeLoad → setTray)로 꽂고 첫 did-finish-load 부터 장벽 → 수동 검사 → 능동 검사 → 장벽 → cspViolations · consoleErrors →
// canary → noNetwork · loginItem → 결과 → 붙은 메뉴 '종료' 까지 실제로 돌린다.
// 앱은 띄우지 않고 electron 은 import · require 하지 않는다(실행기도 하지 않는다 — Electron 객체는 main 이 넘긴다). 실제 바이너리의 판정은
// 스모크가 보고, 여기서는 가짜가 내놓는 사실이 바뀔 때 검사가 판정을 바꾸는지 본다. 음성 사례는 아직 일부 검사에만 있다 —
// webPreferences · sandboxEffective · bridge · ipc · mime · screenshot 은 여기서 양성 갈래만 탄다(webPreferences · screenshot 의 판정 함수
// evaluateWebPreferences · countDistinctColors 는 smokeChecks.test.ts 가 음성까지 본다).
// - 가짜 Electron 장치(rigScenario — 가짜 페이지 · 기본 세션 · 흉내 낸 main · 가짜 렌더러 · 시계)와 사례마다의 준비 · 정리
//   (installRigLifecycle)는 smokeRig.ts 에 있다(#36 T6-8 · T11-5). 사례는 손잡이 하나 — 페이지 처리기(Scenario.page) · main 의 결함
//   (Scenario.main) · 렌더러의 결함(Scenario.renderer) · 갈래 · 로그인 항목 — 를 바꿔 그 검사의 음성 갈래를 탄다(#36 runner-N1 의 tray ·
//   boot · loginItem, 창 검사 theme · opacity).
// - 건강한 흐름은 세 갈래(win32 · darwin · linux)를 호스트와 상관없이 돈다(필수 check 는 ubuntu 에서 Windows 갈래를 덮는다).
// - securityWarnings: 플랫폼마다 다른 켜짐 규칙은 securityWarningsArming 을 바로 불러 본다.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildTrayCsp } from '../../scripts/trayBuild.ts';
import { createFakeLoginItems } from './fakeElectron.ts';
import {
  AI_MS,
  APP_ORIGIN_SLASH,
  APP_VERSION,
  BLOCKED,
  CONNECT_PROBES,
  DEV_BINARY,
  ENABLE,
  MIME_HTML,
  MIME_JS,
  NONCE,
  NOT_RESOLVED,
  OTHER_BINARY,
  RIG_FAKE_TIMERS,
  SETTINGS_URL,
  SMOKE_URL,
  SOCKET_URL,
  SUPABASE_URLS,
  WORKER_SCRIPT,
  canaryLikeChromium,
  checkOf,
  decideLikeMain,
  drive,
  electronNavigate,
  expectOnlyFailure,
  failing,
  healthyPage,
  installRigLifecycle,
  netLikePage,
  probeLikePage,
  rigBase,
  rigScenario,
  runFast,
  runScenario,
  startScenario,
  turns,
  violation,
  type MenuTemplate,
  type Outcome,
  type PageHandler,
  type Scenario,
  type SmokeRun,
} from './smokeRig.ts';

const require = createRequire(import.meta.url);
const { requiredChecks } = require('./smokeResult.cjs') as typeof import('./smokeResult.cjs');
const { AUTOSTART_NAME, loginItemQuery, loginItemSettings } = require('./autostart.cjs') as typeof import('./autostart.cjs');
const { untilAsync } = require('../smoke/support.cjs') as {
  untilAsync(predicate: () => boolean | Promise<boolean>, ms: number, what: string): Promise<boolean>;
};
/** securityWarningsArming 이 읽는 main 의 process 값. */
type Proc = { platform: string; execPath: string; env: Record<string, string | undefined> };
const { securityWarningsArming } = require('../smoke/run.cjs') as {
  securityWarningsArming(proc: Proc): { armed: boolean; detail: string };
};

/** 가드 탐침(가드가 살아 있는지 보는 양성 대조)과 그 상한 — 실행기가 메인 쪽에서 창의 세션으로 보내는 요청. */
const PROBE_URL = 'https://example.invalid/tj-net-guard-probe';
const PROBE_CAP_MS = 5_000;
/** 탐색 검사가 쓰는 허용 목록 주소 — 새 창(저장소)과 메인 프레임 탐색(허브). */
const REPO_URL = 'https://github.com/khkim3115/TwelveJanggi';
const HUB_URL = 'https://khkim3115.github.io/';
/** 격리 world 버퍼를 읽는 코드(브리프의 값 그대로). */
const ISOLATED_CODE = '({ probe: globalThis.__tjIsoProbe, buf: globalThis.__tjCspBuffer })';
/**
 * 실행기가 결과에 싣는 검사(실행 순서) — 창 검사(theme · opacity)는 screenshot 바로 뒤, 조건부 검사(.invalid 빌드의 connectAllowed · --net 의
 * net)는 permissions 뒤에 온다.
 */
const BEFORE_CONDITIONAL = [
  'boot',
  'webPreferences',
  'sandboxEffective',
  'bridge',
  'ipc',
  'mime',
  'securityWarnings',
  'tray',
  'screenshot',
  'theme',
  'opacity',
  'cspMeta',
  'cspHeader',
  'protocol',
  'ai',
  'navigation',
  'permissions',
];
const AFTER_CONDITIONAL = ['cspViolations', 'consoleErrors', 'cspCanary', 'noNetwork', 'loginItem'];
/** 갈래 — 실행기에 넘기는 platform(흉내 낸 main 도 따른다). 호스트 값이 아니다. */
const PLATFORMS = ['win32', 'darwin', 'linux'] as const;
/**
 * 건강한 흐름의 창 기록(흉내 낸 main 이 넘긴 차례) — 시작 표시 → 열기 경로(win32 는 트레이 토글 → 트레이 클릭, 그 밖은 win.close() →
 * 메뉴의 '열기') → win32 는 경합 단계(blur 숨김 → 같은 턴의 클릭 무시 → 경합 시간 뒤 클릭). 그 뒤 검사는 창 기록을 남기지 않는다.
 */
const HEALTHY_WINDOWS: Record<(typeof PLATFORMS)[number], Outcome['windows']> = {
  win32: [
    { action: 'show', reason: 'start' },
    { action: 'hide', reason: 'toggle' },
    { action: 'show', reason: 'tray' },
    { action: 'hide', reason: 'blur' },
    { action: 'show', reason: 'tray' },
  ],
  darwin: [
    { action: 'show', reason: 'start' },
    { action: 'hide', reason: 'close' },
    { action: 'show', reason: 'menu' },
  ],
  linux: [
    { action: 'show', reason: 'start' },
    { action: 'hide', reason: 'close' },
    { action: 'show', reason: 'menu' },
  ],
};

/** tray 가 창을 main 의 길로 보인 채 끝냈다(판정 R13) — 마지막 창 기록이 show 이고, 바로 뒤의 screenshot 이 창을 직접 보이지 않았다. */
function expectEndsShown(outcome: Outcome): void {
  expect(outcome.windows.at(-1)?.action, '마지막 창 기록').toBe('show');
  expect(checkOf(outcome, 'screenshot').detail).not.toContain('보이지 않던 창을 보인 뒤');
}

installRigLifecycle();

describe('전체 흐름 — 필수 검사가 모두 있고 ok 인 성공 결과', () => {
  /** 이 빌드 · --net 의 필수 검사(런처의 규칙) — 결과의 검사 이름 집합이 이것과 같아야 한다. */
  const requiredFor = (build: keyof typeof SUPABASE_URLS, net: boolean): string[] =>
    requiredChecks({ net, supabaseOrigin: buildTrayCsp(SUPABASE_URLS[build]).supabaseOrigin }).sort();

  it("기본 빌드 — 22개가 실행 순서대로 모두 ok · stage · error 없음 · 메모 필드는 ai() 와 canary 전 위반 수 · 붙은 메뉴 '종료' 한 번", async () => {
    const outcome = await runScenario();
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual([...BEFORE_CONDITIONAL, ...AFTER_CONDITIONAL]);
    expect([...outcome.checks.map((entry) => entry.name)].sort()).toStrictEqual(requiredFor('default', false));
    expect(failing(outcome)).toStrictEqual([]);
    expect(Object.keys(outcome.result).filter((key) => key === 'stage' || key === 'error')).toStrictEqual([]);
    expect(outcome.result.nonce).toBe(NONCE);
    expect([...(outcome.result.required as string[])].sort()).toStrictEqual(requiredFor('default', false));
    expect({
      boot: outcome.result.boot,
      cspViolations: outcome.result.cspViolations,
      aiWorker: outcome.result.aiWorker,
      aiAnswered: outcome.result.aiAnswered,
      ms: outcome.result.ms,
    }).toStrictEqual({ boot: true, cspViolations: 0, aiWorker: 'worker', aiAnswered: true, ms: AI_MS });
    expect([outcome.quits, outcome.exits]).toStrictEqual([1, []]);
    // 기본 빌드는 connectProbe · net 을 부르지 않는다 — 원격 요청은 가드 탐침뿐이다
    expect(outcome.pageCalls.filter((name) => name === 'connect-probe' || name === 'net')).toStrictEqual([]);
    expect(checkOf(outcome, 'noNetwork').detail).toContain('기대한 요청 1종만 기록됐다');
  });

  it('격리 world 는 world 999 에서 브리프의 코드로 읽는다 — cspViolations 와 cspCanary 가 한 번씩', async () => {
    const outcome = await runScenario();
    expect(outcome.isolatedCalls).toStrictEqual([
      { worldId: 999, codes: [ISOLATED_CODE] },
      { worldId: 999, codes: [ISOLATED_CODE] },
    ]);
  });

  it('.invalid 빌드 — connectAllowed 까지 23개 ok, noNetwork 는 탐침 + connectProbe 두 주소, consoleErrors 는 취소된 소켓의 오류를 뺀다', async () => {
    const outcome = await runScenario({ build: 'invalid' });
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual([...BEFORE_CONDITIONAL, 'connectAllowed', ...AFTER_CONDITIONAL]);
    expect([...outcome.checks.map((entry) => entry.name)].sort()).toStrictEqual(requiredFor('invalid', false));
    expect(failing(outcome)).toStrictEqual([]);
    expect(checkOf(outcome, 'connectAllowed').detail).toContain(CONNECT_PROBES.join(' · '));
    expect(checkOf(outcome, 'noNetwork').detail).toContain('기대한 요청 3종만 기록됐다');
    expect(checkOf(outcome, 'consoleErrors').detail).toContain('connectProbe 의 취소된 요청 오류 1건은 뺐다');
  });

  it('--net · 실제 값 빌드 — net 까지 23개 ok, noNetwork 는 탐침 + 인증 설정 · Realtime 소켓(가드가 통과시켰다)', async () => {
    const outcome = await runScenario({ build: 'real', net: true });
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual([...BEFORE_CONDITIONAL, 'net', ...AFTER_CONDITIONAL]);
    expect([...outcome.checks.map((entry) => entry.name)].sort()).toStrictEqual(requiredFor('real', true));
    expect(failing(outcome)).toStrictEqual([]);
    expect(checkOf(outcome, 'net').detail).toContain('join "SUBSCRIBED"');
    expect(checkOf(outcome, 'noNetwork').detail).toContain('기대한 요청 3종만 기록됐다');
  });

  it.each(PLATFORMS)(
    "%s — 22개 ok · 최신 메뉴의 '종료' 한 번 · 창은 main 의 길로만 숨고 보였다 · getLoginItemSettings 는 모두 loginItemQuery(갈래) 로 · 원래 setLoginItemSettings 0회 · 테마 네 단계 · 투명도 표",
    async (platform) => {
      const outcome = await runScenario({ platform });
      expect(outcome.checks.map((entry) => entry.name)).toStrictEqual([...BEFORE_CONDITIONAL, ...AFTER_CONDITIONAL]);
      expect(failing(outcome)).toStrictEqual([]);
      expect([outcome.quits, outcome.exits]).toStrictEqual([1, []]);
      expect(outcome.windows).toStrictEqual(HEALTHY_WINDOWS[platform]);
      expect(outcome.loginItemQueries.length).toBeGreaterThanOrEqual(2); // 실행기의 시작 · 끝(win32 는 main 의 메뉴도)
      for (const query of outcome.loginItemQueries) expect(query).toStrictEqual(loginItemQuery(platform));
      expect(outcome.loginItemWrites).toStrictEqual([]);
      const tray = checkOf(outcome, 'tray').detail;
      expect(tray).toContain(platform === 'win32' ? '열기: 트레이 클릭(토글) → 숨김(toggle) → 0.0ms 뒤 트레이 클릭 → 보임 · 포커스' : "열기: win.close() → 숨김(close) → 0.0ms 뒤 메뉴의 '열기' → 보임 · 포커스");
      expect(tray).toContain(platform === 'win32' ? '경합: 표시 350.0ms 뒤 blur → 숨김(blur) → 같은 턴의 트레이 클릭 무시 → 300.0ms 뒤 트레이 클릭 → 보임(tray)' : `경합 단계 건너뜀(${platform}`);
      expect(tray).toContain('아이콘 16×16');
      expect(checkOf(outcome, 'loginItem').detail).toContain(`로그인 항목 요청 기록 ${JSON.stringify(platform === 'win32' ? [{ kind: 'login-item', on: true, managed: false }] : [])}(${platform})`);
      const theme = checkOf(outcome, 'theme').detail;
      expect(theme).toContain(`① setTheme('light') → 스냅샷 · data-theme · tj_theme "light" · body 배경 = --bg = getBackgroundColor() = "rgb(245, 246, 248)"`);
      expect(theme).toContain("③ ① 전의 낡은 메뉴의 '라이트 모드' 체크 false → true(Electron 이 click 전에 뒤집었다)");
      expect(theme).toContain('④');
      expect(checkOf(outcome, 'opacity').detail).toContain('64→64 · 5→30 · 64.4→64 · "70"→64 · NaN→64 · null→64 · 150→100 · 100→100');
      // 창 검사는 페이지에 테마 네 단계 · 투명도 여덟 줄을 묻는다 — screenshot 의 frames 다음, cspMeta 앞이다
      const calls = outcome.pageCalls;
      expect(calls.slice(calls.indexOf('frames') + 1, calls.indexOf('csp-meta'))).toStrictEqual([...Array(4).fill('theme'), ...Array(8).fill('opacity')]);
      expectEndsShown(outcome);
    },
  );
});

describe('boot — 제목 줄의 글자(.tapp-title)가 십이장기다(#36 T10-10)', () => {
  it('제목 줄 안에 버전까지 그렸다 → 실패', async () => {
    const boot = healthyPage({ files: new Map(), unmapped: [] }).boot;
    const outcome = await runScenario({ page: { boot: (arg, app) => ({ ...(boot?.(arg, app) as object), title: `십이장기 ${APP_VERSION}` }) } });
    expectOnlyFailure(outcome, 'boot', [`제목 줄(.tapp-title)이 "십이장기 ${APP_VERSION}" 다(기대 "십이장기")`]);
  });

  it('제목 줄이 없다(null) → 실패', async () => {
    const boot = healthyPage({ files: new Map(), unmapped: [] }).boot;
    const outcome = await runScenario({ page: { boot: (arg, app) => ({ ...(boot?.(arg, app) as object), title: null }) } });
    expectOnlyFailure(outcome, 'boot', ['제목 줄(.tapp-title)이 null 다(기대 "십이장기")']);
  });
});

describe('tray — 최신 메뉴(새 프로필) · main 이 붙인 아이콘 · 열기 경로 · 바깥 클릭과 경합(win32), 끝에는 main 의 길로 보인 채', () => {
  /** 템플릿에서 그 라벨 항목을 고친다. */
  const patchItem =
    (label: string, patch: Record<string, unknown>) =>
    (template: MenuTemplate): MenuTemplate =>
      template.map((entry) => (entry.label === label ? { ...entry, ...patch } : entry));

  it.each(PLATFORMS)("%s — 라벨이 실행기의 글자 목록과 다르다('의견 보내기' 가 빠졌다) → 실패", async (platform) => {
    const outcome = await runScenario({ platform, main: { template: (template) => template.filter((entry) => entry.label !== '의견 보내기') } });
    expectOnlyFailure(outcome, 'tray', ['메뉴 라벨이']);
    expectEndsShown(outcome);
  });

  it("darwin 에 Windows 메뉴('열기' 없음) → 라벨 실패 · 숨긴 창을 열 수 없다 · 끝에도 열지 못했다", async () => {
    const outcome = await runScenario({ platform: 'darwin', main: { template: (template) => template.filter((entry) => entry.label !== '열기') } });
    expectOnlyFailure(outcome, 'tray', ['메뉴 라벨이', "최신 메뉴에 '열기' 가 없다 — 숨긴 창을 main 의 길로 열 수 없다", '끝에 창을 main 의 길로 보인 채 두지 못했다']);
    expect(checkOf(outcome, 'screenshot').detail).toContain('보이지 않던 창을 보인 뒤'); // 뒤의 검사는 그래도 보이는 창에서 돈다
  });

  it.each([`십이장기 ${APP_VERSION}`, '자동 실행', '위치 초기화'])('%s 가 켜졌다 → 실패', async (label) => {
    expectOnlyFailure(await runScenario({ main: { template: patchItem(label, { enabled: true }) } }), 'tray', [`꺼져 있어야 할 항목이 켜졌다: ${label}`]);
  });

  it.each(['자동 실행', '창 고정'])('새 프로필인데 %s 가 체크됐다 → 실패', async (label) => {
    expectOnlyFailure(await runScenario({ main: { template: patchItem(label, { checked: true }) } }), 'tray', [`새 프로필인데 체크된 항목이 있다: ${label}`]);
  });

  it("새 프로필인데 '라이트 모드' 가 체크됐다(늘 체크로 그린다) → tray 실패 — 그 체크를 읽는 theme 도 낡은 메뉴의 전제 · ④ 의 체크 해제에서 잡는다", async () => {
    const outcome = await runScenario({ main: { template: patchItem('라이트 모드', { checked: true }) } });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['tray', 'theme']);
    expect(checkOf(outcome, 'tray').detail).toContain('새 프로필인데 체크된 항목이 있다: 라이트 모드');
    const theme = checkOf(outcome, 'theme').detail;
    expect(theme).toContain("③ ① 전의 메뉴의 '라이트 모드' 가 이미 체크돼 있다(dark 에서 만든 메뉴가 아니다) — 낡은 메뉴 단계를 증명하지 못함");
    expect(theme).toContain("④ 새 메뉴의 '라이트 모드' 체크가 true 다(기대 false)");
    expect([outcome.quits, outcome.exits]).toStrictEqual([1, []]);
  });

  it('아이콘 파일이 없다(빈 이미지) → 실패', async () => {
    expectOnlyFailure(await runScenario({ main: { icon: 'missing' } }), 'tray', ['트레이 아이콘이 빈 이미지다', '트레이 아이콘이 0×0 다(기대 16×16)']);
  });

  it('아이콘을 16×16 으로 줄이지 않았다(원본 64×64) → 실패', async () => {
    const check = expectOnlyFailure(await runScenario({ main: { icon: 'unresized' } }), 'tray', ['트레이 아이콘이 64×64 다(기대 16×16)']);
    expect(check.detail).not.toContain('빈 이미지');
  });

  it.each(PLATFORMS)('%s — 연 창이 포커스를 받지 않는다(main 이 focus 를 부르지 않는다) → 실패', async (platform) => {
    const outcome = await runScenario({ platform, main: { noFocus: true } });
    expectOnlyFailure(outcome, 'tray', ['창이 보이고 포커스를 받지 않았다(보임 true · 포커스 false']);
    expectEndsShown(outcome);
  });

  it('win32 — 토글 숨김에도 경합 가드를 켠다(곧바로 연 클릭을 삼킨다) → 실패, 끝에는 경합 시간 뒤에 main 의 길로 다시 보였다', async () => {
    const outcome = await runScenario({ main: { guardEveryHide: true } });
    expectOnlyFailure(outcome, 'tray', ['숨김(toggle) 기록 0.0ms 뒤의 트레이 클릭 뒤 창이 보이고 포커스를 받지 않았다(보임 false']);
    expect(outcome.windows.map(({ action, reason }) => `${action}:${reason}`)).toStrictEqual(['show:start', 'hide:toggle', 'show:tray']);
    expectEndsShown(outcome);
  });

  it.each([
    ['win32', 'toggle'],
    ['darwin', 'close'],
    ['linux', 'close'],
  ] as const)('%s — 숨김을 다른 이유(request)로 기록한다 → 실패(이유 %s 의 숨김 기록을 받지 못했다)', async (platform, reason) => {
    const outcome = await runScenario({ platform, main: { relabelHide: { [reason]: 'request' } } });
    const how = platform === 'win32' ? '트레이 클릭(토글)' : 'win.close()';
    expectOnlyFailure(outcome, 'tray', [`${how} 뒤 이유 "${reason}" 의 숨김 기록을 받지 못했다(5000ms) — 마지막 창 기록 ["show:start","hide:request"]`]);
    expectEndsShown(outcome);
  });

  it('win32 — 우연한 blur(표시 320ms 뒤 OS 가 포커스를 가져갔다) → 실패(경합 단계를 증명하지 못함), 끝에는 main 의 길로 다시 보였다', async () => {
    const outcome = await runScenario({ main: { strayBlurAfterTrayShow: 320 } });
    expectOnlyFailure(outcome, 'tray', ['우연한 숨김(이유 "blur") — 경합 단계를 증명하지 못함']);
    expect(outcome.windows.map(({ action, reason }) => `${action}:${reason}`)).toStrictEqual(['show:start', 'hide:toggle', 'show:tray', 'hide:blur', 'show:tray']);
    expectEndsShown(outcome);
  });

  it('win32 — 유예 뒤의 blur 가 숨기지 않는다(blur 처리기가 없다) → 실패', async () => {
    const outcome = await runScenario({ main: { ignoreBlur: true } });
    expectOnlyFailure(outcome, 'tray', ['표시 350.0ms 뒤의 blur 가 창을 동기로 숨기지 않았다(기대 숨김 하나 — 이유 "blur") — 새 창 기록 [] · 보임 true']);
    expectEndsShown(outcome);
  });

  it('win32 — 경합 가드가 없다(blur 숨김과 같은 턴의 클릭이 다시 연다) → 실패', async () => {
    const outcome = await runScenario({ main: { noRaceGuard: true } });
    expectOnlyFailure(outcome, 'tray', ['blur 숨김과 같은 턴의 트레이 클릭이 무시되지 않았다(경합 가드) — 새 창 기록 ["show:tray"] · 보임 true']);
    expectEndsShown(outcome);
  });

  it('win32 — 경합 가드가 1초 더 길다(경합 시간 뒤의 클릭도 삼킨다) → 실패, 끝에는 main 의 길로 다시 보였다', async () => {
    const outcome = await runScenario({ main: { longerRace: 1_000 } });
    expectOnlyFailure(outcome, 'tray', ['blur 숨김 300.0ms 뒤의 트레이 클릭이 창을 열지 않았다(기대 보임 — 이유 "tray") — 새 창 기록 [] · 보임 false']);
    expectEndsShown(outcome);
  });
});

describe("theme — ① setTheme('light') ② 'purple' 은 아무것도 바꾸지 않는다 ③ 낡은 메뉴(Electron 이 체크를 먼저 뒤집는다) ④ 최신 메뉴로 dark", () => {
  /** [사례, 시나리오(결함 하나), detail 에 들 글, detail 에 없어야 할 단계] — theme 만 실패한다(다른 검사 · 종료 경로는 그대로). */
  const CASES: Array<[string, Scenario, string[], string[]]> = [
    [
      'main 이 메뉴를 다시 만들지 않는다',
      { main: { themeNoRefresh: true } },
      ['① 새로 전달된 메뉴가 0개다(기대 1개)', '③ 새로 전달된 메뉴가 0개다(기대 1개)', '④ 새로 전달된 메뉴가 0개다(기대 1개)'],
      ['②'],
    ],
    [
      "'라이트 모드' 처리기가 item.checked 대신 상태를 뒤집는다 — ③ 이 잡는다(④ 도 반대로 간다)",
      { main: { lightFlipsState: true } },
      [
        '③ 스냅샷 theme 이 "dark" 다(기대 "light")',
        "③ 새 메뉴의 '라이트 모드' 체크가 false 다(기대 true)",
        '④ 스냅샷 theme 이 "light" 다(기대 "dark")',
        '④ settings.json 의 theme 값을 5000ms 기다렸지만 "light" 다(기대 "dark")',
      ],
      ['①', '②'],
    ],
    [
      "main 이 'purple' 을 받는다 — ② 가 잡는다(메모리 · 페이지가 바뀌고 메뉴를 다시 만들고 tj-theme 를 민다)",
      { main: { themeAcceptsAny: true } },
      ['② 스냅샷 theme 이 "light" 에서 "purple" 로 바뀌었다', '② data-theme 이 "light" 에서 "purple" 로 바뀌었다', '② 새로 전달된 메뉴가 1개다(기대 0개)', '② tj-theme 전달이 1번이다(기대 0번)'],
      ['①', '③', '④'],
    ],
    [
      'main 이 창 배경(setBackgroundColor)을 바꾸지 않는다',
      { main: { themeNoBackground: true } },
      ['① getBackgroundColor() 가 "rgb(13, 17, 23)" 다(기대 "rgb(245, 246, 248)")', '③ getBackgroundColor() 가 "rgb(13, 17, 23)" 다(기대 "rgb(245, 246, 248)")'],
      ['②', '④'],
    ],
    [
      '렌더러가 tj_theme 를 쓰지 않는다',
      { renderer: { noStoreTheme: true } },
      ['① localStorage.tj_theme 이 null 다(기대 "light")', '④ localStorage.tj_theme 이 null 다(기대 "dark")'],
      ['②'],
    ],
    [
      'main 이 저장하지 않는다 → 기다림의 시간 초과를 판정으로 적는다(stage 실패가 아니다)',
      { main: { themeNoSave: true } },
      ['① settings.json 의 theme 값을 5000ms 기다렸지만 "dark" 다(기대 "light")'],
      ['②', '③', '④'],
    ],
    [
      '페이지가 data-theme 을 바꾸지 않는다',
      { renderer: { noDataTheme: true } },
      ['① data-theme 이 "dark" 다(기대 "light")', '① body 배경이 "rgb(13, 17, 23)" 다(기대 "rgb(245, 246, 248)")', '① --bg 가 "rgb(13, 17, 23)" 다(기대 "rgb(245, 246, 248)")'],
      ['②', '④'],
    ],
    [
      "새 메뉴의 '라이트 모드' 가 낡은 값이다(상태를 바꾸기 전에 메뉴를 만든다)",
      { main: { themeRefreshFirst: true } },
      ["① 새 메뉴의 '라이트 모드' 체크가 false 다(기대 true)", "④ 새 메뉴의 '라이트 모드' 체크가 true 다(기대 false)"],
      ['②', '③'],
    ],
    [
      "'라이트 모드' 가 체크박스가 아니다(click 이 checked 를 뒤집지 않는다) — 낡은 메뉴 단계가 Electron 의 뒤집기를 직접 본다",
      { main: { template: (template) => template.map((entry) => (entry.label === '라이트 모드' ? { ...entry, type: 'normal' } : entry)) } },
      ["③ 낡은 메뉴의 '라이트 모드' 를 누른 뒤에도 그 항목의 checked 가 false 다(Electron 이 click 전에 뒤집지 않았다)", '③ 스냅샷 theme 이 "dark" 다(기대 "light")'],
      ['①', '②', '④'],
    ],
  ];
  it.each(CASES)('%s → 실패', async (_label, scenario, fragments, quietSteps) => {
    const check = expectOnlyFailure(await runScenario(scenario), 'theme', fragments);
    // 실패 detail 은 단계 표식으로 시작하는 문제들을 '; ' 로 이은 것이다
    const problems = check.detail.split('; ');
    for (const step of quietSteps) expect(problems.filter((problem) => problem.startsWith(step)), `${step} 단계는 통과한다`).toStrictEqual([]);
  });
});

describe('opacity — 실행기 안의 글자 표(64→64 · 5→30 · 64.4→64 · "70"→64 · NaN→64 · null→64 · 150→100 · 100→100), 어긋난 줄에서 멈춘다', () => {
  /** [사례, 시나리오(결함 하나), detail 에 들 글, detail 에 없어야 할 글] — opacity 만 실패한다. */
  const CASES: Array<[string, Scenario, string[], string[]]> = [
    ["main 이 '70' 을 받는다", { main: { opacityAcceptsString: true } }, ['"70"→64: 스냅샷 opacity 가 70 다(기대 64)', '"70"→64: 창 투명도 round(getOpacity() × 100) 이 70 다(기대 64)'], ['NaN→64']],
    ['main 이 잘못된 값을 기본값으로 바꾼다 — 64 에서 보내므로 무시와 갈린다', { main: { opacityDefaultsInvalid: true } }, ['"70"→64: 스냅샷 opacity 가 100 다(기대 64)'], ['NaN→64']],
    ['main 이 받은 값을 나중에 저장한다(실행기의 기다림보다 늦다)', { main: { opacitySavesLater: true } }, ['64→64: settings.json 의 opacity 값을 5000ms 기다렸지만 100 다(기대 64)'], ['스냅샷', '창 투명도', '5→30']],
    ['main 이 창 투명도(setOpacity)를 바꾸지 않는다 — 스냅샷은 맞고 창은 틀리다', { main: { opacityNoWindow: true } }, ['64→64: 창 투명도 round(getOpacity() × 100) 이 100 다(기대 64)'], ['스냅샷']],
  ];
  it.each(CASES)('%s → 실패', async (_label, scenario, fragments, absent) => {
    const check = expectOnlyFailure(await runScenario(scenario), 'opacity', fragments);
    for (const text of absent) expect(check.detail).not.toContain(text);
  });

  it('NaN 줄에 페이지가 NaN 대신 null 을 보낸다(JSON 으로 넘긴 것과 같다) → 수신 기록으로만 실패 — main 은 둘 다 무시해 스냅샷 · 창은 맞다', async () => {
    const opacity = healthyPage({ files: new Map(), unmapped: [] }).opacity;
    const outcome = await runScenario({ page: { opacity: (arg, app) => opacity?.((arg as { nan?: boolean }).nan === true ? { value: null } : arg, app) } });
    const check = expectOnlyFailure(outcome, 'opacity', ['NaN→64: 실행기의 tj-set-opacity 수신 기록이 [null] 다(기대 ["NaN"])']);
    expect(check.detail).not.toContain('스냅샷');
    expect(check.detail).not.toContain('창 투명도');
  });
});

describe('창 검사의 끝(R13) — theme · opacity 에는 숨김 규칙이 없고, 끝에 창이 숨어 있으면 main 의 길로 다시 보인다(못 보이면 그 검사가 실패한다)', () => {
  it.each(['theme', 'opacity'] as const)('%s 도중 OS 가 포커스를 가져갔다(우연한 blur → 숨김) → ok, 끝에 경합 시간 뒤 트레이 클릭으로 다시 보였다', async (name) => {
    const healthy = healthyPage({ files: new Map(), unmapped: [] })[name];
    let blurred = false;
    const outcome = await runScenario({
      page: {
        [name]: (arg, app) => {
          if (!blurred) {
            blurred = true;
            app.osBlur();
          }
          return healthy?.(arg, app);
        },
      },
    });
    expect(failing(outcome)).toStrictEqual([]);
    expect(outcome.windows.slice(HEALTHY_WINDOWS.win32.length)).toStrictEqual([
      { action: 'hide', reason: 'blur' },
      { action: 'show', reason: 'tray' },
    ]);
    expect(checkOf(outcome, name).detail).toContain('끝에 숨어 있던 창을 main 의 길로 다시 보였다');
    expectEndsShown(outcome);
  });

  /** darwin 메뉴에서 '열기' 를 뺀다 — 숨은 창을 main 의 길로 열 것이 없다(tray 도 실패한다). */
  const NO_OPEN_ITEM: Scenario = { platform: 'darwin', main: { template: (template) => template.filter((entry) => entry.label !== '열기') } };
  /** win32 의 경합 가드가 3초 더 길다 — blur 숨김 뒤의 트레이 클릭을 삼켜, 다시 보이기를 기다리다 시간이 다 된다(tray 의 경합 단계도 실패한다). */
  const LONG_GUARD: Scenario = { main: { longerRace: 3_000 } };
  /** [끝에 다시 보이지 못하는 길, 검사, 시나리오, 이유 조각, 실패하는 검사] */
  const NO_REOPEN: Array<[string, 'theme' | 'opacity', Scenario, string, string[]]> = [
    ["누를 것이 없다(darwin 메뉴에 '열기' 없음)", 'theme', NO_OPEN_ITEM, "최신 메뉴에 '열기' 가 없다", ['tray', 'theme', 'opacity']], // 창이 숨은 채라 opacity 의 끝도 못 연다
    ["누를 것이 없다(darwin 메뉴에 '열기' 없음)", 'opacity', NO_OPEN_ITEM, "최신 메뉴에 '열기' 가 없다", ['tray', 'opacity']],
    ['눌러도 보이지 않는다(win32 경합 가드가 3초 더 길다 — 기다림의 시간 초과)', 'theme', LONG_GUARD, '트레이 클릭 뒤 5000ms 안에 보이지 않았다', ['tray', 'theme']], // opacity 의 끝은 가드가 풀린 뒤라 다시 연다
    ['눌러도 보이지 않는다(win32 경합 가드가 3초 더 길다 — 기다림의 시간 초과)', 'opacity', LONG_GUARD, '트레이 클릭 뒤 5000ms 안에 보이지 않았다', ['tray', 'opacity']],
  ];
  it.each(NO_REOPEN)('%s · %s 도중 우연한 blur → 끝에 창을 다시 보이지 못해 그 검사가 실패한다(R13 · R12 — 숨은 창을 다음 검사로 넘기지 않는다)', async (_path, name, scenario, why, failed) => {
    const healthy = healthyPage({ files: new Map(), unmapped: [] })[name];
    let calls = 0;
    const outcome = await runScenario({
      ...scenario,
      page: {
        [name]: (arg, app) => {
          calls += 1;
          // 그 검사의 둘째 페이지 호출에서 — 첫 단계(줄)의 settings.json 기다림 뒤라 마지막 표시의 유예가 지났다(시작 표시의 유예 안
          // blur 는 숨기지 않는다)
          if (calls === 2) app.osBlur();
          return healthy?.(arg, app);
        },
      },
    });
    expect(failing(outcome).map(([failedName]) => failedName)).toStrictEqual(failed);
    expect(checkOf(outcome, name).detail).toContain(`끝에 창을 main 의 길로 다시 보이지 못했다(${why}`);
    expect([outcome.quits, outcome.exits]).toStrictEqual([1, []]);
  });
});

describe('loginItem(D1) — 대체 함수가 서 있고 쓰기 0회 · 양성 대조(첫 실행 표시 · win32 의 요청 기록 하나) · 환경 전제(시작 · 끝 없음 · 같음)', () => {
  /** '--hidden' 으로 등록된 이 실행의 로그인 항목(Windows 흉내 — 경로는 rig 의 execPath). */
  const registered = (approved: boolean) => ({ name: AUTOSTART_NAME, path: OTHER_BINARY, args: ['--hidden'], approved });

  it('대체 함수가 빠졌다(실행기를 만든 뒤 누가 원래 메서드로 되돌렸다) → 실패', async () => {
    expectOnlyFailure(await runScenario({ unplugBlocker: true }), 'loginItem', ['app.setLoginItemSettings 가 D1 의 대체 함수가 아니다']);
  });

  it('win32 — 가드가 샌다(스모크인데 관리한다고 본다) → 대체 함수가 쓰기 1회를 받아 실패 · 이 PC 의 로그인 항목은 그대로(원래 메서드 0회)', async () => {
    const outcome = await runScenario({ main: { leakLoginItem: true } });
    expectOnlyFailure(outcome, 'loginItem', [`대체 함수가 로그인 항목 쓰기 1회를 받았다(기대 0 — main 의 가드가 샜다): ${JSON.stringify([loginItemSettings('win32', true)])}`]);
    expect(outcome.loginItemWrites).toStrictEqual([]);
  });

  it('첫 실행 표시(autostartDefaultApplied)가 settings.json 에 없다 → 실패', async () => {
    expectOnlyFailure(await runScenario({ main: { noFirstRunFlag: true } }), 'loginItem', ['autostartDefaultApplied 가 false 다(기대 true — 첫 실행 갈래가 돌지 않았다)']);
  });

  it.each([
    ['none', '[]'],
    ['twice', JSON.stringify([0, 1].map(() => ({ kind: 'login-item', on: true, managed: false })))],
  ] as const)('win32 — 로그인 항목 요청 기록이 %s → 실패(정확히 하나여야 한다)', async (loginRecord, seen) => {
    expectOnlyFailure(await runScenario({ main: { loginRecord } }), 'loginItem', [`양성 대조 — 로그인 항목 요청 기록이 ${seen} 다`]);
  });

  it("win32 — '--hidden' 으로 등록 · 승인된 항목이 이미 있다 → 시작 · 끝 openAtLogin true 로 실패(메뉴의 '자동 실행' 도 체크로 보인다)", async () => {
    const outcome = await runScenario({ loginItems: [registered(true)] });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['tray', 'loginItem']);
    const check = checkOf(outcome, 'loginItem');
    expect(check.detail).toContain('환경 전제 — 시작의 openAtLogin 이 true 다');
    expect(check.detail).toContain('환경 전제 — 시작의 executableWillLaunchAtLogin 이 true 다');
    expect(checkOf(outcome, 'tray').detail).toContain('새 프로필인데 체크된 항목이 있다: 자동 실행');
  });

  it("win32 — '--hidden' 으로 등록 · 작업 관리자에서 끔(approved false) → 시작 openAtLogin true 로 실패(인자 없이 읽으면 놓친다)", async () => {
    const outcome = await runScenario({ loginItems: [registered(false)] });
    const check = expectOnlyFailure(outcome, 'loginItem', ['환경 전제 — 시작의 openAtLogin 이 true 다', '환경 전제 — 끝의 openAtLogin 이 true 다']);
    expect(check.detail).not.toContain('executableWillLaunchAtLogin');
    // 대조 — 같은 항목을 인자 없이 물으면 openAtLogin 도 거짓이다(그렇게 읽는 실행기는 통과시켰다)
    expect(createFakeLoginItems([registered(false)]).read(undefined, AUTOSTART_NAME, OTHER_BINARY)).toStrictEqual({ openAtLogin: false, executableWillLaunchAtLogin: false });
  });

  it('darwin — 실행 도중 다른 실행이 같은 경로를 승인된 항목으로 남겼다(openAtLogin 은 그대로 false) → 시작 ≠ 끝으로만 실패', async () => {
    const ai = healthyPage({ files: new Map(), unmapped: [] }).ai;
    const outcome = await runScenario({
      platform: 'darwin',
      page: {
        ai: (arg, app) => {
          app.loginItems.push({ name: '다른 실행', path: OTHER_BINARY, args: [], approved: true });
          return ai?.(arg, app);
        },
      },
    });
    const check = expectOnlyFailure(outcome, 'loginItem', ['환경 전제 — 시작과 끝이 다르다']);
    expect(check.detail).not.toContain('openAtLogin 이');
  });
});

describe('untilAsync — 비동기 predicate 를 ms 까지 기다린다(until 과 같은 모양 — 시간이 다 되면 false 이고 던지지 않는다)', () => {
  /** 가짜 시계에서 work 를 돌려 ms 만큼 민 뒤의 끝(약속이 끝나지 않았으면 'pending'). */
  async function settleOnFakeClock<T>(work: () => Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | 'pending'> {
    vi.useFakeTimers(RIG_FAKE_TIMERS);
    try {
      let outcome: { value: T } | { error: unknown } | 'pending' = 'pending';
      work().then(
        (value) => (outcome = { value }),
        (error: unknown) => (outcome = { error }),
      );
      await vi.advanceTimersByTimeAsync(ms);
      expect(vi.getTimerCount(), '남은 타이머').toBe(0);
      return outcome;
    } finally {
      vi.useRealTimers();
    }
  }

  it('거짓인 동안 다시 보고, 참이 되면 true', async () => {
    let calls = 0;
    const outcome = await settleOnFakeClock(() => untilAsync(async () => (calls += 1) >= 3, 1_000, '셋째'), 1_000);
    expect(outcome).toStrictEqual({ value: true });
    expect(calls).toBe(3);
  });

  it('시간이 다 되면 false — 던지지 않는다', async () => {
    expect(await settleOnFakeClock(() => untilAsync(async () => false, 500, '오지 않는 것'), 600)).toStrictEqual({ value: false });
  });

  it('한 번의 predicate 가 끝나지 않아도 ms 에서 false(기다림이 ms 를 넘지 않는다)', async () => {
    expect(await settleOnFakeClock(() => untilAsync(() => new Promise<boolean>(() => {}), 500, '멈춘 페이지'), 500)).toStrictEqual({ value: false });
  });

  it("predicate 가 거부하거나 던지면 '<what>: <이유>' 로 거부한다(원인은 cause)", async () => {
    const gone = new Error('페이지가 사라졌다');
    const throwing = (): boolean => {
      throw gone;
    };
    for (const predicate of [async () => Promise.reject(gone), throwing]) {
      const outcome = await settleOnFakeClock(() => untilAsync(predicate, 500, 'tapp-hidden 클래스'), 100);
      expect(outcome).toStrictEqual({ error: new Error('tapp-hidden 클래스: 페이지가 사라졌다') });
      expect((outcome as { error: Error }).error.cause).toBe(gone);
    }
  });
});

describe('noNetwork — 가드 탐침은 가드의 기록 + ERR_BLOCKED_BY_CLIENT 거부일 때만 센다', () => {
  it('가드가 기록하고 취소한다 → ok, detail 은 본 거부를 싣는다', async () => {
    const outcome = await runScenario();
    expect(outcome.fetches).toStrictEqual([PROBE_URL]);
    const check = checkOf(outcome, 'noNetwork');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(PROBE_URL);
    expect(check.detail).toContain(JSON.stringify(BLOCKED));
  });

  it('거부의 cause 에 ERR_BLOCKED_BY_CLIENT 가 들어도 취소다(fetch failed + cause 모양)', async () => {
    const check = checkOf(await runScenario({ blocked: () => new TypeError('fetch failed', { cause: new Error(BLOCKED) }) }), 'noNetwork');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(`fetch failed (cause: ${BLOCKED})`);
  });

  /** [사례, 시나리오, detail 에 들 글] — 취소를 증명하지 못한 탐침. detail 은 본 것을 말하고 통과 문장('가드가 기록했고')은 없다. */
  const NOT_CANCELLED: Array<[string, Scenario, string[]]> = [
    ['가드가 기록하고 취소하지 않는다 — .invalid 의 DNS 실패 거부', { guard: 'pass' }, [`거부 ${JSON.stringify(NOT_RESOLVED)} 로 끝났다`, 'ERR_BLOCKED_BY_CLIENT(가드의 취소)가 아니다']],
    ['가드가 기록하고 취소하지 않는다 — 응답을 받았다', { guard: 'pass', network: 'respond' }, ['응답(200)을 받았다 — 가드가 취소하지 않았다']],
    ['가드가 붙지 않았다 — 기록 없음 · DNS 실패 거부', { guard: 'none' }, [`거부 ${JSON.stringify(NOT_RESOLVED)} 로 끝났다`, `기대했지만 기록되지 않은 요청 1종: ${PROBE_URL}`]],
  ];
  it.each(NOT_CANCELLED)('%s → 실패', async (_label, scenario, fragments) => {
    const check = checkOf(await runScenario(scenario), 'noNetwork');
    expect(check.ok, check.detail).toBe(false);
    for (const fragment of fragments) expect(check.detail).toContain(fragment);
    expect(check.detail).not.toContain('가드가 기록했고');
  });

  it('실행기의 가드 없이 다른 무엇이 취소했다(ERR_BLOCKED_BY_CLIENT 이지만 기록 없음) → 실패, 이유는 기록뿐이다', async () => {
    const check = checkOf(await runScenario({ guard: 'foreign' }), 'noNetwork');
    expect(check.ok, check.detail).toBe(false);
    expect(check.detail).toBe(`기대했지만 기록되지 않은 요청 1종: ${PROBE_URL}`);
  });

  it('가드가 기록하고 콜백을 부르지 않는다 → 상한(5초)까지 기다린 뒤 실패, detail 은 끝나지 않았다고 말한다', async () => {
    vi.useFakeTimers(RIG_FAKE_TIMERS);
    try {
      const running = startScenario({ guard: 'hang' });
      await drive(() => running.fetches.length > 0);
      vi.advanceTimersByTime(PROBE_CAP_MS - 1);
      await turns(5);
      expect(running.ended(), '상한 전에는 기다린다').toBe(false);
      vi.advanceTimersByTime(1);
      await drive(running.ended);
      const check = checkOf(await running.finish(), 'noNetwork');
      expect(check.ok, check.detail).toBe(false);
      expect(check.detail).toBe(`가드 탐침이 ${PROBE_CAP_MS}ms 안에 끝나지 않았다(응답 · 거부 없음)`); // 기록은 됐다 — 상한만이 이유다
    } finally {
      vi.useRealTimers();
    }
  });

  it('기대 밖 원격 요청(페이지가 몰래 보낸 것)은 기록되고 취소되고 noNetwork 를 실패시킨다', async () => {
    const outcome = await runScenario({
      page: {
        ai: async (_arg, app) => {
          await app.request('https://example.invalid/tj-sneaky');
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    expectOnlyFailure(outcome, 'noNetwork', ['기대 밖 요청 1종: https://example.invalid/tj-sneaky']);
  });
});

describe('networkGuard — --net 일 때만 Supabase 두 요청(출처 + 경로)을 통과시키고 기록한다', () => {
  /** 가드의 답 — {} 면 통과, { cancel: true } 면 취소. 콜백은 한 번이다. */
  function answers(run: SmokeRun, url: unknown, method: string): unknown[] {
    const responses: unknown[] = [];
    run.networkGuard({ url, method }, (response) => responses.push(response));
    return responses;
  }
  /** [URL, 메서드, 통과하는가] — --net · 실제 값 빌드. */
  const NET_CASES: Array<[string, string, boolean]> = [
    [SETTINGS_URL, 'GET', true],
    [SETTINGS_URL, 'OPTIONS', true], // apikey 머리글이 만드는 CORS 사전 요청
    [`${SETTINGS_URL}?x=1`, 'GET', true], // 쿼리는 보지 않는다
    [SETTINGS_URL, 'POST', false],
    [SOCKET_URL, 'GET', true],
    ['wss://abcd.supabase.co/realtime/v1/websocket', 'GET', true],
    [SOCKET_URL, 'OPTIONS', false],
    [SOCKET_URL, 'POST', false],
    ['https://abcd.supabase.co/auth/v1/token?grant_type=refresh_token', 'POST', false],
    ['https://abcd.supabase.co/auth/v1/signup', 'POST', false],
    ['https://abcd.supabase.co/rest/v1/tj_rooms', 'GET', false],
    ['https://abcd.supabase.co/auth/v1/settings/', 'GET', false], // 경로가 다르다
    ['http://abcd.supabase.co/auth/v1/settings', 'GET', false], // 프로토콜이 다르다
    ['https://abcd.supabase.co:8443/auth/v1/settings', 'GET', false], // 포트가 다르다
    ['https://other.supabase.co/auth/v1/settings', 'GET', false],
    ['ws://abcd.supabase.co/realtime/v1/websocket', 'GET', false],
    ['https://abcd.supabase.co/realtime/v1/websocket', 'GET', false],
    [PROBE_URL, 'GET', false],
  ];
  it.each(NET_CASES)('--net · 실제 값: %s %s → 통과 %s (기록은 늘 한다)', (url, method, passes) => {
    const { run } = rigScenario({ build: 'real', net: true });
    expect(answers(run, url, method)).toStrictEqual([passes ? {} : { cancel: true }]);
  });

  /** --net 이 아니거나 통과시킬 출처가 없는 실행 — 원격은 모두 취소한다. */
  const NO_PASS: Array<[string, Scenario, string]> = [
    ['--net 아님 · 실제 값 빌드', { build: 'real' }, SETTINGS_URL],
    ['--net · 값 없는 빌드', { build: 'default', net: true }, SETTINGS_URL],
    ['--net · .invalid 빌드', { build: 'invalid', net: true }, 'https://ci.invalid/auth/v1/settings'],
  ];
  it.each(NO_PASS)('%s → %s GET 도 취소한다', (_label, scenario, url) => {
    const { run } = rigScenario(scenario);
    expect(answers(run, url, 'GET')).toStrictEqual([{ cancel: true }]);
    expect(answers(run, SOCKET_URL, 'GET')).toStrictEqual([{ cancel: true }]);
  });

  it('원격이 아닌 스킴은 그대로 두고, 이상한 details 에도 콜백을 한 번 부른다', () => {
    const { run } = rigScenario({ build: 'real', net: true });
    expect(answers(run, 'app://twelvejanggi/tray.html', 'GET')).toStrictEqual([{}]);
    expect(answers(run, undefined, 'GET')).toStrictEqual([{}]);
    expect(answers(run, SETTINGS_URL, undefined as unknown as string)).toStrictEqual([{ cancel: true }]);
  });
});

describe('securityWarnings — 경고 검사가 켜졌다는 근거가 있어야 0건이 뜻이 있다', () => {
  it('execPath 가 개발 바이너리 → ok, detail 은 그 근거와 main 의 값으로 추론했다는 말을 싣는다', async () => {
    const check = checkOf(await runScenario({ arming: { execPath: DEV_BINARY } }), 'securityWarnings');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(`경고 검사 켜짐: execPath ${JSON.stringify(DEV_BINARY)} 가`);
    expect(check.detail).toContain('main 프로세스의 값으로 추론했다 — 렌더러에서 본 것이 아니다');
    expect(check.detail).not.toContain(ENABLE);
  });

  it('ELECTRON_ENABLE_SECURITY_WARNINGS=1 → ok, detail 은 그 근거를 싣는다', async () => {
    const check = checkOf(await runScenario({ arming: { execPath: OTHER_BINARY, enable: '1' } }), 'securityWarnings');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(`경고 검사 켜짐: ${ENABLE}="1"(main 프로세스의 값으로 추론했다 — 렌더러에서 본 것이 아니다)`);
    expect(check.detail).not.toContain('execPath');
  });

  it('둘 다 아니다 → 경고 0건이어도 실패(경고 검사가 켜져 있지 않다)', async () => {
    const check = checkOf(await runScenario({ arming: { execPath: OTHER_BINARY } }), 'securityWarnings');
    expect(check.ok, check.detail).toBe(false);
    expect(check.detail.startsWith('경고 검사가 켜져 있지 않다'), check.detail).toBe(true);
  });

  it('켜졌지만 장벽 표식 전에 경고 한 줄 → 실패', async () => {
    const warning = '%cElectron Security Warning (Insecure Content-Security-Policy)';
    const check = checkOf(await runScenario({ warningsBeforeMarker: [warning] }), 'securityWarnings');
    expect(check.ok, check.detail).toBe(false);
    expect(check.detail).toContain(`음성 기록 1건: ${warning}`);
    expect(check.detail).not.toContain('경고 검사가 켜져 있지 않다');
  });
});

describe('securityWarningsArming — main 의 process 값으로 추론하는 켜짐(execPath 는 win32 만 대소문자 무시)', () => {
  /** [사례, 켜짐, main 의 값] */
  const CASES: Array<[string, boolean, Proc]> = [
    ['win32 · electron.exe', true, { platform: 'win32', execPath: 'C:\\홍 길동\\electron.exe', env: {} }],
    ['win32 · 대소문자 무시', true, { platform: 'win32', execPath: 'C:\\홍 길동\\ELECTRON.EXE', env: {} }],
    ['win32 · 패키지 실행 파일', false, { platform: 'win32', execPath: 'C:\\홍 길동\\TwelveJanggi.exe', env: {} }],
    ['win32 · 이름이 electron.exe 로 끝나는 다른 파일', false, { platform: 'win32', execPath: 'C:\\홍 길동\\myelectron.exe', env: {} }],
    ['linux · electron', true, { platform: 'linux', execPath: '/home/홍 길동/electron', env: {} }],
    ['linux · 대소문자를 가린다', false, { platform: 'linux', execPath: '/home/홍 길동/Electron', env: {} }],
    ['env 1', true, { platform: 'linux', execPath: '/usr/bin/node', env: { [ENABLE]: '1' } }],
    ['env 빈 값', false, { platform: 'win32', execPath: 'C:\\nodejs\\node.exe', env: { [ENABLE]: '' } }],
  ];
  it.each(CASES)('%s → 켜짐 %s', (_label, armed, proc) => {
    const arming = securityWarningsArming(proc);
    expect(arming.armed, arming.detail).toBe(armed);
    expect(arming.detail.startsWith(armed ? '경고 검사 켜짐: ' : '경고 검사가 켜져 있지 않다 — '), arming.detail).toBe(true);
    expect(arming.detail).toContain('렌더러에서 본 것이 아니다');
  });

  it('둘 다면 근거를 둘 다 싣는다(env 먼저)', () => {
    const execPath = 'C:\\홍 길동\\electron.exe';
    const { armed, detail } = securityWarningsArming({ platform: 'win32', execPath, env: { [ENABLE]: '1' } });
    expect(armed).toBe(true);
    expect(detail).toBe(`경고 검사 켜짐: ${ENABLE}="1" · execPath ${JSON.stringify(execPath)} 가 electron.exe 로 끝난다(main 프로세스의 값으로 추론했다 — 렌더러에서 본 것이 아니다)`);
  });
});

describe('cspMeta — 문서의 CSP meta 하나(<head>)가 csp.meta 와 같다(공백 정규화)', () => {
  it('공백만 다르면 같다', async () => {
    const outcome = await runScenario({
      page: { 'csp-meta': (_arg, app) => ({ contents: [`  ${app.build.csp.meta.replace(/; /g, ';\n  ')}  `], inHead: [true] }) },
    });
    expect(checkOf(outcome, 'cspMeta').ok).toBe(true);
  });

  /** [사례, 페이지가 본 meta, detail 에 들 글] */
  const CASES: Array<[string, PageHandler, string]> = [
    ['meta 가 둘', (_arg, app) => ({ contents: [app.build.csp.meta, app.build.csp.meta], inHead: [true, true] }), 'CSP meta 가 2개다(1개여야 한다)'],
    ['meta 가 없다', () => ({ contents: [], inHead: [] }), 'CSP meta 가 0개다(1개여야 한다)'],
    ['content 가 다르다', (_arg, app) => ({ contents: [app.build.csp.meta.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")], inHead: [true] }), 'CSP meta 의 content 가 csp.meta 와 다르다'],
    ['<head> 밖', (_arg, app) => ({ contents: [app.build.csp.meta], inHead: [false] }), 'CSP meta 가 <head> 밖에 있다'],
    ['모양이 틀렸다', () => 'meta', '페이지 사실이 { contents, inHead } 가 아니다'],
  ];
  it.each(CASES)('%s → 실패', async (_label, handler, fragment) => {
    expectOnlyFailure(await runScenario({ page: { 'csp-meta': handler } }), 'cspMeta', [fragment]);
  });
});

describe('cspHeader — tray.html 과 AI 워커 스크립트의 응답 헤더: CSP = csp.header · nosniff · 명시 MIME', () => {
  const WORKER_URL = `app://twelvejanggi/${WORKER_SCRIPT}`;

  it('두 응답을 페이지에서 fetch 한다 — tray.html 과 workerScript', async () => {
    const asked: unknown[] = [];
    const outcome = await runScenario({
      page: {
        'csp-header': (arg, app) => {
          asked.push(arg);
          return healthyPage({ files: new Map(), unmapped: [] })['csp-header']?.(arg, app);
        },
      },
    });
    expect(asked).toStrictEqual([['app://twelvejanggi/tray.html', WORKER_URL]]);
    expect(checkOf(outcome, 'cspHeader').ok).toBe(true);
  });

  /** 워커 응답 하나를 바꾼다. */
  const workerResponse =
    (over: Record<string, unknown>): PageHandler =>
    (arg, app) =>
      (arg as string[]).map((url) => ({
        url,
        status: 200,
        csp: app.build.csp.header,
        nosniff: 'nosniff',
        contentType: url.endsWith('.html') ? MIME_HTML : MIME_JS,
        ...(url === WORKER_URL ? over : {}),
      }));
  /** [사례, 페이지 처리기, detail 에 들 글] */
  const CASES: Array<[string, PageHandler, string[]]> = [
    ['워커에 nosniff 가 없다', workerResponse({ nosniff: null }), [`${WORKER_URL}: X-Content-Type-Options 가 null 다(기대 "nosniff")`]],
    ['워커에 CSP 헤더가 없다', workerResponse({ csp: null }), [`${WORKER_URL}: Content-Security-Policy 가 csp.header 와 다르다`]],
    ['워커의 CSP 가 meta 판이다(frame-ancestors 없음)', (arg, app) => workerResponse({ csp: app.build.csp.meta })(arg, app), [`${WORKER_URL}: Content-Security-Policy 가 csp.header 와 다르다`]],
    ['워커의 MIME 이 text/plain', workerResponse({ contentType: 'text/plain; charset=utf-8' }), [`${WORKER_URL}: Content-Type 이 "text/plain; charset=utf-8" 다(기대 "${MIME_JS}")`]],
    ['워커가 404', workerResponse({ status: 404 }), [`${WORKER_URL}: 상태가 404 다(기대 200)`]],
    ['워커 fetch 가 실패했다', workerResponse({ error: 'TypeError: Failed to fetch' }), [`${WORKER_URL}: fetch 가 실패했다`]],
  ];
  it.each(CASES)('%s → 실패', async (_label, handler, fragments) => {
    expectOnlyFailure(await runScenario({ page: { 'csp-header': handler } }), 'cspHeader', fragments);
  });

  it('workerScript 가 null 인 빌드 → 실패(페이지에 묻지 않는다)', async () => {
    const outcome = await runScenario({ workerScript: null });
    expectOnlyFailure(outcome, 'cspHeader', ['workerScript 가 null 이다']);
    expect(outcome.pageCalls).not.toContain('csp-header');
  });
});

describe('protocol — 루트 위 실제 파일을 겨냥한 인코딩 탈출 넷 · 없는 파일 · 디렉터리 · tray-build.json → 404, POST → 405, 다른 호스트 → 404', () => {
  it('페이지가 보낸 요청 — 탈출 넷 · 없는 파일 · 디렉터리 · tray-build.json(GET) · tray.html(POST)', async () => {
    const asked: unknown[] = [];
    const outcome = await runScenario({
      page: {
        protocol: (arg, app) => {
          asked.push(arg);
          return healthyPage({ files: new Map([['tray.html', 'x']]), unmapped: [] }).protocol?.(arg, app);
        },
      },
    });
    expect(asked).toStrictEqual([
      [
        { url: 'app://twelvejanggi/..%2fpackage.json', method: 'GET' },
        { url: 'app://twelvejanggi/%2e%2e%5cpackage.json', method: 'GET' },
        { url: 'app://twelvejanggi/..%5cpackage.json', method: 'GET' },
        { url: 'app://twelvejanggi/%2e%2e%2fpackage.json', method: 'GET' },
        { url: 'app://twelvejanggi/tj-smoke-missing.js', method: 'GET' },
        { url: 'app://twelvejanggi/assets', method: 'GET' },
        { url: 'app://twelvejanggi/tray-build.json', method: 'GET' },
        { url: 'app://twelvejanggi/tray.html', method: 'POST' },
      ],
    ]);
    expect(checkOf(outcome, 'protocol').ok, checkOf(outcome, 'protocol').detail).toBe(true);
  });

  /** 한 요청의 상태만 바꾼다. */
  const statusFor =
    (target: string, method: string, status: number): PageHandler =>
    (arg) =>
      (arg as Array<{ url: string; method: string }>).map((request) => ({
        ...request,
        status: request.url === target && request.method === method ? status : request.method === 'POST' ? 405 : 404,
      }));
  /** [사례, 페이지 처리기, detail 에 들 글] */
  const CASES: Array<[string, PageHandler, string]> = [
    ['%2e%2e%5c 가 루트 위 파일을 내줬다', statusFor('app://twelvejanggi/%2e%2e%5cpackage.json', 'GET', 200), '%2e%2e%5cpackage.json: GET app://twelvejanggi/%2e%2e%5cpackage.json 의 상태가 200 다(기대 404)'],
    ['디렉터리가 200', statusFor('app://twelvejanggi/assets', 'GET', 200), '디렉터리: GET app://twelvejanggi/assets 의 상태가 200 다(기대 404)'],
    ['tray-build.json 을 내줬다', statusFor('app://twelvejanggi/tray-build.json', 'GET', 200), 'tray-build.json: GET app://twelvejanggi/tray-build.json 의 상태가 200 다(기대 404)'],
    ['POST 가 404', statusFor('app://twelvejanggi/tray.html', 'POST', 404), 'POST: POST app://twelvejanggi/tray.html 의 상태가 404 다(기대 405)'],
    ['fetch 가 실패했다', (arg) => (arg as Array<Record<string, unknown>>).map((request) => ({ ...request, error: 'TypeError: Failed to fetch' })), '..%2fpackage.json: GET app://twelvejanggi/..%2fpackage.json 의 상태가 "TypeError: Failed to fetch" 다(기대 404)'],
  ];
  it.each(CASES)('%s → 실패', async (_label, handler, fragment) => {
    expectOnlyFailure(await runScenario({ page: { protocol: handler } }), 'protocol', [fragment]);
  });

  it('메인 net.fetch(app://other/tray.html) 이 200 → 실패', async () => {
    const outcome = await runScenario({ mainFetch: async () => ({ status: 200 }) });
    expectOnlyFailure(outcome, 'protocol', ['메인 net.fetch(app://other/tray.html) 의 상태가 200 다(기대 404)']);
  });

  it('메인 net.fetch 가 거부됐다 → 실패', async () => {
    const outcome = await runScenario({ mainFetch: async () => Promise.reject(new Error('지원하지 않는 스킴')) });
    expectOnlyFailure(outcome, 'protocol', ['메인 net.fetch(app://other/tray.html) 가 거부됐다: 지원하지 않는 스킴']);
  });

  it('루트 바로 위의 package.json 이 없다 → 404 가 아무것도 증명하지 못하므로 실패(탈출 전제)', async () => {
    const outcome = await runScenario({ noParentFile: true });
    expectOnlyFailure(outcome, 'protocol', ['탈출 검사가 겨냥할 파일이 없다', join(rigBase(), 'package.json')]);
  });
});

describe('ai — 모듈 워커가 답했다(aiWorker worker) · 합법 수 · ms', () => {
  /** [사례, ai() 의 답, detail 에 들 글] */
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ['조용한 동기 폴백', { aiWorker: 'fallback', aiAnswered: true, legal: true, ms: 5 }, 'aiWorker 가 "fallback" 다(기대 "worker"'],
    ['답하지 않았다', { aiWorker: 'worker', aiAnswered: false, legal: false, ms: 10_000 }, 'aiAnswered 가 false 다'],
    ['합법 수가 아니다', { aiWorker: 'worker', aiAnswered: true, legal: false, ms: 5 }, 'legal 이 false 다'],
    ['ms 가 숫자가 아니다', { aiWorker: 'worker', aiAnswered: true, legal: true, ms: '5' }, 'ms 가 "5" 다'],
  ];
  it.each(CASES)('%s → 실패, 메모 필드는 ai() 가 낸 값', async (_label, answer, fragment) => {
    const outcome = await runScenario({ page: { ai: () => answer } });
    expectOnlyFailure(outcome, 'ai', [fragment]);
    expect(outcome.result.aiWorker).toBe(answer.aiWorker);
    expect(outcome.result.aiAnswered).toBe(answer.aiAnswered === true);
    expect(outcome.result.ms).toBe(typeof answer.ms === 'number' ? answer.ms : 0);
  });
});

describe('navigation — 새 창은 늘 deny(밖 0회 · 안 1회 열기), 메인 프레임 탐색은 막고 URL 그대로(밖 · 허브 한 번 열기)', () => {
  it('정상 — 열기 기록은 저장소 · 허브 한 번씩, 결정 기록 넷', async () => {
    const check = checkOf(await runScenario(), 'navigation');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain(`${HUB_URL} 를 막고 한 번 열었다`);
  });

  it('Electron 이 막힌 will-frame-navigate 뒤에도 will-navigate 를 낸다 → 허브를 두 번 연다 → 실패', async () => {
    const outcome = await runScenario({
      page: {
        navigate: (arg, app) => {
          electronNavigate(app, String(arg), { alsoWillNavigate: true });
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', [`${HUB_URL} 열기 기록이 2번이다(기대 1번)`]);
  });

  it('막은 탐색이 끝나지 않는다(did-start-navigation 뒤 did-stop-loading 이 없다) → 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({
      page: {
        navigate: (arg, app) => {
          electronNavigate(app, String(arg), { silent: true });
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', [
      'https://example.invalid/: 탐색이 끝나지 않았다(did-start-navigation 뒤 did-stop-loading 을 받지 못했다)',
      `${HUB_URL}: 탐색이 끝나지 않았다(did-start-navigation 뒤 did-stop-loading 을 받지 못했다)`,
    ]);
  });

  it('did-start-navigation 이 없다(탐색이 시작된 기록 없음) → 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({
      page: {
        navigate: (arg, app) => {
          app.guards.willFrameNavigate({ url: String(arg), preventDefault: () => {} });
          setImmediate(() => app.emit('did-stop-loading'));
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', ['https://example.invalid/: did-start-navigation 을 받지 못했다']);
  });

  it('did-stop-loading 이 탐색 시작보다 먼저 왔다(앞 탐색의 것) → 끝으로 세지 않는다', async () => {
    const outcome = await runFast({
      page: {
        navigate: (arg, app) => {
          app.emit('did-stop-loading');
          electronNavigate(app, String(arg), { silent: true });
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', ['https://example.invalid/: 탐색이 끝나지 않았다(did-start-navigation 뒤 did-stop-loading 을 받지 못했다)']);
  });

  it('가드 없이 탐색이 들어갔다 → URL 이 바뀌고 결정 기록이 없다 → 실패', async () => {
    const outcome = await runFast({
      page: {
        navigate: (arg, app) => {
          setImmediate(() => app.commit(String(arg)));
          return true;
        },
      },
    });
    const check = checkOf(outcome, 'navigation');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('https://example.invalid/: will-frame-navigate 차단 기록이 없다');
    expect(check.detail).toContain(`getURL() 이 "${HUB_URL}" 다(기대 ${SMOKE_URL})`);
  });

  it('허용 목록 밖 새 창도 연다(무엇이든 여는 결함 있는 가드) → 실패', async () => {
    const outcome = await runScenario({
      page: {
        'window-open': (arg, app) => {
          const url = String(arg);
          app.record({ kind: 'window-open', url, blocked: true, href: url });
          setImmediate(() => app.open(url));
          return true;
        },
      },
    });
    expectOnlyFailure(outcome, 'navigation', ['허용 목록 밖 https://example.invalid/tj-window-open 를 열었다(1번)']);
  });

  it('새 창이 만들어졌다(window.open 이 null 이 아니다 · deny 기록 없음) → 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({ page: { 'window-open': () => false } });
    expectOnlyFailure(outcome, 'navigation', [
      'window.open(https://example.invalid/tj-window-open) 이 창을 돌려줬다(null 이 아니다)',
      `window.open(${REPO_URL}) 의 deny 기록이 없다`,
      `${REPO_URL} 열기 기록이 0번이다(기대 1번)`,
    ]);
  });
});

describe('permissions — 감싼 처리기의 결정 기록을 기다린 뒤 판정(check: 알림 · 위치 · 클립보드 쓰기, request: 알림 · 위치)', () => {
  it('기록이 페이지의 답보다 늦게 와도 기다린다 → ok', async () => {
    const check = checkOf(await runScenario({ page: { permissions: (_arg, app) => decideLikeMain(app, { later: true }) } }), 'permissions');
    expect(check.ok, check.detail).toBe(true);
  });

  it('위치 권한을 허락했다(처리기 결함) → 실패 — 기록과 페이지 상태 둘 다', async () => {
    const outcome = await runScenario({
      page: {
        permissions: (_arg, app) => {
          app.record({ kind: 'permission-check', permission: 'notifications', url: APP_ORIGIN_SLASH, allowed: true });
          app.record({ kind: 'permission-check', permission: 'geolocation', url: APP_ORIGIN_SLASH, allowed: true });
          app.record({ kind: 'permission-check', permission: 'clipboard-sanitized-write', url: APP_ORIGIN_SLASH, allowed: true });
          app.record({ kind: 'permission-request', permission: 'notifications', url: SMOKE_URL, allowed: true });
          app.record({ kind: 'permission-request', permission: 'geolocation', url: SMOKE_URL, allowed: true });
          return {
            checks: { notifications: 'granted', geolocation: 'granted', clipboardWrite: 'granted' },
            notificationPermission: 'granted',
            requested: 'granted',
            geolocation: 'position',
          };
        },
      },
    });
    expectOnlyFailure(outcome, 'permissions', [
      'permission-check geolocation 결정이 true 다(기대 false)',
      'permission-request geolocation 결정이 true 다(기대 false)',
      '허용 목록 밖 권한을 허락했다',
      'permissions.query(geolocation) 이 "granted" 다(기대 "denied")',
      'getCurrentPosition 이 "position" 다(기대 "error 1")',
    ]);
  });

  it('처리기를 감싸지 않았다(Electron 기본 — 모두 허락 · 기록 없음) → 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({
      page: {
        permissions: () => ({
          checks: { notifications: 'granted', geolocation: 'granted', clipboardWrite: 'granted' },
          notificationPermission: 'granted',
          requested: 'granted',
          geolocation: 'position',
        }),
      },
    });
    expectOnlyFailure(outcome, 'permissions', ['감싼 처리기의 결정 기록이 오지 않았다: permission-check notifications']);
  });
});

describe('cspViolations · consoleErrors — 두 번째 장벽 뒤, canary 단계 전의 위반 · 콘솔', () => {
  it('능동 검사 중 위반 한 건 → cspViolations 만 실패(canary 는 그 단계의 위반만 본다), 메모 cspViolations 1', async () => {
    const outcome = await runScenario({
      page: {
        ai: (_arg, app) => {
          app.violate(violation({ blockedURI: 'app://twelvejanggi/assets/x.js', effectiveDirective: 'worker-src', originalPolicy: app.build.csp.meta }));
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    expectOnlyFailure(outcome, 'cspViolations', ['음성 기록 1건', 'app://twelvejanggi/assets/x.js']);
    expect(outcome.result.cspViolations).toBe(1);
  });

  it("콘솔에 'Content Security Policy' 한 줄(warning) → cspViolations 실패", async () => {
    const message = "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.";
    const outcome = await runScenario({
      page: {
        'csp-meta': (_arg, app) => {
          app.log('warning', message);
          return { contents: [app.build.csp.meta], inHead: [true] };
        },
      },
    });
    expectOnlyFailure(outcome, 'cspViolations', [message]);
  });

  it('preload 가 보냈지만 격리 world 버퍼에 없다(유실) → cspViolations 실패', async () => {
    const outcome = await runScenario({
      page: {
        ai: (_arg, app) => {
          app.violate(violation({ effectiveDirective: 'worker-src', originalPolicy: app.build.csp.meta }), { buffer: false });
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    // canary 단계 뒤의 대조도 같은 유실을 본다
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['cspViolations', 'cspCanary']);
    expect(checkOf(outcome, 'cspViolations').detail).toContain('격리 world 버퍼(0건)가 preload 가 보낸 목록(1건)과 다르다');
  });

  it('격리 world 표식이 없다(다른 world 를 읽었다) → cspViolations · cspCanary 실패', async () => {
    const outcome = await runScenario({ isolated: (buffer) => ({ probe: undefined, buf: [...buffer] }) });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['cspViolations', 'cspCanary']);
    expect(checkOf(outcome, 'cspViolations').detail).toContain('격리 world 표식 __tjIsoProbe 가 undefined 다(기대 1');
  });

  it('능동 검사 중 콘솔 error 한 줄 → consoleErrors 만 실패', async () => {
    const outcome = await runScenario({
      page: {
        ai: (_arg, app) => {
          app.log('error', 'Uncaught TypeError: x is not a function');
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    expectOnlyFailure(outcome, 'consoleErrors', ['음성 기록 1건: Uncaught TypeError: x is not a function']);
  });

  it('기본 빌드에서는 connectProbe 주소를 든 오류도 빼지 않는다 → consoleErrors 실패', async () => {
    const message = `WebSocket connection to '${CONNECT_PROBES[1]}' failed: `;
    const outcome = await runScenario({
      page: {
        ai: (_arg, app) => {
          app.log('error', message);
          return { aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS };
        },
      },
    });
    expectOnlyFailure(outcome, 'consoleErrors', [`음성 기록 1건: ${message}`]);
  });

  it('.invalid 빌드에서도 probe 주소가 없는 오류는 뺄 수 없다 → consoleErrors 실패', async () => {
    const outcome = await runScenario({
      build: 'invalid',
      page: {
        'connect-probe': async (_arg, app) => {
          const answer = await probeLikePage(app);
          app.log('error', 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT');
          return answer;
        },
      },
    });
    expectOnlyFailure(outcome, 'consoleErrors', ['음성 기록 1건: Failed to load resource: net::ERR_BLOCKED_BY_CLIENT']);
  });

  it('능동 검사 뒤 장벽의 표식을 받지 못했다 → 상한까지 기다린 뒤 cspViolations · consoleErrors 실패(양성 기록 없음)', async () => {
    const outcome = await runFast({ barrierMarks: (n) => n !== 2 });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['cspViolations', 'consoleErrors']);
    for (const name of ['cspViolations', 'consoleErrors']) expect(checkOf(outcome, name).detail).toContain('양성 기록이 없다');
  });

  it('canary 뒤 장벽의 표식을 받지 못했다 → cspCanary 실패(그 단계의 콘솔 오류를 다 셌다고 할 수 없다)', async () => {
    const outcome = await runFast({ barrierMarks: (n) => n !== 3 });
    expectOnlyFailure(outcome, 'cspCanary', ['canary 뒤 장벽의 표식을 받지 못했다']);
  });
});

describe('cspCanary — 마지막 단계의 막힌 fetch: 두 전달 경로가 한 건씩 · 그 단계의 콘솔 오류 최대 3건', () => {
  it('정상 — detail 은 두 정책과 콘솔 오류 수를 싣는다', async () => {
    const check = checkOf(await runScenario(), 'cspCanary');
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain('meta · header 정책이 한 건씩 집행됐다');
    expect(check.detail).toContain('이 단계의 콘솔 오류 2건(최대 3건)');
  });

  it('meta 경로만 집행됐다 → 2건을 상한까지 기다린 뒤 실패', async () => {
    const outcome = await runFast({ page: { canary: (_arg, app) => canaryLikeChromium(app, { policies: ['meta'], errors: 1 }) } });
    expectOnlyFailure(outcome, 'cspCanary', ['위반이 정확히 2건이어야 한다: 1건', 'header 정책의 위반이 0건이다(1건이어야 한다)']);
  });

  it('그 단계의 콘솔 오류가 4건 → 실패', async () => {
    const outcome = await runScenario({ page: { canary: (_arg, app) => canaryLikeChromium(app, { errors: 4 }) } });
    expectOnlyFailure(outcome, 'cspCanary', ['이 단계의 콘솔 오류가 4건이다(최대 3건)']);
  });

  it('그 단계에 canary 가 아닌 위반이 끼었다 → 실패', async () => {
    const outcome = await runScenario({
      page: {
        canary: (_arg, app) => {
          app.violate(violation({ blockedURI: 'https://example.invalid/다른', effectiveDirective: 'img-src', originalPolicy: app.build.csp.meta }));
          return canaryLikeChromium(app);
        },
      },
    });
    expectOnlyFailure(outcome, 'cspCanary', ['canary 가 아닌 위반 1건']);
  });
});

describe('connectAllowed — .invalid 빌드: 빌드 출처로 만든 두 주소를 시도 · CSP 위반 0 · 가드가 둘 다 기록하고 취소', () => {
  it('소켓을 시도하지 않았다 → 기록을 상한까지 기다린 뒤 connectAllowed · noNetwork 실패', async () => {
    const outcome = await runFast({ build: 'invalid', page: { 'connect-probe': (_arg, app) => probeLikePage(app, { socket: false }) } });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['connectAllowed', 'noNetwork']);
    const check = checkOf(outcome, 'connectAllowed');
    expect(check.detail).toContain(`attempted ["${CONNECT_PROBES[0]}"] 가 빌드 출처로 만든 ${JSON.stringify(CONNECT_PROBES)} 와 다르다`);
    expect(check.detail).toContain(`기대했지만 기록되지 않은 요청 1종: ${CONNECT_PROBES[1]}`);
  });

  it('페이지가 다른 주소를 시도했다(빌드와 다른 출처) → 실패', async () => {
    const outcome = await runFast({
      build: 'invalid',
      page: {
        'connect-probe': async (_arg, app) => {
          const urls = ['https://other.invalid/tj-connect-probe', 'wss://other.invalid/tj-connect-probe'];
          for (const url of urls) await app.request(url);
          return { attempted: urls };
        },
      },
    });
    const check = checkOf(outcome, 'connectAllowed');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('가 빌드 출처로 만든');
  });

  it('CSP 가 소켓을 막았다(위반 · 요청 없음) → connectAllowed · cspViolations · noNetwork 실패', async () => {
    const outcome = await runFast({
      build: 'invalid',
      page: {
        'connect-probe': async (_arg, app) => {
          const [http = '', ws = ''] = CONNECT_PROBES;
          await app.request(http);
          app.violate(violation({ blockedURI: ws, effectiveDirective: 'connect-src', originalPolicy: app.build.csp.meta }));
          return { attempted: [http, ws] };
        },
      },
    });
    expect(failing(outcome).map(([name]) => name)).toStrictEqual(['connectAllowed', 'cspViolations', 'noNetwork']);
    expect(checkOf(outcome, 'connectAllowed').detail).toContain(`CSP 위반 1건: ${JSON.stringify(CONNECT_PROBES[1])}`);
  });

  it('attempted 가 목록이 아니다 → 실패', async () => {
    const outcome = await runFast({ build: 'invalid', page: { 'connect-probe': () => ({}) } });
    expect(checkOf(outcome, 'connectAllowed').detail).toContain('connectProbe() 의 attempted 가 문자열 목록이 아니다');
  });
});

describe('net — --net: 인증 설정 200 · Realtime 소켓 연결(join 응답은 정보), 값 없는 · .invalid 빌드는 다시 빌드하라는 실패', () => {
  it('설정 GET 이 401 → 실패', async () => {
    const outcome = await runScenario({ build: 'real', net: true, page: { net: (_arg, app) => netLikePage(app, { settingsStatus: 401 }) } });
    expectOnlyFailure(outcome, 'net', ['인증 설정 GET 의 상태가 401 다(기대 200)']);
  });

  it('소켓이 붙지 않았다 → 실패, join 응답은 정보로 싣는다', async () => {
    const outcome = await runScenario({
      build: 'real',
      net: true,
      page: { net: (_arg, app) => netLikePage(app, { realtimeConnected: false, joinStatus: 'TIMED_OUT' }) },
    });
    expectOnlyFailure(outcome, 'net', ['Realtime 소켓이 붙지 않았다', 'join "TIMED_OUT"']);
  });

  it('configured false(페이지 번들에 값이 없다) → 실패', async () => {
    const outcome = await runScenario({
      build: 'real',
      net: true,
      page: { net: () => ({ configured: false, settingsStatus: null, realtimeConnected: false, joinStatus: null, error: null }) },
    });
    const check = checkOf(outcome, 'net');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('configured 가 false 다');
  });

  it('값 없는 빌드 → 다시 빌드하라는 실패, net() 은 부르지 않는다', async () => {
    const outcome = await runScenario({ net: true });
    expectOnlyFailure(outcome, 'net', ['빌드에 Supabase 값이 없다', 'npm run build:tray']);
    expect(outcome.pageCalls).not.toContain('net');
  });

  it('.invalid 빌드 → 다시 빌드하라는 실패(connectAllowed 는 돈다), net() 은 부르지 않는다', async () => {
    const outcome = await runScenario({ build: 'invalid', net: true });
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual([...BEFORE_CONDITIONAL, 'connectAllowed', 'net', ...AFTER_CONDITIONAL]);
    expectOnlyFailure(outcome, 'net', ['CI 의 가짜 값', 'https://ci.invalid', 'npm run build:tray']);
    expect(outcome.pageCalls).not.toContain('net');
  });

  it('net() 이 끝나지 않는다 → 실행기의 상한(30초)에서 check:net 으로 끝난다(감시 타이머 60초 전) · [tj] 한 줄', async () => {
    // 실행기의 fail 은 stderr(fd 2)에 '[tj] …' 를 쓴다 — 모아서 본다(시험 출력에 내보내지 않는다)
    const nodeFs = require('node:fs') as { writeSync: (...args: unknown[]) => unknown };
    const realWriteSync = nodeFs.writeSync;
    const lines: string[] = [];
    nodeFs.writeSync = (fd: unknown, data: unknown, ...rest: unknown[]): unknown => {
      if (fd === 2 && typeof data === 'string' && data.startsWith('[tj] ')) {
        lines.push(data);
        return Buffer.byteLength(data);
      }
      return Reflect.apply(realWriteSync, nodeFs, [fd, data, ...rest]);
    };
    let outcome: Outcome;
    try {
      outcome = await runFast({ build: 'real', net: true, page: { net: () => new Promise(() => {}) } });
    } finally {
      nodeFs.writeSync = realWriteSync;
    }
    expect(outcome.result.stage).toBe('check:net');
    expect(String(outcome.result.error)).toBe('페이지 net(): 30000ms 안에 끝나지 않았다');
    expect(outcome.exits).toStrictEqual([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('[tj] smoke check:net: 페이지 net(): 30000ms 안에 끝나지 않았다'), lines[0]).toBe(true);
    // 실패 결과에도 그때까지의 검사가 실린다 — net 앞의 검사들
    expect(outcome.checks.map((entry) => entry.name)).toStrictEqual(BEFORE_CONDITIONAL);
  });
});
