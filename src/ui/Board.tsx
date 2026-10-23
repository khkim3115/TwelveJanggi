// 보드 SVG(3×4). 표현만 담당하고 클릭 의미는 core/view.ts 가 정한다 — 솔로·멀티가 같은 컴포넌트를 쓴다.
//
// 화면은 언제나 "보는 사람의 진영이 아래"다. 칸 배치는 view.displayToIndex, 말 회전은 view.isUpsideDown 이 정한다.
// 칸 하나는 100×100, 판 밖 여백에 좌표(a–c, 1–4)를 적는다.
// 낭독기에는 4행 3열 표(grid)로 보인다. 칸 하나만 Tab 순서에 두고 판 안은 방향키로 옮긴다(view.nextFocusCell).

import { useId, useRef, useState } from 'react';
import { CELL_LABEL, COLS, COL_OF, KING, ROWS, ROW_OF } from '../core/board';
import { DROP, findKing, kindOf, other, sideOf, type GameState, type Move, type Player } from '../core/gameState';
import {
  KIND_NAME,
  SIDE_LABEL,
  boardView,
  displayToIndex,
  entryCell,
  indexToDisplay,
  isUpsideDown,
  nextFocusCell,
  type Selection,
} from '../core/view';
import { Piece } from './Piece';

const CELL = 100;

export interface BoardProps {
  state: GameState;
  /** 지금 조작하는 쪽. 관전(내 차례가 아예 없음)이면 null. */
  me: Player | null;
  /** 화면 아래에 올 진영. 기본은 me(관전이면 녹). */
  viewer?: Player;
  selection: Selection | null;
  lastMove?: Move | null;
  /** 힌트로 제안된 수. 이동이면 출발→도착 화살표, 투입이면 도착 칸만 표시한다(손패 쪽은 HandTray 가 표시). */
  hint?: Move | null;
  /** true 면 클릭을 받지 않는다(AI 계산 중 등). */
  disabled?: boolean;
  onCell: (cell: number) => void;
}

/** 보드 인덱스 → 화면 좌표(칸 중심). */
function centerOf(cell: number, viewer: Player): [number, number] {
  const d = indexToDisplay(cell, viewer);
  return [COL_OF[d] * CELL + CELL / 2, ROW_OF[d] * CELL + CELL / 2];
}

function describe(state: GameState, cell: number): string {
  const v = state.board[cell];
  if (v === 0) return `${CELL_LABEL[cell]} 빈칸`;
  return `${CELL_LABEL[cell]} ${SIDE_LABEL[sideOf(v)]} ${KIND_NAME[kindOf(v)]}`;
}

