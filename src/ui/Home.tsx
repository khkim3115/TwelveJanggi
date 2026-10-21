// 시작 화면 — 혼자 하기(난이도·선후공) · 온라인 대전. 앱 받기는 배포 단계(#5)에서 붙는다.
import { DIFFICULTIES, DIFFICULTY_DESC, DIFFICULTY_LABEL } from '../engine/ai';
import type { Difficulty } from '../engine/ai';
// 설정 여부만 본다 — lib/supabase 를 import 하면 첫 화면에 Supabase 클라이언트가 실린다.
import { isSupabaseConfigured } from '../lib/env';
import { useAppStore } from '../store/appStore';
import { useGameStore } from '../store/gameStore';
import { Brand } from './Brand';
import { Header } from './Header';
import { SEAT_NOTE, SeatPicker } from './SeatPicker';

export function Home() {
  const setScreen = useAppStore((s) => s.setScreen);
  const difficulty = useGameStore((s) => s.difficulty);
  const setDifficulty = useGameStore((s) => s.setDifficulty);
  const seatPref = useGameStore((s) => s.seatPref);
  const newGame = useGameStore((s) => s.newGame);

  // newGame 을 먼저 부르는 순서는 의도적이다 — 세대를 올리고 thinking 을 세운 뒤
  // 솔로 화면이 그려져야, 내가 적일 때 첫 프레임부터 보드가 잠겨 보인다.
  const startSolo = () => {
    newGame({ difficulty, seatPref });
    setScreen('solo');
  };

  return (
    <div className="page home">
      <Header title={<Brand />} subtitle="3×4 판의 작은 장기" />

      <p className="home-lead">
        王·將·相·子 네 말로 두는 3×4 판의 장기입니다. 상대 <b>王 을 잡거나</b>, 내 <b>王 을 상대 진영에 들여보내 한 턴을
        버티면</b> 이깁니다. 잡은 말은 내 편이 되어 상대 진영을 뺀 빈칸에 다시 놓을 수 있어요.
      </p>

      <section className="home-card">
        <h2>🤖 혼자 하기</h2>
        <p className="home-card-sub">난이도와 선후공을 고르고 AI 와 한 판.</p>
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
        <SeatPicker />
        <p className="home-note">{SEAT_NOTE}</p>
        <button className="btn-primary btn-big" onClick={startSolo}>
          게임 시작
        </button>
      </section>

      <section className="home-card">
        <h2>🌐 온라인 대전</h2>
        <p className="home-card-sub">방을 만들고 6자리 코드를 알려 주면 친구와 1:1 로 둘 수 있어요.</p>
        <button
          className="btn-primary btn-big"
          onClick={() => setScreen('lobby')}
          disabled={!isSupabaseConfigured}
        >
          방 만들기 · 참가
        </button>
        {!isSupabaseConfigured && (
          <p className="home-note">
            이 빌드에는 온라인 대전 서버 설정이 없습니다. 혼자 하기는 그대로 즐길 수 있어요.
          </p>
        )}
      </section>
    </div>
  );
}
