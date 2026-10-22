# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

십이장기(3×4 판의 王·將·相·子) 웹 게임 — **난이도별 탐색 AI 혼자 하기**, **서버 권위 온라인 1:1 대전**, **PWA**.
React 19 + Vite 6 + TypeScript + Zustand 프런트엔드, Supabase(Postgres + Realtime) 멀티플레이, GitHub Pages 배포.
코드 주석과 문서는 한국어로 쓴다.

## Commands

```bash
npm install
npm run dev                  # vite dev server → http://localhost:5173 (서비스 워커 꺼짐)
npm test                     # vitest run — 규칙 계약 · AI 강도 회귀 · 스토어 계약 · 표기 가드
npm run test:watch
npm run test:sql             # 서버(plpgsql)·클라이언트 규칙 일치를 로컬 Postgres(PGlite)로 — 빠른 모드, `-- --deep` 은 깊은 모드
npm run typecheck            # tsc --noEmit (scripts/ · 설정 파일 포함)
npm run build                # tsc --noEmit + vite build → dist/ (PWA 서비스 워커·매니페스트 포함)
npm run preview              # 빌드 결과 서빙 — PWA 설치·오프라인은 dev 가 아니라 여기서 확인
npm run generate-pwa-assets  # public/icon.svg → PWA 아이콘·favicon (pwa-assets.config.ts)
npm run bench:seats          # 선후공 편차 실측(수백 판 — vitest 밖)
npm run e2e:mp               # 실서버 규칙 일치 검증(.env.local 필요 — 아래 '멀티플레이' 참고)
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
- **표기**: 비슷한 3×4 변형 게임의 상표명을 코드·문서·화면 어디에도 쓰지 않는다(`src/naming.test.ts` 가 막는다).

## Layering

```
src/core/      순수 규칙 (UI·네트워크 무관, 테스트 1급 대상)
  board.ts       칸 순서 · KIND_DIRS/STEPS(말 방향) · 시작 배치 — 동결 계약
  rules.ts       RuleConfig(3회 반복) · 판정 순서 머리말 · ONLINE_MAX_PLIES
  gameState.ts   legalMoves · applyMoveInPlace/undoMove · applyMove · 판정 · computeKey · 스냅샷/전송형
  zobrist.ts     국면 해시(전치표)
  view.ts        boardView(하이라이트) · resolveClick(클릭 의미) · turnHint/phaseLabel(문구) · SeatPref/resolveSeat
  testkit.ts     테스트 전용 국면 빌더(12글자 보드 문자열)
src/engine/    AI (UI 무관)
  evaluate.ts    평가함수 / search.ts 알파베타+반복심화+전치표+전술 판정
  ai.ts          chooseMove(난이도) · bestMove(힌트) · PRESETS / ai.worker.ts · aiClient.ts 워커 창구
src/store/     Zustand — appStore(화면) · gameStore(혼자 하기) · multiplayerStore(온라인) — 엔진·서버와 UI 사이의 접착제
src/ui/        React 컴포넌트 (표현 전담, 상태는 스토어에서)
src/lib/       supabase.ts(클라이언트 — 동적 import 전용) · env.ts(설정 여부만) · chat · feedback
src/data/      changelog(패치노트 단일 진실원본) · links
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
- 채팅은 테이블 없이 Realtime **broadcast**(채널 `tj:<roomId>`, 이벤트 `chat`)만 쓴다. 받은 payload 는 `toChatMessage` 로 검증한다.
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
- **공개 RPC 시그니처**(클라이언트가 부르는 `tj_*` 9개의 이름·인자·반환)는 옛 클라이언트(배포 전에 열어 둔 탭·설치한 PWA)와의
  계약이다. 인자는 기본값을 붙여 뒤에만 더한다. 인자 목록이 바뀐 `create or replace` 는 실서버에서 함수를 바꾸지 않고
  오버로드를 하나 더 만들어 옛 호출을 'not unique' 로 깨므로, 마이그레이션에서 옛 시그니처를 `drop function` 한 뒤 새로 만들고
  revoke/grant 를 다시 한다. `test:sql` 의 `PUBLIC_RPCS` 표와 'schema.sql = migrations/' 대조가 이것을 지키게 한다.
- **⚠️ `.env.local` 이 있으면 e2e 가 확인 없이 실서버에 방·익명 사용자를 만든다.** 서브에이전트·리뷰를 돌릴 때는
  `.env.local` 을 레포 밖으로 치워 둔다. `service_role` 키는 절대 쓰지 않는다(스크립트가 거부한다).

## PWA · 배포 · CI

- `vite-plugin-pwa` 0.21(Vite 6 까지만 지원 — Vite 메이저를 올릴 때 함께 확인), `registerType: 'prompt'`.
  서비스 워커 등록은 `ui/PwaStatus.tsx` 한 곳(새 버전은 사용자가 '업데이트'를 눌러 적용). dev 에서는 꺼져 있다.
  알림은 **홈에서만** 띄운다 — 업데이트는 새로고침이라 진행 중인 판을 날리고 온라인 방에서 빼낸다.
- 설치 버튼(`ui/InstallButton.tsx`)은 `beforeinstallprompt` 를 모듈에서 한 번 받아 두고 모든 버튼이 나눠 쓴다.
  헤더에는 아이콘(📥, `compact`)만 두고 페이지가 최대 폭(560px)보다 좁으면 숨긴다 — 첫 방문엔 이벤트가 판 도중에 와서
  헤더가 한 줄 늘며 판을 밀어내기 때문(좁은 화면은 홈 카드가 창구). 글자 버튼(`⬇ 앱 설치`)을 헤더에 넣으면 솔로 헤더가 늘 두 줄이 된다.
- 아이콘은 `public/icon.svg` 하나가 원본이다(王 은 글꼴이 아니라 획으로 그린다). 고친 뒤 `npm run generate-pwa-assets`.
- `main` push 마다 `.github/workflows/deploy.yml` 이 GitHub Pages 로 배포한다(Node 24). repo Variables
  `VITE_SUPABASE_URL`·`VITE_SUPABASE_ANON_KEY` 가 비어 있으면 온라인 대전이 꺼진 채 나가지 않게 빌드가 멈춘다.
- PR(대상 `main`)마다 `.github/workflows/ci.yml` 이 `npm ci` → typecheck → test → test:sql → build 를 돌린다(Node 24, `ubuntu-latest`
  잡 `check` 하나, Supabase 값 없이 빌드). `check` 는 `main` 브랜치 보호의 **필수 검사**다 — 잡 이름을 바꾸거나 경로 필터를
  걸면 검사가 보고되지 않는 PR 이 머지 대기로 막힌다(바꿀 때는 보호 설정도 함께).

## Contributing & releases

`CONTRIBUTING.md` 참고. 트렁크 기반: 이슈 1개 → `<type>/<이슈>-<슬러그>` 브랜치 → PR(`Closes #n`) → **squash merge**
(`main` push 마다 자동 배포). 배포와 *공지*는 분리 — 공지는 `src/data/changelog.ts` 맨 위에 항목을 추가하면서
웹 버전을 올리고 `web-vX.Y.Z` 태그를 단다.
