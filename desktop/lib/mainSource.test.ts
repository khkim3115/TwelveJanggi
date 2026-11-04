// desktop/main.js 소스 시험(설계 §5.5 · §5.7 · §5.3). 소스를 글자로 읽어, 실행하지 않는 갈래까지 포함한 파일 전체에 대한 배선 규칙을
// 본다 — IPC 등록 창구 · 최상위 호출 순서 · 스킴 특권 · webPreferences 공장 · 애플리케이션 메뉴 · AUMID 상수 · DevTools 조건 ·
// 렌더러로 미는 창구(sendToTray).
// 글자로는 조건 · 콜백 · 계산된 키를 보지 못한다. 실제 실행 순서 · 조건 · fail-closed 는 mainWiring.test.ts 가 가짜 electron 위에서
// main.js 를 돌려 본다.
// 주석을 지운 소스만 본다: 설명 글에 적힌 호출이 규칙에 걸리거나 빠진 호출을 대신 채우지 않게. electron 은 import 하지 않는다.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { PUSH_CHANNELS } = createRequire(import.meta.url)('./pushChannels.cjs') as typeof import('./pushChannels.cjs');

/**
 * JS 소스에서 주석을 지운다 — 문자열 · 템플릿 리터럴 안의 '//' · '/*' 는 그대로 둔다. 줄 번호가 그대로이게 블록 주석 자리의
 * 줄바꿈은 남긴다. 정규식 리터럴은 다루지 않는다(main.js 에 없다 — 있으면 그 안의 따옴표를 문자열 시작으로 읽는다).
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const SOURCE = stripComments(readFileSync(new URL('../main.js', import.meta.url), 'utf8'));

/** text 에 needle 이 몇 번 나오는가(겹치지 않게). */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** `name(` 호출 하나의 인자 글(괄호 짝을 맞춰 자른다). */
function callArguments(text: string, call: string): string {
  const start = text.indexOf(call);
  if (start === -1) return '';
  let depth = 1;
  let i = start + call.length;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
  }
  return text.slice(start + call.length, i - 1);
}

/**
 * `function name(…) { … }` 의 본문 글 — 인자 목록 뒤 첫 중괄호부터 짝을 맞춰 자른다. 없으면 ''. 본문 안 문자열 · 템플릿의 중괄호는
 * 다루지 않는다(그런 글이 있으면 짝이 어긋난다).
 */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  if (start === -1) return '';
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i !== -1 && i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return '';
}

describe('stripComments', () => {
  it('주석은 지우고 문자열 안의 // · /* 와 줄 구조는 둔다', () => {
    const src = ["const a = 'app://x'; // 꼬리 ipcMain.handle(", '/* 덩이', ' 주석 */ const b = "c/*d*/";', 'const t = `e//f`; // 끝'].join('\n');
    expect(stripComments(src)).toBe(["const a = 'app://x'; ", '', ' const b = "c/*d*/";', 'const t = `e//f`; '].join('\n'));
  });
});

