# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

십이장기(3×4 판의 王·將·相·子) 웹 게임 — **난이도별 탐색 AI 혼자 하기**, **서버 권위 온라인 1:1 대전**, **PWA**.
React 19 + Vite 6 + TypeScript + Zustand 프런트엔드, Supabase(Postgres + Realtime) 멀티플레이, GitHub Pages 배포.
코드 주석과 문서는 한국어로 쓴다.

## Commands

```bash
npm install
npm run dev                  # vite dev server → http://localhost:5173 (서비스 워커 꺼짐)
npm test                     # vitest run — 규칙 계약 · AI 강도 회귀 · 스토어 계약 · 표기 가드 · 트레이 빌드 도구(scripts/) · desktop/lib 순수 모듈
npm run test:watch
npm run test:sql             # 서버(plpgsql)·클라이언트 규칙 일치를 로컬 Postgres(PGlite)로 — 빠른 모드, `-- --deep` 은 깊은 모드
npm run typecheck            # tsc --noEmit (scripts/ · desktop/lib 시험 · 설정 파일 포함 — desktop 의 JS 는 typecheck:desktop)
npm run build                # tsc --noEmit + vite build → dist/ (PWA 서비스 워커·매니페스트 포함)
npm run preview              # 빌드 결과 서빙 — PWA 설치·오프라인은 dev 가 아니라 여기서 확인
npm run generate-pwa-assets  # public/icon.svg → PWA 아이콘·favicon (pwa-assets.config.ts)
npm run bench:seats          # 선후공 편차 실측(수백 판 — vitest 밖)
npm run e2e:mp               # 실서버 규칙 일치 검증(.env.local 필요 — 아래 '멀티플레이' 참고)

# 트레이 앱(Electron) — 아래 '트레이 앱' 절. Windows 에서만 검증했다
npm run build:tray           # vite build --config vite.tray.config.ts → dist-tray/ (PWA 없음, CSP meta · tray-build.json 포함)
npm run typecheck:desktop    # desktop/ 의 JS(main · preload · lib · smoke · scripts)를 checkJs 로 — 먼저 npm --prefix desktop ci
npm --prefix desktop ci      # Electron 설치 — 42+ 는 바이너리를 받지 않는다(처음 start 때 받는다). `--prefix` 와 인자 없는 `install` 의 조합은 쓰지 않는다
npm --prefix desktop start   # 트레이 앱 실행(= electron .) — 먼저 npm run build:tray
npm --prefix desktop run smoke           # 실제 앱 스모크(한 판 약 5.5초, 런처 포함 · 이 PC 기준) — 결과는 desktop/smoke-out/
npm --prefix desktop run smoke -- --net  # + 실제 Supabase 연결 — 공유 프로젝트라 사용자 확인 뒤에만. `--` 없이는 npm 이 플래그를 가져가 런처가 거부한다
```

단일 테스트: `npx vitest run src/core/gameState.test.ts` (`-t "<이름>"` 으로 한 케이스만).

## 절대 깨뜨리면 안 되는 것

- **보드 인덱스는 동결 계약이다** — `i = 행 * 3 + 열`, 행 0 = 적 진영(위), 행 3 = 녹 진영(아래)
  (`src/core/board.ts`). core·engine·UI·서버 plpgsql 이 모두 이 순서를 쓴다. 재배열하면 에러 없이 다른 게임이 된다.
- **셀 값은 부호 있는 종류 코드다** — `+k` 녹 / `−k` 적 / `0` 빈칸, 王1 將2 相3 子4 侯5. 서버 `tj_rooms.board`(smallint[]) 도 같다.
- **손패 순서는 `[녹 將·相·子, 적 將·相·子]`**(`handIndex`). 서버 열 이름도 `hand` 로 같다.
- **수는 한 모양 `Move { from, to, piece, promote }`** — 놓기는 `from = DROP(-1)`, `piece` 는 승격 전 종류,
  `promote` 는 `legalMoves` 가 정하는 강제 플래그(고르는 값이 아님). UI 클릭(`resolveClick`)·서버 `tj_play(p_from = -1)`·탐색이 같은 표현을 쓴다.
