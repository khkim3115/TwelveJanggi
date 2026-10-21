// 온라인 대전 화면. 솔로와 같은 Board·HandTray·TurnBanner 를 쓰고, 상태는 서버 스냅샷에서만 온다.
// 보는 사람의 진영이 늘 아래다(녹·적은 시작할 때 서버가 무작위로 정한다).
import { useEffect, useMemo, useState } from 'react';
import type { HandKind } from '../core/board';
import { other, type Player } from '../core/gameState';
import { SIDE_LABEL, boardView } from '../core/view';
import { useAppStore } from '../store/appStore';
import {
  TIMEOUT_SECONDS,
  boardBeforeLastMove,
  mpGameState,
  selectMe,
  selectOpponent,
  serverNow,
  sideOfSeat,
  useMultiplayerStore,
} from '../store/multiplayerStore';
import { Board } from './Board';
import { Brand } from './Brand';
import { ChatPanel } from './ChatPanel';
import { ConnectionNote } from './ConnectionNote';
import { HandTray } from './HandTray';
import { Header } from './Header';
import { MpGameOver } from './MpGameOver';
import { TurnBanner } from './TurnBanner';

const NONE: ReadonlySet<HandKind> = new Set();
const TITLE = '십이장기';
/** 내 차례 남은 시간이 이 아래로 내려가면 경고한다(초). */
const WARN_SECONDS = 30;

