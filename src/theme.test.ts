// 글자 대비 가드 — 작은 글자는 바탕 위 4.5:1(WCAG 2.x AA) 이상. index.css 의 다크·라이트 토큰과 규칙을 그대로 읽어 계산한다.
// 라이트에서 상태 색(--hint·--ok·--danger)을 그대로 글자로 쓰면 모자라므로 글자 전용 토큰(--warn-text·--danger-text·--ok-text)을
// 쓴다(#10). 새 규칙이 상태 색을 작은 글자로 쓰면 RULES 에 더한다.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

/** 맨 바깥 규칙(@media 등의 안은 빼고)의 [선택자 목록, 본문]. 주석은 지우고 읽는다 — 줄 끝(CRLF/LF)에 기대지 않는다. */
function topLevelRules(css: string): [string[], string][] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: [string[], string][] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    if (!head.startsWith('@')) rules.push([head.split(',').map((s) => s.trim()), src.slice(open + 1, j - 1)]);
    i = j;
  }
  return rules;
}

/** 본문의 선언 [속성, 값]. 'color' 는 'border-color' 와 섞이지 않게 속성 이름 전체로 비교한다. */
function declarations(body: string): [string, string][] {
  return body
    .split(';')
    .map((d) => d.split(':'))
    .filter((p) => p.length >= 2)
    .map((p) => [p[0].trim(), p.slice(1).join(':').trim()]);
}

const RULES_PARSED = topLevelRules(CSS);

/** 선택자 sel 이 들어 있는 맨 바깥 규칙들 가운데 마지막으로 prop 을 정한 값(같은 우선순위에서는 뒤가 이긴다). */
function ruleValue(sel: string, props: string[]): string {
  let found: string | undefined;
  for (const [sels, body] of RULES_PARSED) {
    if (!sels.includes(sel)) continue;
    for (const [p, v] of declarations(body)) if (props.includes(p)) found = v;
  }
  if (found === undefined) throw new Error(`${sel} 에 ${props.join('/')} 가 없다`);
  return found;
}

interface Theme {
  name: string;
  vars: Record<string, string>;
}

function tokens(selector: string): Record<string, string> {
  const rule = RULES_PARSED.find(([sels]) => sels.length === 1 && sels[0] === selector);
  if (!rule) throw new Error(`${selector} 블록이 없다`);
  return Object.fromEntries(declarations(rule[1]).filter(([p]) => p.startsWith('--')));
}

const darkVars = tokens(':root');
const dark: Theme = { name: 'dark', vars: darkVars };
const light: Theme = { name: 'light', vars: { ...darkVars, ...tokens(":root[data-theme='light']") } };

/** '--x' · 'var(--x)' · '#rgb' · '#rrggbb' 를 테마의 #rrggbb 로. 모르는 값은 그대로(아래 형식 검사에서 걸린다). */
function resolve(t: Theme, spec: string): string {
  const token = spec.startsWith('--') ? spec : /^var\((--[\w-]+)\)$/.exec(spec)?.[1];
  const v = token ? (t.vars[token] ?? `(${token} 없음)`) : spec;
  return /^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join('')}` : v;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** fg · bg 의 대비. 둘 다 #rrggbb 로 풀리지 않으면 그 사실을 실패로 남기고 null. */
function contrast(t: Theme, fg: string, bg: string, label: string): number | null {
  const a = resolve(t, fg);
  const b = resolve(t, bg);
  expect.soft(a, `${label}: 글자색`).toMatch(/^#[0-9a-f]{6}$/i);
  expect.soft(b, `${label}: 바탕색`).toMatch(/^#[0-9a-f]{6}$/i);
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return null;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function expectReadable(t: Theme, fg: string, bg: string, label: string) {
  const r = contrast(t, fg, bg, label);
  if (r !== null) expect.soft(r, `${label} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
}

describe('글자 대비', () => {
  it('글자 토큰은 두 테마 모두 바탕 위 4.5:1 이상', () => {
    for (const t of [dark, light]) {
      for (const fg of ['--text', '--muted', '--warn-text', '--danger-text', '--ok-text'])
        for (const bg of ['--bg', '--surface', '--surface-2']) expectReadable(t, fg, bg, `${t.name} ${fg} on ${bg}`);
      for (const bg of ['--bg', '--surface']) expectReadable(t, '--accent', bg, `${t.name} --accent on ${bg}`);
    }
  });

  it('작은 글자 규칙은 제 바탕 위 4.5:1 이상', () => {
    // [선택자, 바탕들] — null 이면 그 규칙의 background
    const RULES: [string, string[] | null][] = [
      ['.pn-chip-feature', ['--surface']],
      ['.pn-chip-improvement', ['--surface']],
      ['.pn-chip-fix', ['--surface']],
      ['.fb-done', ['--surface']],
      ['.over-win', ['--surface']], // 결과 줄의 '승리!'(굵은 16px — 큰 글자가 아니다)
      ['.btn-danger', ['--surface', '--surface-2']], // 마우스를 올리면 --surface-2
      ['.pn-new', null],
      ['.chat-badge', null],
      ['.chip-alert', null],
    ];
    for (const t of [dark, light])
      for (const [sel, bgs] of RULES) {
        const fg = ruleValue(sel, ['color']);
        for (const bg of bgs ?? [ruleValue(sel, ['background', 'background-color'])])
          expectReadable(t, fg, bg, `${t.name} ${sel} on ${bg}`);
      }
  });
});
