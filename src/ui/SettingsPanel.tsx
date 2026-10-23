// 솔로 설정 — 난이도와 선후공. 바꾼 설정은 다음 판부터 적용되며, 바로 시작할 수도 있다.
import { DIFFICULTIES, DIFFICULTY_DESC, DIFFICULTY_LABEL } from '../engine/ai';
import type { Difficulty } from '../engine/ai';
import { useAppStore } from '../store/appStore';
import { useGameStore } from '../store/gameStore';
import { SIDE_LABEL } from '../core/view';
import { SEAT_NOTE, SeatPicker } from './SeatPicker';
import { useDialog } from './useDialog';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const difficulty = useGameStore((s) => s.difficulty);
  const setDifficulty = useGameStore((s) => s.setDifficulty);
  const humanSeat = useGameStore((s) => s.humanSeat);
  const newGame = useGameStore((s) => s.newGame);
  const inProgress = useGameStore((s) => s.state.ply > 0 && s.state.phase !== 'over');
  const setScreen = useAppStore((s) => s.setScreen);

  const cardRef = useDialog<HTMLDivElement>(onClose);

  const startFresh = () => {
    newGame();
    setScreen('solo');
    onClose();
  };

  return (
    <div className="settings" onClick={onClose}>
      <div
        ref={cardRef}
        className="settings-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="설정"
      >
        <div className="settings-top">
          <h3>⚙️ 설정</h3>
          <button className="pn-x" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <section className="set-section">
          <h4>AI 난이도</h4>
          <div className="diff-list">
            {DIFFICULTIES.map((d: Difficulty) => (
              <button
                key={d}
                className={`diff-row${d === difficulty ? ' on' : ''}`}
                onClick={() => setDifficulty(d)}
                aria-pressed={d === difficulty}
              >
                <span className="diff-name">{DIFFICULTY_LABEL[d]}</span>
                <span className="diff-desc">{DIFFICULTY_DESC[d]}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="set-section">
          <h4>선후공</h4>
          <SeatPicker />
          {inProgress ? (
            <p className="set-note">
              {'이번 판은 '}
              <b>{SIDE_LABEL[humanSeat]}</b>
              {'으로 두는 중 — 바꾼 난이도·선후공은 다음 판부터 적용됩니다.'}
            </p>
          ) : (
            <p className="set-note">{SEAT_NOTE}</p>
          )}
        </section>

        <div className="settings-foot">
          <button className="btn-primary" onClick={startFresh}>
            이 설정으로 새 게임
          </button>
          <button className="btn-ghost" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
