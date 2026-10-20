// 결정론적 PRNG(mulberry32). zobrist 키 생성과 AI 무작위성이 같은 구현을 쓴다.
// 시드를 주면 실행마다 같은 수열이라 테스트를 재현할 수 있다.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
