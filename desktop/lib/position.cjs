'use strict';
// 트레이 팝업의 배치 계산(설계 §5.1 position) — 아이콘 쪽에 붙이고, 작업영역 안으로 넣고, 사용자가 옮긴 것인지 가른다.
// 보이기 · 레이아웃 바꾸기 · 디스플레이 변경이 모두 placeWindow 하나로 배치한다. main.js 는 디스플레이를 고르고(screen) 결과를
// setBounds 에 넘기기만 한다. 사각형 · 디스플레이 · 크기는 전부 인자다 — electron 을 require 하지 않고 플랫폼에도 기대지 않는다.

/**
 * 사각형 — Electron 의 Rectangle 과 같은 모양이다. 좌표는 화면 전체 기준이라 다른 모니터에서는 음수일 수 있다.
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ width: number, height: number }} Size */
/**
 * Electron 의 Display 중 이 모듈이 쓰는 부분(구조 타입). bounds 는 디스플레이 전체, workArea 는 작업표시줄 · 메뉴 막대를 뺀 영역이다.
 * @typedef {object} DisplayLike
 * @property {Rect} bounds
 * @property {Rect} workArea
 */

/** 창과 작업영역 가장자리 사이의 여백, 그리고 아이콘과의 간격. */
const MARGIN = 8;
/** 이동으로 치지 않는 오차(px) — 기준 위치에서 x · y 가 이만큼까지 다른 것은 같은 자리다. */
const MOVE_TOLERANCE = 2;

/**
 * 사각형이 비었는가 — 폭이나 높이가 0 이하이거나, 네 값 가운데 유한수가 아닌 것이 있다. 트레이 아이콘의 위치를 알 수 없다는
 * 뜻이다(이 사각형으로는 디스플레이를 고르지도, 아이콘 쪽에 붙이지도 않는다).
 * @param {Rect} rect
 * @returns {boolean}
 */
function isEmptyRect(rect) {
  const { x, y, width, height } = rect;
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height))) return true;
  return width <= 0 || height <= 0;
}

/**
 * 한 축을 [origin + 여백, origin + extent - length - 여백] 안으로 넣는다. 창이 더 커서 구간이 뒤집히면 시작쪽(왼쪽 · 위)이 이긴다.
 * @param {number} value 창의 시작 좌표
 * @param {number} origin 작업영역의 시작 좌표
 * @param {number} extent 작업영역의 길이
 * @param {number} length 창의 길이
 * @returns {number}
 */
function clampAxis(value, origin, extent, length) {
  const min = origin + MARGIN;
  const max = origin + extent - length - MARGIN;
  return Math.max(min, Math.min(value, max));
}

/**
 * 창(왼쪽 위 pos, 크기 size)을 작업영역 안으로 넣는다 — 네 변 모두 여백 8 이상 떨어지게. 크기는 줄이지 않는다(레이아웃이 깨진다).
 * 창이 작업영역보다 커서 들어갈 수 없으면 왼쪽 위를 맞춘다(제목 줄과 ✕ 가 보이게). 새 객체를 돌려준다.
 * @param {Point} pos
 * @param {Size} size
 * @param {Rect} workArea
 * @returns {Point}
 */
function clampPosition(pos, size, workArea) {
  return {
    x: clampAxis(pos.x, workArea.x, workArea.width, size.width),
    y: clampAxis(pos.y, workArea.y, workArea.height, size.height),
  };
}

/**
 * 팝업을 트레이 아이콘 쪽에 붙인 위치.
 * - x: 아이콘 가운데에서 창 폭의 절반을 뺀다(반올림).
 * - y: 아이콘 가운데가 디스플레이의 위쪽 절반이면 아이콘 아래(아이콘 아래 + 8), 아래쪽 절반이면 아이콘 위(아이콘 위 - 창 높이 - 8)다.
 *   절반은 그 디스플레이의 bounds 로 가른다(절대 좌표의 가운데가 아니다 — 위로 쌓인 디스플레이는 y 가 음수다). 가운데 선 위는
 *   아래쪽 절반으로 본다.
 * - 아이콘 사각형이 비면(isEmptyRect) 작업영역 오른쪽 아래, 여백 8 이다.
 * 그다음 작업영역 안으로 clamp 한다. 왼쪽 · 오른쪽 작업표시줄은 아이콘이 작업영역 밖에 있으므로, clamp 가 창을 작업표시줄 옆
 * (여백 8)에 둔다.
 * @param {{ size: Size, trayBounds: Rect, display: DisplayLike }} input
 * @returns {Point}
 */
