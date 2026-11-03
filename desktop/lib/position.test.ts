// desktop/lib/position.cjs 시험 — 팝업을 트레이 아이콘 쪽에 놓고, 작업영역 안으로 넣고, 사용자가 옮긴 것인지 가린다(설계 §5.1).
// 기대 좌표는 손으로 계산한 값이다. 창은 340×400, 여백은 8 이고, 디스플레이 bounds 를 따로 적지 않으면 1920×1080 이다.
// 좌표는 전부 인자라 호스트 · 플랫폼에 기대지 않는다(필수 check 는 ubuntu).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Rect = import('./position.cjs').Rect;
type Point = import('./position.cjs').Point;
type Size = import('./position.cjs').Size;
type DisplayLike = import('./position.cjs').DisplayLike;

const require = createRequire(import.meta.url);
const { MARGIN, MOVE_TOLERANCE, anchorPosition, clampPosition, isEmptyRect, isUserMove, placeWindow, shouldSaveMove } =
  require('./position.cjs') as typeof import('./position.cjs');

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const SIZE: Size = { width: 340, height: 400 };
/** 디스플레이 bounds 를 따로 적지 않을 때의 값. */
const SCREEN = rect(0, 0, 1920, 1080);
/** SCREEN 에서 아래쪽 작업표시줄(40px)을 뺀 작업영역 — 가장 흔한 Windows 모양. */
const WORK_BOTTOM = rect(0, 0, 1920, 1040);

it('상수 — 여백 8 · 사용자 이동 허용 오차 2', () => {
  expect(MARGIN).toBe(8);
  expect(MOVE_TOLERANCE).toBe(2);
});

describe('isEmptyRect', () => {
  it.each<[string, Rect]>([
    ['{0,0,0,0}', rect(0, 0, 0, 0)],
    ['폭만 0', rect(100, 100, 0, 24)],
    ['높이만 0', rect(100, 100, 24, 0)],
    ['폭이 음수', rect(100, 100, -1, 24)],
    ['높이가 음수', rect(100, 100, 24, -1)],
    ['폭이 NaN', rect(100, 100, NaN, 24)],
    ['높이가 NaN', rect(100, 100, 24, NaN)],
    ['폭이 Infinity', rect(100, 100, Infinity, 24)],
    ['높이가 Infinity', rect(100, 100, 24, Infinity)],
    // 위치를 모르는 사각형도 쓸 수 없다 — 그대로 배치하면 NaN 이 setBounds 에 간다.
    ['x 가 NaN', rect(NaN, 100, 24, 24)],
    ['y 가 NaN', rect(100, NaN, 24, 24)],
    ['x 가 Infinity', rect(Infinity, 100, 24, 24)],
    ['y 가 −Infinity', rect(100, -Infinity, 24, 24)],
  ])('비었다: %s', (_name, value) => {
    expect(isEmptyRect(value)).toBe(true);
  });

  it.each<[string, Rect]>([
    ['보통 아이콘', rect(1800, 1048, 24, 24)],
    ['좌표가 음수(다른 모니터)', rect(-120, -100, 24, 24)],
    ['원점', rect(0, 0, 24, 24)],
    ['1×1', rect(0, 0, 1, 1)],
    ['소수 크기', rect(10, 10, 0.5, 0.5)],
  ])('비지 않았다: %s', (_name, value) => {
    expect(isEmptyRect(value)).toBe(false);
  });
});

