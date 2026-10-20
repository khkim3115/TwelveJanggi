// 차례·진행 상태·지금 할 일을 한 줄로. 솔로와 멀티가 같은 문구를 쓴다.
// 아래 줄은 화면 낭독기에도 읽히는 안내다(aria-live): 힌트가 있으면 추천 수, 없으면 직전 수와 할 일.
import type { GameState, Move, Player } from '../core/gameState';
import { moveLabel, phaseLabel, tryPendingSide, turnHint } from '../core/view';

interface TurnBannerProps {
  state: GameState;
  me: Player | null;
  /** 두 진영 이름(솔로는 '내(녹)'/'AI (보통)', 멀티는 닉네임). */
  names: Record<Player, string>;
  /** AI·상대를 기다리는 중이면 표시. */
  waiting?: boolean;
  /** 직전 수와 그 수를 두기 전의 판(잡기 표시용). */
  lastMove?: Move | null;
  boardBefore?: Int8Array;
  /** 화면에 떠 있는 힌트. */
  hint?: Move | null;
}

export function TurnBanner({ state, me, names, waiting, lastMove, boardBefore, hint }: TurnBannerProps) {
  const s = state;
  const alert = tryPendingSide(s) !== null;
  const last = lastMove ? `직전 수 ${moveLabel(lastMove, boardBefore)}` : null;
  const now = waiting ? '생각 중…' : hint ? `💡 추천: ${moveLabel(hint, s.board)}` : turnHint(s, me);
  return (
    <div className={`turnbar${alert ? ' turnbar-alert' : ''}`}>
      <div className="turnbar-main">
        <span className={`side-dot side-${s.turn}`} aria-hidden="true" />
        <strong>{s.phase === 'over' ? '게임 종료' : `${names[s.turn]} 차례`}</strong>
        <span className={`chip${alert ? ' chip-alert' : ''}`}>{phaseLabel(s)}</span>
      </div>
      <span className="turnbar-hint" aria-live="polite">
        {last && <span className="turnbar-last">{last} · </span>}
        {now}
      </span>
    </div>
  );
}
