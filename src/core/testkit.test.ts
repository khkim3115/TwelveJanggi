// 테스트 빌더 자체의 계약 — 실전에서 나올 수 없는 국면을 조용히 받아들이지 않는다.
import { describe, expect, it } from 'vitest';
import { createInitialState } from './gameState';
import { formatBoard, formatHand, makeState } from './testkit';

describe('makeState', () => {
  it('시작 국면 문자열로 만든 상태는 createInitialState 와 같다', () => {
    const a = makeState({ board: 'rkb .p. .P. BKR' });
    const b = createInitialState();
    expect(Array.from(a.board)).toEqual(Array.from(b.board));
    expect(a.key).toBe(b.key);
    expect(a.hash).toBe(b.hash);
  });

  it('보드·손패 문자열이 왕복한다', () => {
    const s = makeState({ board: 'k.. .h. .R. .K.', hand: ['rbb', 'p'] });
    expect(formatBoard(s)).toBe('k.. .h. .R. .K.');
    expect(formatHand(s)).toEqual(['RBB', 'P']);
  });

  it.each([
    ['글자 수가 틀림', { board: 'rkb .p. .P. BK' }],
    ['모르는 글자', { board: 'rkb .p. .X. BKR' }],
    ['王 이 없음', { board: 'r.b .p. .P. BKR', hand: ['', ''] as [string, string] }],
    ['將 이 3개', { board: 'rkb .p. .P. BKR', hand: ['R', ''] as [string, string] }],
    ['相 이 1개', { board: 'rk. .p. .P. BKR' }],
    ['손패에 王', { board: 'rkb .p. .P. BKR', hand: ['K', ''] as [string, string] }],
    ['승격 줄의 子', { board: 'Pkb .p. ... BKR', hand: ['', 'R'] as [string, string] }],
    ['차례인 쪽 王 이 이미 입성', { board: 'K.. .k. ... ...', hand: ['RBP', 'RBP'] as [string, string] }],
  ])('%s → 거부', (_, spec) => {
    expect(() => makeState(spec)).toThrow();
  });

  it('입성해 있는 王 이 차례가 아닌 쪽이면 받아들인다(입성 대기 국면)', () => {
    expect(() =>
      makeState({ board: 'K.. .k. ... ...', turn: 2, hand: ['RBP', 'RBP'] }),
    ).not.toThrow();
  });
});
