'use strict';
// 십이장기 트레이 앱의 main 프로세스(설계 §5.5 · §5.7). 트레이 빌드(개발 <repo>/dist-tray · 패키지 resources/renderer)를
// app://twelvejanggi/tray.html 로 연다. 판정은 lib/ 의 순수 모듈이 하고(시험도 거기서 한다), 이 파일은 Electron 에 잇기만 한다.
// - 최상위(ready 전, 동기)는 순서가 의미를 가진다: 스모크 인자 → userData → enableSandbox → 스킴 특권 → 단일 인스턴스 잠금.
// - tray-build.json 이 없거나 틀리거나 tray.html 이 없으면 fail-closed 다 — 처리기 · 창 · 트레이를 만들지 않고 알린 뒤 끝낸다.
// - IPC 처리기는 createGuardedIpc 로만 등록한다(ipcMain 의 등록 함수를 직접 부르지 않는다). 처리기는 모두 창을 만들기 전에,
//   사이에 await 없이 건다. 배선은 두 시험이 본다 — desktop/lib/mainSource.test.ts 는 이 파일의 글로, mainWiring.test.ts 는
//   가짜 electron 위에서 이 파일을 돌려서.
// - hooks 는 스모크 실행기(설계 §5.10)의 연결점이다. 비스모크에서는 모두 null 이라 없는 것처럼 동작한다.

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { APP_SCHEME, ENTRY_FILE, ENTRY_URL, SCHEME_PRIVILEGES, buildFileIndex, resolveAppRequest } = require('./lib/appProtocol.cjs');
const { createGuardedIpc } = require('./lib/ipcGuard.cjs');
const { createNavigationGuards } = require('./lib/navigation.cjs');
const { denyDownload, isPermissionAllowed, selectNoCertificate } = require('./lib/permissions.cjs');
const { parseSmokeArgs } = require('./lib/smokeArgs.cjs');
const { failureResult, writeResultAtomic } = require('./lib/smokeOut.cjs');
const { parseTrayBuild } = require('./lib/trayBuildInfo.cjs');
const { trayWindowPreferences } = require('./lib/windowPrefs.cjs');

/** @typedef {import('./lib/navigation.cjs').NavigationRecord} NavigationRecord */
/** @typedef {import('./lib/smokeArgs.cjs').SmokeOn} SmokeOn */
/**
 * 최상위 검사를 지난 스모크 인자 — 틀린 인자(SmokeInvalid)는 여기까지 오지 않는다.
 * @typedef {import('./lib/smokeArgs.cjs').SmokeOff | SmokeOn} SmokeRun
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
 * 스모크 실행기의 연결점. 값이 있을 때만 부르고, 결정은 늘 실제 처리기가 내린다 — 바꿔 끼우지 않고 감싸서 기록만 하게 해서
 * 스모크가 실제 코드와 같게 한다(설계 §5.10).
 * @typedef {object} MainHooks
 * @property {((entry: NavigationRecord | PermissionRecord) => void) | null} record 권한 · 탐색 결정 기록기
 * @property {((href: string) => unknown) | null} open 허용 목록 주소를 여는 함수 — 없으면 시스템 브라우저
 * @property {((win: import('electron').BrowserWindow) => void) | null} beforeLoad 창을 만든 뒤 loadURL 전에 동기로 부른다(수집기)
 * @property {((ipc: import('./lib/ipcGuard.cjs').GuardedIpc) => void) | null} registerIpc tj-app-info 다음에 IPC 를 더 등록한다
 * @property {((details: import('electron').OnBeforeRequestListenerDetails, callback: (response: import('electron').CallbackResponse) => void) => void) | null} networkGuard
 *   기본 세션의 webRequest.onBeforeRequest 처리기(원격 요청 기록 · 취소)
 * @property {((tray: import('electron').Tray, menu: import('electron').Menu) => void) | null} setTray 트레이에 메뉴를 붙일 때마다 부른다
 */

/** 개발 실행의 userData 폴더(%APPDATA% 아래) — 설치한 앱(%APPDATA%/TwelveJanggi)과 저장소 · 단일 인스턴스 잠금을 나눈다. */
const DEV_USER_DATA = 'TwelveJanggi-dev';
/** 빌드 정보 파일 — 렌더러 루트에 있고 색인에는 들지 않는다(렌더러에 내주지 않는다). */
const TRAY_BUILD_FILE = 'tray-build.json';
/** 404 · 405 의 본문. */
const STATUS_TEXT = Object.freeze({ 404: 'Not Found', 405: 'Method Not Allowed' });

/** @type {MainHooks} */
const hooks = { record: null, open: null, beforeLoad: null, registerIpc: null, networkGuard: null, setTray: null };

