// AI 창구의 계약 — 워커 응답 라우팅, 취소, 워커 고장 시 동기 폴백, 어느 길로 답했는지 보이는 진단값.
// 가짜 Worker 로 node 에서 확인한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, isLegal, type Move } from '../core/gameState';
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

// 진단값은 동작에 쓰이지 않는다 — 조용한 동기 폴백이 워커 답으로 보이지 않는지 밖에서 확인하는 용도다.
describe('진단값 getAiPath', () => {
  const ANSWER: Move = { from: 7, to: 4, piece: 4, promote: false };

  /** 워커가 가장 최근 요청에 정상 응답한 것처럼 답한다. */
  function answerLast(w: FakeWorker) {
    w.reply({ id: w.received[w.received.length - 1].id, move: ANSWER });
  }

  it('처음에는 unused 이고, 요청을 보내기만 해서는 바뀌지 않는다', async () => {
    const c = await loadClient();
    expect(c.getAiPath()).toBe('unused');

    void c.requestAiMove(createInitialState(), 'easy');
    expect(FakeWorker.all).toHaveLength(1); // 워커는 만들어졌지만 아직 아무것도 답하지 않았다
    expect(c.getAiPath()).toBe('unused');
  });

  it('워커의 응답이 요청을 끝내면 worker 다', async () => {
    const c = await loadClient();
    const p = c.requestAiMove(createInitialState(), 'easy');
    answerLast(FakeWorker.all[0]);
    await p;
    expect(c.getAiPath()).toBe('worker');
  });

  it('워커가 죽어 같은 스레드에서 다시 계산하면 fallback 이고, 다음 요청 뒤에도 그대로다', async () => {
    const c = await loadClient();
    const s = createInitialState();
    const p = c.requestAiMove(s, 'easy', Infinity);
    FakeWorker.all[0].crash();
    await p;
    expect(c.getAiPath()).toBe('fallback'); // 재계산이 요청을 끝낸 시점 — 다음 요청을 기다리지 않는다

    await c.requestHint(s, 50);
    expect(c.getAiPath()).toBe('fallback');
  });

  it('Worker 를 쓸 수 없어 같은 스레드에서 바로 계산하면 fallback 이다', async () => {
    vi.stubGlobal('Worker', undefined);
    const c = await loadClient();
    await c.requestHint(createInitialState(), 50);
    expect(c.getAiPath()).toBe('fallback');
  });

  it('취소는 값을 바꾸지 않는다', async () => {
    const c = await loadClient();
    const p = c.requestAiMove(createInitialState(), 'hard');
    c.cancelPendingAi();
    await expect(p).resolves.toEqual({ move: null });
    expect(c.getAiPath()).toBe('unused');
  });

  it('한 번 fallback 이 되면 이후 워커가 답해도 worker 로 바뀌지 않는다', async () => {
    vi.stubGlobal('Worker', undefined);
    const c = await loadClient();
    const s = createInitialState();
    await c.requestHint(s, 50);
    expect(c.getAiPath()).toBe('fallback');

    // 워커를 다시 쓸 수 있게 돼도(실제로는 드물다) 한 번 남은 fallback 은 지워지지 않는다.
    vi.stubGlobal('Worker', FakeWorker);
    const p = c.requestAiMove(s, 'easy');
    answerLast(FakeWorker.all[0]);
    await p;
    expect(c.getAiPath()).toBe('fallback');
  });

  it('요청을 끝내지 못한 응답은 worker 로 세지 않는다', async () => {
    const c = await loadClient();
    const first = c.requestAiMove(createInitialState(), 'hard');
    const old = FakeWorker.all[0];
    const oldId = old.received[0].id;

    // 기다리는 요청이 없는 id 의 응답 — 살아 있는 워커가 보내도 끝낸 요청이 없다.
    old.reply({ id: 9999, move: ANSWER });
    expect(c.getAiPath()).toBe('unused');

    // 취소로 끊긴 옛 워커가 뒤늦게 답해도 마찬가지다.
    c.cancelPendingAi();
    await first;
    old.reply({ id: oldId, move: ANSWER });
    expect(c.getAiPath()).toBe('unused');
  });
});
