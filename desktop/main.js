'use strict';
// 십이장기 트레이 앱의 main 프로세스(#20 설계 §5.5 · §5.7). 트레이 빌드(개발 <repo>/dist-tray · 패키지 resources/renderer)를
// app://twelvejanggi/tray.html 로 연다. 판정은 lib/ 의 순수 모듈이 하고(시험도 거기서 한다), 이 파일은 Electron 에 잇기만 한다.
// - 최상위(ready 전, 동기)는 순서가 의미를 가진다: 스모크 인자 → userData → enableSandbox → 스킴 특권 → 단일 인스턴스 잠금.
//   userData 를 만들거나 정하지 못하면 '[tj] userData: …' 를 남기고 그 자리에서 끝낸다.
// - tray-build.json 이 없거나 틀리거나 tray.html 이 없으면 fail-closed 다 — 처리기 · 창 · 트레이를 만들지 않고 알린 뒤 끝낸다.
// - ready 뒤 시작(onReady)이 던지면 반쯤 선 채 두지 않는다 — '[tj] ready: …' 를 남기고 스모크는 결과(stage 'ready'), 아니면 오류 상자
//   뒤 끝낸다.
// - IPC 처리기는 createGuardedIpc 로만 등록한다(ipcMain 의 등록 함수를 직접 부르지 않는다). 처리기는 모두 창을 만들기 전에,
//   사이에 await 없이 건다. 배선은 두 시험이 본다 — desktop/lib/mainSource.test.ts 는 이 파일의 글로, mainWiring.test.ts 는
//   가짜 electron 위에서 이 파일을 돌려서.
// - hooks 는 스모크 실행기(#20 설계 §5.10, smoke/run.cjs)의 연결점이다. 스모크에서만 ready 뒤 처리기보다 먼저 꽂고(plugSmokeRun),
//   비스모크에서는 모두 null 이라 없는 것처럼 동작한다.
// - 트레이 창(#21 설계 §5.2): 보이기 · 숨기기 · 배치 · 설정 바꾸기는 각각 한 함수(showWindow · hideWindow · placeNow · apply*)로만 하고,
//   창은 liveWindow() 로만 만진다 — 없거나 파괴됐거나 종료 중이면 아무것도 하지 않는다. 렌더러로는 sendToTray 로만 민다.
//   설정(<userData>/settings.json)은 ready 뒤 한 번 동기로 읽고, 바뀌면 묶어서(300ms) 쓰고, 종료 · 세션 끝에 남은 것을 비운다.
//   시각은 모두 performance.now() 한 시계로 잰다(부를 때마다 읽는다).
// - 트레이 메뉴는 refreshTrayMenu 한 곳에서 만든다 — 시작 때 한 번, 메뉴를 누를 때마다, 메뉴에 보이는 상태가 바뀔 때마다. Windows 는 메뉴를
//   트레이에 붙이지 않고 우클릭마다 새로 만들어 띄운다(D4 — 자동 실행 체크가 그 순간의 OS 상태다). 로그인 항목은 setLoginItem 한 곳에서만
//   쓰고, 로그인 항목을 관리하는 실행(설치본)에서만 OS 를 부른다.

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, net, protocol, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { APP_SCHEME, ENTRY_FILE, ENTRY_URL, SCHEME_PRIVILEGES, buildFileIndex, resolveAppRequest } = require('./lib/appProtocol.cjs');
const {
  AUTOSTART_NAME,
  HIDDEN_ARG,
  autostartChecked,
  canManageLoginItems,
  firstRunAutostart,
  hasHiddenArg,
  launchedAtLogin,
  loginItemQuery,
  loginItemSettings,
} = require('./lib/autostart.cjs');
const { consoleLine } = require('./lib/consoleLine.cjs');
const { createGuardedIpc } = require('./lib/ipcGuard.cjs');
const { layoutSize, normalizeLayout } = require('./lib/layout.cjs');
const { FEEDBACK_URL, WEB_URL, externalHref } = require('./lib/links.cjs');
const { createNavigationGuards } = require('./lib/navigation.cjs');
const { normalizeOpacity } = require('./lib/opacity.cjs');
const { denyDownload, isPermissionAllowed, selectNoCertificate } = require('./lib/permissions.cjs');
const { isEmptyRect, placeWindow, shouldSaveMove } = require('./lib/position.cjs');
const { PUSH_CHANNELS, buildSnapshot } = require('./lib/pushChannels.cjs');
const { DEFAULT_SETTINGS, SETTINGS_FILE, isRetryableWriteError, readSettings, writeSettings } = require('./lib/settings.cjs');
const { parseSmokeArgs } = require('./lib/smokeArgs.cjs');
const { failureResult, writeResultAtomic } = require('./lib/smokeOut.cjs');
const { THEME_BACKGROUND, normalizeTheme } = require('./lib/theme.cjs');
const { parseTrayBuild } = require('./lib/trayBuildInfo.cjs');
const { buildTrayMenuTemplate } = require('./lib/trayMenu.cjs');
const { BLUR_GRACE_MS, deferredBlurAction, shouldHideOnBlur, trayClickAction, trayDoubleClickAction } = require('./lib/windowPolicy.cjs');
const { trayWindowPreferences } = require('./lib/windowPrefs.cjs');

/** @typedef {import('./lib/navigation.cjs').NavigationRecord} NavigationRecord */
/** @typedef {import('./lib/smokeArgs.cjs').SmokeOn} SmokeOn */
/**
 * 최상위 검사를 지난 스모크 인자(스모크로 도는가) — 틀린 인자(SmokeInvalid)는 여기까지 오지 않는다.
 * @typedef {import('./lib/smokeArgs.cjs').SmokeOff | SmokeOn} SmokeMode
 */
/**
 * 권한 결정 기록 한 건 — request · check 처리기가 결정마다 한 번 hooks.record 로 넘긴다(스모크가 읽는다).
 * @typedef {object} PermissionRecord
 * @property {'permission-request' | 'permission-check'} kind 어느 처리기의 결정인가
 * @property {string} permission 권한 이름('notifications' 등)
 * @property {string} url 요청자 — request 는 details.requestingUrl, check 는 requestingOrigin('…/' 끝 슬래시)
 * @property {boolean} allowed 허락했다
 */
/**
 * 창을 보인 이유 — 시작(ready-to-show) · 트레이 클릭 · 트레이 메뉴 · 두 번째 실행 · macOS 의 activate.
 * @typedef {'start' | 'tray' | 'menu' | 'second-instance' | 'activate'} ShowReason
 */
/**
 * 창을 숨긴 이유 — 바깥 클릭(blur) · 렌더러의 요청(Esc · ✕) · OS 의 닫기 · 트레이 토글 · 메뉴를 열 때.
 * @typedef {'blur' | 'request' | 'close' | 'toggle' | 'menu'} HideReason
 */
/**
 * 창 보이기 · 숨기기 기록 한 건 — 보이거나 숨길 때마다 이유와 함께 hooks.record 로 넘긴다(스모크가 숨김 이유를 읽는다).
 * @typedef {{ kind: 'window', action: 'show', reason: ShowReason } | { kind: 'window', action: 'hide', reason: HideReason }} WindowRecord
 */
/**
 * 렌더러로 민 채널 기록 한 건 — 보낼 때마다 hooks.record 로 넘긴다(스모크가 전달 횟수를 센다).
 * @typedef {object} SentRecord
 * @property {'sent'} kind
 * @property {keyof typeof import('./lib/pushChannels.cjs').PUSH_CHANNELS} channel 보낸 채널(PUSH_CHANNELS 의 키)
 */
/**
 * 로그인 항목(자동 실행) 요청 기록 한 건 — 켜거나 끄려 할 때마다 hooks.record 로 넘긴다(스모크의 양성 대조).
 * @typedef {object} LoginItemRecord
 * @property {'login-item'} kind
 * @property {boolean} on 켜려 했다(false 는 끄려 했다)
 * @property {boolean} managed 이 실행이 로그인 항목을 관리한다 — false 면 OS 를 부르지 않았다(개발 실행 · 스모크)
 */
/**
 * main 이 hooks.record 로 넘기는 기록 — 탐색 · 권한 결정, 창 보이기 · 숨기기, 렌더러로 민 채널, 로그인 항목 요청.
 * @typedef {NavigationRecord | PermissionRecord | WindowRecord | SentRecord | LoginItemRecord} MainRecord
 */
