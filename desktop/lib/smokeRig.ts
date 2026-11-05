// desktop/smoke/run.cjs 시험(smokeRun.test.ts)의 가짜 Electron 장치(#36 T6-8 · T11-5) — createSmokeRun 에 구조 타입의 가짜 Electron 객체를
// 넘겨 main 의 순서(실행기 → 첫 실행 갈래 → 가드 → IPC(main 채널 → registerIpc) → beforeLoad → 트레이(setTray))로 꽂고, 첫 did-finish-load
// 부터 결과 · 최신 메뉴의 '종료' 까지 돌린다. electron 은 import · require 하지 않는다(import type 포함 — 루트 검사는 desktop/node_modules
// 없이 돈다). 이름이 *.test.ts 가 아니어서 vitest 가 시험으로 모으지 않는다. 사례마다의 준비 · 정리는 시험 파일 최상위에서
// installRigLifecycle() 을 한 번 불러 건다.
// - 흉내 낸 main(main.js 의 창 · 트레이 · 첫 실행 갈래 · 테마 · 투명도 · getState) — 실제 lib(windowPolicy · trayMenu · autostart ·
//   pushChannels · theme · opacity, 설정 파일을 쓰는 settings)로 돌고, 창 보이기 · 숨기기 · 렌더러로 민 채널 · 로그인 항목 요청을 실행기의
//   record 로, 만든 메뉴와 아이콘을 setTray 로 넘긴다. 설정 저장은 main 처럼 가짜 시계의 300ms 예약이다(프로필의 settings.json). 메뉴 항목 ·
//   아이콘 · 로그인 항목(Windows 흉내 — approved 포함)은 mainWiring 의 가짜 electron 과 같은 것(fakeElectron.ts 의 fakeMenuItems ·
//   fakeImageFromPath · createFakeLoginItems)을 쓴다. 사례는 Scenario.main 으로 main 의 결함 하나를 고른다.
// - 가짜 렌더러(src/tray/trayState.ts 흉내) — main 이 민 tj-theme 를 <html data-theme> 과 저장값(tj_theme)에, tj-hidden · tj-shown 을 <html>
//   의 tapp-hidden 에 반영한다. 페이지의 테마 · 투명도 처리기는 렌더러의 send 뒤에 main 의 getState 를 부른다(같은 IPC 순서 — 앞의 send 가
//   먼저 처리된다). Esc 는 src/tray/esc.ts 의 처리기 그대로(window 캡처에서 대화상자를 찍고 버블에서 정한다 — 페이지의 #root 리스너는 그
//   사이에 돈다), ✕ 는 tj-hide 다. visibilityState 는 Electron 규칙(한 번 보인 뒤 숨기고 스로틀이 켜져 있을 때만 hidden)으로 계산한다.
//   사례는 Scenario.renderer 로 렌더러의 결함 하나를 고른다.
// - 트레이 창은 파괴할 수 있다(FakeApp.destroyWindow · main 이 close 를 막지 않는 결함) — 그 뒤 창 · webContents 의 멤버는 isDestroyed 말고
//   모두 TypeError('Object has been destroyed') 를 던지고(Electron), 흉내 낸 main 은 파괴된 창을 만지지 않는다(main.js 의 liveWindow).
// - 갈래(Scenario.platform, 기본 win32)는 실행기에 넘기는 platform 과 흉내 낸 main 만 따른다. 그 전부터 있던 검사(ipc · sandboxEffective ·
//   securityWarnings)와 AppInfo.platform 은 호스트 값 그대로다.
// - IPC 가짜는 채널마다 리스너를 여럿 갖고(main 의 처리기 → 실행기의 수신 기록), 렌더러의 send 는 그 채널의 리스너를 모두 부른다.
// - 가짜 페이지는 실행기가 보내는 코드의 태그 주석(smoke/pageScripts.cjs)으로 처리기를 고른다. 기본 처리기는 실제 앱이 낼 사실을 낸다:
//   - 탐색 · 새 창은 main 처럼 lib/navigation.cjs 의 가드를 실행기의 record · open 에 이어 부른다. 탐색은 Electron 44.9.3 의 실제 순서
//     (did-start-navigation → 가드 → did-stop-loading — 막힌 탐색에 did-fail-provisional-load 는 없다)로 사건을 낸다.
//   - 권한은 main 의 처리기처럼 lib/permissions.cjs 로 정하고 기록한다. app:// 응답 상태는 lib/appProtocol.cjs 의 resolveAppRequest 가 정한다.
//   - CSP 위반은 preload 처럼 tj-smoke-csp 로 보내고 격리 world 버퍼(world 999)에도 남긴다.
//   사례는 처리기 하나를 바꿔 그 검사의 음성 갈래를 탄다.
// - 가짜 기본 세션의 fetch 와 페이지의 원격 요청은 Electron 처럼 onBeforeRequest(붙어 있으면)를 먼저 지난다. 탐침은 { cancel: true } 면
//   가드의 취소(net::ERR_BLOCKED_BY_CLIENT)로 거부되고, {} 면 망으로 간다 — .invalid 는 DNS 에서 거부된다(사례가 정하면 응답한다).
// - securityWarnings: 경고 검사의 켜짐은 main 프로세스의 execPath · ELECTRON_ENABLE_SECURITY_WARNINGS 로 추론한다 — 사례마다 정하고
//   afterEach 가 되돌린다.
// - 실행은 가짜 시계(RIG_FAKE_TIMERS — setTimeout · clearTimeout · performance · Date) 위에서 돈다(drive — 몇 바퀴 돌리고 시계를 민다).
//   그래서 상한까지 기다리는 사례도 빨리 끝나고, 실행기의 기다림 · 기록의 at 과 흉내 낸 main 의 유예 · 경합 시각이 모두 같은 시계를
//   따른다(runFast 는 그런 사례라는 표시일 뿐 같은 실행이다).
// - 결과는 mkdtemp(한글 · 공백 이름)의 outDir/result.json 을 읽는다. 실행기의 60초 감시 타이머는 '종료' 와 afterEach 의 will-quit 이 끈다.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { buildTrayBuildInfo, buildTrayCsp } from '../../scripts/trayBuild.ts';
import { createEscHandlers, type EscInput } from '../../src/tray/esc.ts';
import {
  createFakeLoginItems,
  fakeImageFromPath,
  fakeMenuItems,
  type FakeLoginItem,
  type FakePlatform,
  type LoginItemQuery,
  type LoginItemState,
  type LoginItemWrite,
} from './fakeElectron.ts';

const require = createRequire(import.meta.url);
const { RESULT_FILE } = require('./smokeOut.cjs') as typeof import('./smokeOut.cjs');
const { resolveAppRequest } = require('./appProtocol.cjs') as typeof import('./appProtocol.cjs');
const { createNavigationGuards } = require('./navigation.cjs') as typeof import('./navigation.cjs');
const { isPermissionAllowed } = require('./permissions.cjs') as typeof import('./permissions.cjs');
const { AUTOSTART_NAME, autostartChecked, canManageLoginItems, firstRunAutostart, loginItemQuery, loginItemSettings } =
  require('./autostart.cjs') as typeof import('./autostart.cjs');
const { FEEDBACK_URL, WEB_URL } = require('./links.cjs') as typeof import('./links.cjs');
const { DEFAULT_OPACITY, normalizeOpacity } = require('./opacity.cjs') as typeof import('./opacity.cjs');
const { PUSH_CHANNELS, buildSnapshot } = require('./pushChannels.cjs') as typeof import('./pushChannels.cjs');
const { DEFAULT_SETTINGS, SETTINGS_FILE, writeSettings } = require('./settings.cjs') as typeof import('./settings.cjs');
const { THEME_BACKGROUND, normalizeTheme } = require('./theme.cjs') as typeof import('./theme.cjs');
const { buildTrayMenuTemplate } = require('./trayMenu.cjs') as typeof import('./trayMenu.cjs');
const { BLUR_GRACE_MS, deferredBlurAction, shouldHideOnBlur, trayClickAction } = require('./windowPolicy.cjs') as typeof import('./windowPolicy.cjs');

/** 기본 세션의 onBeforeRequest 처리기 — main 이 networkGuard 를 단다. */
type Guard = (details: { url: unknown; method?: unknown }, callback: (response: { cancel?: boolean }) => void) => void;
/** IPC 리스너(createGuardedIpc 의 on 처리기 모양 — 사건 다음에 렌더러가 보낸 값들). */
type IpcListener = (event: unknown, ...payload: unknown[]) => void;
/** 실행기가 main 에 내주는 것 중 이 장치와 시험이 부르는 것 — run.cjs 의 JSDoc 타입(electron 타입)을 끌어오지 않게 구조 타입으로 적는다. */
export type SmokeRun = {
  record(entry: unknown): void;
  open(href: string): void;
  networkGuard: Guard;
  registerIpc(ipc: { on(channel: string, listener: IpcListener): void }): void;
  beforeLoad(win: unknown): void;
  setTray(tray: unknown, menu: unknown, icon: unknown): void;
};
const { createSmokeRun } = require('../smoke/run.cjs') as {
  createSmokeRun(input: Record<string, unknown>): SmokeRun;
};

type Check = { name: string; ok: boolean; detail: string };
type TrayBuild = ReturnType<typeof buildTrayBuildInfo>;
type FileIndex = import('./appProtocol.cjs').FileIndex;
/** preload 가 옮기는 위반 한 건(6필드). */
type Violation = { blockedURI: string; effectiveDirective: string; originalPolicy: string; disposition: string; sourceFile: string; lineNumber: number };

export const NONCE = '논스 시험';
export const APP_VERSION = '0.1.0';
const ELECTRON_VERSION = '44.9.3';
export const SMOKE_URL = 'app://twelvejanggi/tray.html?smoke';
/** check 처리기가 받는 requestingOrigin — 끝 슬래시가 붙은 출처. */
export const APP_ORIGIN_SLASH = 'app://twelvejanggi/';
const RENDERER_PID = 4242;
/** 실행기가 다시 보는 간격 — 가짜 시계를 이만큼씩 민다. */
const POLL_MS = 50;
/**
 * 실행을 돌리는 가짜 시계 — performance 까지 가짜다(판정 R11): 실행기가 기록에 붙이는 at · 시각을 재는 기다림과 흉내 낸 main 의 유예 ·
 * 경합 시각이 같은 시계를 읽는다. 장치를 직접 돌리는 사례(startScenario)도 이것으로 건다.
 */
