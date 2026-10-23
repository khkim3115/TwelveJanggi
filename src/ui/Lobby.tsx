// 온라인 로비 — 방 만들기 / 코드로 참가 / 대기실. 방장이 시작하면 두 사람 모두 대전 화면으로 넘어간다.
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { rememberedCode, rememberedName, useMultiplayerStore } from '../store/multiplayerStore';
import { Brand } from './Brand';
import { ChatPanel } from './ChatPanel';
import { ConnectionNote } from './ConnectionNote';
import { Header } from './Header';

/** 영문 대문자·숫자만 6자리까지 남긴다(서버 코드는 헷갈리는 I·L·O·0·1 을 쓰지 않지만, 잘못 친 글자는 서버가 알려 준다). */
const toCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

export function Lobby() {
  const setScreen = useAppStore((s) => s.setScreen);
  const room = useMultiplayerStore((s) => s.room);
  const players = useMultiplayerStore((s) => s.players);
  const myUserId = useMultiplayerStore((s) => s.myUserId);
  const busy = useMultiplayerStore((s) => s.busy);
  const error = useMultiplayerStore((s) => s.error);
  const createRoom = useMultiplayerStore((s) => s.createRoom);
  const joinRoom = useMultiplayerStore((s) => s.joinRoom);
  const startGame = useMultiplayerStore((s) => s.startGame);
  const leave = useMultiplayerStore((s) => s.leave);

  const [name, setName] = useState(rememberedName);
  const [code, setCode] = useState(() => toCode(rememberedCode()));
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);

  // 방장이 시작하면 두 사람 화면이 모두 대전으로 넘어간다. 끝난 방에 다시 들어온 경우도 결과를 보여 준다.
  useEffect(() => {
    if (room?.status === 'playing' || room?.status === 'finished') setScreen('mpgame');
  }, [room?.status, setScreen]);

  const trimmedName = name.trim();
  const isHost = players.some((p) => p.userId === myUserId && p.isHost);
  const full = players.length === 2;

  const create = () => {
    if (trimmedName && !busy) void createRoom(trimmedName);
  };
  const join = () => {
    if (trimmedName && code.length === 6 && !busy) void joinRoom(code, trimmedName);
  };
  const goHome = () => {
    // 늘 나가기를 부른다 — 들어가는 중이던 요청을 거두고, 첫 읽기가 실패해 화면에 방이 없어도 붙어 있던 구독·좌석을
    // 정리하며, 지난 오류 문구도 지운다. 방이 없으면 대국 중에 남겨 둔 방 코드는 건드리지 않는다.
    void leave();
    setScreen('home');
  };
  const copyCode = async () => {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
    window.setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="page page-mp">
      <Header title={<Brand />} subtitle="온라인 대전">
        <button
          className="theme-btn"
          onClick={goHome}
          aria-label={room ? '방에서 나가 메뉴로' : '메뉴로'}
          title={room ? '방에서 나가 메뉴로' : '메뉴로'}
        >
          🏠
        </button>
      </Header>

      {!room ? (
        <section className="home-card" aria-labelledby="lobby-enter">
          <h2 id="lobby-enter">🌐 방 만들기 · 참가</h2>
          <label className="field">
            <span>닉네임</span>
            <input
              value={name}
              maxLength={24}
              placeholder="상대에게 보일 이름"
              autoComplete="nickname"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) create();
              }}
            />
          </label>

          <button className="btn-primary btn-big" disabled={busy || !trimmedName} onClick={create}>
            {busy ? '잠시만요…' : '방 만들기'}
          </button>

          <div className="join-row">
            <input
              className="join-code"
              value={code}
              maxLength={6}
              placeholder="방 코드"
              aria-label="방 코드 6자리"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setCode(toCode(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) join();
              }}
            />
            <button className="btn-ghost" disabled={busy || !trimmedName || code.length !== 6} onClick={join}>
              참가
            </button>
          </div>

          <p className="home-note">
            방을 만들면 6자리 코드가 나옵니다. 친구에게 코드를 알려 주면 같은 방에서 1:1 로 둘 수 있어요.
          </p>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </section>
      ) : (
        <section className="home-card" aria-labelledby="lobby-wait">
          <h2 id="lobby-wait">대기실</h2>
          <div className="code-row">
            <span className="code-label">방 코드</span>
            <b className="code-value">{room.code}</b>
            <button className="btn-ghost" onClick={() => void copyCode()}>
              {copied === 'ok' ? '복사됨' : '복사'}
            </button>
          </div>
          <p className="home-card-sub" aria-live="polite">
            {copied === 'fail'
              ? '복사하지 못했어요 — 코드를 직접 알려 주세요.'
              : '이 코드를 친구에게 알려 주면 같은 방으로 들어옵니다.'}
          </p>

          <ul className="player-list" aria-label="참가자" aria-live="polite">
            {[0, 1].map((seat) => {
              const p = players.find((x) => x.seat === seat);
              return (
                <li key={seat} className={`player-row${p ? '' : ' empty'}`}>
                  {p ? (
                    <>
                      <span className="player-name">{p.displayName}</span>
                      {p.isHost && <span className="chip">방장</span>}
                      {p.userId === myUserId && <span className="chip">나</span>}
                      {!p.connected && <span className="chip">연결 끊김</span>}
                    </>
                  ) : (
                    <span className="player-waiting">상대를 기다리는 중…</span>
                  )}
                </li>
              );
            })}
          </ul>

          {isHost ? (
            <button className="btn-primary btn-big" disabled={!full || busy} onClick={() => void startGame()}>
              {full ? '대국 시작' : '상대가 들어오면 시작할 수 있어요'}
            </button>
          ) : (
            <p className="home-note">방장이 시작하기를 기다리는 중…</p>
          )}
          <p className="home-note">
            녹·적은 시작할 때 무작위로 정해지고, 녹이 먼저 둡니다. 한 수를 2분 넘게 두지 않으면 상대가 시간초과
            승리를 가져갈 수 있어요.
          </p>

          <button className="btn-ghost" onClick={() => void leave()}>
            방 나가기
          </button>
          <ConnectionNote />
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </section>
      )}

      {room && <ChatPanel />}
    </div>
  );
}