describe('anchorPosition', () => {
  // [무엇을 보는가, 디스플레이 bounds, 작업영역, 트레이 아이콘, 기대 위치]
  const CASES: Array<[string, Rect, Rect, Rect, Point]> = [
    ['아래 작업표시줄 — 아이콘 위, 오른쪽 끝은 여백 8 에서 막힌다', SCREEN, WORK_BOTTOM, rect(1800, 1048, 24, 24), { x: 1572, y: 632 }],
    ['위 작업표시줄 — 아이콘 아래', SCREEN, rect(0, 40, 1920, 1040), rect(1800, 8, 24, 24), { x: 1572, y: 48 }],
    [
      'macOS 메뉴 막대(위) — 아이콘 아래 32 는 작업영역 위 여백(25 + 8)에 막혀 33',
      rect(0, 0, 1440, 900),
      rect(0, 25, 1440, 875),
      rect(1200, 0, 22, 24),
      { x: 1041, y: 33 },
    ],
    ['왼쪽 작업표시줄 — 아이콘이 작업영역 밖이라 클램프가 작업표시줄 옆(60 + 8)에 둔다', SCREEN, rect(60, 0, 1860, 1080), rect(18, 1000, 24, 24), { x: 68, y: 592 }],
    ['오른쪽 작업표시줄 — 작업영역 오른쪽 끝에서 여백 8', SCREEN, rect(0, 0, 1860, 1080), rect(1878, 1000, 24, 24), { x: 1512, y: 592 }],
    ['자동 숨김(아이콘이 작업영역 안, 아래쪽 절반) — 아이콘 위', SCREEN, SCREEN, rect(1800, 1050, 24, 24), { x: 1572, y: 642 }],
    // 위쪽 절반 규칙이 클램프에 가리지 않는 셋 — 규칙을 거꾸로 두면 y 가 클램프 값(8 등)으로 숨지 않고 이 값에서 어긋난다.
    ['자동 숨김, 위쪽 절반 — 아이콘 아래(8 + 24 + 8)', SCREEN, SCREEN, rect(1800, 8, 24, 24), { x: 1572, y: 40 }],
    ['왼쪽 작업표시줄의 위쪽 아이콘 — 아이콘 아래', SCREEN, rect(60, 0, 1860, 1080), rect(18, 100, 24, 24), { x: 68, y: 132 }],
    [
      '위로 쌓인 디스플레이(y 가 음수) — 절반은 절대 좌표 0 이 아니라 그 디스플레이 bounds 의 가운데(−540)로 가른다',
      rect(0, -1080, 1920, 1080),
      rect(60, -1080, 1860, 1080),
      rect(18, -100, 24, 24),
      { x: 68, y: -508 },
    ],
    ['빈 아이콘 bounds {0,0,0,0} — 작업영역 오른쪽 아래, 여백 8', SCREEN, WORK_BOTTOM, rect(0, 0, 0, 0), { x: 1572, y: 632 }],
    [
      '음수 좌표(왼쪽 모니터의 아래 작업표시줄)',
      rect(-1920, 0, 1920, 1080),
      rect(-1920, 0, 1920, 1040),
      rect(-120, 1048, 24, 24),
      { x: -348, y: 632 },
    ],
    [
      '오른쪽 보조 모니터 — 작업영역 시작이 1920 이어도 오른쪽 끝(3840 - 340 - 8)에서 막힌다',
      rect(1920, 0, 1920, 1080),
      rect(1920, 0, 1920, 1040),
      rect(3700, 1048, 24, 24),
      { x: 3492, y: 632 },
    ],
    ['아이콘이 가로 가운데(자동 숨김) — 클램프 없이 아이콘 가운데 − 폭/2 = 912 − 170', SCREEN, SCREEN, rect(900, 1050, 24, 24), { x: 742, y: 642 }],
    ['가운데가 .5(아이콘 폭 25) — 반올림한다: 742.5 → 743', SCREEN, SCREEN, rect(900, 1050, 25, 24), { x: 743, y: 642 }],
  ];

  it.each(CASES)('%s', (_name, bounds, workArea, trayBounds, expected) => {
    expect(anchorPosition({ size: SIZE, trayBounds, display: { bounds, workArea } })).toStrictEqual(expected);
  });

  it('위/아래 절반은 workArea 가 아니라 display.bounds 로 가른다 — 아이콘 가운데 530, bounds 가운데 540, workArea 가운데 520', () => {
    // bounds 로 가르면 위쪽 절반이라 아이콘 아래(518 + 24 + 8 = 550), workArea 로 가르면 아래쪽 절반이라 아이콘 위(110)가 된다.
    const tray = rect(1800, 518, 24, 24);
    expect(anchorPosition({ size: SIZE, trayBounds: tray, display: { bounds: SCREEN, workArea: WORK_BOTTOM } })).toStrictEqual({ x: 1572, y: 550 });
  });

  it.each<[number, Point]>([
    [539, { x: 1572, y: 559 }], // 가운데 선 바로 위 → 위쪽 절반 → 아이콘 아래(527 + 24 + 8)
    [540, { x: 1572, y: 120 }], // 선 위 → 아래쪽 절반으로 본다(결정) → 아이콘 위(528 - 400 - 8)
    [541, { x: 1572, y: 121 }], // 바로 아래 → 아이콘 위
  ])('아이콘 가운데 y 가 bounds 가운데(540) 근처: %d', (centerY, expected) => {
    const tray = rect(1800, centerY - 12, 24, 24);
    expect(anchorPosition({ size: SIZE, trayBounds: tray, display: { bounds: SCREEN, workArea: WORK_BOTTOM } })).toStrictEqual(expected);
  });

  it('창이 작업영역보다 크면 왼쪽 위(여백 8)를 맞춘다 — 아이콘이 있어도 없어도', () => {
    const big: Size = { width: 2000, height: 1200 };
    const display: DisplayLike = { bounds: SCREEN, workArea: WORK_BOTTOM };
    expect(anchorPosition({ size: big, trayBounds: rect(1800, 1048, 24, 24), display })).toStrictEqual({ x: 8, y: 8 });
    expect(anchorPosition({ size: big, trayBounds: rect(0, 0, 0, 0), display })).toStrictEqual({ x: 8, y: 8 });
  });

  it('입력을 바꾸지 않는다', () => {
    const input = { size: { ...SIZE }, trayBounds: rect(1800, 1048, 24, 24), display: { bounds: { ...SCREEN }, workArea: { ...WORK_BOTTOM } } };
    const before = structuredClone(input);
    anchorPosition(input);
    expect(input).toStrictEqual(before);
  });
});

