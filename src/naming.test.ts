// 표기 가드 — 이 게임은 한자 말을 쓰는 십이장기로만 소개한다. 비슷한 3×4 변형의 상표명(한·영·일)이
// 코드·문서·화면 문구에 들어가지 않게 막는다. 금칙어는 조각을 이어 만들어 이 파일 자체에는 원문이 없다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BANNED = [
  '동물' + '장기',
  'do' + 'butsu',
  'dou' + 'butsu',
  'animal ' + 'shogi',
  'どう' + 'ぶつ',
  '動物' + '将棋',
].map((w) => w.toLowerCase());

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.tmp', '.claude']);
const TEXT = /\.(ts|tsx|js|mjs|css|html|md|json|sql|yml|yaml|svg)$/;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name === 'package-lock.json') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

describe('표기 가드', () => {
  it('저장소 어디에도 다른 게임의 상표명이 없다', () => {
    const hits: string[] = [];
    for (const file of walk(ROOT, [])) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const w of BANNED) if (text.includes(w)) hits.push(`${relative(ROOT, file)}: ${w}`);
    }
    expect(hits).toEqual([]);
  });
});