export const RIG_FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] };
/** 갈래를 고르지 않은 사례 — 트레이 앱이 검증된 Windows 다(경합 단계까지 돈다). 호스트 값을 쓰지 않는다. */
export const DEFAULT_PLATFORM: FakePlatform = 'win32';
/** 흉내 낸 main 이 트레이에 붙이는 아이콘 크기(main.js 의 createTray). */
const TRAY_ICON_SIZE = { width: 16, height: 16 } as const;
/** main 의 저장 예약(main.js 의 SAVE_DELAY_MS — 설계 §5.1) — 가짜 시계에서 돈다. */
const SAVE_DELAY_MS = 300;
/** '받은 값을 나중에 저장' 하는 결함의 예약 — 실행기가 settings.json 을 기다리는 상한(support.cjs 의 WAIT_MS 5초)보다 길다. */
const LATE_SAVE_MS = 10_000;
/**
 * 페이지의 배경 — index.css 의 --bg 토큰과 Chromium 이 계산한 body 배경(getComputedStyle 의 모양). <html data-theme> 이 'light' 면 라이트
 * 토큰이고, 그 밖(없음 · 'dark' · 모르는 이름)은 :root 의 다크 토큰이다.
 */
const PAGE_BACKGROUND = {
  dark: { bgToken: '#0d1117', bodyBackground: 'rgb(13, 17, 23)' },
  light: { bgToken: '#f5f6f8', bodyBackground: 'rgb(245, 246, 248)' },
} as const;
/** Electron 이 가드의 취소로 탐침을 거부할 때의 글(실제 스모크가 본 그대로). */
export const BLOCKED = 'net::ERR_BLOCKED_BY_CLIENT';
export const NOT_RESOLVED = 'net::ERR_NAME_NOT_RESOLVED';
export const ENABLE = 'ELECTRON_ENABLE_SECURITY_WARNINGS';
export const WORKER_SCRIPT = 'assets/ai.worker.js';
export const AI_MS = 37;
export const MIME_HTML = 'text/html; charset=utf-8';
export const MIME_JS = 'text/javascript; charset=utf-8';
const CANARY_URL = 'https://example.invalid/tj-csp-canary';
/** 빌드 — default: Supabase 값 없음 · invalid: CI 의 가짜 값 · real: 실제 값 모양. */
export const SUPABASE_URLS = { default: undefined, invalid: 'https://ci.invalid', real: 'https://abcd.supabase.co' } as const;
export const CONNECT_PROBES = ['https://ci.invalid/tj-connect-probe', 'wss://ci.invalid/tj-connect-probe'];
export const SETTINGS_URL = 'https://abcd.supabase.co/auth/v1/settings';
/** supabase-js 가 여는 Realtime 소켓 — 쿼리(apikey · vsn)가 붙는다. */
export const SOCKET_URL = 'wss://abcd.supabase.co/realtime/v1/websocket?apikey=anon-key&vsn=1.0.0';
/** main 프로세스의 execPath — 이 플랫폼의 개발 바이너리(경고 검사가 켜진다)와 그 밖의 실행 파일(켜지지 않는다). */
export const DEV_BINARY =
  process.platform === 'win32' ? 'D:\\홍 길동\\desktop\\node_modules\\electron\\dist\\electron.exe' : '/home/홍 길동/desktop/node_modules/electron/dist/electron';
export const OTHER_BINARY = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node';

/** 페이지 코드의 태그 주석(smoke/pageScripts.cjs) — 이름과 인자 JSON. 가짜 페이지는 이것으로 코드를 가른다(본문은 해석하지 않는다). */
const TAG_RE = /^\/\* tj-smoke:([\w-]+)(?: (.*?))? \*\/ /s;
/** getLastWebPreferences() — Electron 44.9.3 이 돌려주는 모양(기본값 키를 채운다). */
const WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  enableBlinkFeatures: '',
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  webviewTag: false,
};
/** capturePage() — 서로 다른 색 16개(검은 화면이 아니다). */
const SCREEN = {
  isEmpty: () => false,
  toBitmap: () => Buffer.from(Array.from({ length: 16 * 4 }, (_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) * 16))),
  toPNG: () => Buffer.from('png'),
  getSize: () => ({ width: 4, height: 4 }),
};

/**
 * 가짜 렌더러가 그린 페이지 — <html data-theme> 과 저장값(localStorage.tj_theme, 없으면 null), <html> 의 tapp-hidden(main 이 민 tj-hidden ·
 * tj-shown 을 따른다), 페이지가 넣은 aria-modal 요소가 있는가(escHide 의 대화상자 — 렌더러의 isDialogOpen 이 본다).
 */
export type FakeDom = { dataTheme: string; stored: string | null; hiddenClass: boolean; dialog: boolean };
/** 페이지가 읽는 <html> 의 tapp-hidden 과 document.visibilityState(pageScripts.cjs 의 HIDDEN_STATE_SCRIPT). */
export type HiddenState = { hiddenClass: boolean; visibilityState: 'visible' | 'hidden' };
/** 가짜 앱 — 페이지 처리기가 사실을 낼 때 쓰는 자리(콘솔 · 위반 · 원격 요청 · 탐색 · 결정 기록 · 렌더러의 send · getState). */
export type FakeApp = {
  build: TrayBuild;
  /** main 이 webContents 에 거는 탐색 가드 — 실행기의 record · open 에 잇는다 */
  guards: ReturnType<typeof createNavigationGuards>;
  /** main 의 권한 처리기가 결정마다 부르는 기록기(= 실행기의 record) */
  record(entry: unknown): void;
  /** 허용 목록 주소를 여는 함수(= 실행기의 open — 열지 않고 기록한다) */
  open(href: string): void;
  log(level: 'info' | 'warning' | 'error', message: string): void;
  /** preload 처럼 위반을 tj-smoke-csp 로 보내고 격리 world 버퍼에도 남긴다(buffer false 면 보내기만 한다 — 유실) */
  violate(event: Violation, options?: { buffer?: boolean }): void;
  /** 페이지의 원격 요청 — onBeforeRequest(붙어 있으면)를 지난다. 가드가 정한 처리를 돌려준다 */
  request(url: string, method?: string): Promise<'cancelled' | 'passed'>;
  /** 트레이 창의 webContents 사건을 낸다(did-start-navigation · did-stop-loading …) */
  emit(event: string, ...args: unknown[]): void;
  commit(url: string): void;
  url(): string;
  /** 렌더러의 send — 그 채널의 리스너(main 의 처리기 → 실행기의 수신 기록)를 모두 부른다 */
  send(channel: string, ...payload: unknown[]): void;
  /** 렌더러의 getState()(invoke tj-get-state) — main 메모리의 스냅샷. 앞의 send 를 main 이 먼저 처리했다(같은 IPC 순서) */
  getState(): unknown;
  /** 가짜 렌더러가 그린 페이지 — main 이 민 tj-theme · tj-hidden · tj-shown 을 반영한다(Scenario.renderer 의 결함이 없으면) */
  dom: FakeDom;
  /**
   * 페이지가 만든 Escape keydown 을 #root 안 요소에서 보낸다 — window 캡처(렌더러의 Esc 처리기) → #root 버블(rootListener — 페이지가 단 것) →
   * window 버블(렌더러 — 여기서 숨길지 정한다)
   */
  pressEscape(rootListener?: () => void): void;
  /** 진짜 ✕(button[aria-label="숨기기"]) 를 누른다 — 렌더러의 onClick(tjDesktop.hide → tj-hide) */
  pressHideButton(): void;
  /** 지금의 <html> tapp-hidden 과 visibilityState */
  hiddenState(): HiddenState;
  /** OS 가 창의 포커스를 가져간다(우연한 blur — 실행기가 일으키지 않은 숨김의 시작) */
  osBlur(): void;
  /** 트레이 창을 파괴한다(시험 손잡이) — 그 뒤 창 · webContents 의 멤버는 isDestroyed 말고 모두 던진다 */
  destroyWindow(): void;
  /** 이 PC 의 로그인 항목(Windows 흉내) — 실행 도중에 바꾸면 다른 프로그램 · 작업 관리자가 바꾼 것이다 */
  loginItems: FakeLoginItem[];
};
export type PageHandler = (arg: unknown, app: FakeApp) => unknown;
/** 트레이 메뉴 템플릿(trayMenu.cjs 의 buildTrayMenuTemplate 이 돌려주는 모양). */
export type MenuTemplate = Array<Record<string, unknown>>;
/** main 의 숨김 이유(main.js 의 HideReason). */
type HideReason = 'blur' | 'request' | 'close' | 'toggle' | 'menu';
/** 설정의 테마(settings.cjs 의 Settings.theme). */
type Theme = 'dark' | 'light';

