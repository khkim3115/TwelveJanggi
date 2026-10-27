// desktop/lib/appProtocol.cjs 시험 — app:// 처리기의 순수 부분(설계 §5.2 · D4): 상수 · 파일 색인 · 요청 판정.
// 색인은 한글 · 공백이 든 실제 임시 폴더를 훑는다(정션/심볼릭 링크 포함). 판정 시험은 그 색인으로 문자열만 본다.
// electron 은 import 하지 않는다 — 루트 검사는 desktop/node_modules 없이 돈다.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  ENTRY_FILE,
  ENTRY_URL,
  MIME,
  SCHEME_PRIVILEGES,
  buildFileIndex,
  isAppUrl,
  resolveAppRequest,
  toIndexKey,
} = require('./appProtocol.cjs') as typeof import('./appProtocol.cjs');

const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const NOT_FOUND = { status: 404 };

// 렌더러 루트 모양의 임시 폴더 — 이름에 한글 · 공백이 든다('C:\Users\홍 길동\' · 'D:\Google Drive\…' 같은 루트 대비).
// lnk 는 같은 폴더 안의 형제 sub 를 가리키는 정션(win32) · 심볼릭 링크(posix)다. sub 에 파일을 둬서, 링크가 실제로
// 통하는데도 색인에서 빠지는지 본다. 지울 때는 링크를 먼저 unlink 한다(정션을 거쳐 rmSync 하지 않는다).
const FIXTURE: Record<string, string> = {
  'tray.html': '<!doctype html>',
  'assets/a.js': 'export {};',
  'assets/b.css': 'body {}',
  'assets/x.unknownext': '?',
  'tray-build.json': '{}',
  'sub/c.js': '',
};
let root = '';
let index: ReturnType<typeof buildFileIndex>;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tj-트레이 앱 dist '));
  for (const [rel, text] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  symlinkSync(join(root, 'sub'), join(root, 'lnk'), process.platform === 'win32' ? 'junction' : 'dir');
  index = buildFileIndex(root);
});
afterAll(() => {
  if (!root) return;
  const link = join(root, 'lnk');
  if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
  rmSync(root, { recursive: true, force: true });
});

/** 판정 하나 — 색인은 위 임시 폴더의 것이다. */
function request(url: string, method = 'GET') {
  return resolveAppRequest({ url, method }, index);
}
/** 200 판정의 기대값(루트 아래 절대 경로). */
function served(rel: string, contentType: string) {
  return { status: 200, filePath: join(root, ...rel.split('/')), contentType };
}

describe('상수', () => {
  it('출처 · 진입은 동결 계약이다', () => {
    expect({ APP_SCHEME, APP_HOST, APP_ORIGIN, ENTRY_FILE, ENTRY_URL }).toStrictEqual({
      APP_SCHEME: 'app',
      APP_HOST: 'twelvejanggi',
      APP_ORIGIN: 'app://twelvejanggi',
      ENTRY_FILE: 'tray.html',
      ENTRY_URL: 'app://twelvejanggi/tray.html',
    });
  });

  it('스킴 특권은 standard · secure · supportFetchAPI 셋뿐이고 얼려 있다(D1)', () => {
    expect(SCHEME_PRIVILEGES).toStrictEqual({ standard: true, secure: true, supportFetchAPI: true });
    expect(Object.isFrozen(SCHEME_PRIVILEGES)).toBe(true);
  });

  it('MIME 표 — 글자 형식에는 charset=utf-8 를 붙이고, 얼려 있다', () => {
    expect(MIME).toStrictEqual({
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.map': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
      '.wasm': 'application/wasm',
    });
    expect(Object.isFrozen(MIME)).toBe(true);
  });
});

describe('isAppUrl', () => {
  it.each([
    APP_ORIGIN,
    ENTRY_URL,
    'app://twelvejanggi/',
    'app://twelvejanggi/tray.html?smoke',
    'app://twelvejanggi/assets/ai.worker-x.js',
    'app://twelvejanggi?smoke',
    'app://twelvejanggi#top',
  ])('참: %s', (url) => {
    expect(isAppUrl(url)).toBe(true);
  });

  it.each([
    '',
    'app://',
    'app://twelvejanggi.evil/tray.html',
    'app://twelvejanggix/',
    'app://twelvejanggi:80/tray.html',
    'app://twelvejanggi@other/tray.html',
    'app://user@twelvejanggi/tray.html',
    'app://TwelveJanggi/tray.html',
    'APP://twelvejanggi/tray.html',
    'app:twelvejanggi/tray.html',
    'app:///twelvejanggi/tray.html',
    'app://twelvejanggi\\tray.html',
    'app://other/tray.html',
    'https://twelvejanggi/tray.html',
    'file:///C:/twelvejanggi/tray.html',
    ' app://twelvejanggi/',
  ])('거짓: %s', (url) => {
    expect(isAppUrl(url)).toBe(false);
  });

  it('문자열이 아니면 거짓이다', () => {
    expect(isAppUrl(undefined as unknown as string)).toBe(false);
  });
});