describe('clampPosition', () => {
  it.each<[string, Point, Point]>([
    ['안이면 그대로', { x: 100, y: 100 }, { x: 100, y: 100 }],
    ['왼쪽 위 여백 경계는 그대로', { x: 8, y: 8 }, { x: 8, y: 8 }],
    ['오른쪽 아래 여백 경계는 그대로', { x: 1572, y: 632 }, { x: 1572, y: 632 }],
    ['왼쪽 위로 한 칸 벗어남 → 여백 8', { x: 7, y: 7 }, { x: 8, y: 8 }],
    ['오른쪽 아래로 한 칸 벗어남 → 여백 8', { x: 1573, y: 633 }, { x: 1572, y: 632 }],
    ['x 는 오른쪽, y 는 위로 벗어남', { x: 5000, y: -50 }, { x: 1572, y: 8 }],
    ['x 만 벗어나면 y 는 그대로', { x: -10, y: 300 }, { x: 8, y: 300 }],
  ])('작업영역 {0,0,1920,1040}: %s', (_name, pos, expected) => {
    expect(clampPosition(pos, SIZE, WORK_BOTTOM)).toStrictEqual(expected);
  });

  it('창이 작업영역보다 크면 왼쪽 위(여백 8)를 맞추고 크기는 줄이지 않는다', () => {
    const big = Object.freeze({ width: 2000, height: 1200 });
    expect(clampPosition({ x: 100, y: 100 }, big, WORK_BOTTOM)).toStrictEqual({ x: 8, y: 8 });
    expect(clampPosition({ x: 5000, y: -50 }, big, WORK_BOTTOM)).toStrictEqual({ x: 8, y: 8 });
    expect(big).toStrictEqual({ width: 2000, height: 1200 });
  });

  it('한 축만 크면 그 축만 시작쪽을 맞춘다', () => {
    expect(clampPosition({ x: 500, y: 500 }, { width: 2000, height: 400 }, WORK_BOTTOM)).toStrictEqual({ x: 8, y: 500 });
    expect(clampPosition({ x: 500, y: 500 }, { width: 340, height: 1200 }, WORK_BOTTOM)).toStrictEqual({ x: 500, y: 8 });
  });

  it('여백을 뺀 영역에 딱 맞는 폭이면 자리는 8 하나뿐이고, 1 더 크면 시작쪽이 이긴다', () => {
    expect(clampPosition({ x: 500, y: 100 }, { width: 1904, height: 400 }, WORK_BOTTOM)).toStrictEqual({ x: 8, y: 100 }); // 8 .. 8
    expect(clampPosition({ x: 500, y: 100 }, { width: 1905, height: 400 }, WORK_BOTTOM)).toStrictEqual({ x: 8, y: 100 }); // 최대 7 < 최소 8
  });

  it.each<[string, Rect, Point, Point]>([
    ['원점이 0 이 아닌 작업영역', rect(60, 40, 1860, 1000), { x: 0, y: 0 }, { x: 68, y: 48 }],
    ['원점이 0 이 아닌 작업영역 — 오른쪽 아래', rect(60, 40, 1860, 1000), { x: 9999, y: 9999 }, { x: 1572, y: 632 }],
    ['음수 x(왼쪽 모니터)', rect(-1920, 0, 1920, 1040), { x: 0, y: 0 }, { x: -348, y: 8 }],
    ['음수 y(위로 쌓인 모니터)', rect(0, -1080, 1920, 1080), { x: 500, y: 0 }, { x: 500, y: -408 }],
  ])('작업영역 좌표 계산: %s', (_name, workArea, pos, expected) => {
    expect(clampPosition(pos, SIZE, workArea)).toStrictEqual(expected);
  });

  it('새 객체를 돌려주고 입력을 바꾸지 않는다', () => {
    const pos = Object.freeze({ x: 5000, y: -50 });
    const result = clampPosition(pos, SIZE, WORK_BOTTOM);
    expect(result).not.toBe(pos);
    expect(pos).toStrictEqual({ x: 5000, y: -50 });
  });
});