/**
 * 스모크 실행기의 연결점. 값이 있을 때만 부르고, 결정은 늘 실제 처리기가 내린다 — 바꿔 끼우지 않고 감싸서 기록만 하게 해서
 * 스모크가 실제 코드와 같게 한다(#20 설계 §5.10). 예외는 하나다(D1): 실행기는 app.setLoginItemSettings 를 기록만 하고 앞으로 보내지 않는
 * 대체 함수로 바꿔 끼운다 — 로그인 항목(HKCU Run)은 격리 프로필 밖이라, setLoginItem 의 가드에 버그가 있으면 기록만으로는 이 PC 에
 * 남는 것을 막지 못한다. 트레이 메뉴는 '붙은' 메뉴가 아니라 최신 메뉴를 넘긴다(D4 — Windows 는 메뉴를 트레이에 붙이지 않는다).
 * @typedef {object} MainHooks
 * @property {((entry: MainRecord) => void) | null} record 기록기 — 탐색 · 권한 결정, 창 보이기 · 숨기기, 렌더러로 민 채널, 로그인 항목 요청
 * @property {((href: string) => unknown) | null} open 허용 목록 주소를 여는 함수 — 없으면 시스템 브라우저
 * @property {((win: import('electron').BrowserWindow) => void) | null} beforeLoad 창을 만든 뒤 loadURL 전에 동기로 부른다(수집기)
 * @property {((ipc: import('./lib/ipcGuard.cjs').GuardedIpc) => void) | null} registerIpc 창을 만들기 전, main 채널을 모두 등록한 뒤 부른다
 *   — 스모크 채널(tj-smoke-preload · tj-smoke-csp)과 tj-hide · tj-set-opacity 의 수신 기록(같은 채널의 둘째 리스너)을 더 등록한다
 * @property {((details: import('electron').OnBeforeRequestListenerDetails, callback: (response: import('electron').CallbackResponse) => void) => void) | null} networkGuard
 *   기본 세션의 webRequest.onBeforeRequest 처리기(원격 요청 기록 · 취소)
 * @property {((tray: import('electron').Tray, menu: import('electron').Menu, icon: import('electron').NativeImage) => void) | null} setTray
 *   트레이 메뉴를 만들 때마다(시작 때 한 번 포함) 부른다 — 그 메뉴와 new Tray 에 넘긴 아이콘 그 객체(Windows 의 메뉴는 붙지 않은 메뉴다)
 */

/** 개발 실행의 userData 폴더(%APPDATA% 아래) — 설치한 앱(%APPDATA%/TwelveJanggi)과 저장소 · 단일 인스턴스 잠금을 나눈다. */
const DEV_USER_DATA = 'TwelveJanggi-dev';
/** 빌드 정보 파일 — 렌더러 루트에 있고 색인에는 들지 않는다(렌더러에 내주지 않는다). */
const TRAY_BUILD_FILE = 'tray-build.json';
/** 404 · 405 의 본문. */
const STATUS_TEXT = Object.freeze({ 404: 'Not Found', 405: 'Method Not Allowed' });
/** 설정 저장 예약(ms) — 투명도 슬라이더 · 끌기가 몰아 보내는 변경을 한 번의 쓰기로 묶는다. 앞선 예약은 덮는다. */
const SAVE_DELAY_MS = 300;
/** 잠깐 막힌 쓰기(EPERM · EBUSY · EACCES — 백신 · 색인기가 파일을 쥐고 있다)를 한 번 더 해 보기까지(ms). */
const SAVE_RETRY_MS = 100;
/** 아이콘 자리를 모를 때(트레이가 아직 없다)의 빈 사각형 — placeWindow 는 주 디스플레이 작업영역 오른쪽 아래에 놓는다. */
const NO_TRAY_BOUNDS = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

/** @type {MainHooks} */
const hooks = { record: null, open: null, beforeLoad: null, registerIpc: null, networkGuard: null, setTray: null };

/**
 * 트레이 창 — 하나뿐이고, 닫기는 숨김이라 끝날 때까지 산다. IPC 발신자 검증이 메시지마다 이 창의 webContents 를 묻는다.
 * 창을 만지는 코드는 이 변수를 바로 읽지 않고 liveWindow() 를 거친다.
 * @type {import('electron').BrowserWindow | null}
 */
let trayWindow = null;
/**
 * 트레이 — 모듈 변수로 붙잡아 둔다. 지역 변수면 GC 가 거둬 아이콘이 사라진다.
 * @type {import('electron').Tray | null}
 */
let tray = null;
/** 종료 중인가 — before-quit 에서 켠다. 그 전의 창 닫기는 숨김이다. */
let isQuitting = false;
/**
 * 저장 설정 — ready 뒤 settings.json 에서 읽는다(loadSettings). 창 옵션의 배경(테마) · 투명도 · 고정 · 저장 위치가 읽고, 바꾸기
 * 도우미가 고친 뒤 저장을 예약한다. 읽기 전에는 기본값의 사본이다.
 * @type {import('./lib/settings.cjs').Settings}
 */
let settings = { ...DEFAULT_SETTINGS };
/**
 * 설정 파일 경로(<userData>/settings.json) — 읽은 뒤에만 있다. null 이면 쓰지 않는다(fail-closed 는 읽지도 쓰지도 않는다).
 * @type {string | null}
 */
let settingsFile = null;
/** 쓰지 않은 변경이 있다 — 쓰기가 성공했을 때만 지운다(종료 · 세션 끝의 비우기가 이것을 본다). */
let settingsDirty = false;
/**
 * 저장 예약 · 재시도 타이머.
 * @type {ReturnType<typeof setTimeout> | null}
 */
let saveTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let retryTimer = null;
/**
 * 보이려는 상태 — showWindow 와 창 'show' 가 켜고, hideWindow 가 win.hide() 전에, 창 'hide' 가 끈다. getState() 의 visible 이 이
 * 값이다. win.hide() 안에서 동기로 온 blur(그때 isVisible() 는 아직 참일 수 있다)를 바깥 클릭으로 읽지 않게 한다.
 */
let shownIntent = false;
/** 마지막으로 showWindow 한 때(performance.now()) — blur 유예가 이것부터 잰다. */
let shownAt = -Infinity;
/**
 * 마지막 showWindow 의 이유 — 시작 때 보인 창('start')에는 유예 뒤의 미룬 blur 확인을 하지 않는다.
 * @type {ShowReason | null}
 */
let showReason = null;
/**
 * 바깥 클릭(blur)으로 숨긴 때(performance.now()) — 트레이 좌클릭의 경합 가드(windowPolicy 의 trayClickAction)에 넘길 값이다. 그 밖의
 * 숨김(Esc · ✕ · 토글 · 메뉴)은 기록하지 않는다 — 그 직후의 아이콘 클릭은 삼키지 않는다.
 */
let lastBlurHideAt = -Infinity;
/**
 * 직전 트레이 좌클릭의 결과(windowPolicy 의 trayClickAction) — 트레이 더블클릭이 다시 보일지 정할 때 한 번만 쓴다. 좌클릭이 없었거나 그때 창이
 * 없었거나 이미 썼으면 null 이다.
 * @type {'hide' | 'show' | 'ignore' | null}
 */
let lastTrayClickAction = null;
/**
 * 유예 안의 blur 를 삼킨 뒤, 유예가 끝난 때 한 번 더 보는 타이머 — 숨기거나 다시 보이면 지운다.
 * @type {ReturnType<typeof setTimeout> | null}
 */
let deferredBlurTimer = null;
/**
 * 마지막 배치(또는 받아들인 사용자 이동) 뒤의 창 위치 — moved 가 이것과 견줘 사용자가 옮겼는지 가른다.
 * @type {import('./lib/position.cjs').Point | null}
 */
let moveBaseline = null;
/** placeNow 가 setBounds 하는 중이다 — 그 안에서 동기로 온 moved(macOS 미확인)는 사용자 이동이 아니다. */
let placing = false;
/** 마지막 배치 뒤에 will-move 를 받았다 — 사용자가 끈 이동만 저장한다(will-move 는 setBounds 로는 오지 않는다). */
let manualMoveSeen = false;
/**
 * 화면 모드 — 메뉴의 '혼자 하기' · '온라인 대전' 이 바꾼다(setMode). getState() 의 mode 다.
 * @type {'solo' | 'online'}
 */
let mode = 'solo';
/**
 * 지금 레이아웃 — 렌더러가 tj-set-layout 으로 바꾼다. 배치는 이 레이아웃의 콘텐츠 크기로 한다.
 * @type {import('./lib/layout.cjs').LayoutKey}
 */
let layout = 'solo';
/** 로그인으로 시작했다 — 첫 ready-to-show 에서 창을 숨긴 채 둔다(렌더러는 getState().visible 로 안다). onReady 가 정한다. */
let loginLaunch = false;
/** 첫 ready-to-show 의 판단(보일지 숨긴 채 둘지)을 했다 — 그 전의 macOS activate 는 pendingActivate 로 미룬다. */
let startupDecided = false;
/** 첫 판단 전에 macOS activate 가 왔다 — ready-to-show 에서 로그인 실행이어도 보인다. */
let pendingActivate = false;
/**
 * 트레이 아이콘 — new Tray 에 넘긴 그 객체. 스모크에 메뉴와 함께 넘긴다(hooks.setTray).
 * @type {import('electron').NativeImage | null}
 */