- **규칙 코드는 `applyMoveInPlace` 한 곳에만 있다.** `applyMove` 는 `cloneState` 후 이를 호출하고, 엔진은
  `applyMoveInPlace`/`undoMove` 로 같은 함수를 쓴다. 규칙을 두 벌로 만들지 말 것.
- **판정 순서**(`rules.ts` 머리말 = 클라 `detectResult` = 서버 `tj__advance`): 王 잡힘 → 입성(차례가 돌아온 쪽 王 이 상대 진영)
  → 같은 국면 3회 → 둘 수 없음(놓기 포함). 온라인은 그 뒤에 판 길이 상한(`ONLINE_MAX_PLIES` = 1000 → 무승부 `movelimit`, 서버만).
- **반복 판정은 정확한 키로 한다** — 클라 `computeKey`(충돌 없는 정수), 서버 `tj_pos_key`(텍스트). 시작 국면도 1회로 센다
  (서버는 `tj_start_game` 이 시작 국면을 `tj_room_positions` 에 1회로 넣는다). zobrist 해시는 전치표 전용 — 반복 판정에 쓰지 말 것.
- **선후공은 설정(`SeatPref` = `'1'|'2'|'random'`)과 이번 판 좌석(`Player` = `1|2`)이 다른 값이다.** 좌석은 새 판을 시작할 때
  `resolveSeat` 로 딱 한 번 확정되고 판이 끝날 때까지 불변이다. 사람이 적이면 새 판 직후 AI 가 먼저 둔다(`startGame`).
  난이도도 같은 원칙 — 고른 값(`difficulty`, 다음 판부터)과 이번 판 값(`gameDifficulty`)을 섞지 말 것.
- **`src/core`·`src/engine` 에는 React/DOM import 가 없다** — `node` 환경 vitest 로 테스트한다(`src/**/*.test.ts`).
- **트레이 앱 출처는 동결 계약이다** — `app://twelvejanggi`(진입 `tray.html`, 스모크는 `tray.html?smoke`). localStorage · 익명 세션이 이 출처에 묶여
  바꾸면 저장된 설정과 세션이 끊긴다(`desktop/lib/appProtocol.cjs` 의 `APP_ORIGIN`).
- **표기**: 비슷한 3×4 변형 게임의 상표명을 코드·문서·화면 어디에도 쓰지 않는다(`src/naming.test.ts` 가 막는다).

## Layering

```
src/core/      순수 규칙 (UI·네트워크 무관, 테스트 1급 대상)
  board.ts       칸 순서 · KIND_DIRS/STEPS(말 방향) · 시작 배치 — 동결 계약
  rules.ts       RuleConfig(3회 반복) · 판정 순서 머리말 · ONLINE_MAX_PLIES
  gameState.ts   legalMoves · applyMoveInPlace/undoMove · applyMove · 판정 · computeKey · 스냅샷/전송형
  zobrist.ts     국면 해시(전치표)
  view.ts        boardView(하이라이트) · resolveClick(클릭 의미) · turnHint/phaseLabel(문구) · SeatPref/resolveSeat
                 · nextFocusCell/entryCell(판 키보드 이동) · cellLabel/handTileLabel(낭독 문구)
  testkit.ts     테스트 전용 국면 빌더(12글자 보드 문자열)
src/engine/    AI (UI 무관)
  evaluate.ts    평가함수 / search.ts 알파베타+반복심화+전치표+전술 판정
  ai.ts          chooseMove(난이도) · bestMove(힌트) · PRESETS / ai.worker.ts · aiClient.ts 워커 창구
src/store/     Zustand — appStore(화면) · gameStore(혼자 하기) · multiplayerStore(온라인) — 엔진·서버와 UI 사이의 접착제
src/ui/        React 컴포넌트 (표현 전담, 상태는 스토어에서)
src/lib/       supabase.ts(클라이언트 — 동적 import 전용) · env.ts(설정 여부만) · chat · feedback
               · loadSupabase.ts(supabase.ts 를 동적 import 하는 약속 하나 — 스토어 · 트레이 스모크 공용)
src/data/      changelog(패치노트 단일 진실원본) · links
src/tray/      트레이 앱 화면(tray.html 진입) — 웹 전용 모듈 import 금지 · desktop.ts(window.tjDesktop 접근자) · smoke.ts(?smoke 때만)
desktop/       Electron 셸 — main.js · preload.js · smoke/(앱 안 스모크 실행기) · scripts/smoke.cjs(런처)
  lib/           순수 .cjs 모듈 + 시험 — electron 을 import 하지 않는다(루트 검사는 desktop 설치 없이 통과해야 한다)
supabase/      schema.sql(진실원본, 누적본) · migrations/(적용본)
```

