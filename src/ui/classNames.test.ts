// 나인 멘스 모리스에서 옮겨 온 화면별 클래스 이름(mp-primary 등)은 공용 이름으로 바꿨다(#10) — 다시 들어오지 않게 지킨다.
// 버튼은 btn-primary · btn-ghost, 창의 버튼 줄은 modal-actions, 오류 상자는 error-box 다.
// 트레이 앱(src/tray)의 클래스는 모두 tapp- 접두사다(설계 §5.8) — index.css 의 .tray* 는 손패(HandTray) 것이라
// 두 이름 공간이 섞이면 읽는 사람도 스타일도 어느 쪽 것인지 헷갈린다.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const TRAY_APP = join(SRC, 'tray');
const RETIRED = ['mp-primary', 'mp-error', 'ghost-btn', 'go-actions', 'settings-close', 'pn-close'];

/** dir 아래에서 keep 이 참인 파일 경로를 모은다. */
function sources(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, keep, out);
    else if (keep(name)) out.push(p);
  }
  return out;
}

describe('공용 클래스 이름', () => {
  it('src 의 tsx 와 index.css 에 옛 클래스 이름이 없다', () => {
    const hits: string[] = [];
    for (const file of sources(SRC, (name) => name.endsWith('.tsx') || name === 'index.css')) {
      const text = readFileSync(file, 'utf8');
      for (const name of RETIRED) {
        // 앞은 글자·하이픈이 아니고 뒤는 글자가 아닌 곳 — mp-error-row 같은 파생 이름도 걸린다.
        const re = new RegExp(`(?<![\\w-])${name}(?!\\w)`, 'g');
        for (const _ of text.matchAll(re)) hits.push(`${relative(SRC, file)}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

/** CSS 의 클래스 선택자 이름. 주석은 뺀다 — 설명 글에 '.tray*' 를 적을 수 있게. */
function cssClasses(css: string): string[] {
  const names = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g);
  return [...names].map((match) => match[1]);
}

/**
 * tsx 의 className 속성 값 안의 낱말. 따옴표 값은 그대로, {…} 식은 중괄호가 닫힐 때까지 본다 — 식 안의 변수 이름도
 * 낱말로 잡히므로 tray 로 시작하는 변수 이름도 걸린다(바꿔 쓴다). className 이 아닌 속성 · 컴포넌트 이름은 보지 않는다.
 */
function tsxClasses(source: string): string[] {
  const words: string[] = [];
  for (const attr of source.matchAll(/\bclassName\s*=\s*/g)) {
    const start = attr.index + attr[0].length;
    let end = start + 1;
    if (source[start] === '{') {
      for (let depth = 1; end < source.length && depth > 0; end++) {
        if (source[end] === '{') depth++;
        else if (source[end] === '}') depth--;
      }
    } else {
      end = source.indexOf(source[start], start + 1) + 1;
    }
    words.push(...(source.slice(start, end).match(/[A-Za-z_][\w-]*/g) ?? []));
  }
  return words;
}

const isTrayName = (name: string) => /^tray/i.test(name);

describe('트레이 앱 클래스 이름', () => {
  it('판정기 — tray 로 시작하는 클래스만 잡는다', () => {
    expect(cssClasses('.tray { } .tray-slot:hover, a .tapp-x > .Tray2, div.tray-on { }').filter(isTrayName)).toEqual([
      'tray',
      'tray-slot',
      'Tray2',
      'tray-on',
    ]);
    // 주석 · 숫자 · tapp- 접두사 안의 tray 는 걸리지 않는다
    expect(cssClasses('/* index.css 의 .tray* 는 손패 것 */ .tapp-app { margin: 0.5rem .75rem; } .tapp-tray-x { }')).toEqual([
      'tapp-app',
      'tapp-tray-x',
    ]);
    expect(cssClasses('/* .tray */ .tapp-app { }').filter(isTrayName)).toEqual([]);

    const tsx = `<div className="tapp-a tray-b" /><p className={on ? 'tapp-c' : "tray"} /><i className={\`tapp-d \${x ? 'tray-e' : ''}\`} />`;
    expect(tsxClasses(tsx).filter(isTrayName)).toEqual(['tray-b', 'tray', 'tray-e']);
    // className 이 아닌 속성 · 컴포넌트 이름(HandTray)은 클래스가 아니다
    expect(tsxClasses('<HandTray id="tray-root" title="tray" data-tray="x" />')).toEqual([]);
    expect(tsxClasses('<HandTray className="tapp-hand" />').filter(isTrayName)).toEqual([]);
  });

  it('src/tray 의 tsx · css 에 tray 로 시작하는 클래스가 없다', () => {
    const files = existsSync(TRAY_APP) ? sources(TRAY_APP, (name) => /\.(tsx|css)$/.test(name)) : [];
    // 한 파일도 읽지 않은 채 통과하지 않게 — css 와 tsx 가 각각 있어야 한다
    expect(files.some((file) => file.endsWith('.css')), 'src/tray 의 css').toBe(true);
    expect(files.some((file) => file.endsWith('.tsx')), 'src/tray 의 tsx').toBe(true);

    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const names = file.endsWith('.css') ? cssClasses(text) : tsxClasses(text);
      for (const name of names) if (isTrayName(name)) hits.push(`${relative(SRC, file)}: ${name}`);
    }
    expect(hits).toEqual([]);
  });
});