let trayIcon = null;
/**
 * 최신 트레이 메뉴 — refreshTrayMenu 가 만들 때마다 바꾼다. Windows 는 트레이에 붙이지 않고 우클릭 때 이것을 띄운다.
 * @type {import('electron').Menu | null}
 */
let trayMenu = null;

// ── 최상위(ready 전, 동기) — 순서가 의미를 가진다 ──
// 1. 스모크 인자 — userData · 진입 URL 을 정하므로 맨 먼저 읽는다. 틀렸으면(error 는 스모크를 요청했을 때만 있다) 아무것도 하지
//    않고 exit 1 한다. 결과 파일은 쓰지 않는다 — out 경로가 틀린 것일 수 있다.
const smoke = parseSmokeArgs(process.argv);
// 명령줄에 --hidden 이 있다 — Windows 의 로그인 항목이 띄운 실행이다(창 없이 트레이에만 뜬다). 스모크는 늘 아니다(보이는 창으로
// 검사한다). 스모크 인자 옆에서 argv 로만 판별한다 — 순수 함수라 app 을 부르지 않는다.
const hiddenArg = !smoke.enabled && hasHiddenArg(process.argv);
if (smoke.error !== null) {
  logError(`smoke args: ${smoke.error}`);
  app.exit(1);
} else {
  // 2. userData — 스모크 인자 바로 다음, 다른 app 호출보다 먼저 정한다. 단일 인스턴스 잠금이 이 폴더에 걸리므로 잠금보다는 반드시
  //    먼저다: 스모크는 자기 프로필로 떠서 이미 떠 있는 트레이와 따로 돈다. 개발 실행은 TwelveJanggi-dev 로 설치한 앱과 나누고,
  //    패키지는 기본값을 쓴다. getPath('userData') 를 모듈 값으로 잡아 두지 않는다 — setPath 전에 읽은 값은 낡는다.
  //    만들거나 정하지 못하면(권한 · 디스크 · setPath 거부) '[tj] userData: …' 를 남기고 exit 1 한다 — 뒤 단계로 가면 잠금과 저장소가
  //    기본 userData(설치한 앱의 폴더)에 걸린다. 결과 파일은 쓰지 않는다(틀린 인자와 같다).
  const userData = smoke.enabled ? smoke.profile : app.isPackaged ? null : path.join(app.getPath('appData'), DEV_USER_DATA);
  let userDataReady = true;
  if (userData !== null) {
    try {
      fs.mkdirSync(userData, { recursive: true }); // setPath 는 없는 폴더면 던진다(Electron 문서) — 첫 개발 실행 대비
      app.setPath('userData', userData);
    } catch (err) {
      userDataReady = false;
      logError(`userData: ${errorText(err)} (${userData})`);
      app.exit(1);
    }
  }
  if (userDataReady) {
    // 3. 모든 렌더러를 sandbox 로 — ready 뒤에 부르면 throw 한다. 잠금보다 먼저 부른다: argv 에 --no-sandbox 가 있으면 Windows 의
    //    단일 인스턴스 창이 WM_COPYDATA 필터를 푼다(설계 §5.5).
    app.enableSandbox();
    // 4. app:// 특권(D1) — ready 전에만 부를 수 있다. 값은 SCHEME_PRIVILEGES 하나에서만 온다(펼치거나 더하지 않는다).
    protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: SCHEME_PRIVILEGES }]);
    // 5. 단일 인스턴스 — 같은 userData 로 이미 떠 있으면 그쪽이 second-instance 로 창을 보이고 이쪽은 끝난다.
    if (!app.requestSingleInstanceLock()) {
      if (smoke.enabled) {
        const reason = `단일 인스턴스 잠금을 얻지 못했다 — 같은 프로필로 이미 떠 있다 (${smoke.profile})`;
        logError(`lock: ${reason}`);
        failSmoke(smoke, 'lock', reason);
      } else {
        app.quit();
      }
    } else {
      app.on('second-instance', (_event, argv) => onSecondInstance(argv)); // 보이기 · 포커스만 — 화면 상태는 바꾸지 않는다
      app.on('window-all-closed', () => {}); // 트레이 앱 — 창이 없어도 끝나지 않는다
      // 종료 — 이 뒤로는 창을 만지지 않는다(liveWindow 가 null). 미룬 blur 확인을 지우고, 쓰지 않은 설정을 곧바로 쓴다(예약 · 재시도는 지운다).
      app.on('before-quit', () => {
        isQuitting = true;
        clearDeferredBlur();
        flushSettings();
      });
      app.whenReady().then(() => onReady(smoke)).catch((err) => failReady(smoke, err));
    }
  }
}

/**
 * ready 뒤 — 렌더러 루트 검증 · 색인 → (스모크) 실행기 → 설정 읽기(첫 실행이면 자동 실행 기본값) · 로그인 실행 판별 → (macOS) Dock
 * 숨기기 → app:// 처리기 → 세션(권한 · 장치 · 다운로드) → 클라이언트 인증서 → 탐색 가드 → IPC → 창 → 트레이(시작 메뉴) → 디스플레이
 * 사건 → (macOS) activate. 모두 동기다: 처리기는 창보다 먼저, 사이에 await 없이 서서 첫 요청 · 첫 탐색 · 첫 IPC 를 받는다. 던지면
 * whenReady 의 catch(failReady)가 받는다.
 * @param {SmokeMode} smoke
 */
function onReady(smoke) {
  // Windows 의 앱 사용자 모델 ID — 자동 실행 항목 이름과 같은 값이다(상수 하나에서만 온다).
  if (process.platform === 'win32') app.setAppUserModelId(AUTOSTART_NAME);
  Menu.setApplicationMenu(null);

  const root = app.isPackaged ? path.join(process.resourcesPath, 'renderer') : path.join(__dirname, '..', 'dist-tray');
  const renderer = loadRenderer(root);
  if (!renderer.ok) {
    failClosed(smoke, renderer.reason);
    return;
  }

  const { index, cspHeader } = renderer;
  // 아래 설정 읽기 · 처리기 · 창 · 트레이가 hooks 를 읽기 전에 — D1 의 대체 함수도 여기서 선다(첫 실행의 자동 실행 기본값보다 먼저)
  if (smoke.enabled) plugSmokeRun(smoke, root, renderer);
  loadSettings(); // 창 옵션(배경 · 투명도)이 읽는다 — 창보다 먼저
  // 로그인으로 시작했는가(첫 ready-to-show 의 판단) — Windows 는 명령줄의 --hidden 이다(명령줄은 최상위에서만 읽는다 — hiddenArg,
  // 스모크는 늘 거짓). macOS 는 wasOpenedAtLogin 이다(macOS 미확인 — 스모크는 묻지 않는다: 늘 로그인 실행이 아니다), linux 는 늘 아니다.
  const loginItem = process.platform === 'darwin' && !smoke.enabled ? app.getLoginItemSettings() : {};
  loginLaunch = launchedAtLogin({ platform: process.platform, argv: hiddenArg ? [HIDDEN_ARG] : [], loginItem });
  // macOS — 메뉴 막대 앱이라 Dock 아이콘을 두지 않는다. 창을 만들기 전에 숨긴다: 만든 뒤에 숨기면 Dock 이 깜빡인다(macOS 미확인).
  if (process.platform === 'darwin') app.dock?.hide();
  protocol.handle(APP_SCHEME, (request) => serveApp(request, index, cspHeader));
  guardSession();
  app.on('select-client-certificate', selectNoCertificate);
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents));
  registerIpc();
  createWindow(smoke);
  createTray();
  // 보이는 중에 모니터를 떼거나 배율 · 작업영역이 바뀌면 다시 배치한다 — 창이 보이는 디스플레이의 작업영역 안에 남게.
  screen.on('display-removed', () => placeIfShown());
  screen.on('display-metrics-changed', () => placeIfShown());
  // macOS — Finder · Spotlight 로 다시 실행하면 두 번째 프로세스가 아니라 activate 가 온다(Electron 문서). macOS 미확인
  if (process.platform === 'darwin') app.on('activate', () => onActivate());
}

/**
 * 설정을 동기로 읽는다(<userData>/settings.json). 없으면 기본값(첫 실행), 못 읽으면 '[tj] settings: …' 한 줄을 남기고 기본값이다
 * — 못 읽은 파일은 첫 실행이 아니다(settings.cjs 가 autostartDefaultApplied 를 참으로 준다 — 자동 실행 기본값이 되살아나지 않는다).
 * 첫 실행이면 자동 실행 기본값을 적용한다 — Windows 는 켠다(setLoginItem — 로그인 항목을 관리하지 않는 실행이면 기록만 남고 OS 는
 * 부르지 않는다), macOS · 그 밖은 부르지 않고 끈 채 둔다. 그 뒤 적용했다고 표시하고 곧바로 쓴다(개발 · 스모크 프로필에도 — 그 프로필은
 * 로그인 항목을 관리하지 않으므로 해가 없다).
 */