describe('buildFileIndex', () => {
  it('빌드 산출물(일반 파일)만 POSIX 상대 키 → 루트 아래 절대 경로로, 이름순으로 넣는다', () => {
    expect([...index.files.keys()]).toStrictEqual(['assets/a.js', 'assets/b.css', 'sub/c.js', 'tray.html']);
    for (const [key, filePath] of index.files) expect(filePath).toBe(join(root, ...key.split('/')));
  });

  it('표에 없는 확장자는 넣지 않고 unmapped 로 낸다', () => {
    expect(index.unmapped).toStrictEqual(['assets/x.unknownext']);
  });

  it('루트의 tray-build.json 은 넣지 않는다', () => {
    expect(index.files.has('tray-build.json')).toBe(false);
    expect(index.unmapped).not.toContain('tray-build.json');
  });

  it('링크(정션 · 심볼릭 링크)는 실제로 통해도 따라가지도 넣지도 않는다', () => {
    const link = join(root, 'lnk');
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // Node 는 정션도 심볼릭 링크로 본다
    expect(existsSync(join(link, 'c.js'))).toBe(true);
    const keys = [...index.files.keys(), ...index.unmapped];
    expect(keys.filter((key) => key.split('/')[0] === 'lnk')).toStrictEqual([]);
  });
});

describe('toIndexKey — path.win32 · path.posix', () => {
  it.each<[string, typeof win32, string, string, string]>([
    ['win32 · 한글 · 공백 루트', win32, 'C:\\Users\\홍 길동\\dist-tray', 'C:\\Users\\홍 길동\\dist-tray\\assets\\a.js', 'assets/a.js'],
    ['win32 · 끝 구분자 루트', win32, 'D:\\Google Drive\\홍 길동\\r\\', 'D:\\Google Drive\\홍 길동\\r\\tray.html', 'tray.html'],
    ['posix · 한글 · 공백 루트', posix, '/home/홍 길동/dist-tray', '/home/홍 길동/dist-tray/assets/a.js', 'assets/a.js'],
    // posix 에서 '\' 는 이름 글자다 — 키에 남고, resolveAppRequest 의 세그먼트 검사가 이런 키로 가는 요청을 막는다.
    ['posix · 이름의 백슬래시', posix, '/home/홍 길동/r/', '/home/홍 길동/r/sub/a\\b.js', 'sub/a\\b.js'],
  ])('%s', (_name, pathImpl, base, filePath, key) => {
    expect(toIndexKey(base, filePath, pathImpl)).toBe(key);
  });

  it('기본은 이 플랫폼의 path 다', () => {
    expect(toIndexKey(root, join(root, 'assets', 'a.js'))).toBe('assets/a.js');
  });
});

describe('resolveAppRequest — 내주는 것', () => {
  it.each([
    'app://twelvejanggi/',
    'app://twelvejanggi',
    'app://twelvejanggi/tray.html',
    'app://twelvejanggi/tray.html?smoke',
    'app://twelvejanggi/?smoke#top',
  ])('루트 · 진입 → tray.html: %s', (url) => {
    expect(request(url)).toStrictEqual(served('tray.html', HTML));
  });

  it('쿼리 · 해시는 버린다', () => {
    expect(request('app://twelvejanggi/assets/a.js?v=1#h')).toStrictEqual(served('assets/a.js', JS));
  });

  it('HEAD 도 200 이다(본문은 main 이 뺀다)', () => {
    expect(request('app://twelvejanggi/assets/a.js', 'HEAD')).toStrictEqual(served('assets/a.js', JS));
  });

  it('다른 확장자 · 하위 폴더', () => {
    expect(request('app://twelvejanggi/assets/b.css')).toStrictEqual(served('assets/b.css', CSS));
    expect(request('app://twelvejanggi/sub/c.js')).toStrictEqual(served('sub/c.js', JS));
  });
});

