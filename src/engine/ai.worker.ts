/// <reference lib="webworker" />
// AI 탐색 워커. 어려움 난이도가 1초 넘게 파도 UI 가 얼지 않도록 별도 스레드에서 돈다.

import { fromTransfer, type Move, type StateTransfer } from '../core/gameState';
import { bestMove, chooseMove, type Difficulty } from './ai';

export interface AiRequest {
  /** 요청 식별자 — 늦게 도착한 응답을 버리기 위해 되돌려 준다. */
  id: number;
  kind: 'move' | 'hint';
  state: StateTransfer;
  difficulty: Difficulty;
  timeBudgetMs?: number;
}

export interface AiResponse {
  id: number;
  move: Move | null;
  /** 힌트일 때만 채운다(평가 점수). */
  score?: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<AiRequest>) => {
  const req = e.data;
  const state = fromTransfer(req.state);
  if (req.kind === 'hint') {
    const r = bestMove(state, req.timeBudgetMs);
    const res: AiResponse = { id: req.id, move: r.move, score: r.score };
    ctx.postMessage(res);
    return;
  }
  const move = chooseMove(state, req.difficulty, { timeBudgetMs: req.timeBudgetMs });
  const res: AiResponse = { id: req.id, move };
  ctx.postMessage(res);
};
