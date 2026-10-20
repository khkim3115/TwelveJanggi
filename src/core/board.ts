// 십이장기 보드 위상(topology)과 말의 이동 방향 — 동결 계약.
//
// 12 칸의 인덱스 순서는 core·engine·UI·서버(plpgsql)가 공유하는 단일 좌표계다.
// 순서를 바꾸면 저장된 국면·서버 검증이 아무 에러 없이 다른 게임이 된다. 절대 재배열하지 말 것.
//
//         a     b     c          i = 행 * 3 + 열
//   4  [  0][  1][  2]   행 0 — 적 진영 (녹이 子 를 승격하고 王 이 입성하는 줄)
//   3  [  3][  4][  5]   행 1
//   2  [  6][  7][  8]   행 2
//   1  [  9][ 10][ 11]   행 3 — 녹 진영 (적이 승격·입성하는 줄)
//
// 녹(1P)은 아래에서 위로(행 감소), 적(2P)은 위에서 아래로(행 증가) 나아간다.
// 셀 값은 부호 있는 종류 코드다: +k = 녹, −k = 적, 0 = 빈칸 (k 는 아래 KING…HU).
// 서버의 smallint[] 보드도 같은 인코딩을 쓴다.

export const COLS = 3;
export const ROWS = 4;
export const CELL_COUNT = 12;

/* ── 말 종류 ─────────────────────────────────────────────────────────── */

export const KING = 1; // 王 — 8방향 1칸
export const JANG = 2; // 將 — 상하좌우 1칸
export const SANG = 3; // 相 — 대각 1칸
export const JA = 4; // 子 — 앞 1칸
export const HU = 5; // 侯 — 子 의 승격. 뒤쪽 대각을 뺀 6방향 1칸

export type Kind = 1 | 2 | 3 | 4 | 5;
/** 손패에 들어갈 수 있는 종류(王 은 잡히면 끝, 侯 는 子 로 돌아간다). */
export type HandKind = 2 | 3 | 4;
/** 진영(1 = 녹 선공, 2 = 적 후공). gameState 의 Player 와 같은 값. */
export type Side = 1 | 2;

export const KINDS: readonly Kind[] = [KING, JANG, SANG, JA, HU];
export const HAND_KINDS: readonly HandKind[] = [JANG, SANG, JA];

/** 테스트 국면 문자열·수 표기용 한 글자(대문자 = 녹). R(將)·B(相) 은 직선·대각 말이라는 뜻. */
export const KIND_LETTER: readonly string[] = ['', 'K', 'R', 'B', 'P', 'H'];

/* ── 칸 좌표 ─────────────────────────────────────────────────────────── */

/** 표준 표기(녹 기준 열 a–c, 아래부터 1–4). 로그·디버깅·접근성 라벨용. */
export const CELL_LABEL: readonly string[] = [
  'a4', 'b4', 'c4',
  'a3', 'b3', 'c3',
  'a2', 'b2', 'c2',
  'a1', 'b1', 'c1',
];

export const ROW_OF: readonly number[] = Array.from({ length: CELL_COUNT }, (_, i) => Math.floor(i / COLS));
export const COL_OF: readonly number[] = Array.from({ length: CELL_COUNT }, (_, i) => i % COLS);

export function cellAt(row: number, col: number): number {
  return row * COLS + col;
}

/** 판을 180° 돌린 칸(점대칭). 녹·적의 방향표와 초기 배치가 이것으로 서로 대응한다. */
export function rotate(cell: number): number {
  return CELL_COUNT - 1 - cell;
}

/** side 의 자기 진영 행(처음 말이 놓이는 줄). */
export function homeRow(side: Side): number {
  return side === 1 ? ROWS - 1 : 0;
}

/** side 에게 상대 진영인 행 — 子 승격, 王 입성(try), 투입 금지가 모두 이 줄 기준이다. */
export function farRow(side: Side): number {
  return side === 1 ? 0 : ROWS - 1;
}

/* ── 이동 방향 ───────────────────────────────────────────────────────── */

/**
 * 말 주인 기준 방향 [행 변화, 열 변화]. 앞 = 행 −1(녹 시점).
 * 적은 판을 180° 돌린 것이므로 두 성분의 부호를 모두 뒤집어 쓴다.
 * UI 는 이 표로 말 위의 이동 방향 눈금을 그리고, 보는 사람과 다른 진영의 말만 180° 돌려 그린다
 * (화면 방향 규칙은 view.ts 의 indexToDisplay · isUpsideDown).
 */
export const KIND_DIRS: readonly (readonly (readonly [number, number])[])[] = [
  [],
  /* 王 */ [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
  /* 將 */ [[-1, 0], [0, -1], [0, 1], [1, 0]],
  /* 相 */ [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  /* 子 */ [[-1, 0]],
  /* 侯 */ [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]],
];

/** STEPS[side][kind][from] — 판 안에 있는 목적지 칸(점유 여부는 보지 않음). 이동 생성의 핫패스. */
export const STEPS: readonly (readonly (readonly (readonly number[])[])[])[] = (() => {
  const bySide = (side: Side) =>
    KIND_DIRS.map((dirs) =>
      Array.from({ length: CELL_COUNT }, (_, from) => {
        const out: number[] = [];
        for (const [dr, dc] of dirs) {
          const r = ROW_OF[from] + (side === 1 ? dr : -dr);
          const c = COL_OF[from] + (side === 1 ? dc : -dc);
          if (r >= 0 && r < ROWS && c >= 0 && c < COLS) out.push(cellAt(r, c));
        }
        return out;
      }),
    );
  return [[], bySide(1), bySide(2)];
})();

/** canStep 의 O(1) 룩업: [side][kind][from][to] 를 평평하게. */
const STEP_FLAT = (() => {
  const f = new Uint8Array(3 * 6 * CELL_COUNT * CELL_COUNT);
  for (const side of [1, 2] as const) {
    for (const kind of KINDS) {
      STEPS[side][kind].forEach((tos, from) => {
        for (const to of tos) f[((side * 6 + kind) * CELL_COUNT + from) * CELL_COUNT + to] = 1;
      });
    }
  }
  return f;
})();

/** side 의 kind 말이 from 에서 to 로 한 걸음에 갈 수 있는가(점유 여부 무관 — 공격 판정에도 쓴다). */
export function canStep(side: Side, kind: Kind, from: number, to: number): boolean {
  return STEP_FLAT[((side * 6 + kind) * CELL_COUNT + from) * CELL_COUNT + to] === 1;
}

/* ── 초기 배치 ───────────────────────────────────────────────────────── */

/**
 * 진영 가운데 王, 주인 기준 왼쪽 相 · 오른쪽 將, 王 바로 앞 子. 두 진영은 점대칭이다
 * (적에게 '오른쪽'은 녹이 보기에 왼쪽).
 */
export const INITIAL_BOARD: readonly number[] = [
  -JANG, -KING, -SANG,
  0, -JA, 0,
  0, JA, 0,
  SANG, KING, JANG,
];