describe('resolveAppRequest — 404', () => {
  it.each([
    '/tray-build.json',
    '/sub/',
    '/sub',
    '/missing.js',
    '/lnk/c.js',
    '/lnk',
    '/assets/x.unknownext',
    '/TRAY.HTML',
    '/assets/a.js/',
  ])('색인에 없음: %s', (path) => {
    expect(request(APP_ORIGIN + path)).toStrictEqual(NOT_FOUND);
  });

  it.each([
    '/..%2f..%2fpackage.json',
    '/%2e%2e%5cpackage.json',
    '/..%5c..%5cx',
    '/%2e%2e%2fpackage.json',
    '/../package.json',
    '/assets/../tray.html',
    '/./tray.html',
    '/%2e/tray.html',
    '/assets%5ca.js',
    '/a%00.js',
    '/C:/Windows/win.ini',
    '/C%3a/Windows/win.ini',
    '/assets//a.js',
    '//tray.html',
    '/%2ftray.html',
    '/%E0%A4%A',
    '/%zz.js',
  ])('탈출 · 인코딩 변형 · 잘못된 세그먼트: %s', (path) => {
    expect(request(APP_ORIGIN + path)).toStrictEqual(NOT_FOUND);
  });

  it.each([
    'app://other/tray.html',
    'app://TwelveJanggi/tray.html',
    'app://twelvejanggi.evil/tray.html',
    'app://twelvejanggi:80/tray.html',
    'app://user@twelvejanggi/tray.html',
    'app://twelvejanggi@other/tray.html',
    'APP://twelvejanggi/tray.html',
    'https://twelvejanggi/tray.html',
    'file:///C:/tray.html',
    '',
  ])('출처가 정확히 app://twelvejanggi 가 아님: %s', (url) => {
    expect(request(url)).toStrictEqual(NOT_FOUND);
  });
});

describe('resolveAppRequest — 405', () => {
  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'get'])('GET · HEAD 밖 메서드: %s', (method) => {
    expect(request(ENTRY_URL, method)).toStrictEqual({ status: 405 });
    expect(request(`${APP_ORIGIN}/missing.js`, method)).toStrictEqual({ status: 405 });
  });

  it('출처를 먼저 본다 — 다른 출처는 메서드와 상관없이 404', () => {
    expect(request('app://other/tray.html', 'POST')).toStrictEqual(NOT_FOUND);
  });
});

describe('resolveAppRequest — 손으로 만든 색인', () => {
  const handIndex = {
    files: new Map([
      ['tray.html', 'Z:\\elsewhere\\entry.html'],
      ['%2e%2e/x.js', '/r/%2e%2e/x.js'],
      ['x.unknownext', '/r/x.unknownext'],
    ]),
    unmapped: [],
  };
  const handRequest = (url: string) => resolveAppRequest({ url, method: 'GET' }, handIndex);

  it('내주는 경로는 요청에서 만들지 않고 색인의 값을 그대로 쓴다', () => {
    expect(handRequest(ENTRY_URL)).toStrictEqual({ status: 200, filePath: 'Z:\\elsewhere\\entry.html', contentType: HTML });
  });

  it('퍼센트 디코딩은 한 번만 한다', () => {
    expect(handRequest(`${APP_ORIGIN}/%252e%252e/x.js`)).toStrictEqual({ status: 200, filePath: '/r/%2e%2e/x.js', contentType: JS });
  });

  it('색인에 있어도 표에 없는 확장자는 내주지 않는다', () => {
    expect(handRequest(`${APP_ORIGIN}/x.unknownext`)).toStrictEqual(NOT_FOUND);
  });

  // 실제 색인에는 이런 키가 생기지 않아 위의 404 는 색인 조회만으로도 나온다. 위험한 키를 일부러 넣은 색인으로
  // 세그먼트 검사가 색인 내용과 상관없이 막는지 본다(빈 것 · '.' · '..' · '\' · ':' · NUL).
  const poisonKeys: [string, string][] = [
    ['assets//a.js', '/assets//a.js'],
    ['./a.js', '/./a.js'],
    ['../x.js', '/..%2fx.js'],
    ['..\\x.js', '/..%5cx.js'],
    ['a\\b.js', '/a%5cb.js'],
    ['C:/x.js', '/C:/x.js'],
    ['a\0.js', '/a%00.js'],
  ];
  const poisonIndex = { files: new Map(poisonKeys.map(([key]) => [key, `/r/${key}`])), unmapped: [] };

  it.each(poisonKeys)('세그먼트 검사는 색인 내용과 상관없이 막는다: %j ← %s', (_key, path) => {
    expect(resolveAppRequest({ url: APP_ORIGIN + path, method: 'GET' }, poisonIndex)).toStrictEqual(NOT_FOUND);
  });
});
