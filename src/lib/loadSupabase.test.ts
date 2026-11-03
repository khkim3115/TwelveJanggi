// 공용 Supabase 로더의 계약(#20 D6) — 약속 하나를 나눠 쓴다 · 실패하면 비워 다음 호출이 다시 import 한다 · 오류는 정해 둔 문구로 바꾼다.
// 가짜 importer 로만 돈다. 진짜 lib/supabase 는 불러오지 않는다 — 불러오면 클라이언트가 만들어지고, .env 가 있는 PC 에서는 실서버 값을 본다.
// (store 의 mock 이 이 로더 위에서도 걸리는지는 multiplayerStore.test.ts 가 본다.)
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseLoader } from './loadSupabase';

// 진짜 모듈이 실수로 불리면 조용히 실서버로 나가는 대신 여기서 멈춘다.
vi.mock('./supabase', () => {
  throw new Error('loadSupabase 시험은 진짜 lib/supabase 를 불러오지 않는다');
});

type SupabaseModule = typeof import('./supabase');

/** 가짜 모듈 — 로더는 안을 보지 않고 그대로 돌려준다. 호출마다 새 객체라 어느 import 의 결과인지 가려 낸다. */
const fakeModule = () => ({ supabase: {} }) as unknown as SupabaseModule;

describe('createSupabaseLoader', () => {
  it('로더를 만들 때가 아니라 처음 부를 때 import 한다', async () => {
    const importer = vi.fn(() => Promise.resolve(fakeModule()));
    const load = createSupabaseLoader(importer);
    expect(importer).not.toHaveBeenCalled();

    await load();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('동시에 부른 호출은 같은 약속을 받고 import 는 한 번만 한다', async () => {
    const loaded = fakeModule();
    const importer = vi.fn(() => Promise.resolve(loaded));
    const load = createSupabaseLoader(importer);

    const first = load();
    const second = load();

    expect(second).toBe(first);
    await expect(first).resolves.toBe(loaded);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('불러온 뒤에도 약속을 나눠 쓴다 — 다시 import 하지 않는다', async () => {
    const loaded = fakeModule();
    const importer = vi.fn(() => Promise.resolve(loaded));
    const load = createSupabaseLoader(importer);

    await load();
    await expect(load()).resolves.toBe(loaded);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("첫 import 가 실패하면 원래 오류 대신 'client load failed' 로 던진다(humanError 의 한국어 문구가 이 글자에 걸린다)", async () => {
    const load = createSupabaseLoader(() =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/supabase-abc.js')),
    );

    const error = await load().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('client load failed');
  });

  it('실패하면 비워 두어 다음 호출이 다시 import 한다 — 성공하면 그 약속을 나눠 쓴다', async () => {
    const loaded = fakeModule();
    const importer = vi
      .fn<() => Promise<SupabaseModule>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(loaded);
    const load = createSupabaseLoader(importer);

    await expect(load()).rejects.toThrow('client load failed');
    expect(importer).toHaveBeenCalledTimes(1);

    await expect(load()).resolves.toBe(loaded);
    expect(importer).toHaveBeenCalledTimes(2);

    await load();
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('실패한 약속에 함께 붙은 호출은 모두 같은 거절을 받고, 그 뒤 호출이 새로 시도한다', async () => {
    const loaded = fakeModule();
    const importer = vi
      .fn<() => Promise<SupabaseModule>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(loaded);
    const load = createSupabaseLoader(importer);

    const first = load();
    const second = load();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow('client load failed');
    await expect(second).rejects.toThrow('client load failed');
    expect(importer).toHaveBeenCalledTimes(1);

    await expect(load()).resolves.toBe(loaded);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('로더마다 상태가 따로다 — 약속을 나누는 것은 같은 로더를 부르는 쪽이다', async () => {
    const importer = vi.fn(() => Promise.resolve(fakeModule()));

    await createSupabaseLoader(importer)();
    await createSupabaseLoader(importer)();

    expect(importer).toHaveBeenCalledTimes(2);
  });
});