/** 흉내 낸 main 의 결함 하나(사례가 고른다 — 그 검사의 음성 갈래). 주지 않은 것은 main.js 와 같다. */
export type MainFlaw = {
  /** 메뉴 템플릿을 고친다(trayMenu.cjs 가 만든 것 → 붙일 것) */
  template?: (template: MenuTemplate) => MenuTemplate;
  /** 트레이 아이콘 — missing: 파일이 없다(빈 이미지) · unresized: 16×16 으로 줄이지 않았다(원본 64×64) */
  icon?: 'missing' | 'unresized';
  /** showWindow 가 focus() 를 부르지 않는다 */
  noFocus?: boolean;
  /** 숨김을 다른 이유로 기록한다(실제 이유 → 기록하는 이유). 동작은 실제 이유를 따른다 */
  relabelHide?: Partial<Record<HideReason, string>>;
  /** 모든 숨김의 시각을 경합 가드에 남긴다(blur 숨김만 남겨야 한다 — 토글 · 닫기 직후의 클릭을 삼킨다) */
  guardEveryHide?: boolean;
  /** tj-hide(Esc · ✕) 숨김의 시각도 경합 가드에 남긴다 — 그 숨김 직후의 트레이 클릭을 삼킨다(토글 · 닫기는 그대로) */
  guardRequestHide?: boolean;
  /** 창이 숨어도 렌더러에 tj-hidden 을 밀지 않는다 */
  noHiddenPush?: boolean;
  /** 창이 보여도 렌더러에 tj-shown 을 밀지 않는다 */
  noShownPush?: boolean;
  /** close 를 막지 않는다 — win.close()(OS 닫기)가 창을 숨기지 않고 파괴한다 */
  closeDestroys?: boolean;
  /** close 를 막기만 하고 숨기지 않는다 — win.close() 가 아무것도 하지 않는다 */
  closeIgnored?: boolean;
  /** 경합 가드가 없다 — 트레이 클릭은 보이면 숨기고 아니면 보인다 */
  noRaceGuard?: boolean;
  /** 경합 가드를 이만큼(ms) 더 오래 건다 */
  longerRace?: number;
  /** blur 처리기가 아무것도 하지 않는다(바깥 클릭으로 숨지 않는다) */
  ignoreBlur?: boolean;
  /** 처음 'tray' 로 보인 뒤 이 시간(ms)에 OS 가 포커스를 가져간다(우연한 blur) */
  strayBlurAfterTrayShow?: number;
  /** 로그인 항목 요청의 기록 — none: 남기지 않는다 · twice: 두 번 남긴다(요청 한 번에) */
  loginRecord?: 'none' | 'twice';
  /** 첫 실행 표시(autostartDefaultApplied)를 켜지 않고 설정 파일을 쓴다 */
  noFirstRunFlag?: boolean;
  /** 로그인 항목 가드가 샌다 — 스모크인데 관리한다고 보고 app.setLoginItemSettings 를 부른다(메뉴의 '자동 실행' 켜짐은 그대로) */
  leakLoginItem?: boolean;
  /** 테마를 바꿔도(IPC · 메뉴의 '라이트 모드') 메뉴를 다시 만들지 않는다 */
  themeNoRefresh?: boolean;
  /** 테마 상태를 바꾸기 전에 메뉴를 다시 만든다 — 새 메뉴의 '라이트 모드' 가 낡은 값이다 */
  themeRefreshFirst?: boolean;
  /** 메뉴의 '라이트 모드' 처리기가 item.checked 대신 지금 상태를 뒤집는다 — 낡은 메뉴의 클릭이 사용자가 본 것과 반대로 간다 */
  lightFlipsState?: boolean;
  /**
   * normalizeTheme 을 거치지 않는다 — 'purple' 같은 글도 상태 · 렌더러 · 메뉴 · 저장에 쓴다. 창 배경은 표에 있는 이름일 때만 바꾼다
   * (Electron 의 setBackgroundColor 는 색이 아닌 값에 던진다 — 이 결함은 던지지 않는 쪽이다)
   */
  themeAcceptsAny?: boolean;
  /** 테마를 바꿔도 창 배경(setBackgroundColor)을 그대로 둔다 */
  themeNoBackground?: boolean;
  /** 테마를 바꿔도 저장을 예약하지 않는다 */
  themeNoSave?: boolean;
  /** 투명도에 숫자 글('70')도 받는다(Number 로 바꾼 뒤 거른다) */
  opacityAcceptsString?: boolean;
  /** 받지 않는 투명도를 무시하지 않고 기본값(100)으로 바꾼다 */
  opacityDefaultsInvalid?: boolean;
  /** 받은 투명도를 나중에 저장한다 — 저장 예약(LATE_SAVE_MS)이 실행기의 기다림보다 길다 */
  opacitySavesLater?: boolean;
  /** 투명도를 바꿔도 창(setOpacity)은 그대로 둔다 — 스냅샷은 맞고 창은 틀리다 */
  opacityNoWindow?: boolean;
};

/**
 * 가짜 렌더러의 결함 하나(사례가 고른다). 주지 않은 것은 src/tray 와 같다 — 받은 테마를 data-theme · 저장값에, tj-hidden · tj-shown 을
 * tapp-hidden 에 반영하고(trayState.ts), Esc 는 esc.ts 의 캡처 · 버블 처리기, ✕ 는 tjDesktop.hide() 다(TrayApp.tsx).
 */
export type RendererFlaw = {
  /** 받은 테마를 저장값(localStorage.tj_theme)에 쓰지 않는다 — 처음 스냅샷 때도 */
  noStoreTheme?: boolean;
  /** 받은 테마로 <html data-theme> 을 바꾸지 않는다(첫 페인트의 dark 그대로) */
  noDataTheme?: boolean;
  /** Esc 처리기가 없다(window 에 keydown 리스너를 걸지 않았다) */
  noEsc?: boolean;
  /**
   * Esc 의 캡처 리스너가 없다 — 버블 단계에서 그때의 isDialogOpen() 으로 정한다(같은 Esc 로 먼저 닫힌 대화상자 때문에 창까지 숨는다 — 등록
   * 순서 의존)
   */
  escNoCapture?: boolean;
  /** ✕ 단추에 처리기가 없다(눌러도 tj-hide 를 보내지 않는다) */
  noHideButton?: boolean;
  /** <html> 의 tapp-hidden 을 tj-hidden · tj-shown 이 아니라 visibilitychange(document.visibilityState)로 바꾼다 */
  visibilityDriven?: boolean;
  /** tj-shown 을 받아도 tapp-hidden 을 빼지 않는다 */
  keepHiddenClass?: boolean;
};

export type Scenario = {
  /**
   * 기본 세션의 onBeforeRequest — run: 실행기의 가드 그대로(기록 · 취소) · pass: 실행기가 기록한 뒤 {} 로 통과시킨다 ·
   * hang: 실행기가 기록한 뒤 콜백을 부르지 않는다 · foreign: 실행기의 가드 없이 취소만 한다(기록 없음) · none: 붙이지 않는다. 기본 run
   */
  guard?: 'run' | 'pass' | 'hang' | 'foreign' | 'none';
  /** 가드를 지난 탐침의 끝 — unresolved: DNS 실패(.invalid) · respond: 200 응답. 기본 unresolved */
  network?: 'unresolved' | 'respond';
  /** 가드가 취소한 탐침의 거부 — 기본 new Error(BLOCKED) */
  blocked?: () => unknown;
  /** 첫 장벽 표식보다 먼저 오는 콘솔 줄(warning) */
  warningsBeforeMarker?: readonly string[];
  /** n 번째 장벽(1부터)이 표식을 콘솔에 찍는가 — 기본 늘 찍는다 */
  barrierMarks?: (n: number) => boolean;
  /** main 프로세스의 execPath · ELECTRON_ENABLE_SECURITY_WARNINGS(없으면 지운다). 기본은 런처처럼 env 로 켠다 */
  arming?: { execPath: string; enable?: string };
  /** tray-build.json 의 Supabase 값 — 기본 default */
  build?: keyof typeof SUPABASE_URLS;
  /** --net. 기본 false */
  net?: boolean;
  /** tray-build.json 의 workerScript. 기본 WORKER_SCRIPT */
  workerScript?: string | null;
  /** 페이지 처리기 바꾸기(태그 → 처리기) — 그 검사의 음성 갈래 */
  page?: Partial<Record<string, PageHandler>>;
  /** 격리 world 의 답 — 기본은 preload 처럼 world 999 에서만 { probe: 1, buf: 버퍼 } */
  isolated?: (buffer: readonly Violation[]) => unknown;
  /** main 의 net.fetch(app://…) 답 — 기본은 resolveAppRequest 의 상태 */
  mainFetch?: (url: string) => Promise<{ status: number }>;
  /** 렌더러 루트 바로 위의 package.json 을 깔지 않는다(탈출 검사의 전제가 깨진다) */
  noParentFile?: boolean;
  /** 갈래 — 실행기에 넘기는 platform 과 흉내 낸 main 이 따른다. 기본 DEFAULT_PLATFORM(win32) */
  platform?: FakePlatform;
  /** 시작 때 이 PC 에 있는 로그인 항목(Windows 흉내) — 기본 없음 */
  loginItems?: readonly FakeLoginItem[];
  /** 흉내 낸 main 의 결함 하나 */
  main?: MainFlaw;
  /** 가짜 렌더러의 결함 하나 */
  renderer?: RendererFlaw;
  /**
   * 트레이 창 webContents 의 스로틀(기본은 Electron 처럼 켜진 채 시작하고 setBackgroundThrottling 을 따른다) — sticky: 한 번 끄면
   * setBackgroundThrottling(true) 가 듣지 않는다(끈 스로틀이 돌아오지 않는다) · ignored: setBackgroundThrottling(false) 가 듣지 않는다(숨긴 창이
   * hidden 이 된다) · off: 꺼진 채 시작한다(main 이 setThrottling(false) 를 부른 것과 같다 — #21 에는 부르는 곳이 없다)
   */
  throttle?: 'sticky' | 'ignored' | 'off';
  /** 실행기를 만든 뒤 app.setLoginItemSettings 를 원래 메서드로 되돌린다(누군가 D1 의 대체 함수를 다시 바꿔 끼웠다) */
  unplugBlocker?: boolean;
};
export type Outcome = {
  result: Record<string, unknown>;
  checks: Check[];
  fetches: string[];
  quits: number;
  exits: number[];
  /** 가짜 페이지가 받은 코드의 태그(순서대로) */
  pageCalls: string[];
  isolatedCalls: Array<{ worldId: number; codes: string[] }>;
  /** 흉내 낸 main 이 실행기에 넘긴 창 기록(차례대로 — 기록한 이유) */
  windows: Array<{ action: 'show' | 'hide'; reason: string }>;
  /** getLoginItemSettings 가 받은 인자(main · 실행기 모두, 차례대로 — 인자 없이 부르면 undefined) */
  loginItemQueries: unknown[];
  /** 원래 app.setLoginItemSettings 가 받은 인자 — 이 PC 의 로그인 항목 쓰기다(D1 이 막으면 비었다) */
  loginItemWrites: unknown[];
  /** 끝난 때 트레이 창 webContents 의 스로틀(getBackgroundThrottling) — 창이 파괴됐으면 null */
  throttling: boolean | null;
  /**
   * capturePage() 를 부를 때마다 그때 창이 보였는가(차례대로) — 숨긴 창을 캡처하면 페이지가 visible 로 바뀌어 visibility ② 의 양성 기록을
   * 흐린다(설계 §5.5 '숨긴 동안 capturePage 를 하지 않는다')
   */
  captures: boolean[];
};
type Running = { fetches: string[]; ended(): boolean; finish(): Promise<Outcome> };
type Rig = { run: SmokeRun; start(): Running };

