// 말 한 개(SVG). 장기 알처럼 팔각형 나무 패에 한자를 새기고, 가장자리 눈금으로 갈 수 있는 방향을 보여 준다.
// 보드·손패·도움말이 같은 그림을 쓴다. (0,0) 중심으로 그리므로 부모가 translate/rotate 한다.
//
// 방향 눈금은 KIND_DIRS(주인 기준, 앞 = 위)를 그대로 그린다 — 보는 사람과 다른 진영의 말은 부모가 통째로
// 180° 돌리므로(view.isUpsideDown) 눈금도 화면 위의 실제 이동 방향과 맞는다.

import { HU, JA, KING, KIND_DIRS, type Kind } from '../core/board';
import type { Player } from '../core/gameState';
import { KIND_HANJA } from '../core/view';

/** 장기처럼 계급이 높을수록 패가 크다. */
const RADIUS: Record<Kind, number> = { 1: 40, 2: 37, 3: 37, 4: 32, 5: 35 };

function octagon(r: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 8; k++) {
    const a = ((22.5 + 45 * k) * Math.PI) / 180;
    pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** 방향 하나의 눈금(바깥을 가리키는 작은 삼각형). */
function pip(dr: number, dc: number, r: number): string {
  const len = Math.hypot(dr, dc);
  const ux = dc / len;
  const uy = dr / len;
  const tip = r * 0.86;
  const base = r * 0.66;
  const half = 4.2;
  const bx = ux * base;
  const by = uy * base;
  return [
    `${(ux * tip).toFixed(2)},${(uy * tip).toFixed(2)}`,
    `${(bx - uy * half).toFixed(2)},${(by + ux * half).toFixed(2)}`,
    `${(bx + uy * half).toFixed(2)},${(by - ux * half).toFixed(2)}`,
  ].join(' ');
}

export interface PieceProps {
  kind: Kind;
  side: Player;
}

export function Piece({ kind, side }: PieceProps) {
  const r = RADIUS[kind];
  const shape = octagon(r);
  return (
    <g className={`piece piece-${side}${kind === HU ? ' piece-hu' : ''}${kind === KING ? ' piece-king' : ''}`}>
      <polygon className="piece-shadow" points={shape} transform="translate(0 3)" />
      <polygon className="piece-face" points={shape} />
      <polygon className="piece-inlay" points={octagon(r - 6)} />
      {KIND_DIRS[kind].map(([dr, dc]) => (
        <polygon key={`${dr},${dc}`} className="piece-pip" points={pip(dr, dc, r)} />
      ))}
      <text className="piece-char" fontSize={kind === KING ? 38 : kind === JA ? 29 : 33} dy="0.05em">
        {KIND_HANJA[kind]}
      </text>
    </g>
  );
}
