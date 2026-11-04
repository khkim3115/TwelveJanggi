// desktop/lib/opacity.cjs 시험 — 창 투명도 정규화(설계 §5.1 opacity.cjs).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { DEFAULT_OPACITY, MAX_OPACITY, MIN_OPACITY, normalizeOpacity } = require('./opacity.cjs') as typeof import('./opacity.cjs');

describe('상수', () => {
  it('30–100, 기본 100', () => {
    expect([MIN_OPACITY, MAX_OPACITY, DEFAULT_OPACITY]).toStrictEqual([30, 100, 100]);
  });
});

describe('normalizeOpacity', () => {
  it.each([
    [64, 64],
    [30, 30],
    [100, 100],
    [5, 30],
    [29.6, 30],
    [29.4, 30],
    [64.4, 64],
    [64.5, 65],
    [100.4, 100],
    [150, 100],
    [-10, 30],
    [Infinity, null],
    [-Infinity, null],
  ])('%j → %j', (input, want) => {
    expect(normalizeOpacity(input)).toBe(want);
  });

  it.each(['70', NaN, null, true, undefined, {}, [], [70]])('%j 는 받지 않는다(null)', (v) => {
    expect(normalizeOpacity(v)).toBeNull();
  });
});