## 멀티플레이 (Supabase, 서버 권위)

정적 프런트엔드는 게임 권위를 갖지 않는다. 모든 변경은 `tj_*` `SECURITY DEFINER` RPC 를 거치고, 클라이언트 직접 쓰기는
권한 회수 + RLS 로 막혀 있다. `supabase/schema.sql` 이 백엔드의 진실원본이다.

- **⚠️ 요트다이스·나인 멘스 모리스와 Supabase 프로젝트를 공유한다.** 이 프로젝트의 기본 ACL 은 새 테이블·함수에
  anon·authenticated 전 권한(TRUNCATE 포함)을 준다 → **`tj_` 객체 이름을 하나씩 적어** revoke 한 뒤 필요한 것만 grant 한다.
  `on all ... in schema`, `alter default privileges`, `create extension`, 다른 게임 객체(`rooms`·`room_players`·`leaderboard`·
  `feedback`·`room_status`·`nmm_*`) 변경은 금지.
- SQL 을 바꿀 때(#4 의 적용 절차): 새 마이그레이션(`supabase/migrations/<version>_<name>.sql`) + `schema.sql` 누적본 갱신 →
  `npm run test:sql -- --deep` 로 로컬 대조(둘이 같은 결과를 내는지도 본다) → **적용 전에 SQL 전문을 보여 주고 승인을 받는다**
  (MCP `apply_migration`·`execute_sql` 의 DDL 포함) → 비-tj 객체 권한·정의 스냅샷 → 적용 → 스냅샷이 그대로인지와
  tj_ 권한 매트릭스를 확인한다.
- `multiplayerStore.ts` 는 쓰기를 RPC 로만 한다. 읽기는 Realtime 구독과 회원 SELECT(RLS) 재조회·폴링이라
  `tj_rooms`·`tj_room_players` 의 authenticated `select` 권한과 select 정책을 빼면 안 된다(Realtime 전달도 이것으로 걸러진다).
  보드 클릭은 솔로와 같은 `core/view.resolveClick` 으로 해석한다.
  Supabase 클라이언트는 `lib/supabase` 를 **동적 import** 로만 불러온다 — 첫 화면(Home 등)은 `lib/env` 만 본다(번들 크기).
- 동기화: 방 행 `version`(UPDATE 마다 +1)보다 낮은 스냅샷은 버린다. Realtime **DELETE 는 필터가 걸리지 않으므로**
  `payload.old.id` 가 내 방일 때만 처리한다. 구독이 (다시) 붙을 때·탭 복귀·수를 보낸 뒤 방을 다시 읽고, 끊긴 동안은 폴링한다.
- 채팅은 `tj_chat` 테이블 + `tj_send_chat` RPC 다(#11 — 예전 공개 broadcast 는 누구나 읽고 보낸 사람을 꾸밀 수 있었다).
  보낸 사람·이름은 서버가 `tj_room_players` 에서 채우고, 읽기는 RLS select 와 `postgres_changes` INSERT(`room_id` 필터)다.
  방을 다시 읽을 때마다(진입·재연결·탭 복귀·착수 뒤·폴링) 최근 50개를 읽어 id 로 합친다(`mergeMessages`) — 처음 읽은 지난
  메시지는 안 읽음에 세지 않는다. `tj_chat` 의 replica identity 는 기본값으로 둔다(full 이면 필터·RLS 가 없는 DELETE 이벤트로 본문이 샌다).
  읽기 정책이 '지금 회원'만 보므로, 대기실에서 누가 나가면(`tj_leave_room`) 그 방 채팅을 지운다 — 같은 코드로 다음에 들어오는
  사람이 떠난 사람의 대화를 읽지 않게. `tj_send_chat` 은 방 행을 `for key share` 로 잠가 나가기와 줄을 세운다.
- **규칙 일치 검증**은 두 가지다. `src/core` 나 plpgsql 규칙을 고쳤으면 둘 다 돌릴 것.
  - `npm run test:sql`(`scripts/sql-parity.ts`) — PGlite(WASM Postgres)에 Supabase 흉내(롤·`auth.uid()`·기본 ACL·pgcrypto)를
    깔고 `schema.sql` 을 빈 DB 에 올려 대조한다: 권한 매트릭스(tj_ 함수·테이블·열 — 허용 목록 밖은 전부 회수돼 있어야 한다),
    `tj_can_step` 전수, 판정 순서, 무작위 대국 매 ply, 고정·표본 국면마다 가능한 모든 `tj_play` 인자, 방 흐름·제한·CHECK.
    `migrations/` 를 차례로 적용한 DB(= 실서버)의 tj_ 함수·테이블이 `schema.sql` 과 같은지도 본다(마이그레이션 빠뜨림·
    남은 오버로드·회수 누락·본문 차이). DB·비밀값이 없어 CI 가 PR 마다 빠른 모드를 돌린다.
    `--sql <파일>` 은 `schema.sql` 대신 쓸 **전체 누적본**(초안)이다 — 델타 마이그레이션은 받지 않는다. 초안도 저장소의
    `migrations/` 와 견주므로, 초안의 마이그레이션을 아직 넣지 않았으면 그 대조는 실패한다.
    PGlite 0.5.8 은 SQL 오류마다 스택이 새서(한 인스턴스에서 수천 건 — 단순 오류 기준 약 1,870건 — 이면
    `stack depth limit exceeded`) 오류를 많이 내는 전수 대조는 국면마다 새 인스턴스(템플릿의 `clone()`)에서 돌린다.
  - `npm run e2e:mp`(`scripts/mp-e2e.ts`) — 익명 세션 2개로 **실서버**에서 시나리오와 AI 자가대국을 두며 매 수
    판·손패·차례·직전 수·승패를 대조한다. `--steps-sql` 은 `tj_can_step` 전수 대조 SQL.
- **공개 RPC 시그니처**(클라이언트가 부르는 `tj_*` 9개의 이름·인자·반환)는 옛 클라이언트(배포 전에 열어 둔 탭·설치한 PWA·설치한 트레이 앱 —
  트레이 앱은 화면 번들을 앱 안에 담아 쓰므로(패키지 실행은 `resources/renderer`) 웹 배포가 닿지 않는다)와의 계약이다. 인자는 기본값을 붙여 뒤에만 더한다.
  인자 목록이 바뀐 `create or replace` 는 실서버에서 함수를 바꾸지 않고 오버로드를 하나 더 만들어 옛 호출을 'not unique' 로 깨므로,
  마이그레이션에서 옛 시그니처를 `drop function` 한 뒤 새로 만들고 revoke/grant 를 다시 한다. `test:sql` 의 `PUBLIC_RPCS` 표와
  'schema.sql = migrations/' 대조가 이것을 지키게 한다.
- **⚠️ `.env.local` 이 있으면 e2e 가 확인 없이 실서버에 방·익명 사용자를 만든다.** 서브에이전트·리뷰를 돌릴 때는
  `.env.local` 을 레포 밖으로 치워 둔다. `service_role` 키는 절대 쓰지 않는다(스크립트가 거부한다).
- 단위 테스트(vitest)는 `.env*` 를 읽지 않는다(`vitest.config.ts` 의 `envDir`, `src/lib/env.test.ts` 가 지킨다). #11 에서 스토어의
  동시 `import('../lib/supabase')` 가 vitest mock 을 새게 해 테스트가 실서버로 읽기 요청을 보낸 적이 있다 — 그래서 스토어와 트레이 스모크
  (`src/tray/smoke.ts`)는 `src/lib/loadSupabase.ts` 의 `loadSupabase()` import 약속 하나를 나눠 쓴다. 동적 import 를 새로 만들 때도 같은 약속을 쓴다.

## PWA · 배포 · CI

- `vite-plugin-pwa` 0.21(Vite 6 까지만 지원 — Vite 메이저를 올릴 때 함께 확인), `registerType: 'prompt'`.
  서비스 워커 등록은 `ui/PwaStatus.tsx` 한 곳(새 버전은 사용자가 '업데이트'를 눌러 적용). dev 에서는 꺼져 있다.
  알림은 **홈에서만** 띄운다 — 업데이트는 새로고침이라 진행 중인 판을 날리고 온라인 방에서 빼낸다.
- 설치 버튼(`ui/InstallButton.tsx`)은 `beforeinstallprompt` 를 모듈에서 한 번 받아 두고 모든 버튼이 나눠 쓴다.
  헤더에는 아이콘(📥, `compact`)만 두고 페이지가 최대 폭(560px)보다 좁으면 숨긴다 — 첫 방문엔 이벤트가 판 도중에 와서
  헤더가 한 줄 늘며 판을 밀어내기 때문(좁은 화면은 홈 카드가 창구). 글자 버튼(`⬇ 앱 설치`)을 헤더에 넣으면 솔로 헤더가 늘 두 줄이 된다.
- 보드게임 모음(허브, `data/links.ts` 의 `HUB_URL`)으로 가는 `← 보드게임 모음` 은 헤더 **줄이 아니라 그 위 한 줄**이다(`.hub-link`)
  — 솔로 헤더 줄은 390px 에서 12px 남짓, 데스크톱도 📥 가 뜨면 35px 만 남아 글자(약 95px)나 아이콘 버튼(42~46px)을 더하면 두 줄이
  된다. `.page` 위 여백·간격을 음수 여백으로 빌려 화면이 12px 만 내려간다. 같은 탭으로 가고(허브도 게임을 같은 탭으로 연다), 설치한
  앱(standalone)에서는 그리지 않는다(허브 `/` 는 앱 범위 밖). standalone 은 렌더 때 읽지 말고 `useStandalone()` 으로 구독한다 —
  데스크톱은 설치하면 지금 탭이 새로고침 없이 앱 창으로 옮겨 가서, 읽기만 하면 엉뚱한 다음 렌더에 화면이 12px 움직인다.
- 아이콘은 `public/icon.svg` 하나가 원본이다(王 은 글꼴이 아니라 획으로 그린다). 고친 뒤 `npm run generate-pwa-assets`.
- `main` push 마다 `.github/workflows/deploy.yml` 이 GitHub Pages 로 배포한다(Node 24). repo Variables
  `VITE_SUPABASE_URL`·`VITE_SUPABASE_ANON_KEY` 가 비어 있으면 온라인 대전이 꺼진 채 나가지 않게 빌드가 멈춘다.
- PR(대상 `main`)마다 `.github/workflows/ci.yml` 이 잡 둘을 돌린다(Node 24). `check`(`ubuntu-latest`)는 `npm ci` → typecheck → test →
  test:sql → build(Supabase 값 없이) → `build:tray` → `npm --prefix desktop ci` → `typecheck:desktop` 이다 — 루트 단계가 desktop 설치 없이
  도는지 매번 보이게 설치를 뒤에 둔다. `check` 는 `main` 브랜치 보호의 **필수 검사**다 — 잡 이름을 바꾸거나 경로 필터를 걸면 검사가
  보고되지 않는 PR 이 머지 대기로 막힌다 (바꿀 때는 보호 설정도 함께). `tray-smoke`(`windows-latest`)는 `desktop/lib` · `scripts` 시험 →
  `.invalid` Supabase 값으로 `build:tray` → 스모크 → `smoke-out/` 아티팩트이고(Electron 바이너리는 `.electron-cache` 에 캐시),
  **아직 필수 검사가 아니다** — 필수로 둘지는 첫 PR 의 초록 실행 뒤 브랜치 보호가 정한다.

## 트레이 앱 (Electron)

- 구조: `tray.html` 과 `src/tray/` 를 `vite.tray.config.ts`(웹 설정과 따로 — PWA 없음, 도구 `scripts/trayBuild.ts`)로 `dist-tray/` 에
  빌드하고 `desktop/` 의 Electron 이 `app://twelvejanggi/tray.html` 로 연다(사용법 · 스모크 표 · 문제 해결은 `desktop/README.md`, Windows 만 검증).
  개발은 `npm run dev` → `/tray.html`(CSP 없음 · `window.tjDesktop` 은 스텁), 앱은 `build:tray` → `npm --prefix desktop ci` →
  `npm --prefix desktop start`. 설치는 `ci` 로만 한다 — `--prefix` 와 인자 없는 `install` 은 Windows 에서 저장소 루트를 `desktop/node_modules`
  에 링크하고, node_modules 정션을 따라간 삭제는 진짜 폴더를 지운 적이 있다(다른 정션이었다). lock 은 `desktop/` 안에서 `npm install` 로만 다시 쓴다.
- 스킴 특권은 `{ standard, secure, supportFetchAPI }` 뿐이다 — `supportFetchAPI` 는 제품 코드가 아니라 스모크의 페이지 안 fetch 검사용이고,
  `corsEnabled`(다른 출처가 app:// 응답을 읽게 된다) · `stream` · `bypassCSP` 는 넣지 않는다.
- 처리기: app:// 는 시작할 때 만든 파일 색인에서만 내주고(요청 문자열은 경로 계산에 넣지 않는다 · 호스트 정확 일치 · GET/HEAD 만, 그 밖은 405 ·
  없거나 거부하면 404, throw 없음), IPC 는 `createGuardedIpc` 로만 등록하고, 앱 밖 탐색 · 새 창은 막은 뒤 허용 목록(`links.cjs`)만 시스템 브라우저로 연다.
- **CSP 는 한 원본이다** — `buildTrayCsp` 한 문자열이 `tray.html` 의 meta 와 `tray-build.json` → app:// 응답 헤더(+`frame-ancestors 'none'`)에
  그대로 간다(전용 워커는 문서 meta 를 물려받지 않는다). **fail-closed**: `tray-build.json` 이 없거나 틀리거나 `tray.html` 이 없으면
  main 은 처리기 · 창 · 트레이를 만들지 않고 알린 뒤 끝낸다(`tray.html` 의 내용은 `build:tray` 의 출력 검사와 스모크 `cspMeta` 가 본다).
- **빌드 가드는 양방향이다** — `trayGuard`(트레이 빌드에 PWA 가상 모듈 · `src/main.tsx` · `Header` · `Home` · `appStore` 등)와 `webGuard`(웹 빌드에
  `src/tray/**` — `apply: 'build'` 라 dev 의 `/tray.html` 은 막지 않는다)가 `load` 훅과 `worker.plugins` 에서 빌드를 실패시킨다.
  쓸 부분이 웹 전용 모듈에 있으면 순수 모듈로 옮긴다. `build:tray` 는 cwd 와 무관하다(루트 · 진입 · 가드 루트가 `repoRoot(import.meta.url)` 한 값).
- `desktop/main.js` 최상위(ready 전 · 동기)는 **순서가 의미를 가진다**: 스모크 인자 → userData → `enableSandbox` →
  `registerSchemesAsPrivileged` → 단일 인스턴스 잠금. webPreferences 는 `lib/windowPrefs.cjs` 한 공장에서만 만들어
  스모크와 같다(`additionalArguments` 금지).
- **트레이 창은 프레임 없는 팝업이다**(#21) — 보이기 · 숨기기 · 배치는 `showWindow(reason)` · `hideWindow(reason)` · `placeNow` 로만 하고 창은
  `liveWindow()`(없거나 파괴됐거나 종료 중이면 null)로만 만진다. `hideWindow` 는 `win.hide()` **전에** `shownIntent` 를 끈다 — 그 안의 동기 blur 를 바깥
  클릭으로 읽으면 경합 가드가 다음 클릭을 삼킨다. blur 는 숨긴다(예외: 창 고정 · DevTools · 표시 뒤 `BLUR_GRACE_MS` 300). Windows 좌클릭은 blur 로 숨긴 지
  `CLICK_RACE_MS` 250 안이면 무시한다 — `lastBlurHideAt` 은 blur 숨김만 적는다(Esc · ✕ 뒤의 클릭은 삼키지 않게). `transparent` 는 쓰지 않는다(투명도는
  `setOpacity` 로만).
- **트레이 메뉴는 `refreshTrayMenu` 한 곳에서 만든다** — Windows 는 `setContextMenu` 없이 우클릭마다 새로 만들어 띄운다(D4 — 붙이면 OS 가 우클릭을 받아
  `right-click` 이 오지 않고, 자동 실행 체크를 그 순간의 OS 상태로 그릴 수 없다). 체크박스는 `item.checked` 를 원하는 값으로 쓴다(낡은 메뉴도 사용자가 본
  것과 반대로 가지 않는다). 화면 모드는 메뉴의 '혼자 하기' · '온라인 대전' 만 바꾼다. 판단은 `desktop/lib` 순수 모듈이 하고 시험은 플랫폼을 값으로 받는다.
- **로그인 항목(자동 실행)은 `setLoginItem` 한 곳에서, `canManageLoginItems` 가 참일 때만 쓴다** — 설치본(패키지 · 스모크 아님 · win32/darwin · 실행
  파일이 `electron(.exe)` 아님)뿐이다. 개발 실행 · 스모크 · 시험이 쓰면 개발용 electron.exe 가 이 PC 의 HKCU `Run` 에 남는다. 스모크는 더 나아가
  `app.setLoginItemSettings` 를 기록만 하는 대체 함수로 바꿔 끼운다(D1 — '감싸서 기록만' 의 유일한 예외: 가드에 버그가 있으면 기록으로는 막지 못한다).
  Windows 는 `--hidden` 으로 등록하고 같은 인자로 읽는다(`loginItemQuery` — 다른 인자로 읽으면 체크가 OS 와 어긋난다).
- **브리지 `window.tjDesktop` 은 11키다**(`TJ_DESKTOP_KEYS` = preload 의 얼린 객체, 이 순서): `getAppInfo · getState · setTheme · setOpacity · setLayout ·
  hide · onTheme · onOpacity · onMode · onShown · onHidden`. preload 는 값을 고치지 않는다 — 정규화는 main 한 곳이고 틀린 값은 무시한다. 렌더러는 테마 ·
  투명도를 미리 바꾸지 않고 main 이 민 값으로만 바꾼다(토글 흐름은 하나 — 브리지 없는 `/tray.html` 용 흐름도 만들지 않는다).
- **main→렌더러는 `sendToTray` 하나로 `PUSH_CHANNELS` 의 채널만 민다**(`webContents.send(` 는 그 함수 안에만). 미는 채널은 모두 `getState()` 스냅샷(main
  메모리의 값)에 필드가 있어야 한다 — 구독보다 먼저 온 send 는 사라지므로 렌더러는 구독을 모두 건 뒤에 묻고 그 응답을 최종값으로 쓴다. 채널을 더하면
  (#22 의 `tj-compat`) 표 · 스냅샷 · preload · `TJ_DESKTOP_KEYS` 를 함께 늘린다.
- **`tj-shown` · `tj-hidden` 은 창의 `show` · `hide` 사건에서 보낸다** — 어느 길로 보이든 숨든(OS · 스모크의 직접 호출 포함) 렌더러가 같은 상태를 본다.
  렌더러는 `<html>` 에 `tapp-hidden` 을 달아 애니메이션을 멈춘다. `visibilitychange` 는 쓰지 않는다 — 스로틀을 끄면(#25) 숨겨도 visible 이다.
- **Esc 는 `window` 의 keydown 리스너 둘로 정한다**(`src/tray/esc.ts`) — 캡처 단계에서 그 이벤트가 시작될 때의 `isDialogOpen()` 을 찍고, 버블 단계에서
  순수 함수 `escAction` 으로 숨길지 정한다. 버블에서 그때의 대화상자를 보면 대화상자를 닫은 같은 Esc 로 창까지 숨는다(React 19 는 닫기를 마이크로태스크에서
  커밋한다). 캡처 기록은 등록 순서와 상관없고, 결정이 버블이라 React `stopPropagation` 이 막은 Esc 는 닿지 않는다.
- **스모크**(`npm --prefix desktop run smoke [-- --net]`)는 실제 앱을 `tray.html?smoke` · 격리 프로필로 띄워 필수 검사 24개를 하나도
  건너뛰지 않는다(`.invalid` 빌드는 +`connectAllowed`, `--net` 은 +`net`). 기본 스모크 · CI 는 원격으로 나가는 요청이 0 이고,
  `--net` 은 공유 Supabase 에 닿으니 사용자 확인 뒤에만 돌린다.
- **Windows 앱 실행 규칙**: 에이전트는 앱 · 스모크를 한 번에 하나만 돌린다 — 스모크는 `run smoke` 런처로, 앱은 PID 를 기록하는 `spawn` 도우미로 띄우고
  PID 로 끝낸다(Git Bash 는 `taskkill //PID <pid> //T //F` — `/PID` 를 경로로 바꾸므로 슬래시를 겹친다. cmd · PowerShell 은 `/PID <pid> /T /F`).
  `/IM electron.exe`(다른 Electron 앱도 꺼진다)와 `npm --prefix desktop start` 의 도구 포그라운드 · 백그라운드 실행은 금지다.
  끝나면 `TwelveJanggi` 가 든 `electron.exe` 가 없는지 조회한다.
- 버전 규칙: Electron 은 첫 출시 후 2주가 지난 가장 높은 메이저(`^44.9.3`)를 쓰고 패치는 `desktop/package-lock.json` 이 고정한다.
  트레이 앱의 CSS 클래스는 모두 `tapp-` 접두사다(`index.css` 의 `.tray*` 는 손패 것).

## Contributing & releases

`CONTRIBUTING.md` 참고. 트렁크 기반: 이슈 1개 → `<type>/<이슈>-<슬러그>` 브랜치 → PR(`Closes #n`) → **squash merge**
(`main` push 마다 자동 배포). 배포와 *공지*는 분리 — 공지는 `src/data/changelog.ts` 맨 위에 항목을 추가하면서
웹 버전을 올리고 `web-vX.Y.Z` 태그를 단다.
