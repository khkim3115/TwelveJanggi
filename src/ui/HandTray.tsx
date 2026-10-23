// 손패(잡아 온 말) 한 줄. 내 손패는 눌러서 놓을 말을 고르고, 상대 손패는 보기만 한다.
// 보드와 같은 말 그림을 쓰고, 보드와 같은 규칙으로 돌려 그린다(보는 사람과 다른 진영의 말은 180°).

import { HAND_KINDS, type HandKind } from '../core/board';
import { handCount, type GameState, type Player } from '../core/gameState';
import { handTileLabel, isUpsideDown } from '../core/view';
import { Piece } from './Piece';

export interface HandTrayProps {
  state: GameState;
  side: Player;
  /** 화면 아래 진영(말 회전 기준). */
  viewer: Player;
  label: string;
  /** 지금 이 손패를 눌러 놓을 수 있는 종류(내 차례가 아니면 빈 집합). */
  droppable: ReadonlySet<HandKind>;
  /** 고른 손패. */
  selected: HandKind | null;
  /** 힌트가 이 손패를 놓는 수면 그 종류. */
  hintPiece?: HandKind | null;
  /** 없으면 보기 전용(상대 손패). */
  onPick?: (piece: HandKind) => void;
}

export function HandTray({ state, side, viewer, label, droppable, selected, hintPiece, onPick }: HandTrayProps) {
  const held = HAND_KINDS.filter((k) => handCount(state, side, k) > 0);
  const flip = isUpsideDown(side, viewer);

  return (
    <div className={`tray tray-${side}`} role="group" aria-label={label}>
      <span className="tray-label" aria-hidden="true">
        <span className={`side-dot side-${side}`} />
        {label}
      </span>
      <div className="tray-pieces">
        {held.length === 0 && <span className="tray-empty">잡은 말 없음</span>}
        {held.map((k) => {
          const n = handCount(state, side, k);
          const glyph = (
            <>
              <svg viewBox="-44 -44 88 88" aria-hidden="true">
                <g transform={flip ? 'rotate(180)' : undefined}>
                  <Piece kind={k} side={side} />
                </g>
              </svg>
              {n > 1 && <span className="tray-count">×{n}</span>}
            </>
          );
          // 상대 손패는 누를 수 없는 그림일 뿐이다 — 버튼으로 두면 낭독기에서 내 손패와 구분되지 않는다.
          if (!onPick) {
            return (
              <span key={k} className="tray-tile" role="img" aria-label={handTileLabel(label, k, n)}>
                {glyph}
              </span>
            );
          }
          const can = droppable.has(k);
          const classes = [
            'tray-tile',
            can ? 'tray-tile-can' : '',
            selected === k ? 'tray-tile-on' : '',
            hintPiece === k ? 'tray-tile-hint' : '',
          ]
            .filter(Boolean)
            .join(' ');
          // disabled 대신 aria-disabled — AI 가 생각하는 동안에도 초점을 잃지 않게.
          return (
            <button
              key={k}
              type="button"
              className={classes}
              aria-disabled={!can}
              aria-pressed={selected === k}
              aria-label={handTileLabel(label, k, n, { can, hinted: hintPiece === k })}
              onClick={() => can && onPick(k)}
            >
              {glyph}
            </button>
          );
        })}
      </div>
    </div>
  );
}