/** 이번 사례의 mkdtemp 폴더 — 사례 밖(설치 전 · 사례 사이)에는 '' 다. 읽기는 rigBase() 로만 한다(사례 밖이면 던진다). */
let base = '';
let restoreProcess = (): void => {};
/** 이번 사례의 실행기에 will-quit 을 낸다 — 감시 타이머가 남았으면 끈다. */
let quitApp: (() => void) | null = null;

/**
 * 사례마다의 준비 · 정리 — mkdtemp 폴더, main 의 process 값(execPath · ELECTRON_ENABLE_SECURITY_WARNINGS), 실행기의 will-quit.
 * 시험 파일 최상위에서 한 번 부른다(beforeEach · afterEach 가 그 파일의 모든 사례에 걸린다).
 */
export function installRigLifecycle(): void {
  beforeEach(() => {
    // 임시 폴더의 실제 경로 아래에 만든다 — windows-latest 러너의 TEMP 는 8.3 짧은 이름(RUNNER~1)이라 경로를 견주는 사례가 다른 글자를 본다
    base = mkdtempSync(join(realpathSync.native(tmpdir()), 'tj-실행기 '));
    const execPath = process.execPath;
    const enable = process.env[ENABLE];
    restoreProcess = () => {
      process.execPath = execPath;
      if (enable === undefined) delete process.env[ENABLE];
      else process.env[ENABLE] = enable;
    };
  });

  afterEach(() => {
    // base 부터 비운다 — 뒤의 단계가 던져도 사례 밖의 rig 사용은 rigBase() 가 막는다
    const laid = base;
    base = '';
    vi.useRealTimers();
    quitApp?.();
    quitApp = null;
    restoreProcess();
    if (laid !== '') rmSync(laid, { recursive: true, force: true }); // mkdtemp 가 던진 사례에는 지울 폴더가 없다
  });
}

/**
 * 이번 사례의 mkdtemp 폴더 — rigScenario 가 앱 폴더 · 렌더러 루트 · outDir 을 이 안에 깐다(사례가 기대값으로 읽는다).
 * 사례 밖(installRigLifecycle() 호출이 없거나 사례 사이)에는 던진다 — 빈 base 로 깔면 경로가 모두 cwd 기준이 되어 저장소에 쓴다.
 */
export function rigBase(): string {
  if (base === '') throw new Error('rig 는 사례 안에서만 쓴다 — 시험 파일 최상위에서 installRigLifecycle() 호출을 빠뜨렸거나 사례 밖에서 불렀다');
  return base;
}

