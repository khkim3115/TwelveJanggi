# 기여 가이드 — 브랜치 · 커밋 · 릴리스 규약

웹 앱은 `main` 푸시마다 GitHub Pages 로 **자동 배포**된다(연속 배포). 그래서
**코드가 배포되는 시점**과 **사용자에게 패치노트 NEW 가 뜨는 시점**을 분리해 운영한다.
배포는 그때그때, **공지는 모아서**(트렁크 기반 + 패치노트 묶기).

## 브랜치 규약

- 한 이슈 = 한 브랜치, 짧게 유지. 항상 `main` 에서 분기.
- 이름: `<type>/<이슈번호>-<짧은-설명>`
  - 예) `feat/4-online-mp`, `fix/31-drop-row`, `chore/40-deps-bump`, `docs/42-readme`
- `type` 은 커밋 `type` 과 동일: `feat` / `fix` / `chore` / `docs` / `refactor` / `style` / `test`
- `main` 에 직접 커밋 금지 — 자동배포라 항상 "배포 가능" 상태를 유지한다.

## 커밋 규약 (Conventional Commits, 한국어)

- 형식: `<type>(<scope>): <한국어 설명> (#이슈)`
  - 예) `feat(engine): 어려움 AI 전치표 추가 (#25)`
- `scope` 예: `core`, `engine`, `solo`, `mp`, `ui`, `web`, `ci`, `deps` …

## PR & 머지

- 브랜치 → PR(대상 `main`). 본문에 `Closes #이슈` 를 넣으면 머지 시 이슈가 자동으로 닫힌다.
- **Squash merge** 사용 → `main` 히스토리 = "이슈 1개 = 커밋 1줄 `(#PR)`".
- 머지되면 곧바로 자동 배포된다(코드 기준 즉시 반영, 단 NEW 공지는 아래 참고).

## 릴리스 & 패치노트 (방안 A)

1. 작은 단위로 자유롭게 `main` 에 머지한다. 그때마다 배포되지만 **NEW 는 뜨지 않는다**
   (다시 찾은 사용자에게는 홈에 '새 버전이 준비됐어요 · 업데이트' 알림만 뜬다 — 서비스 워커 갱신).
2. 묶을 만큼 모이면 패치노트를 **한 번에** 올린다:
   - `src/data/changelog.ts` 의 `CHANGELOG` **맨 위(index 0)** 에 새 버전 항목 1개를 추가
     (그동안의 변경을 종류별로 한 줄씩 정리).
   - 항목을 추가하면 `LATEST_VERSION` 이 자동 갱신된다 →
     **이 순간 사용자에게 헤더 NEW 배지 + (재방문 사용자엔) 자동 모달이 뜬다.**
   - 버전 문자열은 `package.json` 과 **분리된 웹 공개 버전**(예: `0.2.0`). semver 권장.
3. 같은 버전으로 git 태그 `web-vX.Y.Z` 를 단다.

### 패치노트 항목 작성 요령

- `type`: `feature`(✨ 새 기능) / `improvement`(🔧 개선) / `fix`(🐛 버그 수정)
- 개발 용어 대신 **사용자 언어**로, 한 항목 = 한 변경. 작성 예시는 `src/data/changelog.ts` 참고.

## 버전 체계

| 대상 | 버전 출처 | 태그 | 배포 |
|---|---|---|---|
| 웹 앱 | `src/data/changelog.ts` 의 `LATEST_VERSION` | `web-vX.Y.Z` | `main` push → Pages 자동 |

루트 `package.json` 의 `version` 은 사용자에게 노출되지 않는다 — 패치노트 버전이 웹의 단일 진실원본.

## PR 전 체크

- `npm run typecheck`
- `npm test`
- `npm run build`
- 위 셋과 `npm run test:sql`(빠른 모드)은 PR 을 열면 CI(`.github/workflows/ci.yml`)가 다시 돌린다 — 실패하면 머지 버튼에
  표시되고, 필수 검사라 머지가 막힌다.
- 로직 변경은 **테스트 먼저**(TDD 권장). 순수 로직은 `src/**/*.test.ts`(node 환경).
- `src/core` 를 손댔다면 `src/engine` 강도 회귀 테스트까지 반드시 확인한다.
- `src/core` 나 `supabase/` 의 규칙을 바꿨다면 서버·클라이언트 규칙 일치를 확인한다 — 먼저 로컬에서
  `npm run test:sql -- --deep`, 그다음 `npm run e2e:mp`(실서버에 방·익명 사용자를 만든다 — `README.md` 의 '규칙 일치 검증').
- Supabase 스키마는 공유 프로젝트다 — 바꿀 때는 새 마이그레이션 파일과 `supabase/schema.sql` 을 함께 고치고,
  `tj_` 객체 이름을 하나씩 적어 권한을 다룬다(`CLAUDE.md` 의 '멀티플레이').
