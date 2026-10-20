// 보드 위상·말 방향 불변식. 여기가 깨지면 UI·AI·서버가 조용히 다른 게임을 하게 된다.
import { describe, expect, it } from 'vitest';
import {
  CELL_COUNT,
  CELL_LABEL,
  COLS,
  COL_OF,
  HU,
  INITIAL_BOARD,
  JA,
  JANG,
  KING,
  KINDS,
  KIND_DIRS,
  ROWS,
  ROW_OF,
  SANG,
  STEPS,
  canStep,
  cellAt,
  farRow,
  homeRow,
  rotate,
} from './board';

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

describe('칸 좌표', () => {
  it('12칸 · 라벨이 유일하고 행·열과 맞는다(녹 기준 a–c, 아래부터 1–4)', () => {
    expect(CELL_COUNT).toBe(ROWS * COLS);
    expect(CELL_LABEL).toHaveLength(CELL_COUNT);
    expect(new Set(CELL_LABEL).size).toBe(CELL_COUNT);
    for (let i = 0; i < CELL_COUNT; i++) {
      expect(CELL_LABEL[i]).toBe('abc'[COL_OF[i]] + String(ROWS - ROW_OF[i]));
      expect(cellAt(ROW_OF[i], COL_OF[i])).toBe(i);
    }
    expect(CELL_LABEL[0]).toBe('a4');
    expect(CELL_LABEL[11]).toBe('c1');
  });

  it('rotate 는 180° 회전이고 자기 역함수다', () => {
    for (let i = 0; i < CELL_COUNT; i++) {
      expect(rotate(rotate(i))).toBe(i);
      expect(ROW_OF[rotate(i)]).toBe(ROWS - 1 - ROW_OF[i]);
      expect(COL_OF[rotate(i)]).toBe(COLS - 1 - COL_OF[i]);
    }
  });

  it('진영 행: 녹은 아래(행 3), 적은 위(행 0). 상대 진영 = 상대의 자기 진영', () => {
    expect(homeRow(1)).toBe(3);
    expect(homeRow(2)).toBe(0);
    expect(farRow(1)).toBe(homeRow(2));
    expect(farRow(2)).toBe(homeRow(1));
  });
});

describe('말 이동 방향', () => {
  it('방향 수: 王 8 · 將 4 · 相 4 · 子 1 · 侯 6, 侯 는 뒤쪽 대각이 없다', () => {
    expect(KIND_DIRS.map((d) => d.length)).toEqual([0, 8, 4, 4, 1, 6]);
    expect(KIND_DIRS[HU]).not.toContainEqual([1, -1]);
    expect(KIND_DIRS[HU]).not.toContainEqual([1, 1]);
    expect(KIND_DIRS[JA]).toEqual([[-1, 0]]);
  });

  it('목적지는 판 안의 이웃 한 칸이고 중복·제자리가 없다', () => {
    for (const side of [1, 2] as const) {
      for (const kind of KINDS) {
        for (let from = 0; from < CELL_COUNT; from++) {
          const tos = STEPS[side][kind][from];
          expect(new Set(tos).size).toBe(tos.length);
          for (const to of tos) {
            expect(to).toBeGreaterThanOrEqual(0);
            expect(to).toBeLessThan(CELL_COUNT);
            expect(to).not.toBe(from);
            expect(Math.abs(ROW_OF[to] - ROW_OF[from])).toBeLessThanOrEqual(1);
            expect(Math.abs(COL_OF[to] - COL_OF[from])).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('대표 칸의 목적지(녹)', () => {
    expect(sorted(STEPS[1][KING][4])).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(sorted(STEPS[1][KING][0])).toEqual([1, 3, 4]);
    expect(sorted(STEPS[1][JANG][4])).toEqual([1, 3, 5, 7]);
    expect(sorted(STEPS[1][JANG][0])).toEqual([1, 3]);
    expect(sorted(STEPS[1][SANG][4])).toEqual([0, 2, 6, 8]);
    expect(sorted(STEPS[1][SANG][9])).toEqual([7]);
    expect(STEPS[1][JA][7]).toEqual([4]);
    expect(STEPS[1][JA][1]).toEqual([]); // 맨 윗줄의 子 는 더 갈 곳이 없다(실전에선 이미 侯)
    expect(sorted(STEPS[1][HU][4])).toEqual([0, 1, 2, 3, 5, 7]);
  });

  it('적은 판을 180° 돌린 방향으로 움직인다', () => {
    expect(STEPS[2][JA][4]).toEqual([7]);
    expect(sorted(STEPS[2][HU][7])).toEqual([4, 6, 8, 9, 10, 11]);
    for (const kind of KINDS) {
      for (let from = 0; from < CELL_COUNT; from++) {
        expect(sorted(STEPS[2][kind][rotate(from)])).toEqual(sorted(STEPS[1][kind][from].map(rotate)));
      }
    }
  });

  it('canStep 은 STEPS 와 완전히 일치한다', () => {
    for (const side of [1, 2] as const) {
      for (const kind of KINDS) {
        for (let a = 0; a < CELL_COUNT; a++) {
          for (let b = 0; b < CELL_COUNT; b++) {
            expect(canStep(side, kind, a, b)).toBe(STEPS[side][kind][a].includes(b));
          }
        }
      }
    }
  });
});

describe('초기 배치', () => {
  it('녹: 진영 가운데 王, 왼쪽 相, 오른쪽 將, 王 앞 子', () => {
    expect(INITIAL_BOARD).toHaveLength(CELL_COUNT);
    expect(INITIAL_BOARD[cellAt(3, 0)]).toBe(SANG);
    expect(INITIAL_BOARD[cellAt(3, 1)]).toBe(KING);
    expect(INITIAL_BOARD[cellAt(3, 2)]).toBe(JANG);
    expect(INITIAL_BOARD[cellAt(2, 1)]).toBe(JA);
  });

  it('두 진영은 점대칭이다(적은 녹의 배치를 180° 돌리고 부호만 바꾼 것)', () => {
    for (let i = 0; i < CELL_COUNT; i++) {
      expect(INITIAL_BOARD[rotate(i)]).toBe(-INITIAL_BOARD[i] || 0);
    }
  });
});