function loadSettings() {
  const file = path.join(app.getPath('userData'), SETTINGS_FILE);
  const loaded = readSettings(file);
  settingsFile = file;
  settings = loaded.settings;
  if (loaded.status === 'unreadable') logError(`settings: 읽지 못해 기본값으로 시작한다 (${file})`);
  if (!settings.autostartDefaultApplied) {
    if (firstRunAutostart(process.platform)) setLoginItem(true);
    else settings.autostart = false;
    settings.autostartDefaultApplied = true;
    settingsDirty = true;
    saveSettingsNow();
  }
}

/**
 * 렌더러 루트에서 처리기가 쓸 값을 만든다 — tray-build.json(검증) · 파일 색인. throw 하지 않는다.
 * 어긋나면 '<무엇>: <왜>' 한 줄이다(stderr · 오류 상자 · 스모크 결과에 같은 글): tray-build.json 을 못 읽음 · 형식이 틀림 ·
 * 루트를 못 훑음 · tray.html 이 없음(유효한 tray-build.json 만 남은 렌더러 루트가 빈 창을 열지 않게).
 * build 는 검증한 tray-build.json 이다(스모크 실행기가 읽는다).
 * @param {string} root
 * @returns {{ ok: true, index: import('./lib/appProtocol.cjs').FileIndex, cspHeader: string, build: import('./lib/trayBuildInfo.cjs').TrayBuildInfo } | { ok: false, reason: string }}
 */
function loadRenderer(root) {
  const buildFile = path.join(root, TRAY_BUILD_FILE);
  /** @type {string} */
  let text;
  try {
    text = fs.readFileSync(buildFile, 'utf8');
  } catch (err) {
    return { ok: false, reason: `${TRAY_BUILD_FILE}: 읽지 못했다 (${errorText(err)})` };
  }
  const build = parseTrayBuild(text);
  if (!build.ok) return { ok: false, reason: `${TRAY_BUILD_FILE}: ${build.error} (${buildFile})` };
  /** @type {import('./lib/appProtocol.cjs').FileIndex} */
  let index;
  try {
    index = buildFileIndex(root);
  } catch (err) {
    return { ok: false, reason: `renderer: 렌더러 루트를 훑지 못했다 (${errorText(err)})` };
  }
  if (!index.files.has(ENTRY_FILE)) return { ok: false, reason: `${ENTRY_FILE}: 렌더러 루트에 없다 (${root})` };
  // CSP 헤더는 검증한 header 판 그대로다 — 기본값 · optional chaining 을 쓰지 않는다('undefined' 가 헤더 글이 되지 않게).
  return { ok: true, index, cspHeader: build.value.csp.header, build: build.value };
}

/**
 * 스모크 실행기(smoke/run.cjs)를 hooks 에 꽂는다 — 스모크에서만 부르고, run.cjs 도 여기서만 require 한다. onReady 가 처리기 · IPC ·
 * 창 · 트레이보다 먼저 부른다(그것들이 hooks 를 읽는다). 무인 실행이라 uncaughtException · unhandledRejection 도 실행기의 fail 로
 * 보낸다 — 결과를 쓰고 exit 1 한다(Electron 의 오류 상자가 런처의 시간 제한까지 막고 있지 않게). 실행기의 플랫폼 갈래는 여기서 넘기는
 * platform 만 따른다(설계 §5.5).
 * @param {SmokeOn} smoke
 * @param {string} root 렌더러 루트
 * @param {{ index: import('./lib/appProtocol.cjs').FileIndex, build: import('./lib/trayBuildInfo.cjs').TrayBuildInfo }} renderer
 */
function plugSmokeRun(smoke, root, renderer) {
  const { createSmokeRun } = require('./smoke/run.cjs');
  const run = createSmokeRun({
    args: smoke,
    app,
    session,
    net,
    trayBuild: renderer.build,
    rendererRoot: root,
    appRoot: __dirname,
    index: renderer.index,
    platform: process.platform,
  });
  process.on('uncaughtException', (err) => run.fail('uncaughtException', err));
  process.on('unhandledRejection', (reason) => run.fail('unhandledRejection', reason));
  hooks.record = run.record;
  hooks.open = run.open;
  hooks.networkGuard = run.networkGuard;
  hooks.registerIpc = run.registerIpc;
  hooks.beforeLoad = run.beforeLoad;
  hooks.setTray = run.setTray;
}

/**
 * 트레이 빌드를 못 읽었다 — 처리기 · 창 · 트레이를 만들지 않고 끝낸다(#20 설계 §5.3 fail-closed). 빈 창 대신 이유를 알린다.
 * stderr 에 '[tj] …' 한 줄 → 스모크는 결과(stage 'tray-build')를 쓰고 exit 1, 아니면 오류 상자 뒤 종료한다 — 트레이 전용 앱이
 * 조용히 끝나면 멈춘 것처럼 보인다.
 * @param {SmokeMode} smoke
 * @param {string} reason '<무엇>: <왜>' 한 줄
 */
function failClosed(smoke, reason) {
  logError(app.isPackaged ? reason : `${reason} — 저장소 루트에서 npm run build:tray 로 트레이 빌드를 만든다`);
  if (smoke.enabled) {
    failSmoke(smoke, 'tray-build', reason);
    return;
  }
  const hint = app.isPackaged ? '' : '\n\n저장소 루트에서 npm run build:tray 를 먼저 실행해 주세요.';
  dialog.showErrorBox('십이장기', `트레이 화면 파일을 읽지 못해 종료해요.\n\n${reason}${hint}`);
  app.quit();
}

/**
 * ready 뒤 시작(onReady)이 던졌다 — 처리기 · 창 · 트레이가 반쯤 선 채 조용히 돌지 않게 끝낸다. 받지 않으면 처리되지 않은 거부로
 * 묻힌다. stderr 에 '[tj] ready: <이유>'(뒤 줄에 스택 — 예상하지 못한 예외라 어디서 던졌는지가 필요하다) → 스모크는 결과(stage
 * 'ready')를 쓰고 exit 1, 아니면 오류 상자(이유) 뒤 종료한다.
 * @param {SmokeMode} smoke
 * @param {unknown} err
 */
function failReady(smoke, err) {
  const reason = errorText(err);
  const stack = err instanceof Error && typeof err.stack === 'string' ? `\n${err.stack}` : '';
  logError(`ready: ${reason}${stack}`);
  if (smoke.enabled) {
    failSmoke(smoke, 'ready', reason);
    return;
  }
  dialog.showErrorBox('십이장기', `십이장기를 시작하지 못해 종료해요.\n\n${reason}`);
  app.quit();
}

/**
 * app:// 요청 하나에 답한다(판정은 resolveAppRequest). throw · reject 하지 않는다 — 무엇이 잘못돼도(파일을 못 읽어도) 404 다.
 * 200 헤더: Content-Type(확장자 표) · Content-Security-Policy(tray-build.json 의 header 판) · nosniff. HEAD 는 본문 없이 보낸다.
 * @param {Request} request
 * @param {import('./lib/appProtocol.cjs').FileIndex} index
 * @param {string} cspHeader
 * @returns {Promise<Response>}
 */
async function serveApp(request, index, cspHeader) {
  try {
    const resolved = resolveAppRequest(request, index);
    if (resolved.status !== 200) return plainResponse(resolved.status, request.method);
    const headers = {
      'content-type': resolved.contentType,
      'content-security-policy': cspHeader,
      'x-content-type-options': 'nosniff',
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(await fs.promises.readFile(resolved.filePath), { status: 200, headers });
  } catch {
    return plainResponse(404);
  }
}

/**
 * 본문이 글 한 줄인 404 · 405(text/plain). HEAD 는 본문 없이 보낸다.
 * @param {404 | 405} status
 * @param {string} [method]
 * @returns {Response}
 */
function plainResponse(status, method) {
  return new Response(method === 'HEAD' ? null : STATUS_TEXT[status], {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}

/**
 * 기본 세션의 처리기 — Electron 은 처리기가 없으면 권한을 모두 허락하고 다운로드를 받는다(permissions.cjs).
 * request · check 가 같은 isPermissionAllowed 로 판정한다: request 는 details.requestingUrl, check 는 requestingOrigin 과
 * (있으면) details.requestingUrl — 없으면 undefined 라 isPermissionAllowed 가 보지 않는다. 결정(callback · 반환값)을 먼저 내고
 * 그 뒤에 기록한다. 장치(HID · USB · 시리얼) 권한은 모두 거부다.
 */
function guardSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const allowed = isPermissionAllowed({ permission, requestingUrl: details.requestingUrl });
    callback(allowed);
    recordEntry({ kind: 'permission-request', permission, url: details.requestingUrl, allowed });
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const allowed = isPermissionAllowed({ permission, requestingOrigin, requestingUrl: details.requestingUrl });
    recordEntry({ kind: 'permission-check', permission, url: requestingOrigin, allowed });
    return allowed;
  });
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', denyDownload);
  if (hooks.networkGuard) ses.webRequest.onBeforeRequest(hooks.networkGuard);
}

