// 솔로 결과 화면. 승패 이유까지 한국어로 풀어 준다(왜 끝났는지 모르면 배울 수 없으니).
// '판 보기'로 창을 접으면 마지막 국면을 그대로 둔 채 판 위에 짧은 결과 줄만 남긴다.
import { useId, useRef, useState } from 'react';
import { DEFAULT_RULES, ONLINE_MAX_PLIES } from '../core/rules';
import type { DrawReason, GameResult, Player, WinReason } from '../core/gameState';
import { SIDE_LABEL } from '../core/view';
import { DIFFICULTY_LABEL } from '../engine/ai';
import { isPanelOpen, useAppStore } from '../store/appStore';
import { useGameStore } from '../store/gameStore';
import { useDialog } from './useDialog';

/** 이유 문구 [이긴 쪽에서 본 말, 진 쪽에서 본 말]. 멀티 결과 화면도 같은 사전을 쓴다. */
export const WIN_REASON: Record<WinReason, [string, string]> = {
  capture: ['상대 王 을 잡았습니다', '내 王 이 잡혔습니다'],
  try: ['내 王 이 상대 진영에서 한 턴을 버텼습니다', '상대 王 이 내 진영에서 한 턴을 버텼습니다'],
  blocked: ['상대가 둘 수 있는 수가 없습니다', '둘 수 있는 수가 없습니다'],
  resign: ['상대가 기권했습니다', '기권했습니다'],
  timeout: ['상대가 시간 안에 두지 않았습니다', '시간 안에 두지 않았습니다'],
};

export const DRAW_REASON: Record<DrawReason, string> = {
  repetition: `같은 국면(판·손패·차례)이 ${DEFAULT_RULES.repetitionLimit}번 나왔습니다`,
  movelimit: `${ONLINE_MAX_PLIES}수가 지나도록 승부가 나지 않았습니다(온라인 대전 상한)`,
};

export function resultText(result: GameResult, me: Player): { title: string; detail: string } {
  if (result.kind === 'draw') {
    return { title: '무승부', detail: DRAW_REASON[result.reason] };
  }
  const won = result.winner === me;
  return {
    title: won ? '승리!' : '패배',
    detail: WIN_REASON[result.reason][won ? 0 : 1],
  };
}

export function GameOver() {
  const result = useGameStore((s) => s.state.result);
  const generation = useGameStore((s) => s.generation);
  // 판이 바뀌면(새 게임·되돌리기) 접어 둔 상태도 새로 시작한다.
  return result ? <GameOverView key={generation} result={result} /> : null;
}

function GameOverView({ result }: { result: GameResult }) {
  const humanSeat = useGameStore((s) => s.humanSeat);
  const difficulty = useGameStore((s) => s.gameDifficulty);
  const hintUsed = useGameStore((s) => s.hintUsedThisGame);
  const ply = useGameStore((s) => s.state.ply);
  const newGame = useGameStore((s) => s.newGame);
  const setScreen = useAppStore((s) => s.setScreen);
  // 도움말·설정·패치노트·피드백이 열린 채 판이 끝나면 결과 창은 그 창이 닫힌 뒤에 띄운다 — aria-modal 대화상자가
  // 둘이 되지 않게, 쓰던 피드백이 날아가지 않게. (차례 배너는 승패를 알리지 않는다 — '게임이 끝났습니다.' 뿐이다.)
  const panelOpen = useAppStore(isPanelOpen);
  // 미뤄서 뜨는 결과 창은 제목에 초점을 둔다 — 창을 닫은 Enter 가 이어져 '다시 하기'를 누르지 않게.
  // 이 컴포넌트는 판이 끝날 때마다 generation key 로 한 번 마운트되므로 처음 값이 곧 '미뤘는가'다.
  const [deferred] = useState(panelOpen);
  const [peek, setPeek] = useState(false);

  const { title, detail } = resultText(result, humanSeat);
  const tone = result.kind === 'draw' ? 'draw' : result.winner === humanSeat ? 'win' : 'lose';
  const chips = [
    `난이도 ${DIFFICULTY_LABEL[difficulty]}`,
    `내 편 ${SIDE_LABEL[humanSeat]}`,
    `${ply}수`,
    ...(hintUsed ? ['💡 힌트 사용'] : []),
  ];

  if (peek) {
    return (
      <div className="over-bar" role="status">
        <span className={`over-bar-title over-${tone}`}>{title}</span>
        <span className="over-bar-detail">{detail}</span>
        <button className="btn-ghost" onClick={() => setPeek(false)}>
          결과 보기
        </button>
        <button className="btn-primary" onClick={() => newGame()}>
          다시 하기
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
      chips={chips}
      focusTitle={deferred}
      onPeek={() => setPeek(true)}
      onAgain={() => newGame()}
      onMenu={() => setScreen('home')}
    />
  );
}

interface OverDialogProps {
  title: string;
  detail: string;
  tone: string;
  chips: string[];
  /** 주 버튼 문구(솔로 '다시 하기', 온라인 '로비로'). */
  againLabel?: string;
  /**
   * 첫 초점을 버튼이 아니라 제목에 둔다. 온라인 결과는 상대의 기권·시간초과로 아무 때나 뜨는데, 그때 채팅을
   * 치던 중이면 다음 Space·Enter 가 첫 버튼('로비로' — 방을 나간다)을 눌러 버린다.
   */
  focusTitle?: boolean;
  onPeek: () => void;
  onAgain: () => void;
  onMenu: () => void;
}

/** 결과 창 — 솔로와 온라인 결과(MpGameOver)가 같은 모양을 쓴다. */
export function OverDialog({
  title,
  detail,
  tone,
  chips,
  againLabel = '다시 하기',
  focusTitle,
  onPeek,
  onAgain,
  onMenu,
}: OverDialogProps) {
  const titleRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const detailId = useId();
  // ESC 는 창을 접어 판을 보여 준다(결과 자체는 그대로).
  const cardRef = useDialog<HTMLDivElement>(onPeek, focusTitle ? titleRef : undefined);
  // 승패와 이유를 대화상자 설명으로 잇는다 — 첫 초점이 버튼이어도 낭독기가 결과를 읽는다.
  return (
    <div className="over">
      <div
        ref={cardRef}
        className="over-card"
        role="dialog"
        aria-modal="true"
        aria-label="게임 결과"
        aria-describedby={`${titleId} ${detailId}`}
      >
        <div ref={titleRef} id={titleId} className={`over-title over-${tone}`} tabIndex={focusTitle ? -1 : undefined}>
          {title}
        </div>
        <p id={detailId} className="over-detail">
          {detail}
        </p>
        <div className="over-meta">
          {chips.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
        </div>
        <div className="over-actions">
          <button className="btn-primary" onClick={onAgain}>
            {againLabel}
          </button>
          <button className="btn-ghost" onClick={onPeek}>
            판 보기
          </button>
          <button className="btn-ghost" onClick={onMenu}>
            메뉴로
          </button>
        </div>
      </div>
    </div>
  );
}
