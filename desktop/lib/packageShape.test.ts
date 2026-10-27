// desktop/package.json · package-lock.json 모양 가드 — 설계 §3 'desktop/ 의 의존성은 electron 하나(dev)' · §5.12 'type 필드 없음'.
// Windows 에서 인자 없는 `npm --prefix desktop install` 은 npm 의 전역 설치 분기를 타서 지금 폴더(저장소 루트)를 "file:.." 의존성으로
// 더하고 desktop/node_modules/twelve-janggi → 저장소 루트 정션을 만든다(#20 작업 중 실제로 났다). 그래도 typecheck · 다른 시험은
// 모두 통과해서 이 시험이 두 파일을 직접 읽어 막는다. 설치는 `npm --prefix desktop ci`, lock 을 새로 쓸 때는 desktop 안에서 `npm install`.
// 추적되는 두 파일만 읽는다 — desktop/node_modules 가 없어도(CI check 의 루트 단계) 돈다. electron 은 import 하지 않는다.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** package.json — 이 시험이 보는 필드만 타입을 준다. */
interface Manifest {
  readonly [field: string]: unknown;
  readonly devDependencies?: Readonly<Record<string, string>>;
}
/** package-lock.json(lockfileVersion 3)의 packages 항목 — 이 시험이 보는 필드만. */
interface LockEntry {
  readonly version?: string;
  readonly link?: boolean;
}

/** desktop/ 의 JSON 파일 하나 — 이 시험 파일 기준 상대 경로로 읽는다(실행 위치와 무관). */
function readDesktopJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')) as T;
}

const MANIFEST = readDesktopJson<Manifest>('package.json');
const PACKAGES = readDesktopJson<{ packages?: Readonly<Record<string, LockEntry>> }>('package-lock.json').packages ?? {};

/** ^44 를 만족하는 버전 = 44.x.y — semver 의 ^ 는 프리릴리스(44.1.0-beta.1 등)를 받지 않는다. */
const ELECTRON_44 = /^44\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

describe('desktop/package.json', () => {
  it('type 필드가 없다 — main.js · preload.js 가 CJS 로 읽힌다(설계 §5.12)', () => {
    expect(MANIFEST).not.toHaveProperty('type');
  });

  it('의존성은 electron 하나(dev)다(설계 §3)', () => {
    // dependencies · optionalDependencies 는 설치 파일(#22)에 실린다 — file:.. 이면 저장소 루트가 통째로 실릴 수 있다.
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      expect(MANIFEST).not.toHaveProperty(field);
    }
    expect(Object.keys(MANIFEST.devDependencies ?? {})).toStrictEqual(['electron']);
  });
});

describe('desktop/package-lock.json', () => {
  it("packages 의 키는 루트('')와 node_modules/… 뿐이다 — file: · 링크가 가리키는 폴더('..' 등)가 없다", () => {
    expect(Object.keys(PACKAGES)).toContain('');
    expect(Object.keys(PACKAGES).filter((key) => key !== '' && !key.startsWith('node_modules/'))).toStrictEqual([]);
  });

  it('링크 항목(link: true — 정션 · 심볼릭 링크로 깔리는 것)이 없다', () => {
    expect(Object.keys(PACKAGES).filter((key) => PACKAGES[key]?.link === true)).toStrictEqual([]);
  });

  it('electron 은 ^44 를 만족하는 버전으로 풀려 있다(설계 §5.1 — 메이저는 44, 패치는 lock 이 고정한다)', () => {
    expect(PACKAGES['node_modules/electron']?.version).toMatch(ELECTRON_44);
  });
});
