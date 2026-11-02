# desktop — 십이장기 트레이 앱 (Electron)

웹과 같은 코드(`src/core` · `src/engine` · `src/store` · `src/ui`)로 만든 트레이 빌드(`dist-tray/`)를
`app://twelvejanggi/tray.html` 로 여는 Electron 셸입니다. 지금은 **골격**(#20)이라 창에는 제목과 자리표시 한 문단뿐이고,
산출물은 화면이 아니라 **증명**입니다 — AI 모듈 워커 · CSP · 보안 기본선이 `app://` 출처에서 실제로 동작하는지를
PR 마다 스모크가 확인합니다. 화면은 #24 · #25, 창 동작 · 메뉴는 #21, 설치 파일 · 업데이트는 #22, 전용 아이콘은 #23 이 잇습니다.

- **Windows 만 검증했습니다.** macOS · Linux 의 트레이는 확인하지 않았습니다.
- 필요한 것: Node 22.12 이상(`package.json` 의 `engines` — Electron 44 패키지의 하한과 같습니다), 저장소 루트에서 `npm ci`.
- 이 폴더의 규칙(출처 동결 · 특권 · 처리기 · 가드 · 최상위 순서 …)은 루트 [`CLAUDE.md`](../CLAUDE.md) 의 '트레이 앱' 절에 있습니다.

## 구조

```
desktop/
  main.js              main 프로세스 — app:// 처리기 · 창 · 트레이 · 단일 인스턴스 · 보안 처리기를 잇는다
  preload.js           window.tjDesktop = { getAppInfo } (tray.html?smoke 일 때만 CSP 위반 수집 · 실효 상태 보고)
  lib/                 순수 모듈(.cjs)과 시험(*.test.ts) — electron 을 require 하지 않는다
  smoke/               앱 안 스모크 실행기 — main 이 스모크 인자를 받았을 때만 불러온다
  scripts/smoke.cjs    스모크 런처(plain node)
  assets/tray.png      임시 트레이 아이콘 — public/pwa-64x64.png 의 사본(16×16 으로 줄여 쓴다)
  tsconfig.json · tsconfig.preload.json    typecheck:desktop 의 checkJs 프로젝트 둘(preload 만 DOM 타입을 더한다)
  smoke-out/           스모크 결과(git 무시)
```

루트 쪽의 짝: `tray.html` · `src/tray/`(화면) · `vite.tray.config.ts` · `scripts/trayBuild.ts`(CSP · 빌드 가드) → `dist-tray/`(빌드 산출물, git 무시).

| `lib/` 모듈 | 역할 |
|---|---|
| `appProtocol` | app:// 파일 색인 · 요청 판정 · MIME 표 · 스킴 특권 · 출처 상수 |
| `ipcGuard` · `links` · `navigation` · `permissions` | IPC 발신자 검증 · 시스템 브라우저로 열 https 허용 목록 · 탐색 / 새 창 / webview 가드 · 권한 / 다운로드 / 인증서 처리기 |
| `windowPrefs` · `trayBuildInfo` | webPreferences 공장(실제 창과 스모크가 같은 값) · `tray-build.json` 검증 |
| `smokeArgs` · `smokeLaunch` · `smokeFs` · `smokeOut` | 스모크 인자 · 런처의 판단 · 임시 폴더 / 잠금 / 정리 · 결과 파일 쓰기 |
| `smokeResult` · `smokeChecks` · `guards` | 통과 판정과 필수 검사 목록 · 검사 평가 · 값 가드 |

## 실행

저장소 루트에서(Windows):

```bash
npm ci                       # 루트 의존성 — 처음 한 번
npm run build:tray           # → dist-tray/ — 앱이 읽는 화면이다. 이게 없으면 앱이 안내 뒤 끝난다
npm --prefix desktop ci      # Electron 설치. 바이너리는 받지 않는다(아래 '문제 해결')
npm --prefix desktop start   # = electron . → 트레이 아이콘 + 창(app://twelvejanggi/tray.html)
```

- 설치는 `ci` 로 합니다(`desktop/` 안에서 `npm install` 도 됩니다). **`--prefix` 와 인자 없는 `install` 의 조합은 쓰지 않습니다** —
  Windows 에서 npm 이 지금 폴더(저장소 루트)를 `file:..` 의존성으로 더하고 `desktop/node_modules` 에 저장소 루트로 가는 링크를 만듭니다.
  링크를 따라가는 재귀 삭제가 진짜 `node_modules` 를 지운 적이 있어 쓰지 않는 것입니다(`desktop/lib/packageShape.test.ts` 가 이 모양을 막습니다).
- 앱은 `dist-tray/` 를 읽습니다. 화면을 고치면 `build:tray` 를 다시 해야 합니다(핫 리로드는 없습니다).
- `dist-tray/tray-build.json` 이 없거나 형식이 틀리거나 `tray.html` 이 없으면 빈 창 대신 오류 상자('트레이 화면 파일을 읽지 못해 종료해요')와
  `build:tray` 안내를 보이고 끝납니다(stderr 에도 `[tj] …` 한 줄).
- 창은 콘텐츠 340×400, 크기 조절 불가, OS 프레임 유지, 메뉴 막대 없음입니다. 닫기(X)는 숨김이고 끝내려면 트레이 메뉴 '종료' 입니다.
  트레이 메뉴는 '열기' · '종료' 이고 Windows 에서는 좌클릭도 열기입니다. 두 번째 실행은 기존 창을 보이고 끝납니다(단일 인스턴스).
- 개발 실행의 userData 는 `%APPDATA%/TwelveJanggi-dev` 입니다. `TJ_DEVTOOLS=1` 은 개발 실행에서만 DevTools(분리 창)를 엽니다.

## 개발 흐름

1. **화면(`src/tray/`)만 고칠 때** — 루트에서 `npm run dev` 후 <http://localhost:5173/tray.html>. 브라우저에서 보는 것이라 CSP 가 없고
   `window.tjDesktop` 도 없어서 스텁으로 동작합니다(제목 줄에 버전이 나오지 않습니다).
2. **셸(`desktop/`)이나 빌드 설정을 고칠 때** — `npm run build:tray` → `npm --prefix desktop start`.
3. **확인** — `npm run typecheck:desktop`(JS 타입 검사: webPreferences 키 오타는 조용히 보안을 끄므로), `npm test`(`desktop/lib` 시험 포함),
   `npm --prefix desktop run smoke`. 트레이를 바꾼 PR 의 확인 목록은 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 에 있습니다.
4. **빌드 가드** — 트레이 코드가 웹 전용 모듈(`src/main.tsx` · `Header` · `Home` · `PwaStatus` · `InstallButton` · `DownloadCards` · `appStore` ·
   PWA 가상 모듈)을 import 하면 `build:tray` 가 실패합니다. 반대로 웹 빌드에 `src/tray/**` 가 들어와도 실패합니다
   (`scripts/trayBuild.ts` 의 `trayGuard` · `webGuard`, 자동 음성 시험은 `scripts/trayBuild.test.ts`). 손으로 보려면 `src/tray` 에서 `Header` 를
   일부러 import 해 보면 됩니다. 쓸 부분이 웹 전용 모듈 안에 있으면 순수 모듈로 옮깁니다. `vite.tray.config.ts` 는 Vite `root` · 진입
   (`rollupOptions.input = resolve(root, 'tray.html')`) · 가드 루트를 모두 `repoRoot(import.meta.url)` 한 값에서 절대 경로로 풀어, `build:tray` 가 실행 위치(cwd)와
   무관합니다 — 상대 `'tray.html'` 은 Rollup 이 cwd 기준으로 풀어 다른 폴더에서는 진입을 못 찾기 때문입니다.
5. **`desktop/lib` 는 `electron` 을 import · require 하지 않습니다** — 루트 검사(`npm test` · `typecheck`)가 `desktop/node_modules` 없이 통과해야
   하기 때문입니다. CI 의 `check` 도 루트 단계를 먼저 돌리고 desktop 설치는 뒤에 합니다.
6. 스타일은 `tapp-` 접두사만 씁니다. 루트 `index.css` 의 `.tray*` 는 손패(HandTray) 것이라 '트레이 앱' 과 '손패' 의 이름 공간을 섞지 않습니다.

## 스모크

`npm --prefix desktop run smoke` 는 **실제 앱**을 띄워 증명하는 자동 점검입니다.

- 런처(`scripts/smoke.cjs`)가 이번 실행만의 임시 프로필로 앱(같은 `main.js` · webPreferences · preload · 처리기)을 `tray.html?smoke` 로 띄웁니다.
  앱 안 실행기(`smoke/`)가 검사하고 `desktop/smoke-out/result.json` 에 결과를 쓴 뒤 **실제 트레이 메뉴의 '종료'** 를 눌러 끝냅니다.
  판정은 런처가 파일로 합니다.
- **건너뛰기가 없습니다.** 아래가 모두 참일 때만 통과(종료 코드 0)입니다 — 시간 초과 · 신호 종료가 없고, 앱이 exit 0 이고,
  `result.nonce` 가 런처의 것과 같고(지난 실행의 결과가 섞이지 않게), 결과의 electron 버전 · 빌드의 Supabase 출처가 런처가 읽은 값과 같고,
  필수 검사가 전부 있고, 보고된 검사가 모두 ok 이고, 실행 뒤 새 `tj-smoke-*` 폴더가 없습니다.
- 필수 검사는 런처가 정합니다(`lib/smokeResult.cjs` 의 `BASE_REQUIRED` · `requiredChecks`). 앱이 결과에 적은 `required` 는 참고일 뿐입니다.
- '없었다' 를 보는 검사(`securityWarnings` · `cspViolations` · `consoleErrors`)는 그 사건의 양성 기록(페이지가 `getAppInfo` 를 왕복한 뒤
  콘솔에 찍는 장벽 표식)을 먼저 받은 뒤에만 판정합니다.
- 한 판은 약 2초이고 그동안 창이 실제로 뜹니다(`screenshot` 이 보이는 창을 찍습니다). 시간 상한은 둘 — 앱 안 감시 타이머 60초,
  런처의 하드 타임아웃 90초(`-- --timeout=<10~90>` 으로 줄일 수 있습니다).
- **격리** — `%TEMP%/tj-smoke-*` 아래에 이번 실행 전용 프로필이 생기고(앱의 `TMP`/`TEMP` 도 그 안), 동시 실행 잠금은 `%TEMP%/tj-smoke.lock` 입니다.
  끝나면 지우고, 못 지운 것은 다음 실행의 첫 단계가 정리합니다. 스모크는 자기 프로필이라 이미 떠 있는 트레이와 따로 돕니다. 동시 실행은 지원하지 않습니다.
- 런처는 앱 env 에서 `ELECTRON_RUN_AS_NODE` · `ELECTRON_DISABLE_SECURITY_WARNINGS` · `TJ_DEVTOOLS` · `NODE_OPTIONS` · `ELECTRON_FORCE_IS_PACKAGED` 를 빼고,
  `ELECTRON_OVERRIDE_DIST_PATH` 가 있으면 실행을 거부합니다(고정한 바이너리로만 돕니다). Electron 을 내려받지도 않습니다(아래 '문제 해결').

### 필수 검사

표의 순서는 런처가 찍는 순서(`BASE_REQUIRED`)입니다. 앱 안에서 도는 순서는 `smoke/run.cjs` 의 `runChecks` 에 있습니다.

| 검사 | 확인하는 것 |
|---|---|
| `boot` | 진입 URL(`app://twelvejanggi/tray.html?smoke`) · `#root` 렌더 · 제목 줄의 버전(= `getAppInfo().version`) · body 배경이 다크 토큰(CSS 가 실렸다) |
| `webPreferences` | `getLastWebPreferences()` 가 `contextIsolation` · `sandbox` true, `nodeIntegration` false 이고, 기본값이 안전한 키 7개는 있으면 안전한 값 |
| `sandboxEffective` | preload 가 보고한 `process.sandboxed` · `contextIsolated` true, 렌더러가 OS 수준 sandbox(Windows 는 integrityLevel untrusted · low), 페이지에 격리 world 표식 · `require` · `process` 가 없음 |
| `bridge` | `window.tjDesktop` 의 키가 계약 상수(`TJ_DESKTOP_KEYS`)와 같음 |
| `ipc` | `getAppInfo()` 가 desktop 패키지 버전 · 고정한 electron 패키지 버전 · chrome · platform 을 돌려줌 |
| `cspMeta` | 문서의 CSP meta 가 `<head>` 안에 하나이고 `tray-build.json` 의 `csp.meta` 와 같음(공백 정규화) |
| `cspHeader` | `tray.html` 과 AI 워커 스크립트의 응답이 200 · `Content-Security-Policy` = `csp.header` · `nosniff` · 명시 Content-Type |
| `mime` | 파일 색인에 MIME 표 밖 확장자가 없음 |
| `protocol` | 루트 밖을 겨냥한 인코딩 탈출 넷 · 없는 파일 · 디렉터리 · `tray-build.json` → 404, POST → 405, 다른 호스트(`app://other/…`) → 404 |
| `ai` | 모듈 워커가 답했고(`aiWorker` `'worker'` — 조용한 동기 폴백이 아님) 낸 수가 시작 국면의 합법 수. 걸린 시간은 정보 |
| `navigation` | 앱 밖 탐색 · `window.open` 은 막히고 URL 은 그대로, 허용 목록 주소만 열기 기록이 1번(스모크에서는 열지 않고 기록) |
| `permissions` | 알림 · 클립보드 쓰기만 허락하고 위치는 거부(감싼 처리기의 결정 기록으로 판정 — Electron 은 처리기가 없으면 모두 허락한다) |
| `securityWarnings` | 보안 경고 검사가 켜져 있고 'Electron Security Warning' 이 0건 |
| `noNetwork` | 가드가 기록한 원격 요청 = 기대 목록. 기본은 가드 탐침(가드가 살아 있는지 보는 양성 대조) 한 건뿐이고 앱 · 페이지가 낸 원격 요청은 0건 — `.invalid` 빌드는 connectProbe 두 건, `--net` 은 두 건이 더 기대됨 |
| `loginItem` | `openAtLogin` 이 시작 · 끝 모두 false(내 PC 의 로그인 항목을 바꾸지 않음) |
| `tray` | 트레이 · 아이콘(비어 있지 않음) · 메뉴 '열기' · '종료' · 단일 인스턴스 잠금 · 창을 숨긴 뒤 '열기' → 보임 · 포커스 |
| `screenshot` | `capturePage()` 가 서로 다른 색 8개 이상(검은 화면 거부) → `screenshot.png` |
| `cspViolations` | 장벽 뒤 CSP 위반 0건 · 콘솔의 CSP 줄 0건, 격리 world 버퍼 = preload 가 보낸 목록(유실 없음) |
| `consoleErrors` | 장벽 뒤 콘솔 error 0건(`.invalid` 빌드에서 가드가 취소한 connectProbe 요청의 오류만 뺌) |
| `cspCanary` | 막혀야 하는 fetch(`https://example.invalid/…`)의 위반이 정확히 2건 — meta · header 두 전달 경로가 한 건씩 집행됨. 이 단계의 콘솔 오류는 최대 3건 허용 |
| `connectAllowed` (조건부) | `.invalid` 빌드에서만 필수 — 빌드 출처의 https · wss 로 시도한 요청에 CSP 위반이 없고 가드가 둘 다 취소 |
| `net` (조건부) | `--net` 에서만 필수 — 인증 설정 GET 200 + Realtime 소켓 연결 |

필수 검사 수: 기본 빌드(Supabase 값 없음)는 20개, `.invalid` 빌드는 `connectAllowed` 가 더해져 21개, `--net`(실제 값 빌드)은 `net` 이 더해집니다.
실제 값으로 빌드해도 `--net` 이 없으면 20개이고 원격 요청은 나가지 않습니다.
`.invalid` 빌드는 CI 의 가짜 값입니다 — 환경 변수로만 줍니다(`.env` 파일에 두지 않습니다). 로컬에서 같은 것을 하려면(Git Bash):

```bash
VITE_SUPABASE_URL=https://ci.invalid VITE_SUPABASE_ANON_KEY=ci-dummy-anon-key npm run build:tray
npm --prefix desktop run smoke        # connectAllowed 포함 21개 — 요청은 가드가 취소한다
npm run build:tray                    # 기본 빌드로 되돌린다 — 저장소 루트에 .env.local 이 있으면 그 값이 들어간다
```

### 결과 위치

`desktop/smoke-out/` — git 무시, 실행마다 처음에 비웁니다. CI 의 `tray-smoke` 잡(windows-latest)은 `.invalid` 빌드로 스모크를 돌리고 이 폴더를 아티팩트(`tray-smoke`)로 올립니다.

| 파일 | 쓰는 쪽 | 내용 |
|---|---|---|
| `result.json` | 앱 | `nonce` · `checks[]`(이름 · ok · detail) · `required[]` · `versions` · `build`(`tray-build.json` 요약) · `boot` · `cspViolations` · `aiWorker` · `aiAnswered` · `ms`. 앱이 실패하면 `stage` · `error` |
| `summary.json` | 런처 | `verdict`(`ok` / `fail`) · `reasons` · `tmpLeft` · `tempNew` · `sweep` · `run` · `nonce` · `finishedAt` · `net` · `timeoutSec` |
| `screenshot.png` | 앱 | `screenshot` 검사가 찍은 창 |

런처는 검사 표(`ok` / `FAIL` / `MISSING`)와 판정도 콘솔에 찍습니다.

### `--net` 주의

```bash
npm --prefix desktop run smoke -- --net    # '--' 뒤에 쓴다
```

- **공유 Supabase 에 실제로 닿습니다.** 이 Supabase 프로젝트는 다른 게임과 같이 쓰므로 프로젝트 소유자가 허락한 뒤에만 돌립니다.
  기본 스모크와 CI 는 원격으로 나가는 요청이 0 입니다(가드가 취소합니다).
- 빌드에 실제 `VITE_SUPABASE_URL` · `VITE_SUPABASE_ANON_KEY` 가 있어야 합니다(저장소 루트의 `.env.local` 에서 읽습니다 — 값은 저장소에 없습니다).
  값이 없거나 `.invalid` 이면 `net` 이 실패하고 다시 빌드하라고 안내합니다.
- 가드는 **정확히 두 요청**만 통과시킵니다 — `GET <출처>/auth/v1/settings`(+ 그 CORS 사전 요청 `OPTIONS`)와 Realtime 웹소켓
  (`GET <wss 출처>/realtime/v1/websocket`). 그 밖의 요청은 모두 기록하고 취소하며 실행을 실패시킵니다.
  `OPTIONS` 허용은 apikey 머리글 때문에 브라우저가 사전 요청을 먼저 보낼 것이라는 **추론**이고, 아직 실제로 관찰하지 않았습니다.
- 하는 일은 둘뿐입니다 — 인증 설정을 읽고, 공개 broadcast 채널(`tj:probe-…`) 하나에 붙었다가 떨어집니다. 익명 로그인 · 방 만들기 · RPC 는 하지 않고 DB 에 쓰지 않습니다.
- `--` 없이 `npm --prefix desktop run smoke --net` 이라 쓰면 npm 이 `--net` 을 자기 설정으로 가져가 스크립트에는 아무것도 넘기지 않고, 경고도 없이 기본 스모크가
  돌아 통과합니다(npm 10.9.2 에서 확인). 그래서 런처는 `npm_config_net` · `npm_config_timeout` 이 env 에 있으면 이유를 알리고 거부합니다.

## 보안 기본선

| 기본선 | 어디서 걸리는가 | 확인하는 검사 |
|---|---|---|
| 출처 동결 | `app://twelvejanggi` — localStorage · 익명 세션이 여기에 묶인다. 스킴 특권은 `{ standard, secure, supportFetchAPI }` 뿐(`supportFetchAPI` 는 스모크의 페이지 안 fetch 검사용) | `boot` · `protocol` |
| 렌더러 격리 | webPreferences 는 정확히 `{ preload, contextIsolation: true, sandbox: true, nodeIntegration: false }` — `lib/windowPrefs.cjs` 한 곳에서만 만든다. `app.enableSandbox()` 를 단일 인스턴스 잠금보다 먼저 부른다. `additionalArguments` 는 쓰지 않는다(비어 있지 않으면 spare renderer 를 못 써서 스모크만 다른 시작 경로를 탄다) | `webPreferences` · `sandboxEffective` |
| 노출 면 | preload 는 `require('electron')` 만 쓰고 `window.tjDesktop = { getAppInfo }` 만 노출한다(raw `ipcRenderer` 없음). 채널은 `tj-*`. IPC 는 트레이 창의 메인 프레임에서 온 것만 받는다 | `bridge` · `ipc` |
| CSP | 문서 meta 와 응답 헤더 두 경로에 같은 정책(헤더 판 = meta 판 + `frame-ancestors 'none'`). 전용 워커는 문서 meta 를 물려받지 않고 자기 응답 헤더를 따르므로 헤더가 필요하다. 인라인 스크립트 · 스타일이 없다(`style-src 'self'`) | `cspMeta` · `cspHeader` · `cspViolations` · `cspCanary` |
| 요청 처리기 | 파일 색인에서만 내준다 · 호스트 정확 일치 · GET/HEAD · 없거나 거부하면 404 · 표 밖 확장자 없음 · `nosniff` | `protocol` · `mime` |
| 탐색 · 새 창 · webview | 앱 밖은 막고 허용 목록(`khkim3115.github.io` · 이 저장소의 `github.com`)만 시스템 브라우저로 연다 | `navigation` |
| 권한 · 다운로드 · 인증서 | 권한은 알림 · `clipboard-sanitized-write` 만(장치 권한은 거부), 다운로드는 막고, 클라이언트 인증서는 고르지 않는다 | `permissions` |
| 보안 경고 | Electron 의 보안 경고 검사가 켜진 채 0건 | `securityWarnings` |
| 원격 요청 | 기본 스모크 · CI 에서는 나가지 않는다 | `noNetwork` · `connectAllowed` |
| 내 PC 불변 | 로그인 항목을 바꾸지 않고 `%TEMP%` 에 잔여를 남기지 않는다 | `loginItem` · 런처의 실행 뒤 비교 |

CSP(Supabase 값 없는 빌드의 meta 판). 값이 있으면 `connect-src` 가 `'self' https://<호스트> wss://<호스트>` 가 됩니다.

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
```

정책 문자열은 `scripts/trayBuild.ts` 의 `buildTrayCsp` 하나가 만들고, `tray.html` 의 meta 와 `dist-tray/tray-build.json` 에 그대로 갑니다. main 은 `tray-build.json` 을
검증해(없거나 틀리면 fail-closed) 그 `header` 를 모든 응답에 실어 보냅니다.

## 문제 해결

### 처음 `start` 가 오래 걸린다 / 스모크가 'electron 바이너리가 없다' 고 한다

- 스모크가 'electron 패키지가 없다' 고 하면 `npm --prefix desktop ci` 가 아직입니다.
- Electron 42 부터 `npm --prefix desktop ci` 는 바이너리를 내려받지 않습니다. 바이너리가 없는 채로 `npm --prefix desktop start`(= `electron .`)를 하면
  Electron 44 의 `require('electron')` 이 직접 내려받습니다(네트워크 필요 — Windows x64 용 `electron-v44.9.3-win32-x64.zip` 이 약 160 MB 이고,
  풀린 것은 `desktop/node_modules/electron/dist/` 에 있습니다).
- **스모크 런처는 내려받지 않습니다.** `desktop/node_modules/electron/path.txt` 와 바이너리를 먼저 확인하고, 없으면 다음 명령을 안내한 뒤 끝납니다.
  CI 도 같은 명령으로 미리 받아 `.electron-cache` 에 캐시합니다.

  ```bash
  node desktop/node_modules/electron/install.js
  ```

### 두 번째 실행이 새 창 없이 바로 끝난다

- 단일 인스턴스입니다 — 같은 userData 로 이미 떠 있으면 두 번째 실행은 기존 창을 보이고 끝납니다(종료 코드 0).
- 끝나기 전에 Chromium 이 `Unable to move the cache: 액세스가 거부되었습니다. (0x5)` 한 줄을 찍을 수 있습니다. 첫 인스턴스가 쥔 같은 프로필의 디스크 캐시를
  옮기려다 거부당한 것으로, 해가 없고 종료 코드도 0 입니다(Windows 에서 본 일).

### 개발 프로필 `TwelveJanggi-dev`

- 개발 실행의 userData 는 `%APPDATA%/TwelveJanggi-dev` 입니다 — 나중에 설치한 앱(기본 userData 는 `%APPDATA%/TwelveJanggi`, #22)과 저장소 · 단일 인스턴스 잠금을
  나눕니다. 지우면 개발 실행의 저장 값이 초기화됩니다.
- 스모크가 아닌 개발 트레이가 떠 있는 동안 `%TEMP%` 에 0바이트 `<GUID>.tmp` 가 하나 있고, 트레이가 끝나면 사라집니다. 열려 있는 동안만 있는 임시 파일이라 잔여가 아닙니다(Windows 에서 본 일).

### 앱 끝내기는 PID 로

```bash
taskkill /PID <pid> /T /F
```

- 이미지 이름(`/IM electron.exe`)으로는 끄지 않습니다 — 다른 프로젝트에서 `electron .` 으로 띄운 Electron 앱도 같은 이미지 이름이라 함께 꺼집니다.
- 스모크 런처를 끄면 그 Electron 도 함께 끝납니다(Windows job object — 확인한 동작). 그래도 남았는지 봅니다.

  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ? CommandLine -like '*TwelveJanggi*' | select ProcessId,CommandLine
  ```

### 스모크가 '다른 스모크가 실행 중' 이라고 한다 / `tj-smoke-*` 가 남았다

- 동시 실행 잠금(`%TEMP%/tj-smoke.lock`)입니다. 죽은 PID 의 잠금(강제 종료가 남긴 것)은 다음 실행이 넘겨받습니다. 적힌 PID 가 스모크가 아니면 잠금 파일을 지웁니다.
- 지난 실행의 `tj-smoke-*` 는 다음 실행의 첫 단계가 지웁니다. 어떤 프로세스가 폴더를 쥐고 있으면 경고만 하고 계속합니다. 이번 실행이 새 `tj-smoke-*` 를 남기면 그 실행은 실패입니다.

### 클라이언트 인증서

- 서버가 클라이언트 인증서를 요구해도(`select-client-certificate`) 앱은 인증서를 고르지 않고 진행합니다(`lib/permissions.cjs` 의 `selectNoCertificate`) —
  저장소에서 첫 인증서를 자동으로 고르는 Electron 의 기본 동작을 막기 위해서입니다.
- 그 비용은 클라이언트 인증서가 필요한 환경(mTLS 프록시 등)에서 연결이 거부될 수 있다는 것입니다. 설계에서 따져 본 것이고 그런 환경에서 확인한 적은 없습니다.
  이 앱이 부르는 원격은 `connect-src` 에 적힌 Supabase 뿐입니다.

### Electron 44.9.3 에서 본 동작 (스모크 규칙이 이것에 맞춰져 있다)

- `getLastWebPreferences()` 는 앱이 넘기지 않은 기본값 키 7개도 모두 돌려줍니다. 그래서 `webPreferences` 검사에서 7개가 실제로 비교됩니다.
  (검사는 키가 없으면 Electron 기본값이라 통과로 보고, 있으면 안전한 값과 같아야 통과로 봅니다.)
- `will-frame-navigate` 가 막은 메인 프레임 탐색은 `did-fail-provisional-load` 를 내지 않습니다. 그래서 `navigation` 검사는 그 주소의 `did-start-navigation` 뒤에
  오는 `did-stop-loading` 을 기다립니다.
- `cspCanary` 단계는 콘솔 오류를 정확히 3건 냅니다. 설계의 상한(최대 3건)과 같아서, 콘솔 오류를 하나 더 찍는 Chromium 은 `cspCanary` 를 실패시킵니다 —
  거짓 통과가 아니라 거짓 실패 쪽입니다. Electron 을 올린 뒤 이 검사가 '콘솔 오류가 4건' 으로 실패하면 먼저 그 메시지를 봅니다.

### Node 22.13.0 이 출력 없이 죽는다 (한 PC 에서 본 일)

- 저장소 경로에 특정 한글 폴더 이름(홍 · 길동 · 배 …)이 들어 있을 때 Node 22.13.0 이 아무것도 출력하지 않고 종료 코드 `0xC0000005` 로 죽었습니다.
  같은 경로에서 21.7.3 과 16.16.0 은 죽지 않았습니다. CI 는 Node 24 를 씁니다. 원인은 확인하지 못했고 한 PC 에서만 본 일입니다.
  같은 증상이면 Node 버전을 바꿔 봅니다.

### 버전 규칙

- Electron 은 **첫 출시 후 2주가 지난 가장 높은 메이저**를 쓰고, 패치는 `desktop/package-lock.json` 으로 고정합니다(`"electron": "^44.9.3"`).
  메이저를 올리는 날 그 규칙을 다시 확인하고, 44 와 45 의 차이 중 스모크에 걸리는 것(보안 경고를 찍는 시점 · 환경 변수 우선순위 · spare renderer)을 봅니다.
  45 로의 이동은 #22 · Dependabot 몫입니다.
- 의존성은 `electron` 하나(dev)이고 `package.json` 에 `type` 필드를 두지 않습니다(`main.js` · `preload.js` 가 CJS) — `lib/packageShape.test.ts` 가 지킵니다.
- 앱 버전(`package.json` 의 `version`)은 `getAppInfo().version` 으로 창의 제목 줄에 보이며, 웹의 공개 버전(`src/data/changelog.ts`)과는 따로입니다.

### 알려진 한계

- 패키지(설치 파일) 실행과 그 스모크는 #22 에서 다룹니다. 지금의 스모크는 개발 실행(`dist-tray/` 를 읽는 앱) 기준이고,
  `protocol` 검사가 탈출 대상으로 삼는 파일(저장소의 `package.json`)이 패키지된 앱에는 없을 수 있습니다.
