// AI 호출 창구. 워커가 있으면 워커에서, 없으면(테스트·구형 환경) 같은 스레드에서 계산한다.
// UI 는 이 모듈만 부르고 워커의 존재를 몰라도 된다.
// 어느 길로 답했는지는 getAiPath() 로 읽는다 — 조용한 동기 폴백이 워커 답으로 보이지 않게 하는 진단용이다.
//
// 응답 규칙: move:null 은 "취소됨"(새 판·되돌리기)이거나 둘 수가 없을 때뿐이다. 워커가 죽으면 기다리던
// 요청은 같은 스레드에서 다시 계산해 답하고, 이후로는 워커를 만들지 않는다 — 그러지 않으면 AI 차례가
// 끝나지 않아 판이 멈춘다.

import { fromTransfer, toTransfer, type GameState, type Move } from '../core/gameState';
import { bestMove, chooseMove, type Difficulty } from './ai';
import type { AiRequest, AiResponse } from './ai.worker';

export interface AiAnswer {
  move: Move | null;
  score?: number;
}

/**
 * 요청이 어느 길로 끝났는지(진단용 — 동작에는 쓰이지 않는다). 'unused': 끝난 요청 없음(취소는 세지 않는다) ·
 * 'worker': 워커의 응답이 요청을 끝냈다 · 'fallback': 같은 스레드 계산이 요청을 끝낸 적이 있다(한 번 되면 그대로).
 */
export type AiPath = 'unused' | 'worker' | 'fallback';

interface Pending {
  req: AiRequest;
  resolve: (r: AiAnswer) => void;
}

let worker: Worker | null = null;
/** 워커가 한 번 죽으면(모듈 워커 미지원·CSP·엔진 예외) 이후로는 동기 계산만 한다. */
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();
/** getAiPath() 의 값. 쓰는 곳은 computeSync(fallback)와 워커 onmessage(worker) 둘뿐이다 — 취소는 건드리지 않는다. */
let aiPath: AiPath = 'unused';

/** 워커 없이 같은 스레드에서 계산한다. 엔진이 예외를 던져도 요청은 반드시 끝낸다(수 없음으로). */
function computeSync(req: AiRequest): AiAnswer {
  // 이 계산이 요청을 끝낸다. 워커 없음 · 생성 실패 · 워커 고장이 모두 여기로 오므로 한 곳에서 남긴다.
  aiPath = 'fallback';
  try {
    const state = fromTransfer(req.state);
    if (req.kind === 'hint') {
      const r = bestMove(state, req.timeBudgetMs);
      return { move: r.move, score: r.score };
    }
    return { move: chooseMove(state, req.difficulty, { timeBudgetMs: req.timeBudgetMs }) };
  } catch {
    return { move: null };
  }
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (workerBroken || typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    // 핸들러는 자기 워커에만 반응한다 — 취소로 갈아 끼운 뒤 옛 워커의 이벤트가 새 요청을 건드리지 않게.
    w.onmessage = (e: MessageEvent<AiResponse>) => {
      if (worker !== w) return;
      const p = pending.get(e.data.id);
      if (!p) return; // 이미 버려진(취소된) 요청
      pending.delete(e.data.id);
      // 살아 있는 워커의 응답이 요청을 끝냈다. 이미 fallback 이 남았다면 덮지 않는다.
      if (aiPath !== 'fallback') aiPath = 'worker';
      p.resolve({ move: e.data.move, score: e.data.score });
    };
    w.onerror = () => {
      if (worker !== w) return;
      workerBroken = true;
      w.terminate();
      worker = null;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.resolve(computeSync(p.req));
      }
    };
    worker = w;
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

function ask(kind: AiRequest['kind'], state: GameState, difficulty: Difficulty, timeBudgetMs?: number): Promise<AiAnswer> {
  const req: AiRequest = { id: nextId++, kind, state: toTransfer(state), difficulty, timeBudgetMs };
  const w = getWorker();
  if (!w) {
    // 동기 폴백 — UI 가 잠깐 멈추지만 결과는 동일하다.
    return Promise.resolve(computeSync(req));
  }
  return new Promise<AiAnswer>((resolve) => {
    pending.set(req.id, { req, resolve });
    w.postMessage(req);
  });
}

/** 난이도에 맞는 AI 의 한 수. */
export function requestAiMove(state: GameState, difficulty: Difficulty, timeBudgetMs?: number): Promise<AiAnswer> {
  return ask('move', state, difficulty, timeBudgetMs);
}

/** 힌트(항상 어려움과 같은 예산). */
export function requestHint(state: GameState, timeBudgetMs?: number): Promise<AiAnswer> {
  return ask('hint', state, 'hard', timeBudgetMs);
}

/**
 * 진행 중인 요청을 모두 버린다(새 게임·되돌리기 등으로 국면이 바뀌었을 때). 기다리던 쪽은 move:null 을 받고,
 * 호출자는 세대 번호로 낡은 응답을 걸러 낸다. 계산 중인 워커는 끊고 새로 만든다 — 그러지 않으면 버린 탐색이
 * 끝날 때까지(최대 시간 상한) 다음 요청이 줄을 선다. 기다리는 요청이 없으면 워커를 그대로 둔다.
 */
export function cancelPendingAi(): void {
  if (pending.size === 0) return;
  for (const [, p] of pending) p.resolve({ move: null });
  pending.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

/** 지금까지 요청이 어느 길로 끝났는지(진단용). 스모크가 AI 가 워커에서 돈 것인지 조용한 폴백인지 가려 내려고 읽는다. */
export function getAiPath(): AiPath {
  return aiPath;
}