/**
 * 기록 한 건을 hooks.record 에 넘긴다(스모크만 단다) — 권한 결정, 창 보이기 · 숨기기, 렌더러로 민 채널, 로그인 항목 요청. 일을 먼저
 * 하고 그 뒤에 부른다. 기록기가 던지면 다음 tick 에 다시 던진다 — 이미 한 일은 그대로이고 오류는 묻히지 않는다(navigation.cjs 의 탐색
 * 결정과 같은 규칙).
 * @param {MainRecord} entry
 */
function recordEntry(entry) {
  const record = hooks.record;
  if (record === null) return;
  try {
    record(entry);
  } catch (err) {
    setImmediate(() => {
      throw err;
    });
  }
}

/**
 * 모든 webContents(트레이 창 · DevTools 등)에 탐색 가드를 건다 — app://twelvejanggi 밖으로 가는 탐색 · 새 창 · webview 를 막고,
 * 허용 목록 주소만 시스템 브라우저로 연다(navigation.cjs — 여는 함수는 트레이 메뉴와 같은 openExternal 이다).
 * @param {import('electron').WebContents} contents
 */
function guardWebContents(contents) {
  const guards = createNavigationGuards({ open: openExternal, record: hooks.record ?? undefined });
  contents.on('will-frame-navigate', guards.willFrameNavigate);
  contents.on('will-navigate', guards.willNavigate);
  contents.on('will-redirect', guards.willRedirect);
  contents.setWindowOpenHandler(guards.windowOpen);
  contents.on('will-attach-webview', guards.willAttachWebview);
}

/**
 * IPC 처리기 — createGuardedIpc 로만 등록한다. 발신자는 메시지마다 트레이 창의 메인 프레임인지 본다(창이 없거나 파괴됐으면 거부).
 * 응답 모양은 src/tray/desktop.ts 의 AppInfo · TrayState 다. 받은 값은 preload 가 고치지 않고 넘기므로 여기 도우미의 정규화가
 * 유일한 방어다(틀린 값은 무시). 순서: main 채널(#21 설계 §5.3 표) 다음 hooks.registerIpc(스모크).
 */
function registerIpc() {
  const ipc = createGuardedIpc(ipcMain, () => (trayWindow !== null && !trayWindow.isDestroyed() ? trayWindow.webContents : null));
  ipc.handle('tj-app-info', () => appInfo());
  ipc.handle('tj-get-state', () => buildSnapshot({ settings, mode, visible: shownIntent }));
  ipc.on('tj-set-theme', (_event, theme) => applyTheme(theme));
  ipc.on('tj-set-opacity', (_event, percent) => applyOpacity(percent));
  ipc.on('tj-set-layout', (_event, key) => applyLayout(key));
  ipc.on('tj-hide', () => hideWindow('request')); // Esc · ✕
  hooks.registerIpc?.(ipc);
}

/**
 * 트레이 창 — 프레임 없는 팝업이다. 숨긴 채 만들고 ready-to-show 에 보인다(로그인으로 시작했으면 숨긴 채 둔다 — 그 전에 macOS 의
 * 다시 실행(activate)이 왔으면 보인다). 닫기는 숨김이다(종료 중이 아닐 때).
 * - 크기는 레이아웃 'solo' 의 콘텐츠 크기, 크기 조절 · 최대화 · 최소화 · 전체 화면 불가(작업표시줄 단추가 없어 최소화하면 되찾을 길이
 *   트레이뿐이다), 작업표시줄에 없고 늘 위다. 투명은 쓰지 않는다 — 투명도는 opacity 로만 한다.
 * - 첫 페인트 전 배경과 투명도는 설정(테마 · opacity)에서 온다. webPreferences 는 공장 하나에서만 온다(스모크와 바이트까지 같다).
 * - macOS 는 만든 뒤 'screen-saver' 단계(메뉴 막대 · Dock 보다 위)로 올린다(macOS 미확인) — alwaysOnTop 의 기본 단계는 floating 이다.
 * - 창 사건: show · hide → 렌더러에 tj-shown · tj-hidden(어느 경로로 보이든 숨든 — OS · 스모크의 직접 호출 포함), blur → 바깥 클릭
 *   숨김, will-move · moved → 사용자가 옮긴 위치 저장, session-end(Windows 의 로그오프 · 종료 — before-quit 이 오지 않는다) → 설정 비우기.
 * - 콘솔 중계는 개발 실행(비패키지 · 비스모크)에서만 단다 — 수집기(hooks.beforeLoad) 뒤에. 패키지는 stdout 이 없고 스모크는 자기
 *   수집기가 있다.
 * @param {SmokeMode} smoke
 */
function createWindow(smoke) {
  const win = new BrowserWindow({
    ...layoutSize('solo'),
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: '십이장기',
    backgroundColor: THEME_BACKGROUND[settings.theme],
    opacity: settings.opacity / 100,
    webPreferences: trayWindowPreferences(path.join(__dirname, 'preload.js')),
  });
  if (process.platform === 'darwin') win.setAlwaysOnTop(true, 'screen-saver'); // macOS 미확인
  trayWindow = win;
  // 첫 판단 — 로그인 실행이면 숨긴 채 둔다. 그 전에 온 macOS activate(다시 실행)는 로그인 실행이어도 보인다.
  win.once('ready-to-show', () => {
    startupDecided = true;
    if (!loginLaunch || pendingActivate) showWindow('start');
  });
  win.on('show', () => {
    shownIntent = true;
    sendToTray('tj-shown');
  });
  win.on('hide', () => {
    shownIntent = false;
    clearDeferredBlur();
    sendToTray('tj-hidden');
  });
  win.on('blur', () => onBlur());
  win.on('will-move', () => {
    manualMoveSeen = true;
  });
  win.on('moved', () => onMoved());
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideWindow('close');
  });
  win.on('session-end', () => flushSettings());
  if (!app.isPackaged && process.env.TJ_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  hooks.beforeLoad?.(win); // 수집기(스모크)는 창과 loadURL 사이에 동기로 붙는다
  if (!app.isPackaged && !smoke.enabled) win.webContents.on('console-message', (details) => relayConsole(details));
  win.loadURL(ENTRY_URL + (smoke.enabled ? '?smoke' : '')).catch((err) => logError(`loadURL: ${errorText(err)}`));
}

/**
 * 트레이 — 아이콘(16×16) · 툴팁 · 시작 메뉴(refreshTrayMenu). Windows 는 좌클릭이 팝업 토글이고(더블클릭은 첫 좌클릭이 보인 창을 지킨다)
 * 우클릭마다 메뉴를 새로 만들어 띄운다(D4 — 메뉴를 붙이면 우클릭을 OS 가 받아 right-click 이 오지 않는다). macOS · 그 밖은 메뉴를 붙이고
 * click 처리기를 달지 않는다(메뉴가 있어도 click 이 함께 와서 토글이 겹친다 — Electron 소스).
 */
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (icon.isEmpty()) logError(`tray icon: 빈 이미지다 — 아이콘을 읽지 못했다 (${iconPath})`);
  trayIcon = icon;
  tray = new Tray(icon);
  tray.setToolTip('십이장기');
  if (process.platform === 'win32') {
    tray.on('click', () => onTrayClick());
    tray.on('double-click', () => onTrayDoubleClick());
    tray.on('right-click', () => onTrayRightClick());
  }
  refreshTrayMenu();
}

/**
 * 트레이 메뉴를 만든다 — 메뉴는 이 함수에서만 만든다. 지금 상태(설정 · 로그인 항목)로 템플릿을 만들어(trayMenu.cjs) Menu 로 바꾸고 최신
 * 메뉴로 둔다. Windows 는 붙이지 않고(우클릭 때 띄운다 — D4) 자동 실행 체크를 그 순간의 OS 상태로 그린다(등록할 때와 같은 인자로 묻는다).
 * macOS · 그 밖은 트레이에 붙이고, macOS 는 메뉴가 열리고 닫힐 때 팝업을 맞춘다(D6). 만든 메뉴는 hooks.setTray 로 알린다(스모크가 최신
 * 메뉴와 아이콘을 본다). 종료 중에는 만들지 않는다.
 */