describe('main.js', () => {
  it("ipcMain 은 require('electron') 의 구조 분해와 createGuardedIpc(ipcMain, …) 에만 나온다 — IPC 처리기는 createGuardedIpc 로만 등록한다", () => {
    // 등록 함수 이름을 세는 것으로는 ipcMain['handle'](…) · const { on: listen } = ipcMain · 별칭을 못 잡는다 — 이름이 나오는 자리를 본다.
    const electronImport = /\bconst\s*\{([^}]*)\}\s*=\s*require\(\s*'electron'\s*\)\s*;/.exec(SOURCE);
    expect(electronImport, "require('electron') 구조 분해").not.toBeNull();
    const [statement = '', names = ''] = electronImport ?? [];
    expect(names.split(',').map((name) => name.trim())).toContain('ipcMain'); // 이름을 바꾸지 않는다(ipcMain: 다른 이름 아님)
    expect(SOURCE).toMatch(/\bcreateGuardedIpc\(\s*ipcMain\s*,/);
    const rest = SOURCE.replace(statement, '').replace(/\bcreateGuardedIpc\(\s*ipcMain\s*,/g, '');
    expect(rest.match(/\bipcMain\b/g)).toBeNull();
  });

  it('additionalArguments 를 쓰지 않는다 — 비어 있지 않으면 spare renderer 를 못 써 스모크만 다른 시작 경로를 탄다', () => {
    expect(SOURCE).not.toContain('additionalArguments');
  });

  it('최상위 순서: userData → enableSandbox → 스킴 특권 → 단일 인스턴스 잠금(각각 한 번)', () => {
    const calls = ["app.setPath('userData'", 'app.enableSandbox(', 'protocol.registerSchemesAsPrivileged(', 'app.requestSingleInstanceLock('];
    for (const call of calls) expect(count(SOURCE, call), call).toBe(1);
    const positions = calls.map((call) => SOURCE.indexOf(call));
    expect(positions).toStrictEqual([...positions].sort((a, b) => a - b));
  });

  it('registerSchemesAsPrivileged 의 특권은 SCHEME_PRIVILEGES 그대로다(펼치거나 더하지 않는다)', () => {
    const args = callArguments(SOURCE, 'protocol.registerSchemesAsPrivileged(');
    expect(args).toMatch(/\bprivileges:\s*SCHEME_PRIVILEGES\s*[,}]/);
    expect(args).toMatch(/\bscheme:\s*APP_SCHEME\s*[,}]/);
  });

  it('webPreferences 는 한 곳이고 trayWindowPreferences 공장에서만 온다', () => {
    expect(count(SOURCE, 'webPreferences:')).toBe(1);
    expect(SOURCE).toContain('webPreferences: trayWindowPreferences(');
  });

  it('애플리케이션 메뉴를 없앤다', () => {
    expect(SOURCE).toContain('Menu.setApplicationMenu(null)');
  });

  it('AUMID 는 자동 실행 이름 상수(AUTOSTART_NAME)로만 쓴다 — 그 값의 글자를 main.js 에 다시 적지 않는다(두 벌이 어긋나지 않게)', () => {
    expect(SOURCE).toContain('app.setAppUserModelId(AUTOSTART_NAME)');
    expect(SOURCE).not.toContain('com.khkim.twelvejanggi');
  });

  it('webContents.send( 는 sendToTray 안에만 있다 — main→렌더러 전달은 한 함수로만 한다(설계 §5.3)', () => {
    expect(count(SOURCE, 'function sendToTray(')).toBe(1);
    const body = functionBody(SOURCE, 'sendToTray');
    expect(count(body, 'webContents.send(')).toBeGreaterThan(0);
    expect(count(SOURCE, 'webContents.send(')).toBe(count(body, 'webContents.send('));
  });

  it("sendToTray('…' 의 채널은 모두 PUSH_CHANNELS 에 있다 — 부르는 곳은 모두 글자 채널이다(변수로 넘기지 않는다)", () => {
    const callSites = count(SOURCE, 'sendToTray(') - count(SOURCE, 'function sendToTray(');
    const channels = [...SOURCE.matchAll(/\bsendToTray\(\s*'([^']*)'/g)].map((match) => match[1]);
    expect(channels.length).toBeGreaterThan(0);
    expect(channels).toHaveLength(callSites);
    for (const channel of channels) expect(Object.keys(PUSH_CHANNELS), channel).toContain(channel);
  });

  it('openDevTools 는 같은 줄이나 바로 위 줄(빈 줄 건너뜀)의 개발 · TJ_DEVTOOLS 조건 아래에서만 부른다', () => {
    const lines = SOURCE.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('openDevTools')) return;
      const above = lines
        .slice(0, i)
        .reverse()
        .find((candidate) => candidate.trim() !== '');
      const guard = `${above ?? ''}\n${line}`;
      expect(guard).toContain('TJ_DEVTOOLS');
      expect(guard).toContain('!app.isPackaged');
    });
  });
});
