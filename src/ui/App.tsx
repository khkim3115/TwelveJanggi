// 솔로 게임 화면 — 차례 배너 + 상대 손패 + 보드 + 내 손패 + 조작 버튼 + 결과 오버레이.
import { useEffect, useState } from 'react';
import type { HandKind } from '../core/board';
import { DROP, other, type Player } from '../core/gameState';
import { SIDE_LABEL, boardView, newGameShortcutAllowed } from '../core/view';
import { DIFFICULTY_LABEL } from '../engine/ai';
import { canUndo, useGameStore } from '../store/gameStore';
import { Board } from './Board';
import { Brand } from './Brand';
import { GameOver } from './GameOver';
import { HandTray } from './HandTray';
import { Header } from './Header';
import { TurnBanner } from './TurnBanner';
import { isDialogOpen } from './useDialog';

const NONE: ReadonlySet<HandKind> = new Set();
const NEW_GAME_NOTICE = '판 중간에는 ↺ 새 게임 버튼으로 새로 시작합니다(N 은 판이 끝난 뒤).';
const NOTICE_MS = 4000;

export default function App() {
  const state = useGameStore((s) => s.state);
  const past = useGameStore((s) => s.past);
  const humanSeat = useGameStore((s) => s.humanSeat);
  const difficulty = useGameStore((s) => s.gameDifficulty);
  const selection = useGameStore((s) => s.selection);
  const thinking = useGameStore((s) => s.thinking);
  const lastMove = useGameStore((s) => s.lastMove);
  const hint = useGameStore((s) => s.hint);
  const hintLoading = useGameStore((s) => s.hintLoading);
  const undoable = useGameStore(canUndo);
  const clickCell = useGameStore((s) => s.clickCell);
  const clickHand = useGameStore((s) => s.clickHand);
  const undo = useGameStore((s) => s.undo);
  const askHint = useGameStore((s) => s.askHint);
  const resign = useGameStore((s) => s.resign);
  const newGame = useGameStore((s) => s.newGame);

  const over = state.phase === 'over';
  const myTurn = !over && !thinking && state.turn === humanSeat;
  const aiSeat: Player = other(humanSeat);
  // 이름에 편을 달아 두면 랜덤으로 뽑힌 판에서도 배너만 보고 내 편을 알 수 있다.
  const names = {
    [humanSeat]: `내(${SIDE_LABEL[humanSeat]})`,
    [aiSeat]: `AI (${DIFFICULTY_LABEL[difficulty]})`,
  } as Record<Player, string>;
  const droppable = myTurn ? boardView(state, humanSeat, null).droppable : NONE;
  const hintPiece = hint && hint.from === DROP ? (hint.piece as HandKind) : null;
  // 직전 수를 두기 전의 판(잡기 표시용). 기권은 수를 늘리지 않으므로 ply 로 걸러 낸다.
  const prev = past[past.length - 1];
  const boardBefore = prev && prev.ply === state.ply - 1 ? prev.board : undefined;

  // 판 중간에 N 을 누르면 새 게임 대신 잠깐 띄우는 안내(차례 배너의 낭독 줄에 나온다).
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);

  // 단축키: H 힌트 · Z(또는 Backspace) 되돌리기 · N 새 게임(판이 시작 전이거나 끝났을 때만 — view.newGameShortcutAllowed).
  // 물리 키(e.code)로 본다 — 한글 입력 상태에서는 e.key 가 'ㅗ' 등으로 바뀐다. 모달이 열려 있거나
  // 조합 중·반복 입력·수정 키 조합이면 무시한다(모달 뒤의 판을 건드리거나 되돌리기가 연타되지 않게).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (isDialogOpen()) return;
      if (e.code === 'KeyH') askHint();
      else if (e.code === 'KeyZ' || e.code === 'Backspace') undo();
      else if (e.code === 'KeyN') {
        if (newGameShortcutAllowed(useGameStore.getState().state)) newGame();
        else setNotice(NEW_GAME_NOTICE);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askHint, undo, newGame]);

  return (
    <div className="page">
      <Header title={<Brand />} subtitle="혼자 하기" showHome showSettings autoHelp />

      <TurnBanner
        state={state}
        me={humanSeat}
        names={names}
        waiting={thinking}
        lastMove={lastMove}
        boardBefore={boardBefore}
        hint={hint}
        notice={notice}
      />

      <div className="table">
        <HandTray
          state={state}
          side={aiSeat}
          viewer={humanSeat}
          label={`${names[aiSeat]} 손패`}
          droppable={NONE}
          selected={null}
        />
        <div className="board-wrap">
          <Board
            state={state}
            me={humanSeat}
            selection={selection}
            lastMove={lastMove}
            hint={hint}
            disabled={!myTurn}
            onCell={clickCell}
          />
        </div>
        <HandTray
          state={state}
          side={humanSeat}
          viewer={humanSeat}
          label="내 손패"
          droppable={droppable}
          selected={selection?.kind === 'hand' ? selection.piece : null}
          hintPiece={hintPiece}
          onPick={clickHand}
        />
      </div>

      <GameOver />

      <div className="controls">
        <button className="btn-ghost" onClick={askHint} disabled={!myTurn || hintLoading} title="힌트 (H)">
          {hintLoading ? '⏳ 계산 중' : '💡 힌트'}
        </button>
        <button className="btn-ghost" onClick={undo} disabled={!undoable} title="되돌리기 (Z)">
          ↩ 되돌리기
        </button>
        <button className="btn-ghost" onClick={() => newGame()} title="새 게임 (N)">
          ↺ 새 게임
        </button>
        <button className="btn-ghost btn-danger" onClick={resign} disabled={over}>
          🏳 기권
        </button>
      </div>
    </div>
  );
}
