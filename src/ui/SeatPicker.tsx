// 선후공 선택(녹·적·랜덤). 홈과 설정이 같은 것을 쓴다 — 두 벌이면 반드시 갈라진다.
import { SEAT_PREFS, SEAT_PREF_DESC, SEAT_PREF_LABEL, type SeatPref } from '../core/view';
import { useGameStore } from '../store/gameStore';

/**
 * 선후공 안내 — 홈·설정·도움말이 같은 문장을 쓴다. 엔진 실측(scripts/bench-seats.ts, engine/ai.ts 주석)에 근거:
 * 같은 난이도끼리 선공 승점 쉬움 50% · 보통 59% · 어려움 71%, 어려움 상대로 보통 수준은 선공 12% · 후공 3%.
 */
export const SEAT_NOTE =
  '녹이 언제나 먼저 둡니다. AI 가 강할수록 먼저 두는 쪽이 유리해서, 보통·어려움에서는 적으로 두면 더 어렵습니다. 랜덤은 판마다 다시 뽑아요.';

export function SeatPicker() {
  const seatPref = useGameStore((s) => s.seatPref);
  const setSeatPref = useGameStore((s) => s.setSeatPref);

  return (
    <div className="seg seg-seat" role="group" aria-label="선후공 (녹이 먼저 둡니다)">
      {SEAT_PREFS.map((p: SeatPref) => (
        <button
          key={p}
          className={`seg-btn${seatPref === p ? ' on' : ''}`}
          onClick={() => setSeatPref(p)}
          aria-pressed={seatPref === p}
          title={`${SEAT_PREF_LABEL[p]} — ${SEAT_PREF_DESC[p]}`}
        >
          <span className={`side-dot side-${p}`} aria-hidden="true" />
          {SEAT_PREF_LABEL[p]}
        </button>
      ))}
    </div>
  );
}