function refreshTrayMenu() {
  if (tray === null || trayIcon === null || isQuitting) return;
  const platform = process.platform;
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
      open: () => menuThenRefresh(() => showWindow('menu')),
      solo: () => menuThenRefresh(() => setMode('solo')),
      online: () => menuThenRefresh(() => setMode('online')),
      setAutostart: (on) => menuThenRefresh(() => setAutostart(on)),
      setLight: (on) => applyTheme(on ? 'light' : 'dark'), // applyTheme · setPinned · resetPosition 은 끝에서 스스로 다시 만든다
      setPinned: (on) => setPinned(on),
      resetPosition: () => resetPosition(),
      openWeb: () => menuThenRefresh(() => openExternal(WEB_URL)),
      sendFeedback: () => menuThenRefresh(() => openExternal(FEEDBACK_URL)),
      // '종료' 는 app.quit() 만 — 메뉴를 다시 만들지 않고, isQuitting 은 before-quit 이 켠다(스모크가 그 종료 경로를 그대로 탄다).
      quit: () => app.quit(),
    },
  );
  const menu = Menu.buildFromTemplate(/** @type {import('electron').MenuItemConstructorOptions[]} */ (/** @type {unknown} */ (template)));
  if (platform === 'darwin') {
    menu.on('menu-will-show', () => onMenuWillShow());
    menu.on('menu-will-close', () => onMenuWillClose());
  }
  trayMenu = menu;
  if (platform !== 'win32') tray.setContextMenu(menu);
  hooks.setTray?.(tray, menu, trayIcon);
}

/**
 * 메뉴 항목 하나의 동작 뒤에 메뉴를 다시 만든다 — 메뉴를 누를 때마다(바뀐 것이 없어도) 정확히 한 번이다(#21 설계 §5.1). 스스로 다시 만드는
 * applyTheme · setPinned · resetPosition 은 이것을 거치지 않는다.
 * @param {() => void} action
 */
function menuThenRefresh(action) {
  action();
  refreshTrayMenu();
}

/**
 * Windows 좌클릭 — 보이면 숨기고(토글), 바깥 클릭(blur)으로 숨긴 지 CLICK_RACE_MS 안이면 무시하고(그 클릭이 낳은 blur 가 먼저 숨겼다),
 * 그 밖은 보인다(windowPolicy 의 trayClickAction). 경합 가드는 좌클릭에만 건다 — 메뉴 · 두 번째 실행은 늘 보인다.
 */
function onTrayClick() {
  const win = liveWindow();
  if (win === null) {
    lastTrayClickAction = null;
    return;
  }
  const action = trayClickAction({ now: performance.now(), visible: shownIntent && win.isVisible(), lastBlurHideAt });
  lastTrayClickAction = action;
  if (action === 'hide') hideWindow('toggle');
  else if (action === 'show') showWindow('tray');
}

/**
 * Windows 더블클릭 — 둘째 누름에는 click 없이 double-click 만 오고, 그 누름에 작업표시줄이 활성화를 가져가 blur 가 먼저 온다(손 확인). 직전 좌클릭이
 * 창을 보였을 때만 다시 보인다(windowPolicy 의 trayDoubleClickAction): showWindow 가 미룬 blur 확인을 지우고 포커스를 되찾고, 이미 blur 로 숨었으면
 * 다시 보인다. 직전 좌클릭의 결과는 한 번만 쓴다. 창 없음 · 종료 중은 showWindow 의 liveWindow() 가 막는다.
 */
function onTrayDoubleClick() {
  const action = trayDoubleClickAction({ lastClickAction: lastTrayClickAction });
  lastTrayClickAction = null;
  if (action === 'show') showWindow('tray');
}

/**
 * Windows 우클릭 — 메뉴를 그 순간의 상태(자동 실행은 OS 상태)로 새로 만들어 띄운다. 고정 안 한 팝업은 그 전에 blur 로 숨는다(작업표시줄이
 * 활성화를 가져가고 PopUpContextMenu 가 SetForegroundWindow 를 부른다) — 고정한 팝업은 보인 채다. 종료 중에는 띄우지 않는다.
 */
function onTrayRightClick() {
  if (tray === null || isQuitting) return;
  refreshTrayMenu();
  if (trayMenu !== null) tray.popUpContextMenu(trayMenu);
}

/**
 * macOS 의 메뉴가 열린다(D6 — macOS 미확인) — 'screen-saver' 단계의 팝업은 메뉴 막대 메뉴보다 위라 메뉴를 덮는다. 고정 안 한 팝업은
 * 숨기고(이유 'menu' — 바깥 클릭이 아니다), 고정한 팝업은 메뉴가 열린 동안 'floating' 으로 내린다.
 */
function onMenuWillShow() {
  const win = liveWindow();
  if (win === null) return;
  if (settings.pinned) win.setAlwaysOnTop(true, 'floating');
  else hideWindow('menu');
}

/** macOS 의 메뉴가 닫혔다(D6) — 팝업을 'screen-saver' 단계로 되돌린다. */
function onMenuWillClose() {
  const win = liveWindow();
  if (win === null) return;
  win.setAlwaysOnTop(true, 'screen-saver');
}

/**
 * 두 번째 실행 — 명령줄에 --hidden 이 있으면(로그인 항목이 이미 떠 있는 앱을 한 번 더 띄웠다) 아무것도 하지 않고, 아니면 창을 보인다.
 * 화면 모드는 바꾸지 않는다. 첫 ready-to-show 전에 와도 곧바로 보인다(로그인으로 시작한 창도).
 * @param {string[]} argv 두 번째 프로세스의 명령줄
 */
function onSecondInstance(argv) {
  if (hasHiddenArg(argv)) return;
  showWindow('second-instance');
}

/**
 * macOS activate(Finder · Spotlight 로 다시 실행) — 창을 보이기만 한다(모드는 그대로). 첫 판단(ready-to-show) 전이면 기억했다가 그때
 * 보인다 — 그리기 전의 창은 보이지 않는다. macOS 미확인
 */
function onActivate() {
  if (!startupDecided) {
    pendingActivate = true;
    return;
  }
  showWindow('activate');
}

// ── 바깥 · OS 에 닿는 것 — 외부 주소 · 로그인 항목 ──

/**
 * 허용 목록 주소를 시스템 브라우저로 연다 — 탐색 가드와 트레이 메뉴('웹에서 열기' · '의견 보내기')가 이 함수 하나를 쓴다. externalHref 로
 * 거른 값만 연다(밖이면 아무것도 하지 않는다). 스모크는 hooks.open(열지 않고 기록)이고, 아니면 shell.openExternal — 그 실패는 받아서
 * '[tj] openExternal: …' 한 줄로 남긴다: 받지 않으면 unhandledRejection 이고, 버리면 왜 열리지 않았는지 흔적이 없다.
 * @param {string} href
 */
function openExternal(href) {
  const safe = externalHref(href);
  if (safe === null) return;
  if (hooks.open !== null) {
    hooks.open(safe);
    return;
  }
  shell.openExternal(safe).catch((err) => logError(`openExternal: ${errorText(err)}`));
}

/**
 * 이 실행이 로그인 항목을 관리하는가 — 설치본(패키지 · 스모크 아님 · win32 · darwin · 개발 바이너리 아님)만이다(autostart.cjs).
 * 개발 실행 · 스모크는 이 PC 의 로그인 항목을 바꾸지 않는다. 메뉴의 '자동 실행' 도 관리할 때만 켜진 항목이다.
 * @returns {boolean}
 */
function managesLoginItems() {
  return canManageLoginItems({ isPackaged: app.isPackaged, smoke: smoke.enabled, platform: process.platform, execPath: process.execPath });
}

/**
 * 로그인 항목(자동 실행)을 켜거나 끈다 — app.setLoginItemSettings 는 이 함수에서만 부른다(mainSource 시험). 관리하지 않는 실행이면
 * 부르지 않는다. 그 뒤 { kind: 'login-item', on, managed } 를 기록한다(스모크의 양성 대조 — 비스모크는 기록기가 없다).
 * @param {boolean} on
 */
function setLoginItem(on) {
  const managed = managesLoginItems();
  if (managed) {
    const options = loginItemSettings(process.platform, on);
    if (options !== null) app.setLoginItemSettings(options);
  }
  recordEntry({ kind: 'login-item', on, managed });
}

/**
 * 메뉴의 '자동 실행' — on 은 사용자가 본 상자를 누른 결과(원하는 값)다. 로그인 항목을 그 값으로 하고, macOS 는 체크 상태를 설정에 적는다
 * (macOS 미확인 — 시스템 설정에서 지운 것은 모른다). Windows 는 OS 가 원본이라 적지 않는다 — 다시 만드는 메뉴가 OS 상태를 다시 읽는다.
 * @param {boolean} on
 */
