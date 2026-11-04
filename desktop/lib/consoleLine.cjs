'use strict';
// 개발 실행의 콘솔 중계 한 줄(설계 §5.1 consoleLine.cjs). 페이지가 보낸 글을 개발자 터미널에 쓰므로 터미널을 건드리는 글자는 날것으로 나가지 않는다.
// - C0 제어 문자(탭 제외) · DEL · C1(U+0080–U+009F)을 \uXXXX 로 바꾼다. 줄바꿈도 바꾼다(가짜 `[tj]` 줄을 막는다). ESC · OSC 52 가 터미널에 닿지 않는다.
// - 자르기 · 표시 규칙은 guards.cjs 의 repr 을 따른다(글자 수에서 자르고 … 를 붙인다). 다만 결과는 따옴표 없는 글이다.
// electron 을 require 하지 않는다.

const { repr } = require('./guards.cjs');

const LEVELS = ['info', 'warning', 'error', 'debug'];
const MAX_MESSAGE = 500;
const MAX_SOURCE = 200;
const MAX_LINE_NUMBER = 20;

/**
 * 믿을 수 없는 값을 글로 — 글자는 그대로, 그 밖은 repr(JSON · String). 던지지 않는다.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function asText(value, max) {
  if (typeof value !== 'string') return repr(value, max);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 탭을 뺀 C0 · DEL · C1 을 \uXXXX 로.
 * @param {string} text
 * @returns {string}
 */
function escapeControls(text) {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * @param {{ level: unknown, message: unknown, sourceId: unknown, lineNumber: unknown }} input
 * @returns {string} `[tray:<level>] <message> (<sourceId>:<lineNumber>)` — 줄바꿈이 없는 한 줄
 */
function consoleLine({ level, message, sourceId, lineNumber }) {
  const knownLevel = typeof level === 'string' && LEVELS.includes(level) ? level : 'info';
  const msg = escapeControls(asText(message, MAX_MESSAGE));
  const src = escapeControls(asText(sourceId, MAX_SOURCE));
  const num = escapeControls(asText(lineNumber, MAX_LINE_NUMBER));
  return `[tray:${knownLevel}] ${msg} (${src}:${num})`;
}

module.exports = { consoleLine };
