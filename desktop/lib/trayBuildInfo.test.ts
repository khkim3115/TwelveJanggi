// desktop/lib/trayBuildInfo.cjs 시험 — tray-build.json 검증(설계 §5.3 'main 은 fail-closed').
// 계약: scripts/trayBuild.ts 가 쓰는 값을 그대로 받아야 한다 — 시험 값을 빌드 도구의 함수로 만들어 둘이 따로 놀지 않게 한다.
// 거부 사례는 정상 값에서 규칙 하나만 어기게 고치고, 오류 문구로 바로 그 규칙에서 걸렸는지 본다.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildTrayBuildInfo, buildTrayCsp } from '../../scripts/trayBuild.ts';

const require = createRequire(import.meta.url);
const { parseTrayBuild } = require('./trayBuildInfo.cjs') as typeof import('./trayBuildInfo.cjs');

const FRAME_ANCESTORS = "; frame-ancestors 'none'";
/** Supabase 값이 든 빌드(AI 워커 포함). */
const INFO = buildTrayBuildInfo(
  buildTrayCsp('https://abc.supabase.co'),
  'assets/ai.worker-x.js',
  '2026-10-26T00:00:00.000Z',
  null,
);
/**
 * Supabase 값도 AI 워커도 없는 빌드(supabaseOrigin · workerScript null) — 모양으로는 받는다. 지금 build:tray 는 AI 워커 경로를
 * 적고, workerScript null 은 스모크의 cspHeader 가 실패시킨다(smoke/active.cjs).
 */
const PLAIN = buildTrayBuildInfo(buildTrayCsp(undefined), null, '2026-10-27T02:35:34.894Z', '1832f3d');
const META = INFO.csp.meta;

/** INFO 에서 일부만 바꾼 JSON(undefined 로 준 키는 빠진다). */
function variant(patch: Record<string, unknown>): string {
  return JSON.stringify({ ...INFO, ...patch });
}
/** meta 만 바꾸고 header 는 meta + frame-ancestors 로 맞춘다 — header 규칙이 아니라 meta 규칙에서 걸리게. */
function withMeta(meta: string): string {
  return variant({ csp: { meta, header: meta + FRAME_ANCESTORS } });
}

describe('parseTrayBuild', () => {
  it('계약 — buildTrayBuildInfo 가 만든 값(Supabase 출처 · AI 워커)을 그대로 받는다', () => {
    expect(parseTrayBuild(JSON.stringify(INFO))).toStrictEqual({ ok: true, value: INFO });
  });

  it('workerScript · supabaseOrigin 이 null 인 빌드도 받는다(build:tray 출력 모양 — 들여쓰기 · 끝 줄바꿈)', () => {
    expect(parseTrayBuild(`${JSON.stringify(PLAIN, null, 2)}\n`)).toStrictEqual({ ok: true, value: PLAIN });
  });

  it('commit 키가 없으면 null 로 받는다(git 없는 빌드)', () => {
    expect(parseTrayBuild(variant({ commit: undefined }))).toStrictEqual({ ok: true, value: INFO });
    expect(parseTrayBuild(variant({ commit: 'abc1234' }))).toStrictEqual({ ok: true, value: { ...INFO, commit: 'abc1234' } });
  });

  it('모르는 키는 값에 싣지 않는다', () => {
    expect(parseTrayBuild(variant({ extra: 1 }))).toStrictEqual({ ok: true, value: INFO });
  });

  it.each<[string, string, string]>([
    ['빈 글', '', 'JSON'],
    ['깨진 JSON', '{', 'JSON'],
    ['최상위 null', 'null', '최상위'],
    ['최상위 배열', '[]', '최상위'],
    ['csp 없음', variant({ csp: undefined }), 'csp 가 객체'],
    ['meta 가 빈 글', withMeta(''), 'csp.meta 가 빈 문자열'],
    ['header 가 문자열이 아님', variant({ csp: { meta: META, header: 1 } }), 'csp.header 가 빈 문자열'],
    ['header 불일치(frame-ancestors 없음)', variant({ csp: { meta: META, header: META } }), 'frame-ancestors'],
    ['meta 에 줄바꿈', withMeta(META.replace('; ', ';\n')), 'ASCII'],
    ["default-src 'none' 없음", withMeta(META.replace("default-src 'none'", "default-src 'self'")), 'default-src'],
    ["첫 default-src 가 'none' 이 아님(뒤의 것은 무시된다)", withMeta(`default-src *; ${META}`), 'default-src'],
    ['supabaseOrigin 없음', variant({ supabaseOrigin: undefined }), 'supabaseOrigin'],
    ['workerScript ../x.js', variant({ workerScript: '../x.js' }), 'workerScript'],
    ['workerScript assets\\x.js', variant({ workerScript: 'assets\\x.js' }), 'workerScript'],
    ['workerScript 없음', variant({ workerScript: undefined }), 'workerScript'],
    ['builtAt 없음', variant({ builtAt: undefined }), 'builtAt'],
    ['commit 이 수', variant({ commit: 1 }), 'commit'],
  ])('거부: %s', (_name, text, reason) => {
    expect(parseTrayBuild(text)).toStrictEqual({ ok: false, error: expect.stringContaining(reason) });
  });
});