describe('placeWindow', () => {
  const PRIMARY: DisplayLike = { bounds: SCREEN, workArea: WORK_BOTTOM };
  /** 보조 모니터 — 기본 모니터의 오른쪽. */
  const SECOND: DisplayLike = { bounds: rect(1920, 0, 1920, 1080), workArea: rect(1920, 0, 1920, 1040) };
  /** 아래 작업표시줄의 아이콘. */
  const TRAY = rect(1800, 1048, 24, 24);
  const place = (over: Partial<Parameters<typeof placeWindow>[0]> = {}) =>
    placeWindow({ size: SIZE, saved: null, savedDisplay: null, trayBounds: TRAY, trayDisplay: PRIMARY, ...over });

  describe('저장 위치가 있으면 그 디스플레이 작업영역 안으로 clamp 한다(왼쪽 위 유지)', () => {
    it('안이면 그대로', () => {
      expect(place({ saved: { x: 100, y: 100 }, savedDisplay: PRIMARY })).toStrictEqual({ x: 100, y: 100 });
    });

    it('바깥이면 안으로 — 떼어 낸 모니터의 저장 위치는 남은 디스플레이(main 이 고른 savedDisplay)로 들어온다', () => {
      expect(place({ saved: { x: 3000, y: 100 }, savedDisplay: PRIMARY })).toStrictEqual({ x: 1572, y: 100 });
      expect(place({ saved: { x: -5000, y: -5000 }, savedDisplay: PRIMARY })).toStrictEqual({ x: 8, y: 8 });
    });

    it('아이콘이 있는 디스플레이가 아니라 저장 위치의 디스플레이 작업영역을 쓴다', () => {
      // 보조 모니터에 저장한 위치는 기본 모니터(trayDisplay)의 작업영역으로 clamp 하면 1572 로 끌려온다.
      expect(place({ saved: { x: 2000, y: 100 }, savedDisplay: SECOND, trayDisplay: PRIMARY })).toStrictEqual({ x: 2000, y: 100 });
      expect(place({ saved: { x: 9000, y: 100 }, savedDisplay: SECOND, trayDisplay: PRIMARY })).toStrictEqual({ x: 3492, y: 100 });
    });

    it('레이아웃이 바뀌어 크기가 달라져도 왼쪽 위를 유지하고, 넘칠 때만 안으로 민다', () => {
      const saved = { x: 100, y: 100 };
      expect(place({ saved, savedDisplay: PRIMARY, size: { width: 340, height: 300 } })).toStrictEqual({ x: 100, y: 100 });
      expect(place({ saved, savedDisplay: PRIMARY, size: { width: 340, height: 1000 } })).toStrictEqual({ x: 100, y: 32 }); // 1040 - 1000 - 8
    });

    it('창이 작업영역보다 크면 그 디스플레이 작업영역의 왼쪽 위(여백 8)', () => {
      const big = { width: 2000, height: 1200 };
      expect(place({ saved: { x: 100, y: 100 }, savedDisplay: PRIMARY, size: big })).toStrictEqual({ x: 8, y: 8 });
      expect(place({ saved: { x: 2100, y: 100 }, savedDisplay: SECOND, size: big })).toStrictEqual({ x: 1928, y: 8 });
    });

    it('savedDisplay 가 없으면 아이콘이 있는 디스플레이로 clamp 한다(던지지 않는다)', () => {
      expect(place({ saved: { x: 3000, y: 100 }, savedDisplay: null })).toStrictEqual({ x: 1572, y: 100 });
    });

    it('새 객체를 돌려주고 저장 위치를 바꾸지 않는다', () => {
      const saved = Object.freeze({ x: 3000, y: 100 });
      const result = place({ saved, savedDisplay: PRIMARY });
      expect(result).not.toBe(saved);
      expect(saved).toStrictEqual({ x: 3000, y: 100 });
    });
  });

  describe('저장 위치가 없으면 그 크기로 아이콘 쪽 위치를 다시 구한다', () => {
    it('anchorPosition 과 같다', () => {
      expect(place()).toStrictEqual(anchorPosition({ size: SIZE, trayBounds: TRAY, display: PRIMARY }));
      expect(place()).toStrictEqual({ x: 1572, y: 632 });
    });

    it('낡은 savedDisplay 가 넘어와도 saved 가 없으면 쓰지 않는다', () => {
      expect(place({ savedDisplay: SECOND })).toStrictEqual({ x: 1572, y: 632 });
    });

    it.each<[number, number]>([
      [400, 632],
      [600, 432],
      [300, 732],
    ])('아래 작업표시줄 — 높이 %d 이면 y %d: 크기가 바뀌어도 아래 가장자리는 1032 로 아이콘 쪽에 붙어 있다', (height, y) => {
      const result = place({ size: { width: 340, height } });
      expect(result).toStrictEqual({ x: 1572, y });
      expect(result.y + height).toBe(1032);
    });

    it('아이콘 bounds 가 비면 작업영역 오른쪽 아래', () => {
      expect(place({ trayBounds: rect(0, 0, 0, 0) })).toStrictEqual({ x: 1572, y: 632 });
    });
  });
});

