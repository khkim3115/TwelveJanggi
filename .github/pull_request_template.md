<!-- 규약: CONTRIBUTING.md 참고 -->

## 변경 요약

<!-- 무엇을, 왜 바꿨는지 한두 줄 -->

Closes #

## 종류

- [ ] feat (새 기능)
- [ ] fix (버그 수정)
- [ ] chore / docs / refactor / style / test

## 패치노트 (사용자 공지)

- [ ] 사용자에게 알릴 변경 없음
- [ ] 알릴 변경 있음 → `src/data/changelog.ts` 항목 추가 (이 PR 또는 묶음 릴리스 PR에서)

## 확인

- [ ] `npm run typecheck` 통과
- [ ] `npm test` 통과
- [ ] `npm run build` 통과
- [ ] `src/core` 나 `supabase/` 규칙을 바꿨다면 `npm run e2e:mp` 로 서버·클라이언트 규칙 일치 확인
- [ ] 화면을 바꿨다면 브라우저에서 직접 확인(375px · 라이트/다크 · 키보드)