function anchorPosition({ size, trayBounds, display }) {
  const { bounds, workArea } = display;
  if (isEmptyRect(trayBounds)) {
    const corner = {
      x: workArea.x + workArea.width - size.width - MARGIN,
      y: workArea.y + workArea.height - size.height - MARGIN,
    };
    return clampPosition(corner, size, workArea); // 창이 더 크면 왼쪽 위
  }
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - size.width / 2);
  const iconCenterY = trayBounds.y + trayBounds.height / 2;
  const upperHalf = iconCenterY < bounds.y + bounds.height / 2;
  const y = upperHalf ? trayBounds.y + trayBounds.height + MARGIN : trayBounds.y - size.height - MARGIN;
  return clampPosition({ x, y }, size, workArea);
}

/**
 * 팝업을 놓을 위치 — 보이기 · 레이아웃 바꾸기 · 디스플레이 변경이 모두 이 함수 하나로 배치한다.
 * - 저장 위치(saved)가 있으면 그 디스플레이(savedDisplay)의 작업영역 안으로 clamp 한다(왼쪽 위 유지, 크기가 바뀌어도 같다).
 * - 없으면 그 크기로 anchorPosition 을 다시 구한다. 아래쪽 작업표시줄이면 크기가 바뀌어도 아래 가장자리가 아이콘 쪽에 붙어 있다.
 * 디스플레이는 main 이 고른다: 저장 위치는 screen.getDisplayMatching(저장 사각형)(떼어 낸 모니터면 남은 디스플레이가 온다),
 * 기본 위치는 getDisplayMatching(trayBounds), 아이콘 bounds 가 비면 getPrimaryDisplay() 다. 저장 위치가 있는데 savedDisplay 가
 * 없으면 아이콘이 있는 디스플레이(trayDisplay)로 clamp 한다.
 * @param {object} input
 * @param {Size} input.size
 * @param {Point | null} input.saved 저장한 위치(없으면 null)
 * @param {DisplayLike | null} input.savedDisplay saved 가 있을 때 그 위치와 가장 많이 겹치는 디스플레이
 * @param {Rect} input.trayBounds
 * @param {DisplayLike} input.trayDisplay 아이콘이 있는 디스플레이(bounds 가 비면 주 디스플레이)
 * @returns {Point}
 */
function placeWindow({ size, saved, savedDisplay, trayBounds, trayDisplay }) {
  if (saved) return clampPosition(saved, size, (savedDisplay ?? trayDisplay).workArea);
  return anchorPosition({ size, trayBounds, display: trayDisplay });
}

/**
 * 지금 위치가 기준 위치에서 사용자가 옮긴 만큼 벗어났는가 — x 나 y 가 허용 오차(기본 2px)보다 크게 다르면 true 다.
 * 크기는 보지 않는다(사용자는 크기를 바꾸지 못한다 — 크기는 레이아웃 바꾸기가 정한다). 기준이 없으면(null) true 다.
 * @param {Point} current
 * @param {Point | null} baseline
 * @param {number} [tol]
 * @returns {boolean}
 */
function isUserMove(current, baseline, tol = MOVE_TOLERANCE) {
  if (baseline === null || baseline === undefined) return true;
  return Math.abs(current.x - baseline.x) > tol || Math.abs(current.y - baseline.y) > tol;
}

/**
 * `moved` 때 이 위치를 사용자 위치로 저장해도 되는가.
 * - 프로그램이 배치하는 중(placing)이면 false 다.
 * - 마지막 배치 뒤에 `will-move` 를 받지 않았으면(manualMoveSeen) false 다. `will-move` 는 사용자가 옮길 때만 온다(Electron 문서:
 *   setPosition · setBounds 로는 오지 않는다). macOS 의 `moved` 는 `move` 의 별칭이라 setBounds 안에서 바로 올 수 있어서(macOS 미확인),
 *   기준점만으로는 프로그램이 옮긴 것을 사용자 위치로 저장하고 '위치 초기화' 가 바로 되돌아간다.
 * - 그다음 isUserMove(current, baseline, MOVE_TOLERANCE) 다. baseline 은 배치 뒤의 실제 getBounds() 이고, 저장을 받아들이면
 *   main 이 그 자리로 옮긴다.
 * @param {{ placing: boolean, manualMoveSeen: boolean, current: Point, baseline: Point | null }} state
 * @returns {boolean}
 */
function shouldSaveMove({ placing, manualMoveSeen, current, baseline }) {
  if (placing) return false;
  if (!manualMoveSeen) return false;
  return isUserMove(current, baseline, MOVE_TOLERANCE);
}

module.exports = { MARGIN, MOVE_TOLERANCE, isEmptyRect, anchorPosition, clampPosition, placeWindow, isUserMove, shouldSaveMove };