describe('isUserMove', () => {
  const baseline = rect(500, 300, 340, 400);
  const at = (dx: number, dy: number): Rect => rect(baseline.x + dx, baseline.y + dy, baseline.width, baseline.height);

  it.each<[string, Rect, boolean]>([
    ['같은 자리', at(0, 0), false],
    ['(+2, −2) — 허용 오차 안', at(2, -2), false],
    ['(−2, +2) — 허용 오차 안', at(-2, 2), false],
    ['x +3', at(3, 0), true],
    ['x −3', at(-3, 0), true],
    ['y +3', at(0, 3), true],
    ['y −3', at(0, -3), true],
    ['(+3, +3)', at(3, 3), true],
    ['한쪽 축만 넘어도 이동이다 — (+2, +3)', at(2, 3), true],
    ['크기만 달라졌다 — 이동이 아니다', rect(500, 300, 340, 420), false],
  ])('기준에서 %s → %s', (_name, current, expected) => {
    expect(isUserMove(current, baseline)).toBe(expected);
  });

  it('기준이 없으면(null) 이동으로 본다', () => {
    expect(isUserMove(at(0, 0), null)).toBe(true);
  });

  it('허용 오차를 넘기면 그 값으로 가른다 — 기본값은 MOVE_TOLERANCE(2)', () => {
    expect(isUserMove(at(5, 0), baseline, 5)).toBe(false);
    expect(isUserMove(at(6, 0), baseline, 5)).toBe(true);
    expect(isUserMove(at(0, 0), baseline, 0)).toBe(false);
    expect(isUserMove(at(1, 0), baseline, 0)).toBe(true);
    expect(isUserMove(at(MOVE_TOLERANCE, 0), baseline)).toBe(false);
    expect(isUserMove(at(MOVE_TOLERANCE + 1, 0), baseline)).toBe(true);
  });

  it('위치(x, y)만 있는 값도 받는다', () => {
    expect(isUserMove({ x: 503, y: 300 }, { x: 500, y: 300 })).toBe(true);
    expect(isUserMove({ x: 502, y: 300 }, { x: 500, y: 300 })).toBe(false);
  });
});

