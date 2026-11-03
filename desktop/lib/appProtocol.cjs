'use strict';
// app:// 처리기의 순수 부분(설계 §5.2 · D4). main.js 는 시작할 때 렌더러 루트로 색인을 한 번 만들고, 요청마다
// resolveAppRequest 의 판정을 Response(Content-Type · CSP 헤더 · nosniff)로 바꾼다. 이 파일은 electron 을 require 하지
// 않는다 — vitest · 루트 검사가 desktop/node_modules 없이 돈다.
// - 색인은 빌드 산출물만 담는다: 일반 파일(Dirent.isFile)만 넣고 디렉터리만 재귀한다. 심볼릭 링크 · 정션(Node 는 정션도
//   심볼릭 링크로 본다)과 루트의 tray-build.json 은 넣지 않는다. 표에 없는 확장자는 unmapped 로 낸다.
// - 요청은 문자열로만 본다. 요청 문자열은 path.join/normalize 에 들어가지 않고, 내주는 경로는 색인의 값이다.
//   표준 스킴의 URL 파서는 '..' 를 접어 버리고(app://twelvejanggi/../x → /x) 디코딩된 %5c 는 Windows 에서 구분자가
//   되므로, 쿼리 · 해시만 뗀 raw 경로를 한 번 디코딩해 세그먼트를 직접 본다.

const fs = require('node:fs');
const path = require('node:path');

const APP_SCHEME = 'app';
const APP_HOST = 'twelvejanggi';
/** 트레이 앱 출처(동결 계약) — localStorage · 익명 세션이 여기에 묶인다. */
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const ENTRY_FILE = 'tray.html';
const ENTRY_URL = `${APP_ORIGIN}/${ENTRY_FILE}`;
/** 빌드 정보 — main 이 검증해서 읽고(trayBuildInfo.cjs), 렌더러에는 내주지 않는다. */
const TRAY_BUILD_FILE = 'tray-build.json';

/**
 * registerSchemesAsPrivileged 의 특권(D1 승인). corsEnabled · stream · bypassCSP · allowServiceWorkers 는 넣지 않는다 —
 * corsEnabled 를 켜면 같은 세션의 다른 출처가 app:// 응답을 읽을 수 있고, stream 은 미디어용이다.
 * supportFetchAPI 는 제품 코드가 쓰지 않는다. 스모크의 페이지 안 fetch 검사(경로 탈출 · 405 · 응답 헤더)용이다.
 */
const SCHEME_PRIVILEGES = Object.freeze({ standard: true, secure: true, supportFetchAPI: true });

/**
 * 확장자(소문자) → Content-Type. 응답에 nosniff 를 붙이므로 표에 없는 확장자는 내주지 않는다(색인의 unmapped).
 * @type {Readonly<Record<string, string>>}
 */
