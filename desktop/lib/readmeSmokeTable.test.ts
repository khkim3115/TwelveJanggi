// desktop/README.md 의 스모크 '필수 검사' 표 시험(#36 T14-1) — 표가 런처의 필수 검사 목록과 어긋나지 않게 한다.
// - 기본 행('(조건부)' 표시가 없는 행)은 BASE_REQUIRED 와 순서까지 같다 — 표 머리말이 '표의 순서는 런처가 찍는 순서' 라고 적는다.
// - 조건부 행은 정확히 connectAllowed · net 이다 — requiredChecks 가 .invalid 빌드 · --net 에서 더하는 둘.
// - 표 전체의 순서는 런처가 찍는 순서다 — 런처는 requiredChecks 의 차례로 검사 표를 찍는다(조건부 둘은 기본 뒤). 런처가 새 조건부 검사를
//   요구하는데 표에 없으면 여기서 걸린다.
// - 행마다 '확인하는 것' 이 비지 않는다. 절 · 표를 못 찾거나 이름 칸을 못 읽는 행이 있으면 빈 채로 통과하지 않고 실패한다.
// 줄은 /\r?\n/ 으로 나눈다 — 이 PC 와 windows-latest 는 저장소를 CRLF 로 받는다(core.autocrlf).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { BASE_REQUIRED, requiredChecks } = require('./smokeResult.cjs') as typeof import('./smokeResult.cjs');

/** 표가 있는 절의 머리글 — 이 줄 뒤(다음 머리글 전)의 첫 표가 스모크 필수 검사 표다. */
const HEADING = '### 필수 검사';
/** 조건부 검사 — 런처가 .invalid 빌드(connectAllowed)와 --net(net)에서만 요구한다. */
const CONDITIONAL = ['connectAllowed', 'net'];
/** 이름 칸 — `이름` 또는 `이름` (조건부). */
const NAME_CELL = /^`([A-Za-z]+)`( \(조건부\))?$/;

interface SmokeRow {
  /** 이름 칸의 원문 — 실패 글에 싣는다. */
  cell: string;
  /** 검사 이름 — 이름 칸이 NAME_CELL 모양이 아니면 null. */
  name: string | null;
  conditional: boolean;
  /** '확인하는 것' 칸. */
  what: string;
}

/** 표 한 줄의 두 칸 — 둘째 칸은 마지막 '|' 까지다. 표 줄 모양이 아니면 null. */
function cellsOf(line: string): [string, string] | null {
  const match = /^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
  return match === null ? null : [match[1], match[2]];
}

/** HEADING 절의 첫 표 — 머리 줄과 데이터 행(구분 줄 뒤). 절이 없거나 다음 머리글 전에 표가 없으면 null. */
function readSmokeTable(text: string): { header: [string, string] | null; rows: SmokeRow[] } | null {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(HEADING);
  if (start < 0) return null;
  let first = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('#')) return null;
    if (lines[index].startsWith('|')) {
      first = index;
      break;
    }
  }
  if (first < 0) return null;
  let end = first;
  while (end < lines.length && lines[end].startsWith('|')) end += 1;
  const [headerLine, , ...dataLines] = lines.slice(first, end);
  const rows = dataLines.map((line): SmokeRow => {
    const cells = cellsOf(line);
    const cell = cells === null ? line : cells[0];
    const match = cells === null ? null : NAME_CELL.exec(cells[0]);
    return { cell, name: match === null ? null : match[1], conditional: match !== null && match[2] !== undefined, what: cells === null ? '' : cells[1] };
  });
  return { header: cellsOf(headerLine), rows };
}

const table = readSmokeTable(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
const rows = table?.rows ?? [];

describe('README 스모크 필수 검사 표', () => {
  it(`'${HEADING}' 절에 표가 있고 머리 줄이 '검사 | 확인하는 것' 이다(못 찾아 빈 채로 통과하지 않게)`, () => {
    expect(table).not.toBeNull();
    expect(table?.header).toStrictEqual(['검사', '확인하는 것']);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('행마다 이름 칸이 `이름` 또는 `이름` (조건부) 다', () => {
    expect(rows.filter((row) => row.name === null).map((row) => row.cell)).toStrictEqual([]);
  });

  it('기본 행 = BASE_REQUIRED(순서까지)', () => {
    expect(rows.filter((row) => !row.conditional).map((row) => row.name)).toStrictEqual([...BASE_REQUIRED]);
  });

  it('조건부 행은 정확히 connectAllowed · net 이다', () => {
    expect(rows.filter((row) => row.conditional).map((row) => row.name)).toStrictEqual(CONDITIONAL);
  });

  it('표 전체의 순서 = 런처가 찍는 순서(requiredChecks — .invalid 빌드 · --net 둘 다)', () => {
    expect(rows.map((row) => row.name)).toStrictEqual(requiredChecks({ net: true, supabaseOrigin: 'https://ci.invalid' }));
  });

  it("행마다 '확인하는 것' 이 비지 않는다", () => {
    expect(rows.filter((row) => row.what === '').map((row) => row.cell)).toStrictEqual([]);
  });
});
