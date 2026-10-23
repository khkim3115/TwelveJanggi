// 온라인 대전 결과. 문구는 솔로 결과의 사전(resultText)을, 창은 같은 OverDialog 를 쓴다.
// '판 보기'로 접으면 마지막 국면을 그대로 둔 채 판 위에 짧은 결과 줄만 남긴다.
import { useState } from 'react';
import type { GameResult, Player } from '../core/gameState';
import { SIDE_LABEL } from '../core/view';
import { isPanelOpen, useAppStore } from '../store/appStore';
import { useMultiplayerStore } from '../store/multiplayerStore';
import { OverDialog, resultText } from './GameOver';

interface MpGameOverProps {
  result: GameResult;
  mySide: Player;
  moveCount: number;
}

export function MpGameOver({ result, mySide, moveCount }: MpGameOverProps) {
  const setScreen = useAppStore((s) => s.setScreen);
  const leave = useMultiplayerStore((s) => s.leave);
  // 솔로 결과와 같다 — 다른 창이 열려 있으면 그 창이 닫힌 뒤에 띄운다(온라인 결과 창은 늘 제목에 초점).
  const panelOpen = useAppStore(isPanelOpen);
  const [peek, setPeek] = useState(false);

  const { title, detail } = resultText(result, mySide);
  const tone = result.kind === 'draw' ? 'draw' : result.winner === mySide ? 'win' : 'lose';
  // 같은 방에서 다시 두는 기능은 없다 — 로비에서 새 방을 만들거나 새 코드로 들어간다.
  const toLobby = () => {
    void leave();
    setScreen('lobby');
  };
  const toMenu = () => {
    void leave();
    setScreen('home');
  };

  if (peek) {
    return (
      <div className="over-bar" role="status">
        <span className={`over-bar-title over-${tone}`}>{title}</span>
        <span className="over-bar-detail">{detail}</span>
        <button className="btn-ghost" onClick={() => setPeek(false)}>
          결과 보기
        </button>
        <button className="btn-primary" onClick={toLobby}>
          로비로
        </button>
      </div>
    );
  }
  if (panelOpen) return null;
  return (
    <OverDialog
      title={title}
      detail={detail}
      tone={tone}
      chips={[`내 편 ${SIDE_LABEL[mySide]}`, `${moveCount}수`]}
      againLabel="로비로"
      focusTitle
      onAgain={toLobby}
      onPeek={() => setPeek(true)}
      onMenu={toMenu}
    />
  );
}