/**
 * 트레이 창 — 하나뿐이고, 닫기는 숨김이라 끝날 때까지 산다. IPC 발신자 검증이 메시지마다 이 창의 webContents 를 묻는다.
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

// ── 최상위(ready 전, 동기) — 순서가 의미를 가진다 ──
// 1. 스모크 인자 — userData · 진입 URL 을 정하므로 맨 먼저 읽는다. 틀렸으면(error 는 스모크를 요청했을 때만 있다) 아무것도 하지
//    않고 exit 1 한다. 결과 파일은 쓰지 않는다 — out 경로가 틀린 것일 수 있다.
const smoke = parseSmokeArgs(process.argv);
if (smoke.error !== null) {
  logError(`smoke args: ${smoke.error}`);
  app.exit(1);
} else {
  // 2. userData — 스모크 인자 바로 다음, 다른 app 호출보다 먼저 정한다. 단일 인스턴스 잠금이 이 폴더에 걸리므로 잠금보다는 반드시
  //    먼저다: 스모크는 자기 프로필로 떠서 이미 떠 있는 트레이와 따로 돈다. 개발 실행은 TwelveJanggi-dev 로 설치한 앱과 나누고,
  //    패키지는 기본값을 쓴다. getPath('userData') 를 모듈 값으로 잡아 두지 않는다 — setPath 전에 읽은 값은 낡는다.
  const userData = smoke.enabled ? smoke.profile : app.isPackaged ? null : path.join(app.getPath('appData'), DEV_USER_DATA);
  if (userData !== null) {
    fs.mkdirSync(userData, { recursive: true }); // setPath 는 없는 폴더면 던진다(Electron 문서) — 첫 개발 실행 대비
    app.setPath('userData', userData);
  }
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
    app.on('second-instance', showWindow); // 보이기 · 포커스만 — 화면 상태는 바꾸지 않는다
    app.on('window-all-closed', () => {}); // 트레이 앱 — 창이 없어도 끝나지 않는다
    app.on('before-quit', () => {
      isQuitting = true;
    });
    app.whenReady().then(() => onReady(smoke));
  }
}

/**
 * ready 뒤 — 렌더러 루트 검증 · 색인 → app:// 처리기 → 세션(권한 · 장치 · 다운로드) → 클라이언트 인증서 → 탐색 가드 → IPC →
 * 창 → 트레이. 모두 동기다: 처리기는 창보다 먼저, 사이에 await 없이 서서 첫 요청 · 첫 탐색 · 첫 IPC 를 받는다.
 * @param {SmokeRun} smoke
 */
function onReady(smoke) {
  if (process.platform === 'win32') app.setAppUserModelId('com.khkim.twelvejanggi');
  Menu.setApplicationMenu(null);

  const root = app.isPackaged ? path.join(process.resourcesPath, 'renderer') : path.join(__dirname, '..', 'dist-tray');
  const renderer = loadRenderer(root);
  if (!renderer.ok) {
    failClosed(smoke, renderer.reason);
    return;
  }

  const { index, cspHeader } = renderer;
  protocol.handle(APP_SCHEME, (request) => serveApp(request, index, cspHeader));
  guardSession();
  app.on('select-client-certificate', selectNoCertificate);
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents));
  registerIpc();
  createWindow(smoke);
  createTray();
}

/**
 * 렌더러 루트에서 처리기가 쓸 값을 만든다 — tray-build.json(검증) · 파일 색인. throw 하지 않는다.
 * 어긋나면 '<무엇>: <왜>' 한 줄이다(stderr · 오류 상자 · 스모크 결과에 같은 글): tray-build.json 을 못 읽음 · 형식이 틀림 ·
 * 루트를 못 훑음 · tray.html 이 없음(유효한 tray-build.json 만 남은 렌더러 루트가 빈 창을 열지 않게).
 * @param {string} root
 * @returns {{ ok: true, index: import('./lib/appProtocol.cjs').FileIndex, cspHeader: string } | { ok: false, reason: string }}
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
  return { ok: true, index, cspHeader: build.value.csp.header };
}

/**
 * 트레이 빌드를 못 읽었다 — 처리기 · 창 · 트레이를 만들지 않고 끝낸다(설계 §5.3 fail-closed). 빈 창 대신 이유를 알린다.
 * stderr 에 '[tj] …' 한 줄 → 스모크는 결과(stage 'tray-build')를 쓰고 exit 1, 아니면 오류 상자 뒤 종료한다 — 트레이 전용 앱이
 * 조용히 끝나면 멈춘 것처럼 보인다.
 * @param {SmokeRun} smoke
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
    recordDecision({ kind: 'permission-request', permission, url: details.requestingUrl, allowed });
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const allowed = isPermissionAllowed({ permission, requestingOrigin, requestingUrl: details.requestingUrl });
    recordDecision({ kind: 'permission-check', permission, url: requestingOrigin, allowed });
    return allowed;
  });
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', denyDownload);
  if (hooks.networkGuard) ses.webRequest.onBeforeRequest(hooks.networkGuard);
}

/**
 * 권한 결정을 hooks.record 에 넘긴다(스모크만 단다). 기록기가 던지면 다음 tick 에 다시 던진다 — 이미 낸 결정은 그대로이고
 * 오류는 묻히지 않는다(navigation.cjs 의 탐색 결정과 같은 규칙).
 * @param {PermissionRecord} entry
 */
