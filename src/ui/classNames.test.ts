// 나인 멘스 모리스에서 옮겨 온 화면별 클래스 이름(mp-primary 등)은 공용 이름으로 바꿨다(#10) — 다시 들어오지 않게 지킨다.
// 버튼은 btn-primary · btn-ghost, 창의 버튼 줄은 modal-actions, 오류 상자는 error-box 다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const RETIRED = ['mp-primary', 'mp-error', 'ghost-btn', 'go-actions', 'settings-close', 'pn-close'];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith('.tsx') || name === 'index.css') out.push(p);
  }
  return out;
}

describe('공용 클래스 이름', () => {
  it('src 의 tsx 와 index.css 에 옛 클래스 이름이 없다', () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
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