const MIME = Object.freeze({
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

/**
 * 파일 색인. 키는 디코딩된 POSIX 상대 경로('assets/a.js'), 값은 절대 파일 경로다.
 * @typedef {{ files: Map<string, string>, unmapped: string[] }} FileIndex
 */
/**
 * 요청 판정. 200 은 내줄 파일과 Content-Type 이고, 404 · 405 는 본문 없는 응답이다(처리기는 throw · reject 하지 않는다).
 * @typedef {{ status: 200, filePath: string, contentType: string } | { status: 404 } | { status: 405 }} AppResolution
 */

const NOT_FOUND = Object.freeze({ status: 404 });
const METHOD_NOT_ALLOWED = Object.freeze({ status: 405 });
/** HEAD 는 main 이 본문 없이 보낸다. */
const METHODS = new Set(['GET', 'HEAD']);
const APP_URL_RE = /^app:\/\/twelvejanggi(?:[\/?#]|$)/;

/**
 * app://twelvejanggi 의 URL 인가 — 출처가 정확히 같고 그 뒤가 끝 · '/' · '?' · '#' 이다(대소문자 그대로).
 * app://twelvejanggi.evil · app://twelvejanggi:80 · app://user@twelvejanggi 는 아니다.
 * @param {string} url
 * @returns {boolean}
 */
function isAppUrl(url) {
  return typeof url === 'string' && APP_URL_RE.test(url);
}

/**
 * 색인 키의 Content-Type. 확장자는 마지막 세그먼트의 마지막 '.' 부터다(소문자로 찾는다). 확장자가 없거나
 * '.' 으로 시작하는 이름(.gitkeep), 표에 없는 확장자는 null.
 * @param {string} key
 * @returns {string | null}
 */
function contentTypeOf(key) {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot).toLowerCase();
  return Object.hasOwn(MIME, ext) ? MIME[ext] : null;
}

/**
 * 색인 키 — 루트 기준 상대 경로를 POSIX 구분자로 바꾼 것. pathImpl 은 시험이 win32 · posix 를 넣어 본다.
 * @param {string} root
 * @param {string} filePath root 아래 파일의 경로
 * @param {import('node:path').PlatformPath} [pathImpl]
 * @returns {string}
 */
function toIndexKey(root, filePath, pathImpl = path) {
  return pathImpl.relative(root, filePath).split(pathImpl.sep).join('/');
}

/**
 * 렌더러 루트(개발 <repo>/dist-tray · 패키지 resources/renderer)를 훑어 색인을 만든다 — 시작할 때 한 번.
 * 순서가 플랫폼마다 같도록 이름순으로 훑는다. 루트를 읽지 못하면 throw 한다(main 이 fail-closed 로 처리한다).
 * @param {string} root
 * @returns {FileIndex}
 */
function buildFileIndex(root) {
  const base = path.resolve(root);
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {string[]} */
  const unmapped = [];
  /** @param {string} dir */
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const key = toIndexKey(base, full);
        if (key === TRAY_BUILD_FILE) continue;
        if (contentTypeOf(key) === null) unmapped.push(key);
        else files.set(key, full);
      }
      // 그 밖(심볼릭 링크 · 정션 · 장치 등)은 따라가지도 넣지도 않는다.
    }
  };
  walk(base);
  return { files, unmapped };
}

/**
 * 세그먼트 검사(splendor 식, 디코딩 뒤) — 빈 것('//' · 끝 '/') · '.' · '..' · '\' · ':' · NUL 이 든 것을 거부한다.
 * @param {string} segment
 * @returns {boolean}
 */
function isRejectedSegment(segment) {
  return segment === '' || segment === '.' || segment === '..' || /[\\:\0]/.test(segment);
}

/**
 * app:// 요청 → 내줄 파일(200) · 404 · 405. 문자열만 본다(경로 모듈을 쓰지 않는다). throw 하지 않는다.
 * 1. 출처는 정확히 app://twelvejanggi(isAppUrl) — 대문자 · 다른 호스트 · 포트 · 사용자 정보는 404
 * 2. 메서드는 GET · HEAD 만 — 그 밖은 405
 * 3. 쿼리 · 해시를 버리고 퍼센트 디코딩을 한 번만 한다 — 실패하면 404
 * 4. 루트('/')는 tray.html. 그 밖은 세그먼트 검사 뒤 색인에서 찾는다 — 없거나 표에 없는 확장자면 404
 * @param {{ url: string, method: string }} req protocol.handle 의 Request(구조 타입)
 * @param {FileIndex} index
 * @returns {AppResolution}
 */
function resolveAppRequest(req, index) {
  const { url, method } = req;
  if (!isAppUrl(url)) return NOT_FOUND;
  if (!METHODS.has(method)) return METHOD_NOT_ALLOWED;
  const rest = url.slice(APP_ORIGIN.length); // '' 이거나 '/' · '?' · '#' 로 시작한다
  const cut = rest.search(/[?#]/);
  const rawPath = cut === -1 ? rest : rest.slice(0, cut);
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return NOT_FOUND; // 잘못된 % 인코딩
  }
  const rel = decoded.slice(1); // 앞의 '/' 하나
  if (rel !== '' && rel.split('/').some(isRejectedSegment)) return NOT_FOUND;
  const key = rel === '' ? ENTRY_FILE : rel;
  const filePath = index.files.get(key);
  const contentType = contentTypeOf(key);
  if (filePath === undefined || contentType === null) return NOT_FOUND;
  return { status: 200, filePath, contentType };
}

module.exports = {
  APP_SCHEME,
  APP_HOST,
  APP_ORIGIN,
  ENTRY_FILE,
  ENTRY_URL,
  SCHEME_PRIVILEGES,
  MIME,
  isAppUrl,
  toIndexKey,
  buildFileIndex,
  resolveAppRequest,
};