export function Board({ state, me, viewer: viewerProp, selection, lastMove, hint, disabled, onCell }: BoardProps) {
  const arrowId = useId();
  const viewer: Player = viewerProp ?? me ?? 1;
  const view = boardView(state, disabled ? null : me, selection);
  const active = me !== null && !disabled && state.phase !== 'over' && state.turn === me;
  const pendingKing = view.tryPending !== null ? findKing(state.board, view.tryPending) : -1;
  const selectedCell = selection?.kind === 'cell' ? selection.cell : null;
  const lastTo = lastMove ? lastMove.to : -1;
  const lastFrom = lastMove && lastMove.from !== DROP ? lastMove.from : -1;
  const promotedNow = lastMove?.promote ? lastMove.to : -1;

  // Tab 순서에 둘 칸(화면 칸 번호). 한 번 초점을 받은 뒤에는 마지막 초점 칸 — 화면 위치로 기억하므로
  // 새 판에서 좌석이 바뀌어 판이 뒤집혀도 같은 자리다. 처음에는 고른 칸 → 내 王 → 화면 아래 가운데.
  const [focusD, setFocusD] = useState<number | null>(null);
  const hitRefs = useRef<(SVGRectElement | null)[]>([]);
  const tabD = focusD ?? indexToDisplay(entryCell(state, viewer, selection), viewer);

  // 힌트 화살표(이동만). 도착점 링에 닿기 전에 멈춘다.
  let arrow: { x1: number; y1: number; x2: number; y2: number } | null = null;
  if (hint && hint.from !== DROP) {
    const [x1, y1] = centerOf(hint.from, viewer);
    const [tx, ty] = centerOf(hint.to, viewer);
    const len = Math.hypot(tx - x1, ty - y1);
    const cut = 34 / len;
    arrow = { x1, y1, x2: tx - (tx - x1) * cut, y2: ty - (ty - y1) * cut };
  }

  const renderCell = (d: number) => {
    const i = displayToIndex(d, viewer);
    const x = COL_OF[d] * CELL + CELL / 2;
    const y = ROW_OF[d] * CELL + CELL / 2;
    const v = state.board[i];
    const side = v === 0 ? null : sideOf(v);
    const isTarget = view.targets.has(i);
    const clickable = active && (view.movable.has(i) || isTarget);
    const classes = [
      'cell',
      view.movable.has(i) ? 'cell-movable' : '',
      selectedCell === i ? 'cell-selected' : '',
      clickable ? 'cell-clickable' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const label = [
      describe(state, i),
      selectedCell === i ? '선택됨' : '',
      view.captures.has(i) ? '잡을 수 있음' : isTarget ? '여기로 둘 수 있음' : '',
      view.promotions.has(i) ? '侯 승격' : '',
      i === pendingKing ? '입성 중' : '',
    ]
      .filter(Boolean)
      .join(' — ');

    // 칸은 화면 칸 번호로 key 를 단다 — 좌석이 바뀌어 판이 뒤집혀도 같은 화면 칸의 노드가 남아,
    // 초점과 결과 창의 초점 복귀가 끊기지 않는다(보드 인덱스로 달면 다른 줄로 옮겨지며 새로 그려진다).
    return (
      <g key={d} className={classes} transform={`translate(${x} ${y})`}>
        {/* 그림은 낭독기에서 숨긴다 — 칸의 뜻은 아래 gridcell 의 이름이 전한다(말 한자·侯 배지가 따로 읽히지 않게). */}
        <g aria-hidden="true">
          {i === lastFrom && <rect className="last-from" x={-46} y={-46} width={92} height={92} rx={8} />}
          {i === lastTo && <rect className="last-to" x={-46} y={-46} width={92} height={92} rx={8} />}
          {side !== null && (
            // 칸에 들어온 말이 바뀌면 새로 그린다 — 같은 노드를 재사용하면 회전이 이어져 보일 수 있다.
            <g
              key={v}
              className={`piece-wrap${i === promotedNow ? ' promoted-now' : ''}`}
              transform={isUpsideDown(side, viewer) ? 'rotate(180)' : undefined}
            >
              <Piece kind={kindOf(v)} side={side} />
            </g>
          )}
          {selectedCell === i && (
            <g className="sel-ring">
              <circle className="ring-under" r={46} />
              <circle className="ring" r={46} />
            </g>
          )}
          {i === pendingKing && kindOf(v) === KING && (
            <g className="try-ring">
              <circle className="halo-under" r={47} />
              <circle className="halo" r={47} />
            </g>
          )}
          {isTarget &&
            (v === 0 ? (
              <circle className="target-dot" r={11} />
            ) : (
              <g className="capture-ring">
                <circle className="ring-under" r={45} />
                <circle className="ring" r={45} />
              </g>
            ))}
          {view.promotions.has(i) && (
            <g className="promo-badge" transform="translate(31 -31)">
              <circle r={12} />
              <text dy="0.05em">侯</text>
            </g>
          )}
          {hint && hint.to === i && (
            <g className="hint-ring">
              <circle className="halo-under" r={47} />
              <circle className="halo" r={47} />
            </g>
          )}
          {hint && hint.from === i && <circle className="hint-from" r={46} />}
        </g>
        {/*
          칸은 하나만 Tab 순서에 두고(roving tabindex) 판 안은 방향키로 옮긴다. 누를 수 없을 때(AI 가 생각하는 중 등)도
          초점은 받는다 — aria-disabled 만. 초점을 받는 것이 칸(gridcell) 자체인 까닭: NVDA 는 초점을 받은 표 칸에서만
          초점 모드로 넘어가 방향키를 페이지에 넘겨준다(칸 안의 버튼이면 탐색 모드에 남아 방향키를 가로챈다).
          선택 상태는 이름('선택됨')에 있다 — gridcell 은 aria-pressed 를 지원하지 않는다.
        */}
        <rect
          ref={(el) => {
            hitRefs.current[d] = el;
          }}
          className="cell-hit"
          x={-CELL / 2 + 3}
          y={-CELL / 2 + 3}
          width={CELL - 6}
          height={CELL - 6}
          rx={6}
          role="gridcell"
          tabIndex={d === tabD ? 0 : -1}
          aria-disabled={!clickable}
          aria-label={label}
          onFocus={() => setFocusD(d)}
          onClick={() => !disabled && onCell(i)}
          onKeyDown={(e) => {
            // Alt·Cmd 조합은 브라우저 몫이다(Alt+← 뒤로 가기 등).
            if (e.altKey || e.metaKey) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (!disabled) onCell(i);
              return;
            }
            const next = nextFocusCell(i, viewer, e.key, e.ctrlKey);
            if (next === null) return;
            e.preventDefault();
            hitRefs.current[indexToDisplay(next, viewer)]?.focus();
          }}
        />
      </g>
    );
  };

  return (
    <svg
      className={`board${active ? ' board-active' : ''}`}
      viewBox="-26 -12 342 444"
      role="grid"
      aria-label={`십이장기 판 — 아래쪽이 ${SIDE_LABEL[viewer]} 진영`}
    >
      <defs>
        <marker id={arrowId} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="board-arrow-head" />
        </marker>
      </defs>

      {/* 판 그림 — grid 아래에는 줄과 칸만 남긴다 */}
      <g aria-hidden="true">
        <rect className="board-frame" x={-10} y={-10} width={COLS * CELL + 20} height={ROWS * CELL + 20} rx={12} />
        {/* 위 줄은 상대 진영, 아래 줄은 내 진영 */}
        <rect className={`board-camp camp-${other(viewer)}`} x={0} y={0} width={COLS * CELL} height={CELL} />
        <rect className={`board-camp camp-${viewer}`} x={0} y={(ROWS - 1) * CELL} width={COLS * CELL} height={CELL} />
        <g className="board-grid">
          <rect x={0} y={0} width={COLS * CELL} height={ROWS * CELL} />
          {Array.from({ length: COLS - 1 }, (_, c) => (
            <line key={`v${c}`} x1={(c + 1) * CELL} y1={0} x2={(c + 1) * CELL} y2={ROWS * CELL} />
          ))}
          {Array.from({ length: ROWS - 1 }, (_, r) => (
            <line key={`h${r}`} x1={0} y1={(r + 1) * CELL} x2={COLS * CELL} y2={(r + 1) * CELL} />
          ))}
        </g>
      </g>

      {/* 좌표 — 표시 위치마다 실제 칸 이름을 적으므로 판을 뒤집어도 기보 표기와 맞는다 */}
      <g className="board-coords" aria-hidden="true">
        {Array.from({ length: ROWS }, (_, r) => (
          <text key={`r${r}`} x={-18} y={r * CELL + CELL / 2}>
            {CELL_LABEL[displayToIndex(r * COLS, viewer)].slice(1)}
          </text>
        ))}
        {Array.from({ length: COLS }, (_, c) => (
          <text key={`c${c}`} x={c * CELL + CELL / 2} y={ROWS * CELL + 22}>
            {CELL_LABEL[displayToIndex((ROWS - 1) * COLS + c, viewer)][0]}
          </text>
        ))}
      </g>

      {/* 화면 줄마다 row 하나 — 그리는 순서는 화면 칸 번호(왼쪽 위부터) 그대로다 */}
      {Array.from({ length: ROWS }, (_, r) => (
        <g key={r} role="row">
          {Array.from({ length: COLS }, (_, c) => renderCell(r * COLS + c))}
        </g>
      ))}

      {arrow && (
        <g className="board-hint-arrow" aria-hidden="true">
          {/* 어두운 밑선 — 금색이 나무색 판 위에서 묻히지 않게 */}
          <line className="arrow-under" x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2} />
          <line x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2} markerEnd={`url(#${arrowId})`} />
        </g>
      )}
    </svg>
  );
}