function recordDecision(entry) {
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
 * 허용 목록 주소만 시스템 브라우저로 연다(navigation.cjs). 여는 함수의 실패는 받아서 '[tj] openExternal: …' 한 줄로 남긴다 —
 * 받지 않으면 unhandledRejection 이고, 버리면 링크가 왜 열리지 않았는지 흔적이 없다.
 * @param {import('electron').WebContents} contents
 */
function guardWebContents(contents) {
  const guards = createNavigationGuards({
    open: hooks.open ?? ((href) => shell.openExternal(href).catch((err) => logError(`openExternal: ${errorText(err)}`))),
    record: hooks.record ?? undefined,
  });
  contents.on('will-frame-navigate', guards.willFrameNavigate);
  contents.on('will-navigate', guards.willNavigate);
  contents.on('will-redirect', guards.willRedirect);
  contents.setWindowOpenHandler(guards.windowOpen);
  contents.on('will-attach-webview', guards.willAttachWebview);
}

/**
 * IPC 처리기 — createGuardedIpc 로만 등록한다. 발신자는 메시지마다 트레이 창의 메인 프레임인지 본다(창이 없거나 파괴됐으면 거부).
 * tj-app-info 의 응답 모양은 src/tray/desktop.ts 의 AppInfo 다.
 */
function registerIpc() {
  const ipc = createGuardedIpc(ipcMain, () => (trayWindow !== null && !trayWindow.isDestroyed() ? trayWindow.webContents : null));
  ipc.handle('tj-app-info', () => appInfo());
  hooks.registerIpc?.(ipc);
}

/**
 * 트레이 창 — 숨긴 채 만들고 ready-to-show 에 보인다. 닫기는 숨김이다(종료 중이 아닐 때). 340×400 콘텐츠, 크기 조절 불가,
 * OS 프레임 유지. webPreferences 는 공장 하나에서만 온다(스모크와 바이트까지 같다).
 * @param {SmokeRun} smoke
 */
function createWindow(smoke) {
  const win = new BrowserWindow({
    width: 340,
    height: 400,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    show: false,
    title: '십이장기',
    backgroundColor: '#0d1117',
    webPreferences: trayWindowPreferences(path.join(__dirname, 'preload.js')),
  });
  trayWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });
  if (!app.isPackaged && process.env.TJ_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  hooks.beforeLoad?.(win); // 수집기(스모크)는 창과 loadURL 사이에 동기로 붙는다
  win.loadURL(ENTRY_URL + (smoke.enabled ? '?smoke' : '')).catch((err) => logError(`loadURL: ${errorText(err)}`));
}

/** 트레이 — 아이콘(16×16) · 툴팁 · 메뉴('열기' · '종료'). Windows 에서는 좌클릭도 열기다. */
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (icon.isEmpty()) logError(`tray icon: 빈 이미지다 — 아이콘을 읽지 못했다 (${iconPath})`);
  tray = new Tray(icon);
  tray.setToolTip('십이장기');
  attachTrayMenu(tray, [
    { label: '열기', click: showWindow },
    // isQuitting 은 before-quit 이 켠다 — 여기서 미리 켜지 않는다(스모크가 그 종료 경로를 그대로 탄다).
    { label: '종료', click: () => app.quit() },
  ]);
  if (process.platform === 'win32') tray.on('click', showWindow);
}

/**
 * 트레이에 메뉴를 붙이고, 붙인 메뉴를 hooks.setTray 로 알린다. 트레이 메뉴는 이 도우미로만 붙인다 — 스모크는 여기서 받은
 * '실제로 붙은' 메뉴의 항목을 누른다.
 * @param {import('electron').Tray} target
 * @param {import('electron').MenuItemConstructorOptions[]} template
 */
function attachTrayMenu(target, template) {
  const menu = Menu.buildFromTemplate(template);
  target.setContextMenu(menu);
  hooks.setTray?.(target, menu);
}

/** 트레이 창을 보이고 앞으로 가져온다('열기' · 트레이 좌클릭 · second-instance). 화면(렌더러) 상태는 바꾸지 않는다. */
function showWindow() {
  const win = trayWindow;
  if (win === null || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * 앱 정보 — tj-app-info 의 응답이다(src/tray/desktop.ts 의 AppInfo). 스모크 결과의 versions(smokeVersions)와는 다른 계약이다.
 * @returns {{ version: string, electron: string, chrome: string, platform: string }}
 */
function appInfo() {
  return { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform };
}

/**
 * 스모크 결과의 versions — 결과 파일마다 이 모양이다(smokeOut.cjs 의 SmokeVersions = 계획 Task 8 의 SmokeResult.versions).
 * @returns {import('./lib/smokeOut.cjs').SmokeVersions}
 */
function smokeVersions() {
  return { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, app: app.getVersion() };
}

/**
 * 스모크의 실패 단계(lock · tray-build) — 결과를 쓰고 exit 1 한다. 결과를 못 써도 exit 1 이다(런처는 결과가 없으면 실패로 본다).
 * @param {SmokeOn} smoke
 * @param {'lock' | 'tray-build'} stage
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
