// AI 창구의 계약 — 워커 응답 라우팅, 취소, 워커 고장 시 동기 폴백. 가짜 Worker 로 node 에서 확인한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, isLegal } from '../core/gameState';
import type { AiRequest, AiResponse } from './ai.worker';

/** 테스트가 응답·고장을 직접 일으키는 가짜 워커. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<AiResponse>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: AiRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(req: AiRequest) {
    this.received.push(req);
  }
  terminate() {
    this.terminated = true;
  }
  reply(res: AiResponse) {
    this.onmessage?.({ data: res } as MessageEvent<AiResponse>);
  }
  crash() {
    this.onerror?.(new Error('boom'));
  }
}

async function loadClient() {
  vi.resetModules();
  return import('./aiClient');
}

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('aiClient', () => {
  it('워커 응답을 요청 id 로 돌려준다', async () => {
    const c = await loadClient();
    const p = c.requestAiMove(createInitialState(), 'easy');
    const w = FakeWorker.all[0];
    const req = w.received[0];
    expect(req.kind).toBe('move');
    w.reply({ id: req.id, move: { from: 7, to: 4, piece: 4, promote: false } });
    await expect(p).resolves.toEqual({ move: { from: 7, to: 4, piece: 4, promote: false }, score: undefined });
  });

  it('취소하면 기다리던 요청은 null 을 받고, 옛 워커의 늦은 응답은 새 요청에 섞이지 않는다', async () => {
    const c = await loadClient();
    const first = c.requestAiMove(createInitialState(), 'hard');
    const old = FakeWorker.all[0];
    c.cancelPendingAi();
    await expect(first).resolves.toEqual({ move: null });
    expect(old.terminated).toBe(true);

    const second = c.requestAiMove(createInitialState(), 'hard');
    const fresh = FakeWorker.all[1];
    expect(fresh).toBeDefined();
    // 옛 워커가 뒤늦게 답해도(id 가 같더라도) 무시된다.
    old.reply({ id: fresh.received[0].id, move: { from: 10, to: 6, piece: 1, promote: false } });
    fresh.reply({ id: fresh.received[0].id, move: { from: 11, to: 8, piece: 2, promote: false } });
    await expect(second).resolves.toMatchObject({ move: { from: 11, to: 8 } });
  });

  it('기다리는 요청이 없으면 취소해도 워커를 새로 만들지 않는다', async () => {
    const c = await loadClient();
    const p = c.requestAiMove(createInitialState(), 'easy');
    const w = FakeWorker.all[0];
    w.reply({ id: w.received[0].id, move: null });
    await p;
    c.cancelPendingAi();
    expect(w.terminated).toBe(false);
    void c.requestAiMove(createInitialState(), 'easy');
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('워커가 죽으면 기다리던 요청을 같은 스레드에서 계산해 답하고, 이후로는 워커를 만들지 않는다', async () => {
    const c = await loadClient();
    const s = createInitialState();
    const p = c.requestAiMove(s, 'easy', Infinity);
    FakeWorker.all[0].crash();
    const answer = await p;
    expect(answer.move && isLegal(s, answer.move)).toBe(true);

    const hint = await c.requestHint(s, 50);
    expect(hint.move && isLegal(s, hint.move)).toBe(true);
    expect(FakeWorker.all).toHaveLength(1);
  });
});
