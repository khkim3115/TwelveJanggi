// 테스트 전용 국면 빌더. 앱 번들에는 포함되지 않는다(테스트에서만 import).
//
// 보드 문자열은 12글자 — '.' 빈칸, 대문자 녹 / 소문자 적: K 王 · R 將 · B 相 · P 子 · H 侯.
// 인덱스는 board.ts 순서 그대로(행 0 = 적 진영부터). 공백은 무시하므로 행마다 띄어 써도 된다:
//   'rkb .p. .P. BKR'  ← 시작 국면
//
// makeState 는 말 보존을 검증한다. 실제 대국에서 나올 수 없는 국면(같은 말 3개, 승격 줄의 子 등)은
// 해시 표 범위를 벗어나거나 판정 전제를 깨서 조용히 틀린 결과를 내기 때문이다.
// 단 "입성 대기 王 이 직전에 어디서 왔는가" 같은 이력 조건은 보지 않는다 — 판정 순서를 고정하는
// 인위적 국면(실전에선 안 나오는 겹침)을 테스트에서 만들 수 있게 일부러 열어 둔다.

import { CELL_COUNT, HU, JA, JANG, KING, KIND_LETTER, ROW_OF, SANG, farRow, type Kind } from './board';
import { DEFAULT_RULES, type RuleConfig } from './rules';
import {
  findKing,
  handIndex,
  kindOf,
  pieceCode,
  sideOf,
  stateFrom,
  type GameState,
  type Player,
} from './gameState';

export interface StateSpec {
  board: string;
  turn?: Player;
  /** 손패 [녹, 적] — 'RBP' 처럼 종류 글자를 늘어놓는다(대소문자 무관, K·H 불가). */
  hand?: [string, string];
  rules?: Partial<RuleConfig>;
}

const LETTER_KIND: Record<string, Kind> = { K: KING, R: JANG, B: SANG, P: JA, H: HU };

export function makeState(spec: StateSpec): GameState {
  const cells = spec.board.replace(/\s/g, '');
  if (cells.length !== CELL_COUNT) {
    throw new Error(`board 문자열은 ${CELL_COUNT}글자여야 합니다 (받은 값: ${cells.length})`);
  }
  const board = new Int8Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = cells[i];
    if (c === '.') continue;
    const kind = LETTER_KIND[c.toUpperCase()];
    if (!kind) throw new Error(`알 수 없는 칸 문자: ${c}`);
    board[i] = pieceCode(c === c.toUpperCase() ? 1 : 2, kind);
  }

  const hand = new Int8Array(6);
  const specHand = spec.hand ?? ['', ''];
  ([1, 2] as const).forEach((side) => {
    for (const c of specHand[side - 1].toUpperCase()) {
      const kind = LETTER_KIND[c];
      if (kind !== JANG && kind !== SANG && kind !== JA) throw new Error(`손패에 둘 수 없는 글자: ${c}`);
      hand[handIndex(side, kind)] += 1;
    }
  });

  const turn = spec.turn ?? 1;
  validate(board, hand, turn);
  return stateFrom(board, hand, turn, { ...DEFAULT_RULES, ...spec.rules });
}

/** 실제 대국에서 성립하는 국면인지 — 말 보존과 판정 전제. */
function validate(board: Int8Array, hand: Int8Array, turn: Player): void {
  const total = { [JANG]: 0, [SANG]: 0, [JA]: 0 } as Record<number, number>;
  const kings = [0, 0];
  for (let i = 0; i < CELL_COUNT; i++) {
    const v = board[i];
    if (v === 0) continue;
    const side = sideOf(v);
    const kind = kindOf(v);
    if (kind === KING) kings[side - 1] += 1;
    else total[kind === HU ? JA : kind] += 1;
    if (kind === JA && ROW_OF[i] === farRow(side)) {
      throw new Error(`${KIND_LETTER[kind]} 가 승격 줄(${i})에 있습니다 — 그 자리면 侯 여야 합니다`);
    }
  }
  for (let h = 0; h < 6; h++) {
    total[JANG + (h % 3)] += hand[h];
    if (hand[h] > 2) throw new Error('같은 종류 손패는 2개를 넘을 수 없습니다');
  }
  if (kings[0] !== 1 || kings[1] !== 1) throw new Error('王 은 진영마다 정확히 1개여야 합니다');
  for (const kind of [JANG, SANG, JA]) {
    if (total[kind] !== 2) {
      throw new Error(`${KIND_LETTER[kind]} 는 판+손패 합계가 2개여야 합니다 (받은 값: ${total[kind]})`);
    }
  }
  const k = findKing(board, turn);
  if (ROW_OF[k] === farRow(turn)) {
    throw new Error('차례인 쪽 王 이 이미 상대 진영에 있습니다 — 이미 try 로 끝난 국면');
  }
}

/** 국면을 12글자 보드 문자열로(행 사이 공백). 실패한 테스트를 눈으로 읽기 위한 것. */
export function formatBoard(s: GameState): string {
  let out = '';
  for (let i = 0; i < CELL_COUNT; i++) {
    if (i > 0 && i % 3 === 0) out += ' ';
    const v = s.board[i];
    if (v === 0) out += '.';
    else {
      const letter = KIND_LETTER[kindOf(v)];
      out += sideOf(v) === 1 ? letter : letter.toLowerCase();
    }
  }
  return out;
}

/** 손패를 [녹, 적] 글자 모음으로. */
export function formatHand(s: GameState): [string, string] {
  const one = (side: Player) =>
    [JANG, SANG, JA].map((k) => KIND_LETTER[k].repeat(s.hand[handIndex(side, k as 2 | 3 | 4)])).join('');
  return [one(1), one(2)];
}