/** 초 → m:ss */
function clock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function MultiplayerGame() {
  const setScreen = useAppStore((s) => s.setScreen);
  const room = useMultiplayerStore((s) => s.room);
  const selection = useMultiplayerStore((s) => s.selection);
  const sending = useMultiplayerStore((s) => s.sending);
  const error = useMultiplayerStore((s) => s.error);
  const me = useMultiplayerStore(selectMe);
  const opponent = useMultiplayerStore(selectOpponent);
  const clickCell = useMultiplayerStore((s) => s.clickCell);
  const clickHand = useMultiplayerStore((s) => s.clickHand);
  const resign = useMultiplayerStore((s) => s.resign);
  const claimTimeout = useMultiplayerStore((s) => s.claimTimeout);
  const leave = useMultiplayerStore((s) => s.leave);
  const clearError = useMultiplayerStore((s) => s.clearError);

  const state = useMemo(() => mpGameState(room), [room]);
  const playing = state !== null && state.phase !== 'over';
  // 시간초과는 서버 시계로 판정하므로 남은 시간도 서버 기준 지금으로 센다.
  const [now, setNow] = useState(serverNow);
  const [confirmResign, setConfirmResign] = useState(false);
  const mySide: Player | null = room && me ? sideOfSeat(me.seat, room.greenSeat) : null;
  const myTurn = playing && state.turn === mySide;

  // 남은 시간·시간초과 버튼에만 쓰는 1초 시계(대국 중에만 돈다).
  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => setNow(serverNow()), 1000);
    return () => window.clearInterval(t);
  }, [playing]);

  // 방이 사라졌거나(정리·나가기) 아직 시작 전이면 로비로.
  useEffect(() => {
    if (!room || room.status === 'lobby' || room.status === 'abandoned') setScreen('lobby');
  }, [room, setScreen]);

  // 기권 확인은 잠깐만 열어 둔다 — 눌러 둔 채 잊었다가 다음 클릭에 기권하지 않게.
  useEffect(() => {
    if (!confirmResign) return;
    const t = window.setTimeout(() => setConfirmResign(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmResign]);

  // 다른 탭을 보고 있어도 내 차례가 온 걸 알 수 있게 탭 제목에 표시한다.
  useEffect(() => {
    document.title = myTurn ? `● 내 차례 — ${TITLE}` : TITLE;
    return () => {
      document.title = TITLE;
    };
  }, [myTurn]);

  const onLeave = () => {
    void leave();
    setScreen('home');
  };

  if (!room || !state || !me || mySide === null) {
    return (
      <div className="page page-mp">
        <Header title={<Brand />} subtitle="온라인 대전" />
        <p className="home-note" role="status">
          대국을 불러오는 중…
        </p>
      </div>
    );
  }

  const oppSide: Player = other(mySide);
  // 편은 판마다 무작위라 이름에 붙여 둔다 — 배너만 보고도 내 편을 알 수 있게.
  const names = {
    [mySide]: `${me.displayName}(나·${SIDE_LABEL[mySide]})`,
    [oppSide]: `${opponent?.displayName ?? '상대'}(${SIDE_LABEL[oppSide]})`,
  } as Record<Player, string>;

  const over = state.phase === 'over';
  const elapsed = room.turnStartedAt ? Math.max(0, (now - Date.parse(room.turnStartedAt)) / 1000) : 0;
  const left = TIMEOUT_SECONDS - elapsed;
  const canClaim = !over && !myTurn && left <= 0;
  const droppable = myTurn && !sending ? boardView(state, mySide, null).droppable : NONE;
  const away = !over && opponent !== null && !opponent.connected;

  // 화면 낭독기에는 매초가 아니라 경계를 넘을 때만 알린다(아래 문장이 바뀔 때만 읽힌다).
  const timeAlert = over
    ? ''
    : myTurn
      ? left <= 0
        ? '내 시간이 지났습니다. 상대가 시간초과 승리를 가져갈 수 있습니다.'
        : left <= WARN_SECONDS
          ? `내 차례 — ${WARN_SECONDS}초도 안 남았습니다.`
          : ''
      : canClaim
        ? '상대가 2분 넘게 두지 않았습니다. 시간초과 승리를 요청할 수 있습니다.'
        : '';

  const awayNote = !away
    ? null
    : myTurn
      ? '상대가 방을 나갔습니다. 내가 수를 둔 뒤 상대가 2분 안에 돌아오지 않으면 시간초과 승리를 요청할 수 있어요.'
      : canClaim
        ? '상대가 방을 나갔습니다. 지금 시간초과 승리를 요청할 수 있어요.'
        : '상대가 방을 나갔습니다. 돌아오지 않으면 위 시간이 지난 뒤 시간초과 승리를 요청할 수 있어요.';

  const onResign = () => {
    if (!confirmResign) {
      setConfirmResign(true);
      return;
    }
    setConfirmResign(false);
    void resign();
  };

  return (
    <div className="page page-mp">
      <Header title={<Brand />} subtitle={`온라인 · ${room.code}`}>
        <button
          className="theme-btn"
          onClick={onLeave}
          aria-label="방에서 나가 메뉴로"
          title={
            over
              ? '방에서 나가 메뉴로'
              : '방 나가기 — 같은 코드로 다시 들어올 수 있어요. 내 차례에 2분이 지나면 상대가 시간초과 승리를 가져갈 수 있습니다.'
          }
        >
          🏠
        </button>
      </Header>

      <TurnBanner
        state={state}
        me={mySide}
        names={names}
        lastMove={room.lastMove}
        boardBefore={boardBeforeLastMove(room)}
      />

      <div className="table">
        <HandTray
          state={state}
          side={oppSide}
          viewer={mySide}
          label={`상대(${SIDE_LABEL[oppSide]}) 손패`}
          droppable={NONE}
          selected={null}
        />
        <div className="board-wrap">
          <Board
            state={state}
            me={mySide}
            selection={selection}
            lastMove={room.lastMove}
            disabled={!myTurn || sending}
            onCell={clickCell}
          />
        </div>
        <HandTray
          state={state}
          side={mySide}
          viewer={mySide}
          label="내 손패"
          droppable={droppable}
          selected={selection?.kind === 'hand' ? selection.piece : null}
          onPick={clickHand}
        />
      </div>

      {!over && (
        <p className={`mp-note${myTurn && left <= WARN_SECONDS ? ' mp-note-warn' : ''}`}>
          {myTurn
            ? left > 0
              ? `⏱ 내 차례 — ${clock(left)} 안에 두세요`
              : '⏱ 시간이 지났습니다 — 상대가 시간초과 승리를 가져갈 수 있어요'
            : left > 0
              ? `⏱ 상대 차례 — ${clock(left)} 뒤부터 시간초과 승리를 요청할 수 있어요`
              : '⏱ 상대가 2분 넘게 두지 않았습니다'}
        </p>
      )}
      <span className="sr-only" role="status">
        {timeAlert}
      </span>

      <div className="controls">
        {canClaim && (
          <button className="btn-primary" onClick={() => void claimTimeout()} disabled={sending}>
            ⏱ 시간초과 승리
          </button>
        )}
        <button className="btn-ghost btn-danger" onClick={onResign} disabled={over || sending}>
          {confirmResign ? '한 번 더 누르면 기권' : '🏳 기권'}
        </button>
      </div>

      {awayNote && (
        <p className="mp-note" role="status">
          {awayNote}
        </p>
      )}
      <ConnectionNote />
      {error && (
        <div className="mp-error mp-error-row" role="alert">
          <span>{error}</span>
          <button className="mp-error-close" onClick={clearError} aria-label="오류 닫기">
            ✕
          </button>
        </div>
      )}

      <ChatPanel />
      {over && state.result && (
        <MpGameOver key={room.id} result={state.result} mySide={mySide} moveCount={room.moveCount} />
      )}
    </div>
  );
}
