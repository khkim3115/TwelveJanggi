// 실시간 연결이 끊겼을 때만 알리는 한 줄(로비·대국 공용). 처음 붙는 1–2초 동안은 깜빡이지 않게 늦게 띄운다.
import { useEffect, useState } from 'react';
import { useMultiplayerStore } from '../store/multiplayerStore';

const SHOW_AFTER_MS = 3000;

export function ConnectionNote() {
  const live = useMultiplayerStore((s) => s.live);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (live) {
      setShow(false);
      return;
    }
    const t = window.setTimeout(() => setShow(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [live]);

  if (!show) return null;
  return (
    <p className="mp-note mp-note-warn" role="status">
      실시간 연결이 끊겼습니다 — 다시 붙을 때까지 몇 초마다 판을 새로 불러옵니다.
    </p>
  );
}