/** setImmediate 로 한 바퀴씩 돈다(가짜 시계가 건드리지 않는다). 실행기의 흐름은 마이크로태스크라 몇 바퀴면 된다. */
export async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** predicate 가 참이 될 때까지 돈다 — 2초(실제 시각) 안에 오지 않으면 던진다. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what}: 2초 안에 오지 않았다`);
    await turns(1);
  }
}

/** 가짜 시계 위에서 돈다 — 몇 바퀴 돌리고, cond 가 아직이면 시계를 POLL_MS 민다. 200초를 밀어도 안 되면 던진다. */
export async function drive(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 4_000; i += 1) {
    await turns(3);
    if (cond()) return;
    vi.advanceTimersByTime(POLL_MS);
  }
  throw new Error('가짜 시계로 200초를 밀어도 끝나지 않았다');
}

/** Electron 44.9.3 의 탐색(실제 스모크에서 본 순서) — did-start-navigation → will-frame-navigate → (막으면) did-stop-loading.
 * will-frame-navigate 가 막으면 will-navigate 는 오지 않고(alsoWillNavigate 면 온다), did-fail-provisional-load 도 없다(그 사건은 오류
 * 페이지로 들어간 탐색에만 난다). 막지 않은 탐색은 들어간다(URL 이 바뀐다). silent 면 did-stop-loading 이 없다(탐색이 끝나지 않았다). */
export function electronNavigate(app: FakeApp, url: string, { alsoWillNavigate = false, silent = false } = {}): void {
  let prevented = false;
  const event = {
    url,
    preventDefault: () => {
      prevented = true;
    },
  };
  app.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
  app.guards.willFrameNavigate(event);
  if (!prevented || alsoWillNavigate) app.guards.willNavigate(event);
  setImmediate(() => {
    if (!prevented) app.commit(url);
    if (!silent) app.emit('did-stop-loading');
  });
}

/** main 의 권한 처리기 — lib/permissions.cjs 로 정하고 결정마다 기록한다(check 는 requestingOrigin, request 는 requestingUrl).
 * later 면 기록을 다음 바퀴로 미룬다(페이지의 답이 기록보다 먼저 온다). */
export function decideLikeMain(app: FakeApp, { later = false } = {}): unknown {
  const note = (entry: unknown): void => {
    if (later) setImmediate(() => app.record(entry));
    else app.record(entry);
  };
  const check = (permission: string): string => {
    const allowed = isPermissionAllowed({ permission, requestingOrigin: APP_ORIGIN_SLASH, requestingUrl: SMOKE_URL });
    note({ kind: 'permission-check', permission, url: APP_ORIGIN_SLASH, allowed });
    return allowed ? 'granted' : 'denied';
  };
  const request = (permission: string): boolean => {
    const allowed = isPermissionAllowed({ permission, requestingUrl: SMOKE_URL });
    note({ kind: 'permission-request', permission, url: SMOKE_URL, allowed });
    return allowed;
  };
  return {
    checks: { notifications: check('notifications'), geolocation: check('geolocation'), clipboardWrite: check('clipboard-sanitized-write') },
    notificationPermission: check('notifications'),
    requested: request('notifications') ? 'granted' : 'denied',
    geolocation: request('geolocation') ? 'position' : 'error 1',
  };
}

/** 페이지의 connectProbe() — .invalid 빌드에서 https 를 fetch 하고 wss 소켓을 연다. 가드가 취소한 소켓은 Chromium 이 콘솔 error 를 남긴다. */
export async function probeLikePage(app: FakeApp, { socket = true } = {}): Promise<unknown> {
  const origin = app.build.supabaseOrigin;
  if (origin === null || !new URL(origin).hostname.endsWith('.invalid')) return { attempted: [] };
  const [http = '', ws = ''] = CONNECT_PROBES;
  const attempted = [http];
  await app.request(http);
  if (socket) {
    attempted.push(ws);
    await app.request(ws);
    app.log('error', `WebSocket connection to '${ws}' failed: `);
  }
  return { attempted };
}

/** 페이지의 net() — 설정 GET(apikey 머리글이라 CORS 사전 요청 OPTIONS 가 먼저 간다)과 Realtime 소켓. result 는 덮어쓸 필드. */
export async function netLikePage(app: FakeApp, result: Record<string, unknown> = {}): Promise<unknown> {
  const preflight = await app.request(SETTINGS_URL, 'OPTIONS');
  const settings = preflight === 'passed' ? await app.request(SETTINGS_URL, 'GET') : 'cancelled';
  const socket = await app.request(SOCKET_URL, 'GET');
  return {
    configured: true,
    settingsStatus: settings === 'passed' ? 200 : null,
    realtimeConnected: socket === 'passed',
    joinStatus: socket === 'passed' ? 'SUBSCRIBED' : null,
    error: null,
    ...result,
  };
}

/** Chromium 의 canary — CSP 가 막은 fetch 하나가 정책마다 위반 하나 · 콘솔 error 하나를 낸다. */
export function canaryLikeChromium(app: FakeApp, { policies = ['meta', 'header'] as ReadonlyArray<'meta' | 'header'>, errors = 2 } = {}): string {
  for (const which of policies) {
    app.violate({ blockedURI: CANARY_URL, effectiveDirective: 'connect-src', originalPolicy: app.build.csp[which], disposition: 'enforce', sourceFile: '', lineNumber: 0 });
  }
  for (let i = 0; i < errors; i += 1) {
    app.log('error', `Refused to connect to '${CANARY_URL}' because it violates the following Content Security Policy directive: "connect-src 'self'".`);
  }
  return 'rejected TypeError: Failed to fetch';
}

/** 실제 앱이 낼 페이지 사실 — 태그마다. 장벽은 rig 가 따로 본다(표식을 콘솔에 찍는다). */
export function healthyPage(index: FileIndex): Record<string, PageHandler> {
  return {
    boot: () => ({ rootChildren: 1, title: '십이장기', version: APP_VERSION, ...PAGE_BACKGROUND.dark, colorScheme: 'dark' }),
    'main-world': () => ({ isoProbe: 'undefined', cspBuffer: 'undefined', require: 'undefined', process: 'undefined' }),
    'disable-warnings': () => false,
    bridge: () => ({ keys: ['getAppInfo'], contract: ['getAppInfo'] }),
    frames: () => true,
    // 테마 한 단계(pageScripts.cjs 의 themeScript) — 테마가 있으면 렌더러의 send(tj-set-theme) 뒤, 없으면(null — 메뉴를 누른 뒤) 곧바로
    // getState() 장벽. 장벽 뒤의 페이지(가짜 렌더러가 그린 data-theme · 저장값과 그 data-theme 의 --bg · body 배경)를 돌려준다
    theme: (arg, app) => {
      if (arg !== null) app.send('tj-set-theme', arg);
      const snapshot = app.getState();
      const { dataTheme, stored } = app.dom;
      return { snapshot, dataTheme, ...PAGE_BACKGROUND[dataTheme === 'light' ? 'light' : 'dark'], stored };
    },
    // 투명도 한 줄(opacityScript) — 태그의 인자는 표식이다: { nan: true } 면 페이지 코드가 만든 NaN 을, 그 밖은 { value } 를 보낸 뒤 장벽
    opacity: (arg, app) => {
      const marker = arg as { nan?: boolean; value?: unknown };
      app.send('tj-set-opacity', marker.nan === true ? Number.NaN : marker.value);
      return app.getState();
    },
    // Esc 한 단계(escScript) — 태그의 인자는 대화상자 갈래: open 은 aria-modal 요소를 넣은 채, closes 는 그 요소와 그것을 동기로 지우는 #root
    // keydown 리스너와 함께(React 커밋 대신), none 은 요소 없이. Escape 를 보낸 뒤 넣은 것을 치우고 getState() 장벽
    esc: (arg, app) => {
      const mode = arg as 'open' | 'closes' | 'none';
      if (mode !== 'none') app.dom.dialog = true;
      const dialog = app.dom.dialog;
      let ran = false;
      app.pressEscape(
        mode === 'closes'
          ? () => {
              ran = true;
              app.dom.dialog = false;
            }
          : undefined,
      );
      const removed = mode !== 'none' && !app.dom.dialog;
      app.dom.dialog = false;
      return { dialog, ran, removed, snapshot: app.getState() };
    },
    // ✕(숨기기) 클릭(HIDE_BUTTON_SCRIPT) — 단추를 눌러 렌더러의 onClick 뒤 getState() 장벽
    'hide-button': (_arg, app) => {
      app.pressHideButton();
      return { found: true, snapshot: app.getState() };
    },
    // <html> 의 tapp-hidden · visibilityState(HIDDEN_STATE_SCRIPT)
    'hidden-state': (_arg, app) => app.hiddenState(),
    'csp-meta': (_arg, app) => ({ contents: [app.build.csp.meta], inHead: [true] }),
    'csp-header': (arg, app) =>
      (arg as string[]).map((url) => ({ url, status: 200, csp: app.build.csp.header, nosniff: 'nosniff', contentType: url.endsWith('.html') ? MIME_HTML : MIME_JS })),
    protocol: (arg) =>
      (arg as Array<{ url: string; method: string }>).map(({ url, method }) => ({ url, method, status: resolveAppRequest({ url, method }, index).status })),
    ai: () => ({ aiWorker: 'worker', aiAnswered: true, legal: true, ms: AI_MS }),
    'window-open': (arg, app) => app.guards.windowOpen({ url: String(arg) }).action === 'deny',
    navigate: (arg, app) => {
      electronNavigate(app, String(arg));
      return true;
    },
    location: (_arg, app) => app.url(),
    permissions: (_arg, app) => decideLikeMain(app),
    'connect-probe': (_arg, app) => probeLikePage(app),
    net: (_arg, app) => netLikePage(app),
    canary: (_arg, app) => canaryLikeChromium(app),
  };
}

/** 가짜 app — 실행기 · 흉내 낸 main 이 쓰는 멤버. setLoginItemSettings 는 실행기가 D1 의 대체 함수로 바꿔 끼운다(쓸 수 있는 속성). */
type RigApp = {
  on(event: string, listener: () => void): void;
  exit(code: number): void;
  quit(): void;
  getVersion(): string;
  getLoginItemSettings(options?: LoginItemQuery): LoginItemState & { wasOpenedAtLogin: boolean };
  setLoginItemSettings(settings: LoginItemWrite): void;
  getAppMetrics(): Array<{ pid: number; sandboxed: boolean; integrityLevel: string }>;
  hasSingleInstanceLock(): boolean;
};
/** 창 사건의 첫 인자 — close 만 막을 수 있다(main 의 처리기가 preventDefault 한다). */
type WindowEvent = { preventDefault(): void };
const windowEvent = (): WindowEvent => ({ preventDefault: () => {} });
/** 트레이 창의 수명 — 창과 webContents 가 함께 본다(창을 파괴하면 webContents 도 파괴된다). */
type WindowLife = { destroyed: boolean };

/** 파괴된 창 · webContents 의 멤버는 Electron 처럼 던진다(isDestroyed 만 답한다). */
function assertAlive(life: WindowLife): void {
  if (life.destroyed) throw new TypeError('Object has been destroyed');
}

/**
 * 가짜 트레이 창 — 숨긴 채 만든다(show: false — main 이 ready-to-show 에 보인다). Electron 처럼 show() · hide() 는 보임이 바뀔 때 'show' ·
 * 'hide' 를 내고(hide 는 포커스도 잃는다), focus() 가 포커스를 주고, close() 는 막을 수 있는 'close' 를 낸다(막지 않으면 창이 파괴된다).
 * emit 은 상태를 바꾸지 않는다(실행기의 win.emit('blur') 는 포커스를 그대로 둔다 — Electron 의 emit 과 같다). OS 가 포커스를 가져간 것은
 * osBlur() 다(포커스를 끄고 blur 를 낸다). 배경색 · 투명도는 창을 만들 때의 값(main 의 backgroundColor · opacity 옵션)에서 시작한다 —
 * getBackgroundColor() 는 Electron 처럼 '#RRGGBB'(대문자)로, setOpacity 는 0–1 로 자른다. destroy() 뒤에는 isDestroyed() 만 답하고 그 밖의
 * 멤버는 던진다(life — webContents 도 같다). wasShown() 은 창이 한 번이라도 보였는가다(visibilityState 의 규칙 — 창의 멤버가 아니다).
 */
function fakeTrayWindow(webContents: unknown, initial: { backgroundColor: string; opacity: number }, life: WindowLife) {
  const events = new EventEmitter();
  let visible = false;
  let shown = false;
  let focused = false;
  let background = initial.backgroundColor;
  let opacity = initial.opacity;
  const alive = (): void => assertAlive(life);
  const win = {
    webContents,
    isDestroyed: (): boolean => life.destroyed,
    destroy: (): void => {
      alive();
      life.destroyed = true;
    },
    isVisible: (): boolean => {
      alive();
      return visible;
    },
    isFocused: (): boolean => {
      alive();
      return focused;
    },
    setBackgroundColor: (color: string): void => {
      alive();
      background = color;
    },
    getBackgroundColor: (): string => {
      alive();
      return background.toUpperCase();
    },
    setOpacity: (value: number): void => {
      alive();
      opacity = Math.min(1, Math.max(0, value));
    },
    getOpacity: (): number => {
      alive();
      return opacity;
    },
    show: (): void => {
      alive();
      if (visible) return;
      visible = true;
      shown = true;
      events.emit('show', windowEvent());
    },
    hide: (): void => {
      alive();
      if (!visible) return;
      visible = false;
      focused = false;
      events.emit('hide', windowEvent());
    },
    focus: (): void => {
      alive();
      focused = true;
    },
    close: (): void => {
      alive();
      let prevented = false;
      events.emit('close', {
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) win.destroy();
    },
    on: (event: string, listener: (event: WindowEvent) => void): void => {
      alive();
      events.on(event, listener);
    },
    emit: (event: string, ...args: unknown[]): boolean => {
      alive();
      return events.emit(event, ...args);
    },
  };
  const osBlur = (): void => {
    if (life.destroyed) return;
    focused = false;
    events.emit('blur', windowEvent());
  };
  return { win, osBlur, wasShown: (): boolean => shown };
}
type FakeTrayWindow = ReturnType<typeof fakeTrayWindow>['win'];

/** createMainLike 에 넘기는 것. */
type MainLikeInput = {
  platform: FakePlatform;
  flaw: MainFlaw;
  app: RigApp;
  win: FakeTrayWindow;
  /** OS 가 창의 포커스를 가져간다(우연한 blur) */
  osBlur(): void;
  /** 렌더러로 민 값을 가짜 렌더러에 건넨다(main 의 webContents.send) */
  deliver(channel: string, value: unknown): void;
  run: SmokeRun;
  /** <프로필>/settings.json — main 이 userData 로 쓰는 프로필 */
  settingsFile: string;
  /** <앱 폴더>/assets/tray.png */
  iconFile: string;
};

/**
 * 흉내 낸 main — main.js 의 첫 실행 갈래(loadSettings) · IPC 처리기(tj-get-state · tj-set-theme · tj-set-opacity · tj-hide) · 테마 ·
 * 투명도(applyTheme · applyOpacity) · 저장 예약 · 창 사건(show · hide · blur · close) · 보이기 · 숨기기 · 트레이(좌클릭 · 메뉴 · setTray) ·
 * 종료(before-quit — 예약된 저장을 비운다)를 실제 lib(windowPolicy · trayMenu · autostart · pushChannels · theme · opacity · settings)로 흉내
 * 낸다. 시각은 performance.now() 다(RIG_FAKE_TIMERS 가 가짜로 돌린다 — 실행기의 at 과 같은 시계). 기록은 실행기의 record 로, 메뉴 ·
 * 아이콘은 setTray 로, 민 값은 deliver 로(가짜 렌더러) 넘기고, 창 기록은 windows 에도 남긴다(시험이 본다). flaw 가 결함 하나를 넣는다.
 * 흉내 내지 않는 것: 레이아웃 IPC, 창 배치, 우클릭(실행기가 내지 않는다), macOS 의 메뉴 붙이기 · D6, rename 재시도 — 메뉴의 창 고정 ·
 * 위치 초기화 · 자동 실행은 상태만 바꾸고 메뉴를 다시 만든다(이 장치의 검사가 누르지 않는다).
 */
function createMainLike({ platform, flaw, app, win, osBlur, deliver, run, settingsFile, iconFile }: MainLikeInput) {
  const settings = { ...DEFAULT_SETTINGS };
  let isQuitting = false;
  let shownIntent = false;
  let shownAt = -Infinity;
  let showReason: string | null = null;
  let lastBlurHideAt = -Infinity;
  let deferredBlur: ReturnType<typeof setTimeout> | null = null;
  let strayBlurPending = flaw.strayBlurAfterTrayShow !== undefined;
  let mode: 'solo' | 'online' = 'solo';
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const windows: Outcome['windows'] = [];
  const source = fakeImageFromPath(iconFile);
  const icon = flaw.icon === 'unresized' ? source : source.resize(TRAY_ICON_SIZE);
  const trayEvents = new EventEmitter();
  const tray = {
    isDestroyed: (): boolean => false,
    getBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }),
    emit: (event: string, ...args: unknown[]): boolean => trayEvents.emit(event, ...args),
  };
  /** main.js 의 liveWindow — 종료 중이거나 창이 파괴됐으면 창을 만지지 않는다. */
  const live = (): boolean => !isQuitting && !win.isDestroyed();
  const managesLoginItems = (): boolean => canManageLoginItems({ isPackaged: false, smoke: true, platform, execPath: process.execPath });

  const clearDeferredBlur = (): void => {
    if (deferredBlur !== null) clearTimeout(deferredBlur);
    deferredBlur = null;
  };
  /** main 의 sendToTray — PUSH_CHANNELS 의 채널만 렌더러에 민 뒤(webContents.send) 'sent' 를 기록한다. */
  const sendToTray = (channel: string, value?: unknown): void => {
    if (!Object.hasOwn(PUSH_CHANNELS, channel) || !live()) return;
    deliver(channel, value);
    run.record({ kind: 'sent', channel });
  };
  /** 지금의 설정을 프로필의 settings.json 에 쓴다(settings.cjs — 임시 파일에 쓰고 rename). */
  const writeNow = (): void => {
    const error = writeSettings(settingsFile, settings);
    if (error !== null) throw error;
  };
  /** main 의 saveSettingsSoon — 앞선 예약을 덮고 delay 뒤에 그때의 설정을 쓴다. */
  const saveSoon = (delay: number = SAVE_DELAY_MS): void => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeNow();
    }, delay);
  };
  const noteWindow = (action: 'show' | 'hide', reason: string): void => {
    windows.push({ action, reason });
    run.record({ kind: 'window', action, reason });
  };

  function showWindow(reason: string): void {
    if (!live()) return;
    shownAt = performance.now();
    showReason = reason;
    shownIntent = true;
    clearDeferredBlur();
    win.show();
    if (flaw.noFocus !== true) win.focus();
    noteWindow('show', reason);
    if (reason === 'tray' && strayBlurPending) {
      strayBlurPending = false;
      setTimeout(osBlur, flaw.strayBlurAfterTrayShow);
    }
  }

  function hideWindow(reason: HideReason): void {
    if (!live()) return;
    shownIntent = false;
    clearDeferredBlur();
    win.hide();
    if (reason === 'blur' || flaw.guardEveryHide === true || (reason === 'request' && flaw.guardRequestHide === true)) lastBlurHideAt = performance.now();
    noteWindow('hide', flaw.relabelHide?.[reason] ?? reason);
  }

  function onBlur(): void {
    if (flaw.ignoreBlur === true || !live() || !shownIntent || !win.isVisible()) return;
    const now = performance.now();
    if (shouldHideOnBlur({ now, shownAt, pinned: settings.pinned, devToolsOpen: false, visible: true })) {
      hideWindow('blur');
      return;
    }
    if (now - shownAt <= BLUR_GRACE_MS && showReason !== 'start' && deferredBlur === null) {
      deferredBlur = setTimeout(() => {
        deferredBlur = null;
        if (!live()) return;
        const action = deferredBlurAction({ visible: shownIntent && win.isVisible(), focused: win.isFocused(), pinned: settings.pinned, devToolsOpen: false });
        if (action === 'hide') hideWindow('blur');
      }, shownAt + BLUR_GRACE_MS + 1 - now);
    }
  }

  function onTrayClick(): void {
    if (!live()) return;
    const visible = shownIntent && win.isVisible();
    const action =
      flaw.noRaceGuard === true
        ? visible
          ? 'hide'
          : 'show'
        : trayClickAction({ now: performance.now(), visible, lastBlurHideAt: lastBlurHideAt + (flaw.longerRace ?? 0) });
    if (action === 'hide') hideWindow('toggle');
    else if (action === 'show') showWindow('tray');
  }

  function setLoginItem(on: boolean): void {
    const managed = flaw.leakLoginItem === true || managesLoginItems();
    if (managed) {
      const options = loginItemSettings(platform, on);
      if (options !== null) app.setLoginItemSettings(options);
    }
    const times = flaw.loginRecord === 'none' ? 0 : flaw.loginRecord === 'twice' ? 2 : 1;
    for (let i = 0; i < times; i += 1) run.record({ kind: 'login-item', on, managed });
  }

  /**
   * 테마 — main.js 의 applyTheme: normalizeTheme(받지 않는 값은 무시) → 설정 · 저장 예약 → 창 배경(THEME_BACKGROUND) → tj-theme → 메뉴
   * 다시 만들기. 같은 값이어도 한다(낡은 메뉴의 클릭도 메뉴를 새로 만든다).
   */
  function applyTheme(theme: unknown): void {
    const value = flaw.themeAcceptsAny === true && typeof theme === 'string' ? theme : normalizeTheme(theme);
    if (value === null || !live()) return;
    if (flaw.themeRefreshFirst === true) refreshTrayMenu();
    settings.theme = value as Theme; // themeAcceptsAny 결함이면 표에 없는 글도 들어간다
    if (flaw.themeNoSave !== true) saveSoon();
    const background = (THEME_BACKGROUND as Readonly<Record<string, string | undefined>>)[value];
    if (flaw.themeNoBackground !== true && background !== undefined) win.setBackgroundColor(background);
    sendToTray('tj-theme', value);
    if (flaw.themeNoRefresh !== true && flaw.themeRefreshFirst !== true) refreshTrayMenu();
  }

  /** 투명도 — main.js 의 applyOpacity: normalizeOpacity(반올림 · 30–100, 받지 않는 값은 무시) → 창 투명도 → 설정 · 저장 예약 → tj-opacity(자른 값). */
  function applyOpacity(percent: unknown): void {
    const given = flaw.opacityAcceptsString === true && typeof percent === 'string' ? Number(percent) : percent;
    const value = normalizeOpacity(given) ?? (flaw.opacityDefaultsInvalid === true ? DEFAULT_OPACITY : null);
    if (value === null || !live()) return;
    if (flaw.opacityNoWindow !== true) win.setOpacity(value / 100);
    settings.opacity = value;
    saveSoon(flaw.opacitySavesLater === true ? LATE_SAVE_MS : SAVE_DELAY_MS);
    sendToTray('tj-opacity', value);
  }

  /** 메뉴의 '라이트 모드' 가 청하는 테마 — item.checked(Electron 이 click 전에 뒤집은 값)다. lightFlipsState 결함이면 지금 상태를 뒤집는다. */
  function lightRequest(on: boolean): Theme {
    if (flaw.lightFlipsState === true) return settings.theme === 'light' ? 'dark' : 'light';
    return on ? 'light' : 'dark';
  }

  function refreshTrayMenu(): void {
    if (!live()) return;
    const loginItem = platform === 'win32' ? app.getLoginItemSettings(loginItemQuery(platform)) : {};
    const template = buildTrayMenuTemplate(
      {
        platform,
        version: app.getVersion(),
        autostart: { checked: autostartChecked({ platform, loginItem, settings }), enabled: managesLoginItems() },
        light: settings.theme === 'light',
        pinned: settings.pinned,
        hasCustomPosition: settings.position !== null,
      },
      {
        open: () => thenRefresh(() => showWindow('menu')),
        solo: () => thenRefresh(() => setMode('solo')),
        online: () => thenRefresh(() => setMode('online')),
        setAutostart: (on) =>
          thenRefresh(() => {
            setLoginItem(on);
            if (platform === 'darwin') settings.autostart = on;
          }),
        // main.js 처럼 applyTheme 이 끝에서 스스로 메뉴를 다시 만든다(thenRefresh 를 거치지 않는다)
        setLight: (on) => applyTheme(lightRequest(on)),
        setPinned: (on) =>
          thenRefresh(() => {
            settings.pinned = on;
          }),
        resetPosition: () =>
          thenRefresh(() => {
            settings.position = null;
          }),
        openWeb: () => thenRefresh(() => run.open(WEB_URL)),
        sendFeedback: () => thenRefresh(() => run.open(FEEDBACK_URL)),
        quit: () => app.quit(),
      },
    );
    run.setTray(tray, { items: fakeMenuItems(flaw.template?.(template) ?? template) }, icon);
  }
  /** 메뉴 항목 하나의 동작 뒤에 메뉴를 다시 만든다(main 의 menuThenRefresh). */
  const thenRefresh = (action: () => void): void => {
    action();
    refreshTrayMenu();
  };
  /** 혼자 하기 · 온라인 대전 — 모드를 바꾸고 렌더러에 tj-mode 를 민 뒤 보인다(main.js 의 setMode). */
  function setMode(next: 'solo' | 'online'): void {
    mode = next;
    sendToTray('tj-mode', next);
    showWindow('menu');
  }

  app.on('before-quit', () => {
    isQuitting = true;
    clearDeferredBlur();
    // main 의 비우기(flushSettings) — 예약된 저장을 곧바로 쓴다
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
      writeNow();
    }
  });
  return {
    windows,
    /** main 의 tj-get-state(invoke) — main 메모리의 스냅샷(buildSnapshot — visible 은 shownIntent) */
    getState: (): unknown => buildSnapshot({ settings, mode, visible: shownIntent }),
    /** 첫 실행(새 프로필) — win32 는 자동 실행 기본값(setLoginItem(true) — 스모크는 관리하지 않아 기록만 남는다), 그 밖은 끈 채. 표시하고 곧바로 쓴다 */
    loadSettings(): void {
      if (firstRunAutostart(platform)) setLoginItem(true);
      else settings.autostart = false;
      settings.autostartDefaultApplied = flaw.noFirstRunFlag !== true;
      const error = writeSettings(settingsFile, settings);
      if (error !== null) throw error;
    },
    /** main 채널 중 send 로 받는 것(main.js 의 차례 — tj-set-layout 은 흉내 내지 않는다). tj-get-state 는 invoke 라 getState 로 따로 준다 */
    registerIpc(on: (channel: string, listener: IpcListener) => void): void {
      on('tj-set-theme', (_event, theme) => applyTheme(theme));
      on('tj-set-opacity', (_event, percent) => applyOpacity(percent));
      on('tj-hide', () => hideWindow('request'));
    },
    /** 창 사건 — show · hide 는 렌더러에 tj-shown · tj-hidden, blur 는 바깥 클릭, close 는 숨김(종료 중이 아니면 막는다) */
    attachWindow(): void {
      win.on('show', () => {
        shownIntent = true;
        if (flaw.noShownPush !== true) sendToTray('tj-shown');
      });
      win.on('hide', () => {
        shownIntent = false;
        clearDeferredBlur();
        if (flaw.noHiddenPush !== true) sendToTray('tj-hidden');
      });
      win.on('blur', () => onBlur());
      win.on('close', (event) => {
        if (isQuitting || flaw.closeDestroys === true) return;
        event.preventDefault();
        if (flaw.closeIgnored !== true) hideWindow('close');
      });
    },
    /** 트레이 — win32 만 좌클릭 처리기를 달고, 시작 메뉴를 만든다(setTray) */
    createTray(): void {
      if (platform === 'win32') trayEvents.on('click', () => onTrayClick());
      refreshTrayMenu();
    },
    /** 첫 ready-to-show — 스모크는 로그인 실행이 아니므로 보인다 */
    readyToShow(): void {
      showWindow('start');
    },
  };
}

/** 실행기를 만들어 main 의 순서로 꽂는다. start() 가 첫 did-finish-load 를 낸다 — finish 는 '종료' 클릭이나 exit 까지 기다려 결과를 읽는다. */
export function rigScenario(scenario: Scenario = {}): Rig {
  const caseDir = rigBase(); // 사례 밖이면 여기서 던진다 — process 값을 바꾸거나 파일을 쓰기 전에
  const {
    guard = 'run',
    network = 'unresolved',
    blocked = () => new Error(BLOCKED),
    warningsBeforeMarker = [],
    arming = { execPath: OTHER_BINARY, enable: '1' },
    build = 'default',
    net = false,
    workerScript = WORKER_SCRIPT,
    platform = DEFAULT_PLATFORM,
    main: flaw = {},
  } = scenario;
  process.execPath = arming.execPath;
  if (arming.enable === undefined) delete process.env[ENABLE];
  else process.env[ENABLE] = arming.enable;

  // 앱 폴더 — ipc 검사가 desktop 패키지 · 고정한 electron 패키지의 version 을 읽고, 흉내 낸 main 이 트레이 아이콘을 읽는다. 렌더러 루트 —
  // protocol 검사의 전제(바로 위의 package.json · 디렉터리 assets · tray-build.json)를 깐다. 프로필 — main 이 userData 로 쓴다(settings.json)
  const appRoot = join(caseDir, 'desktop');
  const rendererRoot = join(caseDir, 'dist-tray');
  const outDir = join(caseDir, 'smoke out');
  const profile = join(caseDir, '스모크 프로필');
  const iconFile = join(appRoot, 'assets', 'tray.png');
  mkdirSync(join(appRoot, 'node_modules', 'electron'), { recursive: true });
  mkdirSync(join(appRoot, 'assets'), { recursive: true });
  mkdirSync(join(rendererRoot, 'assets'), { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ version: APP_VERSION }));
  writeFileSync(join(appRoot, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: ELECTRON_VERSION }));
  if (flaw.icon !== 'missing') writeFileSync(iconFile, 'png');
  if (scenario.noParentFile !== true) writeFileSync(join(caseDir, 'package.json'), JSON.stringify({ name: '저장소' }));
  const trayBuild = buildTrayBuildInfo(buildTrayCsp(SUPABASE_URLS[build]), workerScript, '2026-10-29T00:00:00.000Z', null);
  writeFileSync(join(rendererRoot, 'tray-build.json'), JSON.stringify(trayBuild));
  const index: FileIndex = {
    files: new Map([
      ['tray.html', join(rendererRoot, 'tray.html')],
      [WORKER_SCRIPT, join(rendererRoot, WORKER_SCRIPT)],
    ]),
    unmapped: [],
  };

  // 가짜 app — 로그인 항목은 Windows 흉내(createFakeLoginItems)다. 값 이름의 기본값(AUMID)은 main 처럼 win32 에서만 정한다. '종료' 는
  // app.quit() → before-quit → will-quit(실행기의 감시 타이머를 끈다)
  const appEvents = new EventEmitter();
  quitApp = () => appEvents.emit('will-quit');
  const exits: number[] = [];
  let quits = 0;
  const loginItems = createFakeLoginItems(scenario.loginItems);
  const aumid = platform === 'win32' ? AUTOSTART_NAME : null;
  const loginItemQueries: unknown[] = [];
  const loginItemWrites: unknown[] = [];
  const app: RigApp = {
    on: (event, listener) => {
      appEvents.on(event, listener);
    },
    exit: (code) => {
      exits.push(code);
    },
    quit: () => {
      quits += 1;
      appEvents.emit('before-quit');
      appEvents.emit('will-quit');
    },
    getVersion: () => APP_VERSION,
    getLoginItemSettings: (options) => {
      loginItemQueries.push(options);
      return { ...loginItems.read(options, aumid, process.execPath), wasOpenedAtLogin: false };
    },
    setLoginItemSettings: (settings) => {
      loginItemWrites.push(settings);
      loginItems.write(settings, aumid, process.execPath);
    },
    getAppMetrics: () => [{ pid: RENDERER_PID, sandboxed: true, integrityLevel: 'untrusted' }],
    hasSingleInstanceLock: () => true,
  };
  const realSetLoginItemSettings = app.setLoginItemSettings;

  let beforeRequest: Guard | null = null;
  const fetches: string[] = [];
  const defaultSession = {
    webRequest: {
      onBeforeRequest: (listener: Guard) => {
        beforeRequest = listener;
      },
    },
    /** Electron 의 session.fetch 처럼 onBeforeRequest 를 먼저 지난다. */
    fetch: (url: string): Promise<{ status: number }> => {
      fetches.push(url);
      return new Promise((resolve, reject) => {
        const toNetwork = (): void => {
          if (network === 'respond') resolve({ status: 200 });
          else reject(new Error(NOT_RESOLVED));
        };
        const listener = beforeRequest;
        if (listener === null) toNetwork();
        else listener({ url, method: 'GET' }, (response) => (response.cancel === true ? reject(blocked()) : toNetwork()));
      });
    },
  };

  const events = new EventEmitter();
  // IPC — 채널마다 리스너 여럿(등록 차례). 렌더러의 send 는 그 채널의 리스너를 모두 부른다(Electron 의 ipcMain 과 같다)
  const ipc = new Map<string, IpcListener[]>();
  const ipcOn = (channel: string, listener: IpcListener): void => {
    ipc.set(channel, [...(ipc.get(channel) ?? []), listener]);
  };
  const ipcSend = (channel: string, ...payload: unknown[]): void => {
    for (const listener of ipc.get(channel) ?? []) listener({}, ...payload);
  };
  const buffer: Violation[] = [];
  const pageCalls: string[] = [];
  const isolatedCalls: Outcome['isolatedCalls'] = [];
  let currentUrl = SMOKE_URL;
  let barriers = 0;
  const handlers: Record<string, PageHandler | undefined> = { ...healthyPage(index), ...scenario.page };
  const info = { version: APP_VERSION, electron: ELECTRON_VERSION, chrome: process.versions.chrome, platform: process.platform };
  /** 페이지 코드 하나를 태그로 가른다 — 장벽은 여기서, 그 밖은 처리기가 답한다(처리기가 던지면 거부다). */
  const runPage = async (code: string): Promise<unknown> => {
    const tag = TAG_RE.exec(code);
    if (tag === null) throw new Error(`가짜 페이지가 모르는 코드다(태그 없음): ${code.slice(0, 60)}`);
    const [, name = '', json] = tag;
    pageCalls.push(name);
    const arg: unknown = json === undefined ? undefined : JSON.parse(json);
    if (name === 'barrier') {
      // 장벽 — getAppInfo 왕복 뒤 표식을 콘솔에 찍는다. 첫 장벽에서는 그보다 먼저 온 줄을 앞에 둔다
      barriers += 1;
      if (barriers === 1) for (const message of warningsBeforeMarker) events.emit('console-message', { level: 'warning', message, sourceId: '', lineNumber: 0 });
      if (scenario.barrierMarks?.(barriers) ?? true) events.emit('console-message', { level: 'info', message: String(arg), sourceId: '', lineNumber: 1 });
      return info;
    }
    const handler = handlers[name];
    if (handler === undefined) throw new Error(`가짜 페이지에 '${name}' 처리기가 없다`);
    return handler(arg, fakeApp);
  };
  // 창과 webContents 가 함께 보는 수명 — 창을 파괴하면 webContents 의 멤버도 던진다(isDestroyed 만 답한다)
  const life: WindowLife = { destroyed: false };
  const alive = (): void => assertAlive(life);
  /** 숨긴 창의 렌더러 스로틀(Electron 기본 켬 — Scenario.throttle 이 바꾼다) */
  let throttling = scenario.throttle !== 'off';
  /** capturePage 를 부를 때마다 그때 창이 보였는가(Outcome.captures) */
  const captures: boolean[] = [];
  const contents = Object.assign(events, {
    session: defaultSession,
    isDestroyed: (): boolean => life.destroyed,
    getURL: () => {
      alive();
      return currentUrl;
    },
    getOSProcessId: () => {
      alive();
      return RENDERER_PID;
    },
    getLastWebPreferences: () => {
      alive();
      return { ...WEB_PREFERENCES };
    },
    capturePage: (): Promise<typeof SCREEN> => {
      alive();
      captures.push(win.isVisible());
      return Promise.resolve(SCREEN);
    },
    setBackgroundThrottling: (allowed: boolean): void => {
      alive();
      if (allowed && !throttling && scenario.throttle === 'sticky') return;
      if (!allowed && scenario.throttle === 'ignored') return;
      throttling = allowed;
    },
    getBackgroundThrottling: (): boolean => {
      alive();
      return throttling;
    },
    executeJavaScript: (code: string): Promise<unknown> => {
      alive();
      return runPage(code);
    },
    executeJavaScriptInIsolatedWorld: (worldId: number, scripts: Array<{ code: string }>): Promise<unknown> => {
      alive();
      isolatedCalls.push({ worldId, codes: scripts.map((script) => script.code) });
      if (scenario.isolated !== undefined) return Promise.resolve(scenario.isolated(buffer));
      // preload 의 격리 world 전역은 world 999 에서만 보인다
      return Promise.resolve(worldId === 999 ? { probe: 1, buf: buffer.map((violation) => ({ ...violation })) } : { probe: undefined, buf: undefined });
    },
  });
  // 창은 main 의 옵션(새 프로필 — 설정 기본값의 테마 배경 · 투명도)으로 만든다
  const { win, osBlur, wasShown } = fakeTrayWindow(contents, { backgroundColor: THEME_BACKGROUND[DEFAULT_SETTINGS.theme], opacity: DEFAULT_SETTINGS.opacity / 100 }, life);
  const mainFetch = scenario.mainFetch ?? (async (url: string) => ({ status: resolveAppRequest({ url, method: 'GET' }, index).status }));
  // 가짜 렌더러 — 새 프로필의 첫 화면에서 시작한다: main.tsx 가 지난 테마(없음 → dark)로 data-theme 을 칠했고, 처음 스냅샷(dark)이 저장값을
  // 썼다. main 이 민 tj-theme 는 trayState 처럼 data-theme · 저장값에, tj-hidden · tj-shown 은 <html> 의 tapp-hidden 에 반영한다(결함이 없으면)
  const rendererFlaw = scenario.renderer ?? {};
  const dom: FakeDom = { dataTheme: 'dark', stored: rendererFlaw.noStoreTheme === true ? null : 'dark', hiddenClass: false, dialog: false };
  const deliver = (channel: string, value: unknown): void => {
    if (channel === 'tj-hidden') {
      dom.hiddenClass = true;
      return;
    }
    if (channel === 'tj-shown') {
      if (rendererFlaw.keepHiddenClass !== true) dom.hiddenClass = false;
      return;
    }
    if (channel !== 'tj-theme' || typeof value !== 'string') return;
    if (rendererFlaw.noDataTheme !== true) dom.dataTheme = value;
    if (rendererFlaw.noStoreTheme !== true) dom.stored = value;
  };
  // 가짜 렌더러의 Esc — src/tray/esc.ts 의 처리기 그대로(window 캡처에서 그때의 대화상자를 찍고 버블에서 정한다). 대화상자는 페이지가 넣은
  // aria-modal 요소다(dom.dialog — useDialog 의 isDialogOpen 이 querySelector 로 본다). 숨기기는 ✕ 와 같은 tjDesktop.hide() → tj-hide
  const esc = createEscHandlers({ isDialogOpen: () => dom.dialog, hide: () => ipcSend('tj-hide') });
  const pressEscape = (rootListener?: () => void): void => {
    // 페이지가 만든 KeyboardEvent — 조합 · 반복 · 조합키는 기본값(거짓)이다
    const event: EscInput & { preventDefault(): void } = {
      key: 'Escape',
      isComposing: false,
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
    };
    const keyboard = event as unknown as KeyboardEvent;
    const installed = rendererFlaw.noEsc !== true;
    if (installed && rendererFlaw.escNoCapture !== true) esc.onCapture(keyboard); // window 캡처 — 어떤 처리기보다 먼저
    rootListener?.(); // #root 의 버블 — window 보다 먼저
    if (installed) esc.onBubble(keyboard); // window 버블 — 여기서 숨길지 정한다
  };
  // 가짜 렌더러의 ✕ — TrayApp 의 onClick(desktop()?.hide()) → tj-hide
  const pressHideButton = (): void => {
    if (rendererFlaw.noHideButton !== true) ipcSend('tj-hide');
  };
  const hiddenState = (): HiddenState => {
    // Electron: show:false 로 만든 창은 처음 보이기 전에는 visible 이고, 스로틀을 끄면 숨겨도 visible 이다
    const visibilityState = wasShown() && !win.isVisible() && throttling ? 'hidden' : 'visible';
    return { hiddenClass: rendererFlaw.visibilityDriven === true ? visibilityState === 'hidden' : dom.hiddenClass, visibilityState };
  };

  // main 의 onReady 순서 — 실행기(D1 이 맨 먼저 선다) → 첫 실행 갈래 → 가드 → IPC(main 채널 → 실행기) → 창(수집기) → 트레이(시작 메뉴)
  const run = createSmokeRun({
    args: { enabled: true, outDir, profile, net, nonce: NONCE, error: null },
    app,
    session: { defaultSession },
    net: { fetch: mainFetch },
    trayBuild,
    rendererRoot,
    appRoot,
    index,
    platform,
  });
  if (scenario.unplugBlocker === true) app.setLoginItemSettings = realSetLoginItemSettings;
  const main = createMainLike({ platform, flaw, app, win, osBlur, deliver, run, settingsFile: join(profile, SETTINGS_FILE), iconFile });
  main.loadSettings();
  const fakeApp: FakeApp = {
    build: trayBuild,
    guards: createNavigationGuards({ open: run.open, record: run.record }),
    record: run.record,
    open: run.open,
    log: (level, message) => events.emit('console-message', { level, message, sourceId: '', lineNumber: 0 }),
    violate: (event, { buffer: buffered = true } = {}) => {
      if (buffered) buffer.push(event);
      ipcSend('tj-smoke-csp', { ...event });
    },
    request: (url, method = 'GET') =>
      new Promise((resolve) => {
        const listener = beforeRequest;
        if (listener === null) resolve('passed');
        else listener({ url, method }, (response) => resolve(response.cancel === true ? 'cancelled' : 'passed'));
      }),
    emit: (event, ...args) => {
      events.emit(event, ...args);
    },
    commit: (url) => {
      currentUrl = url;
    },
    url: () => currentUrl,
    send: ipcSend,
    getState: () => main.getState(),
    dom,
    pressEscape,
    pressHideButton,
    hiddenState,
    osBlur,
    destroyWindow: () => win.destroy(),
    loginItems: loginItems.items,
  };
  // 사례의 onBeforeRequest — main 의 순서대로 가드가 먼저다. null 이면 붙이지 않는다
  const guards: Record<NonNullable<Scenario['guard']>, Guard | null> = {
    run: run.networkGuard,
    pass: (details, callback) => run.networkGuard(details, () => callback({})),
    hang: (details) => run.networkGuard(details, () => {}),
    foreign: (_details, callback) => callback({ cancel: true }),
    none: null,
  };
  const attached = guards[guard];
  if (attached !== null) defaultSession.webRequest.onBeforeRequest(attached);
  main.registerIpc(ipcOn);
  run.registerIpc({ on: ipcOn });
  main.attachWindow();
  run.beforeLoad(win);
  main.createTray();
  ipcSend('tj-smoke-preload', { sandboxed: true, contextIsolated: true });

  const ended = (): boolean => quits > 0 || exits.length > 0;
  return {
    run,
    start(): Running {
      main.readyToShow();
      events.emit('did-finish-load');
      return {
        fetches,
        ended,
        async finish(): Promise<Outcome> {
          await waitFor(ended, "결과 뒤 '종료' 클릭이나 exit");
          const result = JSON.parse(readFileSync(join(outDir, RESULT_FILE), 'utf8')) as Record<string, unknown>;
          return {
            result,
            checks: result.checks as Check[],
            fetches,
            quits,
            exits,
            pageCalls,
            isolatedCalls,
            windows: main.windows,
            loginItemQueries,
            loginItemWrites,
            throttling: life.destroyed ? null : throttling,
            captures: [...captures],
          };
        },
      };
    },
  };
}

export const startScenario = (scenario?: Scenario): Running => rigScenario(scenario).start();

/** 가짜 시계로 끝까지 돈다 — 실행기의 기다림(사건 5초 · 페이지 호출 상한 · 감시 타이머 · 시각을 재는 기다림)은 모두 이 시계를 따른다. */
export async function runScenario(scenario?: Scenario): Promise<Outcome> {
  vi.useFakeTimers(RIG_FAKE_TIMERS);
  try {
    const running = startScenario(scenario);
    await drive(running.ended);
    return await running.finish();
  } finally {
    vi.useRealTimers();
  }
}

/** 상한까지 기다리는 사례 — 같은 가짜 시계 위의 실행이다(이름은 무엇을 보는 사례인지 드러낸다). */
export const runFast = runScenario;

/** 결과의 그 검사(한 번만 있다). */
export function checkOf(outcome: Outcome, name: string): Check {
  const found = outcome.checks.filter((check) => check.name === name);
  expect(found.map((check) => check.name), `${name} 검사는 한 번`).toStrictEqual([name]);
  return found[0] as Check;
}

/** ok 가 아닌 검사 [이름, detail]. */
export const failing = (outcome: Outcome): string[][] => outcome.checks.filter((entry) => !entry.ok).map((entry) => [entry.name, entry.detail]);

/** 그 검사만 실패했다 — detail 에 fragments 가 모두 든다. 결과는 성공 경로(stage · error 없음, '종료' 한 번)다. */
export function expectOnlyFailure(outcome: Outcome, name: string, fragments: readonly string[]): Check {
  expect(failing(outcome).map(([failed]) => failed)).toStrictEqual([name]);
  const check = checkOf(outcome, name);
  for (const fragment of fragments) expect(check.detail).toContain(fragment);
  expect([outcome.quits, outcome.exits]).toStrictEqual([1, []]);
  return check;
}

/** 위반 한 건(preload 모양). */
export function violation(over: Partial<Violation> = {}): Violation {
  return { blockedURI: CANARY_URL, effectiveDirective: 'connect-src', originalPolicy: '', disposition: 'enforce', sourceFile: '', lineNumber: 0, ...over };
}