function setAutostart(on) {
  setLoginItem(on);
  if (process.platform !== 'darwin') return;
  settings.autostart = on;
  saveSettingsSoon();
}

// ── 트레이 창 — 창은 liveWindow() 로만 만진다 ──

/**
 * 만져도 되는 트레이 창 — 없거나 파괴됐거나 종료 중(before-quit 뒤)이면 null 이다. 트레이 클릭 · 메뉴 · screen 사건 · blur · moved ·
 * 숨기기 · 바꾸기 도우미가 모두 이것을 거친다: 종료 중에 온 클릭 · 디스플레이 사건이 파괴된 창을 만져 던지지 않게.
 * @returns {import('electron').BrowserWindow | null}
 */
function liveWindow() {
  if (isQuitting || trayWindow === null || trayWindow.isDestroyed()) return null;
  return trayWindow;
}

/**
 * 트레이 창을 보이고 앞으로 가져온다 — 보이기는 모두 이 함수다. 시각 · 이유를 먼저 정하고(blur 유예가 읽는다) → 다시 배치(숨긴
 * 동안 모니터 · 해상도 · 아이콘 자리가 바뀌었을 수 있다) → show → focus. macOS 는 그 전에 앱을 앞으로 가져온다(macOS 미확인 — 메뉴
 * 막대 앱은 창을 보여도 앱이 활성화되지 않아 blur 숨김 · Esc 가 듣지 않을 수 있다). 화면(렌더러) 상태는 바꾸지 않는다.
 * @param {ShowReason} reason
 */
function showWindow(reason) {
  const win = liveWindow();
  if (win === null) return;
  shownAt = performance.now();
  showReason = reason;
  shownIntent = true;
  clearDeferredBlur();
  placeNow(layoutSize(layout));
  if (process.platform === 'darwin') app.focus({ steal: true }); // macOS 미확인
  win.show();
  win.focus();
  recordEntry({ kind: 'window', action: 'show', reason });
}

/**
 * 트레이 창을 숨긴다 — 숨기기는 모두 이 함수다. 보이려는 상태를 win.hide() 전에 끈다: 그 안에서 동기로 오는 blur 를 바깥 클릭으로
 * 읽지 않게(그러면 Esc · ✕ 숨김이 blur 숨김으로 기록돼 경합 가드가 다음 트레이 클릭을 삼킨다). blur 로 숨긴 때만 시각을 남긴다.
 * @param {HideReason} reason
 */
function hideWindow(reason) {
  const win = liveWindow();
  if (win === null) return;
  shownIntent = false;
  clearDeferredBlur();
  win.hide();
  if (reason === 'blur') lastBlurHideAt = performance.now();
  recordEntry({ kind: 'window', action: 'hide', reason });
}

/**
 * blur — 보이려는 상태로 보이는 창이 포커스를 잃었다. 유예 · 고정 · DevTools 가 아니면 바깥 클릭이라 숨긴다(shouldHideOnBlur).
 * 유예 안에서 삼킨 blur 뒤에는 blur 가 다시 오지 않으므로, 시작 때 보인 창이 아니면 유예가 끝난 때(shownAt + 유예 + 1) 한 번 더
 * 본다. 시작 때 보인 창은 빼는 이유: 실행 직후의 blur 까지 숨기면 처음 뜬 팝업이 깜빡이고 사라진다.
 */
function onBlur() {
  const win = liveWindow();
  if (win === null || !shownIntent || !win.isVisible()) return;
  const now = performance.now();
  const devToolsOpen = win.webContents.isDevToolsOpened();
  if (shouldHideOnBlur({ now, shownAt, pinned: settings.pinned, devToolsOpen, visible: true })) {
    hideWindow('blur');
    return;
  }
  const withinGrace = now - shownAt <= BLUR_GRACE_MS;
  if (withinGrace && showReason !== 'start' && deferredBlurTimer === null) {
    deferredBlurTimer = setTimeout(checkDeferredBlur, shownAt + BLUR_GRACE_MS + 1 - now);
  }
}

/** 유예가 끝난 때의 확인 — 아직 보이고 · 포커스가 없고 · 고정이 아니고 · DevTools 가 닫혀 있으면 숨긴다(deferredBlurAction). */
function checkDeferredBlur() {
  deferredBlurTimer = null;
  const win = liveWindow();
  if (win === null) return;
  const action = deferredBlurAction({
    visible: shownIntent && win.isVisible(),
    focused: win.isFocused(),
    pinned: settings.pinned,
    devToolsOpen: win.webContents.isDevToolsOpened(),
  });
  if (action === 'hide') hideWindow('blur');
}

/** 미룬 blur 확인을 지운다 — 숨기거나 다시 보이거나 종료할 때. */
function clearDeferredBlur() {
  if (deferredBlurTimer === null) return;
  clearTimeout(deferredBlurTimer);
  deferredBlurTimer = null;
}

/**
 * 창을 놓는다 — 배치는 모두 이 함수다(placeWindow 가 계산한다). 저장 위치가 있으면 그 위치와 가장 많이 겹치는 디스플레이(떼어 낸
 * 모니터면 남은 디스플레이)의 작업영역 안으로, 없으면 아이콘이 있는 디스플레이(아이콘 자리를 모르면 주 디스플레이)에서 아이콘 쪽에
 * 붙인다. 놓는 동안(setBounds 안의 동기 moved — macOS 미확인)은 사용자 이동이 아니고, 놓은 뒤의 위치가 이동 판별의 기준이 된다.
 * 위치와 함께 레이아웃 크기를 넘긴다: 위치만 넘기면 Electron 이 빠진 크기를 getBounds() 로 채우는데, Windows 소수 배율에서는
 * DIP↔픽셀 반올림이 바깥쪽이라 열 때마다 창이 조금씩 자란다(스모크 실측 510×603 → 516×606).
 * @param {import('./lib/position.cjs').Size} size 콘텐츠 크기(프레임 없는 창이라 창 크기와 같다)
 */
function placeNow(size) {
  const win = liveWindow();
  if (win === null) return;
  placing = true;
  try {
    const trayBounds = tray === null ? NO_TRAY_BOUNDS : tray.getBounds();
    const trayDisplay = isEmptyRect(trayBounds) ? screen.getPrimaryDisplay() : screen.getDisplayMatching(trayBounds);
    const saved = settings.position;
    const savedDisplay = saved === null ? null : screen.getDisplayMatching({ ...saved, ...size });
    win.setBounds({ ...placeWindow({ size, saved, savedDisplay, trayBounds, trayDisplay }), width: size.width, height: size.height });
  } finally {
    moveBaseline = win.getBounds();
    manualMoveSeen = false;
    placing = false;
  }
}

/** 디스플레이가 바뀌었다(떼기 · 배율 · 작업영역) — 보이는 중이면 다시 배치한다. 숨긴 창은 다음 표시가 배치한다. */
function placeIfShown() {
  const win = liveWindow();
  if (win === null || !shownIntent || !win.isVisible()) return;
  placeNow(layoutSize(layout));
}

/**
 * moved — 마지막 배치 뒤 will-move 를 받았고(사용자가 끈 이동) 기준에서 허용 오차보다 벗어났으면, 그 위치를 저장 위치로 삼고
 * 기준을 그 자리로 옮긴 뒤 저장을 예약한다. macOS 의 moved 는 move 의 별칭이라(macOS 미확인) 끄는 동안 계속 온다 — 저장 예약이 쓰기를 묶는다.
 * 메뉴는 '위치 초기화' 의 켜짐이 바뀔 때(저장 위치가 처음 생길 때)만 다시 만든다 — 끄는 동안 메뉴를 거듭 만들지 않게.
 */
function onMoved() {
  const win = liveWindow();
  if (win === null) return;
  const current = win.getBounds();
  if (!shouldSaveMove({ placing, manualMoveSeen, current, baseline: moveBaseline })) return;
  const hadCustomPosition = settings.position !== null;
  settings.position = { x: current.x, y: current.y };
  moveBaseline = current;
  saveSettingsSoon();
  if (!hadCustomPosition) refreshTrayMenu();
}

/**
 * 렌더러로 민다 — main→렌더러 전달은 모두 이 함수다(webContents.send 는 여기에만 있다 — mainSource 시험). PUSH_CHANNELS 의 채널만
 * 보내고, 창이 없거나 파괴됐거나 종료 중이면 아무것도 하지 않는다. 보낸 뒤 { kind: 'sent', channel } 을 기록한다(스모크가 전달을
 * 센다). 구독보다 먼저 온 send 는 사라진다 — 늦게 붙은 화면은 getState() 로 같은 상태를 얻는다.
 * @param {keyof typeof PUSH_CHANNELS} channel
 * @param {unknown} [value] 없으면 값 없이 보낸다(tj-shown · tj-hidden)
 */
