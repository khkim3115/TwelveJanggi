# desktop — 십이장기 트레이 앱 (Electron)

웹과 같은 코드 가운데 `src/core` · `src/engine`(AI)과 `src/lib` · `src/index.css` 로 만든 트레이 빌드(`dist-tray/`)를
`app://twelvejanggi/tray.html` 로 여는 Electron 셸입니다(`src/ui` 는 Esc 판정이 쓰는 `useDialog` 의 `isDialogOpen` 하나뿐이고 `src/store` 는
아직 쓰지 않습니다 — 화면을 만드는 뒤의 이슈에서 들어옵니다).
창은 트레이 팝업입니다(#21) — 아이콘 쪽에 뜨고, 바깥을 누르면 숨고, 위치 · 고정 · 투명도 · 테마를 기억합니다(아래 '조작법'). 안의 화면은 아직
자리표시 한 문단이라 산출물은 화면이 아니라 **증명**입니다 — AI 모듈 워커 · CSP · 보안 기본선과 창 동작이 `app://` 출처에서 실제로 동작하는지를
PR 마다 스모크가 확인합니다. 화면은 #24 · #25, 설치 파일 · 업데이트는 #22, 전용 아이콘은 #23 이 잇습니다.

- **Windows 만 검증했습니다.** macOS · Linux 의 트레이는 확인하지 않았습니다.
- 필요한 것: Node 22.12 이상(`package.json` 의 `engines` — Electron 44 패키지의 하한과 같습니다), 저장소 루트에서 `npm ci`.
- 이 폴더의 규칙(출처 동결 · 특권 · 처리기 · 가드 · 최상위 순서 …)은 루트 [`CLAUDE.md`](../CLAUDE.md) 의 '트레이 앱' 절에 있습니다.

## 구조

```
desktop/
  main.js              main 프로세스 — app:// 처리기 · 창 · 트레이 · 단일 인스턴스 · 보안 처리기를 잇는다
  preload.js           window.tjDesktop — 11키(아래 '보안 기본선' 의 노출 면). tray.html?smoke 일 때만 CSP 위반 수집 · 실효 상태 보고
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
| `ipcGuard` · `links` · `navigation` · `permissions` | IPC 발신자 검증 · 시스템 브라우저로 열 https 허용 목록(웹 · 의견 주소 상수 `WEB_URL` · `FEEDBACK_URL` 포함) · 탐색 / 새 창 / webview 가드 · 권한 / 다운로드 / 인증서 처리기 |
| `windowPrefs` · `trayBuildInfo` | webPreferences 공장(실제 창과 스모크가 같은 값) · `tray-build.json` 검증 |
| `windowPolicy` · `position` · `layout` | 바깥 클릭(blur) 숨김 · 트레이 클릭 경합 가드 · 아이콘 쪽 배치 / 작업영역 클램프 / 사용자 이동 판별 · 레이아웃별 콘텐츠 크기 |
| `settings` · `theme` · `opacity` | `settings.json` 정규화 · 원자적 쓰기 · 테마 이름과 창 배경색 · 투명도 정규화(30–100) |
| `autostart` · `trayMenu` · `pushChannels` · `consoleLine` | 로그인 항목 인자 / 판별 / 관리 가드 · 트레이 메뉴 템플릿 · main→렌더러 채널과 상태 스냅샷의 표 · 개발 실행 콘솔 중계의 한 줄 |
| `smokeArgs` · `smokeLaunch` · `smokeFs` · `smokeOut` | 스모크 인자 · 런처의 판단 · 임시 폴더 / 잠금 / 정리 · 결과 파일 쓰기 |
| `smokeResult` · `smokeChecks` · `guards` | 통과 판정과 필수 검사 목록 · 검사 평가 · 값 가드 |
| `fakeElectron.ts` · `smokeRig.ts` | 시험 도우미(이름이 `*.test.ts` 가 아니라 시험으로 모이지 않는다) — `mainWiring.test.ts` 의 가짜 electron · `smokeRun.test.ts` 의 가짜 Electron 장치. 둘 다 구조 타입이고 electron 을 import 하지 않는다 |

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
  node_modules 안의 정션을 따라간 삭제가 진짜 `node_modules` 를 지운 적이 있습니다(다른 정션이었습니다). 같은 위험을 만드는 링크라서
  쓰지 않는 것입니다(`desktop/lib/packageShape.test.ts` 가 이 모양을 막습니다).
- 앱은 `dist-tray/` 를 읽습니다. 화면을 고치면 `build:tray` 를 다시 해야 합니다(핫 리로드는 없습니다).
- `dist-tray/tray-build.json` 이 없거나 형식이 틀리거나 `tray.html` 이 없으면 빈 창 대신 오류 상자('트레이 화면 파일을 읽지 못해 종료해요')와
  `build:tray` 안내를 보이고 끝납니다(stderr 에도 `[tj] …` 한 줄).
- 창은 프레임 없는 팝업입니다 — 콘텐츠 340×400(자리표시 — 화면별 크기는 #24 · #25), 크기 조절 · 최대화 · 최소화 · 전체 화면 불가, 작업표시줄에
  없고 늘 위, 메뉴 막대 없음. 다루는 법은 아래 '조작법' 입니다.
- 개발 실행의 userData 는 `%APPDATA%/TwelveJanggi-dev` 입니다. `TJ_DEVTOOLS=1` 은 개발 실행에서만 DevTools(분리 창)를 엽니다.

## 조작법

Windows 기준입니다. macOS 갈래는 문서 · 소스대로 짰지만 Mac 에서 확인하지 않았습니다(**macOS 미확인** — #26 에서 봅니다).

### 트레이 아이콘

- **Windows** — 좌클릭은 팝업 열기 · 닫기, 우클릭은 메뉴입니다. 열린 팝업에서 아이콘을 누르면 닫히고 다시 열리지 않습니다 — 그 클릭이 낳은
  바깥 클릭(blur)이 먼저 숨기므로, blur 로 숨은 지 250ms 안의 좌클릭은 무시합니다. Esc · ✕ 로 숨긴 뒤의 클릭은 무시하지 않습니다.
  숨긴 팝업의 아이콘을 더블클릭해도 열린 채 남습니다.
- **macOS** — 클릭이 메뉴를 엽니다. 팝업은 메뉴의 '열기' 로 엽니다(macOS 미확인).
- 메뉴를 열면 고정 안 한 팝업은 숨습니다 — Windows 는 우클릭이 포커스를 가져가 바깥 클릭처럼 숨고, macOS 는 메뉴가 열릴 때 숨깁니다(macOS 미확인).
  메뉴의 '라이트 모드' · '창 고정' · '위치 초기화' 는 숨은 팝업에 적용되고 다음에 열 때 보입니다. 고정한 팝업은 메뉴를 열어도 그대로 보입니다.

### 트레이 메뉴

Windows 는 `십이장기 <버전>` · ─ · 혼자 하기 · 온라인 대전 · ─ · 자동 실행 · 라이트 모드 · 창 고정 · 위치 초기화 · ─ · 웹에서 열기 · 의견 보내기 · ─ · 종료
입니다(─ 는 구분선). macOS · Linux 는 버전 줄 다음에 '열기' 가 있고 나머지는 같습니다(Windows 는 아이콘 좌클릭이 열기입니다).

| 항목 | 하는 일 |
|---|---|
| `십이장기 <버전>` | 버전 줄 — 누를 수 없습니다 |
| 열기 | (macOS · Linux) 팝업을 엽니다 |
| 혼자 하기 · 온라인 대전 | 그 화면으로 바꾸고 팝업을 엽니다(지금은 둘 다 자리표시 문구). 화면을 바꾸는 것은 이 둘뿐입니다 |
| 자동 실행 | 로그인할 때 창 없이 트레이에만 뜹니다(체크) — 아래 '자동 실행' |
| 라이트 모드 | 테마 — 체크가 라이트입니다. 팝업의 ☀️ · 🌙 와 같은 설정입니다 |
| 창 고정 | 바깥을 눌러도 팝업이 숨지 않습니다 |
| 위치 초기화 | 끌어 옮긴 위치를 잊고 아이콘 쪽으로 되돌립니다. 저장 위치가 있을 때만 켜집니다 |
| 웹에서 열기 · 의견 보내기 | 시스템 브라우저로 웹 게임 · 이 저장소의 새 이슈 화면을 엽니다(`lib/links.cjs` 의 `WEB_URL` · `FEEDBACK_URL`) |
| 종료 | 앱을 끝냅니다 — 앱 안에서 끝내는 길은 이것뿐입니다(✕ · Esc · OS 닫기는 숨김) |

### 팝업

- **제목 줄**을 끌어 옮깁니다(단추는 끌기 영역이 아닙니다). 옮긴 위치는 기억합니다 — 다음에 열 때 그 자리이고, 그 위치와 가장 많이 겹치는
  디스플레이(떼어 낸 모니터면 남은 디스플레이)의 작업영역 안으로 맞춥니다. 저장 위치가 없으면 아이콘 쪽에 뜹니다 — 아이콘이 화면 위쪽 절반이면
  그 아래, 아래쪽 절반이면 그 위이고, 작업영역 밖으로 나가지 않습니다. 보이는 동안 모니터를 떼거나 배율 · 작업영역이 바뀌면 다시 놓습니다.
- 🔅 — 투명도 덮개(30–100%)를 펼치고 접습니다. 투명도는 팝업에서만 바꿉니다(메뉴에는 없습니다).
- ☀️ · 🌙 — 테마를 바꿉니다(메뉴의 '라이트 모드' 와 같은 설정).
- ✕ · Esc — 숨깁니다. Esc 는 투명도 슬라이더에 포커스가 있어도 숨기지만, 대화상자를 닫는 Esc · IME 조합 중의 Esc · 누르고 있어 반복되는 Esc ·
  Ctrl/Alt/Meta 와 함께 누른 Esc 로는 숨지 않습니다.
- **바깥을 누르면** 숨습니다. 숨지 않는 때 — 창 고정, DevTools 가 열린 동안, 열린 직후 300ms(그 안에 포커스를 잃었으면 300ms 가 지난 뒤 한 번 더 보고
  그때도 포커스가 없으면 숨깁니다 — 시작 때 뜬 창은 빼고).
- **포커스를 받지 못한 팝업**(뜨는 사이에 다른 앱으로 옮겨 Windows 가 앞으로 가져오지 않은 창)은 바깥을 눌러도 숨지 않습니다 — 팝업 안을 한 번
  눌러 포커스를 준 뒤 바깥을 누르거나, ✕ · 트레이 아이콘으로 닫습니다.

### 자동 실행 · 두 번째 실행 · 설정

- **자동 실행** — 메뉴의 '자동 실행' 을 켜면 로그인할 때 창 없이 트레이에만 뜹니다(Windows 는 로그인 항목의 `--hidden` 인자, macOS 는
  `wasOpenedAtLogin` — macOS 미확인). 로그인 항목은 **설치본에서만** 씁니다 — 개발 실행 · 스모크는 이 PC 의 로그인 항목을 바꾸지 않고, 메뉴의
  '자동 실행' 도 꺼진 항목으로 보입니다. 설치 파일은 #22 라 아래 두 줄은 아직 설치본에서 확인하지 않은 설계입니다.
  - Windows 설치본은 첫 실행 때 켭니다. 체크는 메뉴를 여는 순간의 OS 상태라 작업 관리자 '시작 앱' 에서 끈 것도 꺼짐으로 보이고, 메뉴에서 다시
    켜면 작업 관리자의 끔도 풉니다.
  - macOS 는 기본으로 끕니다. 체크는 앱이 `settings.json` 에 적어 둔 값이라 시스템 설정에서 지운 것은 모릅니다(macOS 미확인).
- **두 번째 실행** — 이미 떠 있으면(같은 userData) 그 팝업을 마지막 화면 그대로 보이고 끝납니다(단일 인스턴스). `--hidden` 이 붙은 두 번째 실행
  (로그인 항목이 한 번 더 띄운 것)은 아무것도 하지 않습니다. macOS 는 Finder · Spotlight 로 다시 열면(activate) 팝업을 보입니다(macOS 미확인).
- **설정** — `<userData>/settings.json`(개발 실행은 `%APPDATA%/TwelveJanggi-dev/settings.json`)에 테마 · 투명도 · 창 고정 · 저장 위치 · 자동 실행(macOS 의
  체크) · 첫 실행 표시를 둡니다. 바뀌면 300ms 뒤 한 번 쓰고(같은 폴더의 임시 파일에 쓴 뒤 rename), 앱을 끝낼 때와 Windows 를 로그오프 · 종료할 때
  남은 것을 씁니다. 못 읽는 파일이면 기본값(다크 · 100% · 고정 안 함 · 아이콘 쪽)으로 시작하고 `[tj] settings: …` 한 줄을 남깁니다 — 첫 실행으로 보지
  않으므로 자동 실행 기본값이 다시 켜지지 않습니다. 화면은 받은 테마를 `localStorage.tj_theme` 에도 적어 다음 첫 페인트에 씁니다.

## 개발 흐름

1. **화면(`src/tray/`)만 고칠 때** — 루트에서 `npm run dev` 후 <http://localhost:5173/tray.html>. 브라우저에서 보는 것이라 CSP 가 없고
   `window.tjDesktop` 도 없습니다 — 제목 줄에 버전이 나오지 않고, 브리지를 쓰는 단추(☀️ · 🌙 · 투명도 슬라이더 · ✕)와 Esc 는 아무것도 하지 않습니다.
   브리지 없는 페이지를 위한 흐름은 따로 만들지 않습니다(렌더러의 흐름은 하나 — 테마 · 투명도는 main 이 민 값으로만 바뀝니다).
   라이트 화면은 개발 도구 콘솔에서 `localStorage.tj_theme = 'light'` 로 두고 새로 고쳐 봅니다(되돌리려면 `'dark'`).
2. **셸(`desktop/`)이나 빌드 설정을 고칠 때** — `npm run build:tray` → `npm --prefix desktop start`.
   숨긴 채 시작하는 길(로그인 실행과 같다)은 `npm --prefix desktop start -- --hidden` 으로 봅니다(`--` 뒤에 씁니다 — 없으면 npm 이 가져갑니다).
   창 없이 트레이에만 뜨고 트레이 좌클릭(Windows)으로 엽니다. 개발 실행이라 로그인 항목은 건드리지 않습니다.
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
- 한 판은 약 5.5초(런처 포함 · 이 PC 기준 — 창 검사가 blur 유예 · 클릭 경합 · 저장 예약 시간을 실제로 기다립니다)이고 그동안 창이 실제로 뜹니다
  (`screenshot` 이 보이는 창을 찍고, 창 검사가 창을 숨겼다가 다시 엽니다). 시간 상한은 둘 — 앱 안 감시 타이머 60초,
  런처의 하드 타임아웃 90초(`-- --timeout=<10~90>` 으로 줄일 수 있습니다).
- **격리** — `%TEMP%/tj-smoke-*` 아래에 이번 실행 전용 프로필이 생기고(앱의 `TMP`/`TEMP` 도 그 안), 동시 실행 잠금은 `%TEMP%/tj-smoke.lock` 입니다.
  끝나면 지우고, 못 지운 것은 다음 실행이 앱을 띄우기 직전에 정리합니다 — 인자 · 잠금 · `smoke-out` 비우기 · 빌드 확인 · electron 확인을 지난 뒤라,
  그 전에 멈춘 실행(빌드나 바이너리가 없는 등)은 정리하지 않습니다. 스모크는 자기 프로필이라 이미 떠 있는 트레이와 따로 돕니다. 동시 실행은 지원하지 않습니다.
- 런처는 앱 env 에서 `ELECTRON_RUN_AS_NODE` · `ELECTRON_DISABLE_SECURITY_WARNINGS` · `TJ_DEVTOOLS` · `NODE_OPTIONS` · `ELECTRON_FORCE_IS_PACKAGED` 를 빼고,
  `ELECTRON_OVERRIDE_DIST_PATH` 가 있으면 실행을 거부합니다(고정한 바이너리로만 돕니다). Electron 을 내려받지도 않습니다(아래 '문제 해결').

### 필수 검사

표의 순서는 런처가 찍는 순서(`BASE_REQUIRED`, 조건부 둘은 맨 뒤)입니다 — `lib/readmeSmokeTable.test.ts` 가 이 표를 그 목록과 대조합니다.
앱 안에서 도는 순서는 `smoke/run.cjs` 의 `runChecks` 에 있습니다.

| 검사 | 확인하는 것 |
|---|---|
| `boot` | 진입 URL(`app://twelvejanggi/tray.html?smoke`) · `#root` 렌더 · 제목 줄의 글자 '십이장기'(`.tapp-title`)와 버전(= `getAppInfo().version`) · body 배경이 다크 토큰(`--bg` · `color-scheme` dark — 새 프로필은 설정 파일이 없어 기본값 다크다. CSS 가 실렸다) |
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
| `loginItem` | 로그인 항목 쓰기를 막았다 — 실행기가 `app.setLoginItemSettings` 를 기록만 하는 대체 함수로 바꿔 끼웠고(D1 — 로그인 항목은 격리 프로필 밖이다) 끝까지 그 함수가 서 있고 쓰기를 0번 받았다. 양성 대조: 프로필 settings.json 의 첫 실행 표시(`autostartDefaultApplied` true)와 로그인 항목 요청 기록(Windows 는 `{ on: true, managed: false }` 하나 — 가드에 닿아 거절했다. 그 밖은 0개). 환경 전제: 쓸 때와 같은 인자로 읽은 `openAtLogin`(Windows 는 `executableWillLaunchAtLogin` 도)이 시작 · 끝 모두 false 이고 둘이 같다 |
| `tray` | 트레이 · main 이 넘긴 아이콘(비지 않음 · 16×16) · 최신 메뉴의 라벨이 플랫폼별 목록('조작법' 의 트레이 메뉴 — 버전 줄은 `app.getVersion()`) · 버전 줄 · '자동 실행' · '위치 초기화' 는 꺼짐 · 체크 없음(새 프로필) · 단일 인스턴스 잠금. 처음 보인 창을 main 의 길로 숨겼다가(Windows 는 트레이 클릭 토글, 그 밖은 `win.close()`) 다시 열면(Windows 는 트레이 좌클릭, 그 밖은 '열기') 보임 · 포커스. Windows 는 바깥 클릭 · 경합도 본다 — 유예(300ms)가 지난 뒤 blur → 숨음(이유 `blur`) → 같은 턴의 트레이 클릭은 무시 → 경합 시간(250ms) 뒤의 클릭 → 보임. 우클릭은 내지 않는다(네이티브 메뉴가 떠서 실행이 멈춘다) |
| `screenshot` | `capturePage()` 가 서로 다른 색 8개 이상(검은 화면 거부) → `screenshot.png` |
| `theme` | 페이지가 `setTheme('light')` → `getState()` 장벽 뒤 스냅샷 · `data-theme` · `localStorage.tj_theme` 이 light, body 배경 = `--bg` = 창 배경(`getBackgroundColor()`) = light 색, 새로 전달된 메뉴의 '라이트 모드' 체크, settings.json light. `setTheme('purple')` 은 아무것도 바꾸지 않는다. 라이트로 바꾸기 전에 받아 둔 낡은 메뉴의 '라이트 모드' 를 누르면 light 그대로 + 새 메뉴(Electron 이 체크를 먼저 뒤집어 '켜기' 가 된다), 최신 메뉴로 누르면 모두 dark(settings.json 까지) |
| `opacity` | 페이지가 보낸 값마다 스냅샷과 창 투명도(`round(getOpacity() × 100)`)가 실행기 안의 글자 표대로다 — 64→64 · 5→30 · 64.4→64 · `'70'`→64 · NaN→64 · null→64 · 150→100 · 100→100. 잘못된 값은 64 에서 보내 '기본값으로 바꿈' 과 '무시' 를 가르고, NaN 줄은 실행기의 수신 기록이 'NaN' 이어야 한다. 저장값이 바뀌는 줄은 settings.json 도 그 값이 된다 |
| `escHide` | 대화상자(`aria-modal="true"` 요소)가 있는 채 Esc → 숨지 않고 `tj-hide` 도 없음 · 그 요소를 `#root` 의 keydown 리스너가 동기로 지워도(대화상자를 닫는 Esc) 창은 그대로 — 리스너 등록 순서와 상관없다 · 요소 없이 Esc → `tj-hide` 1 · 숨김 1(이유 `request`) · 창 파괴 없음 → 다시 보임. Esc 는 페이지가 만든 키 이벤트다(실제 키 경로는 손 확인) |
| `visibility` | 진짜 ✕ 단추 → `tj-hide` 1 · 숨김 1(이유 `request`) · `tj-hidden` 전달 1 · `<html>` 에 `tapp-hidden` · `getBackgroundThrottling()` true → 다시 열면 `tj-shown` 전달 1 · 클래스 빠짐. 스로틀을 끈 한 바퀴: `win.close()`(이유 `close`) 뒤 `visibilityState` 는 visible 인데 `tapp-hidden` 이 붙는다(`visibilitychange` 로 움직이는 렌더러를 걸러 낸다) → 다시 열면 빠짐 → 스로틀을 다시 켠다 |
| `cspViolations` | 장벽 뒤 CSP 위반 0건 · 콘솔의 CSP 줄 0건, 격리 world 버퍼 = preload 가 보낸 목록(유실 없음) |
| `consoleErrors` | 장벽 뒤 콘솔 error 0건(`.invalid` 빌드에서 가드가 취소한 connectProbe 요청의 오류만 뺌) |
| `cspCanary` | 막혀야 하는 fetch(`https://example.invalid/…`)의 위반이 정확히 2건 — meta · header 두 전달 경로가 한 건씩 집행됨. 이 단계의 콘솔 오류는 최대 3건 허용 |
| `connectAllowed` (조건부) | `.invalid` 빌드에서만 필수 — 빌드 출처의 https · wss 로 시도한 요청에 CSP 위반이 없고 가드가 둘 다 취소 |
| `net` (조건부) | `--net` 에서만 필수 — 인증 설정 GET 200 + Realtime 소켓 연결 |

창 검사(`theme` · `opacity` · `escHide` · `visibility`)는 `screenshot` 바로 뒤에 돌고, 끝마다 창을 main 의 길로 보인 채 돌려놓습니다(못 하면 그 검사의
실패 — 뒤 검사는 보이는 다크 창을 전제로 합니다). 실행기는 창을 직접 숨기지 않고 main 의 길(트레이 토글 · ✕ · Esc · `win.close()` · `win.emit('blur')`)로만
숨겨 숨김 이유가 기록되게 하고, `escHide` · `visibility` 는 그 검사가 일으키지 않은 숨김(우연한 blur 등)이 오면 그 이유를 적고 실패합니다. 순서 장벽은
페이지의 `await tjDesktop.getState()` 이고(같은 프레임의 IPC 는 순서를 지킨다는 가정), 저장 예약을 기다리지 않는 판정은 그 스냅샷으로 합니다.

필수 검사 수: 기본 빌드(Supabase 값 없음)는 24개, `.invalid` 빌드는 `connectAllowed` 가 더해져 25개, `--net`(실제 값 빌드)은 `net` 이 더해집니다.
실제 값으로 빌드해도 `--net` 이 없으면 24개이고 원격 요청은 나가지 않습니다.
`.invalid` 빌드는 CI 의 가짜 값입니다 — 환경 변수로만 줍니다(`.env` 파일에 두지 않습니다). 로컬에서 같은 것을 하려면(Git Bash):

```bash
VITE_SUPABASE_URL=https://ci.invalid VITE_SUPABASE_ANON_KEY=ci-dummy-anon-key npm run build:tray
npm --prefix desktop run smoke        # connectAllowed 포함 25개 — 요청은 가드가 취소한다
npm run build:tray                    # 기본 빌드로 되돌린다 — 저장소 루트에 .env.local 이 있으면 그 값이 들어간다
```

### 결과 위치

`desktop/smoke-out/` — git 무시. 잠금을 얻은 실행은 맨 먼저 이 폴더를 비웁니다. 그 전에 거부된 실행(틀린 인자 · npm 이 가져간 인자 · 다른 스모크의 잠금)은
건드리지 않아 지난 실행의 결과가 남으므로, `summary.json` 의 `nonce` · `finishedAt` 으로 이번 실행의 것인지 확인합니다.
CI 의 `tray-smoke` 잡(windows-latest)은 `.invalid` 빌드로 스모크를 돌리고 이 폴더를 아티팩트(`tray-smoke`)로 올립니다.

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

'확인하는 곳' 의 `boot` 같은 이름은 스모크 검사이고, `*.test.ts` 는 `desktop/lib` 의 단위 · 배선 시험(`npm test`)입니다 — 스모크가 돌리지 않는
조항은 그 시험이 지킵니다.

| 기본선 | 어디서 걸리는가 | 확인하는 곳 |
|---|---|---|
| 출처 동결 | `app://twelvejanggi` — localStorage · 익명 세션이 여기에 묶인다. 스킴 특권은 `{ standard, secure, supportFetchAPI }` 뿐(`supportFetchAPI` 는 스모크의 페이지 안 fetch 검사용) | `boot`(진입 URL) · `protocol`(다른 호스트는 404). 특권 셋은 `appProtocol.test.ts` · `mainWiring.test.ts` |
| 렌더러 격리 | webPreferences 는 정확히 `{ preload, contextIsolation: true, sandbox: true, nodeIntegration: false }` — `lib/windowPrefs.cjs` 한 곳에서만 만든다. `app.enableSandbox()` 를 단일 인스턴스 잠금보다 먼저 부른다. `additionalArguments` 는 쓰지 않는다(비어 있지 않으면 spare renderer 를 못 써서 스모크만 다른 시작 경로를 탄다) | `webPreferences` · `sandboxEffective`(실제 창의 값 · 실효 sandbox). 정확히 네 키 · 한 공장 · `additionalArguments` 없음은 `windowPrefs.test.ts` · `mainSource.test.ts`, `enableSandbox` 를 잠금보다 먼저는 `mainSource.test.ts` · `mainWiring.test.ts` |
| 노출 면 | preload 는 `require('electron')` 만 쓰고 `window.tjDesktop`(얼린 객체 11키 — `getAppInfo · getState · setTheme · setOpacity · setLayout · hide · onTheme · onOpacity · onMode · onShown · onHidden`)만 노출한다(raw `ipcRenderer` 없음). 값은 고치지 않고 보낸다 — 정규화는 main 한 곳이고 틀린 값은 무시한다. 구독은 부를 때만 걸고 해제 함수를 돌려주며 이벤트 객체를 넘기지 않는다. 로드 때는 아무것도 보내거나 듣지 않는다(스모크 제외). 채널은 `tj-*`. IPC 는 트레이 창의 메인 프레임에서 온 것만 받는다 | `bridge`(노출 키) · `ipc`(왕복) · `theme` · `opacity`(틀린 값 무시). preload 의 `require` · 채널 이름은 `preloadContract.test.ts` · `mainWiring.test.ts`(구독 채널 = `PUSH_CHANNELS` · 로드 때 호출 0 은 `preloadContract.test.ts`), 메인 프레임만 받는 것은 `ipcGuard.test.ts` · `mainSource.test.ts` · `mainWiring.test.ts` |
| CSP | 문서 meta 와 응답 헤더 두 경로에 같은 정책(헤더 판 = meta 판 + `frame-ancestors 'none'`). 전용 워커는 문서 meta 를 물려받지 않고 자기 응답 헤더를 따르므로 헤더가 필요하다. 인라인 스크립트 · 스타일이 없다(`style-src 'self'`) | `cspMeta` · `cspHeader` · `cspViolations` · `cspCanary` |
| 요청 처리기 | 파일 색인에서만 내준다 · 호스트 정확 일치 · GET/HEAD 만(그 밖의 메서드는 405) · 없거나 거부하면 404 · 표 밖 확장자 없음 · `nosniff` | `protocol` · `mime` · `cspHeader`(`nosniff`). 호스트 정확 일치의 변형(대소문자 · 접두 · 포트 · 사용자 정보)은 `appProtocol.test.ts` |
| 탐색 · 새 창 · webview | 앱 밖은 막고 허용 목록(`khkim3115.github.io` · 이 저장소의 `github.com`)만 시스템 브라우저로 연다 | `navigation`. webview 는 `webPreferences`(`webviewTag=false`) · `navigation.test.ts` |
| 권한 · 다운로드 · 인증서 | 권한은 알림 · `clipboard-sanitized-write` 만(장치 권한은 거부), 다운로드는 막고, 클라이언트 인증서는 고르지 않는다 | `permissions`(알림 · 클립보드 쓰기 허락, 위치 거부). 장치 권한 · 다운로드 · 클라이언트 인증서는 `mainWiring.test.ts` · `permissions.test.ts` |
| 보안 경고 | Electron 의 보안 경고 검사가 켜진 채 0건 | `securityWarnings` |
| 원격 요청 | 기본 스모크 · CI 에서는 나가지 않는다 | `noNetwork` · `connectAllowed` |
| 내 PC 불변 | 로그인 항목을 바꾸지 않고 `%TEMP%` 에 잔여를 남기지 않는다 | `loginItem` · 런처의 실행 뒤 비교 |

CSP(Supabase 값 없는 빌드의 meta 판). 값이 있으면 `connect-src` 가 `'self' https://<호스트> wss://<호스트>` 가 됩니다.

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
```

정책 문자열은 `scripts/trayBuild.ts` 의 `buildTrayCsp` 하나가 만들고, `tray.html` 의 meta 와 `dist-tray/tray-build.json` 에 그대로 갑니다. main 은 `tray-build.json` 을
검증해(없거나 틀리면 fail-closed) 그 `header` 를 200 응답에만 실어 보냅니다 — 404 · 405 는 글 한 줄짜리 `text/plain` 이라 싣지 않습니다.

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

Git Bash 는 슬래시로 시작하는 인자를 경로로 바꿔 버립니다(`/PID` 가 `C:/Program Files/Git/PID` 처럼 됩니다). 그래서 슬래시를 겹쳐 씁니다:

```bash
taskkill //PID <pid> //T //F
```

cmd · PowerShell 에서는 그대로 씁니다:

```powershell
taskkill /PID <pid> /T /F
```

- 이미지 이름(`/IM electron.exe`)으로는 끄지 않습니다 — 다른 프로젝트에서 `electron .` 으로 띄운 Electron 앱도 같은 이미지 이름이라 함께 꺼집니다.
- 스모크 런처를 끄면 그 Electron 도 함께 끝납니다(Windows job object — 확인한 동작). 그래도 남았는지 봅니다.

  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ? CommandLine -like '*TwelveJanggi*' | select ProcessId,CommandLine
  ```

### 스모크가 '다른 스모크가 실행 중' 이라고 한다 / `tj-smoke-*` 가 남았다

- 동시 실행 잠금(`%TEMP%/tj-smoke.lock`)입니다. 죽은 PID 의 잠금(강제 종료가 남긴 것)은 다음 실행이 넘겨받습니다. 적힌 PID 가 스모크가 아니면 잠금 파일을 지웁니다.
- 지난 실행의 `tj-smoke-*` 는 다음 실행이 앱을 띄우기 직전에 지웁니다 — 인자 · 잠금 · 빌드 · electron 확인을 지난 뒤라, 빌드나 바이너리가 없어
  그 전에 멈춘 실행은 지우지 않습니다. 어떤 프로세스가 폴더를 쥐고 있으면 경고만 하고 계속합니다. 이번 실행이 새 `tj-smoke-*` 를 남기면 그 실행은 실패입니다.

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
