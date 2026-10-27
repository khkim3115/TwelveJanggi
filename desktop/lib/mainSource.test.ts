// desktop/main.js 소스 시험(설계 §5.5 · §5.7). main 은 Electron 없이 돌릴 수 없어서 소스를 글자로 읽어 배선 규칙을 본다 —
// IPC 등록 창구 · 최상위 호출 순서 · 스킴 특권 · webPreferences 공장 · 애플리케이션 메뉴 · DevTools 조건.
// 주석을 지운 소스만 본다: 설명 글에 적힌 호출이 규칙에 걸리거나 빠진 호출을 대신 채우지 않게. electron 은 import 하지 않는다.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

describe('stripComments', () => {
  it('주석은 지우고 문자열 안의 // · /* 와 줄 구조는 둔다', () => {
    const src = ["const a = 'app://x'; // 꼬리 ipcMain.handle(", '/* 덩이', ' 주석 */ const b = "c/*d*/";', 'const t = `e//f`; // 끝'].join('\n');
    expect(stripComments(src)).toBe(["const a = 'app://x'; ", '', ' const b = "c/*d*/";', 'const t = `e//f`; '].join('\n'));
  });
});

describe('main.js', () => {
  it('ipcMain 의 등록 함수를 직접 부르지 않는다 — IPC 처리기는 createGuardedIpc 로만 등록한다', () => {
    expect(SOURCE.match(/\bipcMain\s*\.\s*(?:handle|handleOnce|on|once|addListener|prependListener|prependOnceListener)\s*\(/g)).toBeNull();
    expect(SOURCE).toMatch(/\bcreateGuardedIpc\(\s*ipcMain\s*,/);
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
