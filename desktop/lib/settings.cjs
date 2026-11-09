'use strict';
// 저장 설정(설계 §5.1 settings.cjs) — `<userData>/settings.json` 의 정규화 · 읽기 · 원자적 쓰기. fs 는 인자로 받아
// (기본은 node:fs) 시험이 바꿔 끼울 수 있다. electron 을 require 하지 않는다.

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { isRecord } = require('./guards.cjs');
const { normalizeTheme } = require('./theme.cjs');
const { DEFAULT_OPACITY, normalizeOpacity } = require('./opacity.cjs');

/** @typedef {import('./position.cjs').Point} Point */
/**
 * 저장되는 설정. autostart 는 macOS 체크 상태다(Windows 는 OS 가 원본이라 읽지 않는다).
 * @typedef {object} Settings
 * @property {'dark' | 'light'} theme
 * @property {number} opacity 30–100 정수
 * @property {boolean} pinned
 * @property {Point | null} position 사용자가 옮긴 창 위치
 * @property {boolean} autostart
 * @property {boolean} autostartDefaultApplied 자동 실행 기본값을 이미 적용했다(첫 실행이 아니다)
 */

const SETTINGS_FILE = 'settings.json';

/** @type {Readonly<Settings>} */
const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',
  opacity: DEFAULT_OPACITY,
  pinned: false,
  position: null,
  autostart: false,
  autostartDefaultApplied: false,
});

/**
 * 32비트 부호 있는 정수인가 — Electron 의 Rectangle 이 받는 범위다(정수 필드를 int 로 바꾼다).
 * @param {number} n
 * @returns {boolean}
 */
function isInt32(n) {
  return (n | 0) === n;
}

/**
 * {x, y} 둘 다 유한수이고 반올림한 값이 int32 이면 그 정수 위치, 아니면 null. (-0 은 0 으로 쓴다.)
 * int32 밖 좌표(손으로 고친 파일)는 Electron 의 Rectangle 로 바꾸지 못해 보일 때마다 screen.getDisplayMatching 이 던진다 — 저장 위치가
 * 없는 것(기본값 — 아이콘 쪽 배치)으로 본다.
 * @param {unknown} value
 * @returns {Point | null}
 */
function normalizePosition(value) {
  if (!isRecord(value)) return null;
  const { x, y } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const point = { x: Math.round(x) + 0, y: Math.round(y) + 0 };
  return isInt32(point.x) && isInt32(point.y) ? point : null;
}

/**
 * 믿을 수 없는 값을 설정으로 만든다 — 아는 키만 담은 새 객체이고, 틀린 키는 그 키만 기본값이다. 모르는 키는 버린다.
 * @param {unknown} raw
 * @returns {Settings}
 */
function normalizeSettings(raw) {
  const src = isRecord(raw) ? raw : {};
  return {
    theme: normalizeTheme(src.theme) ?? DEFAULT_SETTINGS.theme,
    opacity: normalizeOpacity(src.opacity) ?? DEFAULT_SETTINGS.opacity,
    pinned: src.pinned === true,
    position: normalizePosition(src.position),
    autostart: src.autostart === true,
    autostartDefaultApplied: src.autostartDefaultApplied === true,
  };
}

/**
 * 설정 파일을 읽는다. 없으면 'missing'(첫 실행), 못 읽거나 JSON 이 아니거나 평범한 객체가 아니면 'unreadable' 이다.
 * unreadable 은 파일이 있었으니 첫 실행이 아니다 — autostartDefaultApplied 를 true 로 본다(깨진 파일 때문에 자동 실행이 되살아나지 않게).
 * @param {string} file
 * @param {Pick<typeof import('node:fs'), 'readFileSync'>} [fs]
 * @returns {{ settings: Settings, status: 'missing' | 'ok' | 'unreadable' }}
 */
function readSettings(file, fs = nodeFs) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { settings: normalizeSettings({}), status: 'missing' };
    }
    return { settings: { ...normalizeSettings({}), autostartDefaultApplied: true }, status: 'unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    return { settings: { ...normalizeSettings({}), autostartDefaultApplied: true }, status: 'unreadable' };
  }
  return { settings: normalizeSettings(parsed), status: 'ok' };
}

/**
 * 설정을 원자적으로 쓴다 — 폴더를 만들고(recursive), 같은 폴더의 임시 파일에 쓰고, rename 으로 바꾼다. 실패하면 임시 파일을 지운다.
 * smokeOut.writeJsonAtomic 과 같은 순서이되 던지지 않고 오류를 돌려준다. fs 는 모듈 객체로 부른다(구조 분해하지 않는다).
 * @param {string} file
 * @param {Settings} settings
 * @param {Pick<typeof import('node:fs'), 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync'>} [fs]
 * @returns {Error | null}
 */
function writeSettings(file, settings, fs = nodeFs) {
  const dir = nodePath.dirname(file);
  const temp = nodePath.join(dir, `.${nodePath.basename(file)}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
    fs.renameSync(temp, file);
    return null;
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 임시 파일을 못 지워도 원래 오류를 돌려준다 — 그쪽이 원인이다
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * 잠깐 막힌 쓰기인가 — 백신 · 인덱서가 파일을 쥐고 있을 때의 코드다. 이때만 한 번 더 해 본다.
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryableWriteError(err) {
  const code = isRecord(err) || err instanceof Error ? /** @type {{ code?: unknown }} */ (err).code : undefined;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

module.exports = { SETTINGS_FILE, DEFAULT_SETTINGS, normalizeSettings, readSettings, writeSettings, isRetryableWriteError };