function sendToTray(channel, value) {
  if (!Object.hasOwn(PUSH_CHANNELS, channel)) return;
  const win = liveWindow();
  if (win === null) return;
  if (value === undefined) win.webContents.send(channel);
  else win.webContents.send(channel, value);
  recordEntry({ kind: 'sent', channel });
}

// ── 설정 바꾸기 — 메뉴와 팝업이 같은 함수를 부른다. 받지 않는 값은 무시한다(정규화는 여기 한 곳) ──

/**
 * 테마 — 설정 · 저장 예약 → 창 배경(첫 페인트 전 색과 같은 표) → 렌더러에 tj-theme → 메뉴 다시 만들기('라이트 모드' 체크). 같은 값이어도
 * 한다(낡은 메뉴의 클릭도 메뉴를 새로 만든다).
 * @param {unknown} theme
 */
function applyTheme(theme) {
  const value = normalizeTheme(theme);
  if (value === null) return;
  const win = liveWindow();
  if (win === null) return;
  settings.theme = value;
  saveSettingsSoon();
  win.setBackgroundColor(THEME_BACKGROUND[value]);
  sendToTray('tj-theme', value);
  refreshTrayMenu();
}

/**
 * 투명도(30–100, 반올림 · 자름) — 창 투명도 → 설정 · 저장 예약 → 렌더러에 tj-opacity(자른 값).
 * @param {unknown} percent
 */
function applyOpacity(percent) {
  const value = normalizeOpacity(percent);
  if (value === null) return;
  const win = liveWindow();
  if (win === null) return;
  win.setOpacity(value / 100);
  settings.opacity = value;
  saveSettingsSoon();
  sendToTray('tj-opacity', value);
}

/**
 * 레이아웃 — 콘텐츠 크기를 바꾼 뒤 다시 배치한다(저장 위치는 왼쪽 위 유지, 기본 위치는 아이콘 쪽에 다시 붙인다). 저장하지 않는다.
 * @param {unknown} key
 */
function applyLayout(key) {
  const value = normalizeLayout(key);
  if (value === null) return;
  const win = liveWindow();
  if (win === null) return;
  layout = value;
  const size = layoutSize(value);
  win.setContentSize(size.width, size.height);
  placeNow(size);
}

/**
 * 화면 모드 — 메뉴의 '혼자 하기' · '온라인 대전' 에서만 부른다. 렌더러가 tj-shown 보다 tj-mode 를 먼저 받게 보낸 뒤 보인다.
 * @param {'solo' | 'online'} next
 */
function setMode(next) {
  if (liveWindow() === null) return;
  mode = next;
  sendToTray('tj-mode', next);
  showWindow('menu');
}

/**
 * 창 고정(바깥을 눌러도 숨지 않는다) — 설정 · 저장 예약 → 메뉴 다시 만들기('창 고정' 체크). 유예 안에서 삼킨 blur 의 미룬 확인은 그때의
 * 고정을 읽는다.
 * @param {boolean} on
 */
function setPinned(on) {
  if (liveWindow() === null) return;
  settings.pinned = on;
  saveSettingsSoon();
  refreshTrayMenu();
}

/**
 * 위치 초기화 — 저장 위치를 지우고 저장을 예약한다. 보이는 중이면 곧바로 아이콘 쪽에 다시 놓는다(다음 표시는 늘 다시 배치한다). 그 뒤
 * 메뉴를 다시 만든다('위치 초기화' 꺼짐).
 */
function resetPosition() {
  if (liveWindow() === null) return;
  settings.position = null;
  saveSettingsSoon();
  placeIfShown();
  refreshTrayMenu();
}

/**
 * 숨긴 창의 렌더러 스로틀(기본 켬) — 끄면 숨겨도 visibilityState 가 visible 로 남고 프레임을 계속 그린다(렌더러는 tj-hidden 으로만 멈춘다).
 * @param {boolean} on
 */
function setThrottling(on) {
  const win = liveWindow();
  if (win === null) return;
  win.webContents.setBackgroundThrottling(on);
}

// ── 설정 쓰기 ──

/** 저장을 예약한다(SAVE_DELAY_MS 뒤 한 번) — 앞선 예약 · 재시도는 덮는다. 예약이 마지막 값을 쓴다. */
function saveSettingsSoon() {
  settingsDirty = true;
  clearSaveTimers();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSettingsFile(true);
  }, SAVE_DELAY_MS);
}

/** 지금 쓴다(첫 실행 표시 직후) — 예약 · 재시도를 지우고 쓴다. 잠깐 막힌 쓰기면 SAVE_RETRY_MS 뒤 한 번 더 해 본다. */
function saveSettingsNow() {
  clearSaveTimers();
  writeSettingsFile(true);
}

/**
 * 비우기 — before-quit 과 창의 session-end(Windows 의 로그오프 · 종료에서는 before-quit 이 오지 않는다). 예약 · 재시도를 지우고,
 * 쓰지 않은 변경이 있으면 곧바로 쓴다. 기다릴 수 없으므로 다시 해 보지 않는다(실패는 한 줄로 남긴다).
 */
function flushSettings() {
  clearSaveTimers();
  if (settingsDirty) writeSettingsFile(false);
}

/**
 * 설정 파일을 한 번 쓴다(settings.cjs — 임시 파일에 쓰고 rename). 성공해야만 settingsDirty 를 지운다. rename 이 잠깐 막혔고
 * (EPERM · EBUSY · EACCES) retry 면 SAVE_RETRY_MS 뒤 한 번 더 해 본다. 그 밖의 실패는 '[tj] settings: …' 한 줄이다 — 변경은 남아
 * 다음 저장 · 비우기가 다시 쓴다.
 * @param {boolean} retry
 */
function writeSettingsFile(retry) {
  const file = settingsFile;
  if (file === null) return;
  const error = writeSettings(file, settings);
  if (error === null) {
    settingsDirty = false;
    return;
  }
  if (retry && isRetryableWriteError(error)) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      writeSettingsFile(false);
    }, SAVE_RETRY_MS);
    return;
  }
  logError(`settings: ${error.message} (${file})`);
}

/** 저장 예약 · 재시도 타이머를 지운다. */
function clearSaveTimers() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  if (retryTimer !== null) clearTimeout(retryTimer);
  saveTimer = null;
  retryTimer = null;
}

/**
 * 개발 실행의 콘솔 중계 — 페이지의 콘솔 한 줄을 stderr 에 동기로 쓴다(fd 2). consoleLine() 의 출력만 쓴다: 제어 문자 · 줄바꿈을
 * 바꿔 터미널을 건드리는 글자(ESC · OSC 52)와 가짜 '[tj]' 줄이 나가지 않는다. stderr 가 없으면 버린다.
 * @param {{ level: unknown, message: unknown, sourceId: unknown, lineNumber: unknown }} details console-message 의 첫 인자(새 모양)
 */
function relayConsole(details) {
  try {
    fs.writeSync(2, `${consoleLine(details)}\n`);
  } catch {
    // 쓸 곳이 없다
  }
}

/**
 * 앱 정보 — tj-app-info 의 응답이다(src/tray/desktop.ts 의 AppInfo). 스모크 결과의 versions(smokeVersions)와는 다른 계약이다.
 * @returns {{ version: string, electron: string, chrome: string, platform: string }}
 */
function appInfo() {
  return { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform };
}

/**
 * 스모크 결과의 versions — 결과 파일마다 이 모양이다(smokeOut.cjs 의 SmokeVersions).
 * @returns {import('./lib/smokeOut.cjs').SmokeVersions}
 */
function smokeVersions() {
  return { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, app: app.getVersion() };
}

/**
 * 스모크의 실패 단계(lock · tray-build · ready) — 결과를 쓰고 exit 1 한다. 결과를 못 써도 exit 1 이다(런처는 결과가 없으면 실패로
 * 본다).
 * @param {SmokeOn} smoke
 * @param {'lock' | 'tray-build' | 'ready'} stage
 * @param {string} error
 */
function failSmoke(smoke, stage, error) {
  try {
    writeResultAtomic(smoke.outDir, failureResult({ nonce: smoke.nonce, stage, error, versions: smokeVersions() }));
  } catch (err) {
    logError(`smoke result: ${errorText(err)}`);
  }
  app.exit(1);
}

/**
 * stderr 에 '[tj] …' 한 줄을 동기로 쓴다(fd 2) — 바로 뒤에 exit 해도 잃지 않는다(파이프가 비동기인 플랫폼 포함).
 * stderr 가 없으면(콘솔 없이 띄운 GUI 실행) 버린다.
 * @param {string} message
 */
function logError(message) {
  try {
    fs.writeSync(2, `[tj] ${message}\n`);
  } catch {
    // 쓸 곳이 없다
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
