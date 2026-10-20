// 자리표시 진입점 — 솔로 화면(#3)이 들어오면 화면 전환 스위치로 바뀐다.
// 지금은 core 가 브라우저 번들에서도 도는지 확인하는 용도로 시작 국면만 그린다.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CELL_COUNT } from './core/board';
import { createInitialState, kindOf, sideOf } from './core/gameState';
import { KIND_HANJA, SIDE_LABEL } from './core/view';

function Placeholder() {
  const s = createInitialState();
  const rows: string[] = [];
  for (let i = 0; i < CELL_COUNT; i += 3) {
    rows.push(
      Array.from(s.board.slice(i, i + 3), (v) => (v === 0 ? '·' : KIND_HANJA[kindOf(v)])).join(' '),
    );
  }
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>십이장기</h1>
      <p>준비 중입니다. {SIDE_LABEL[sideOf(s.board[CELL_COUNT - 1])]}이 먼저 둡니다.</p>
      <pre style={{ fontSize: 28, lineHeight: 1.4 }}>{rows.join('\n')}</pre>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