describe('shouldSaveMove', () => {
  const baseline = rect(500, 300, 340, 400);
  const moved3 = rect(503, 300, 340, 400); // 3px — 허용 오차(2)를 넘는다
  const moved2 = rect(502, 300, 340, 400); // 2px — 오차 안
  const seen = { placing: false, manualMoveSeen: true, current: moved3, baseline };

  it('사용자가 옮겼다(will-move 를 받았고 · 배치 중이 아니고 · 3px) → 저장한다', () => {
    expect(shouldSaveMove(seen)).toBe(true);
  });

  it('프로그램이 배치하는 중(placing)이면 저장하지 않는다 — 크게 옮겨졌어도', () => {
    expect(shouldSaveMove({ ...seen, placing: true })).toBe(false);
    expect(shouldSaveMove({ ...seen, placing: true, baseline: null })).toBe(false);
  });

  it('마지막 배치 뒤에 will-move 를 받지 않았으면 저장하지 않는다 — 크게 옮겨졌어도(macOS 의 setBounds 안 moved)', () => {
    expect(shouldSaveMove({ ...seen, manualMoveSeen: false })).toBe(false);
    expect(shouldSaveMove({ ...seen, manualMoveSeen: false, baseline: null })).toBe(false);
  });

  it('will-move 를 받았어도 2px 이내면 저장하지 않는다', () => {
    expect(shouldSaveMove({ ...seen, current: moved2 })).toBe(false);
    expect(shouldSaveMove({ ...seen, current: baseline })).toBe(false);
  });

  it('will-move 를 받았고 기준이 없으면(null) 저장한다', () => {
    expect(shouldSaveMove({ ...seen, baseline: null })).toBe(true);
  });

  it.each<[boolean, boolean, boolean]>([
    [false, false, false],
    [false, true, true], // 이 한 칸만 저장한다
    [true, false, false],
    [true, true, false],
  ])('placing=%s · manualMoveSeen=%s (3px 이동) → %s', (placing, manualMoveSeen, expected) => {
    expect(shouldSaveMove({ placing, manualMoveSeen, current: moved3, baseline })).toBe(expected);
  });
});
