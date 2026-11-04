// desktop/lib/pushChannels.cjs 시험 — main→렌더러 채널 표와 getState 스냅샷(설계 §5.1 pushChannels.cjs).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { PUSH_CHANNELS, buildSnapshot } = require('./pushChannels.cjs') as typeof import('./pushChannels.cjs');
const { DEFAULT_SETTINGS } = require('./settings.cjs') as typeof import('./settings.cjs');

describe('PUSH_CHANNELS', () => {
  it('키 · 값이 정확하고 얼려 있다', () => {
    expect(PUSH_CHANNELS).toEqual({
      'tj-theme': 'theme',
      'tj-opacity': 'opacity',
      'tj-mode': 'mode',
      'tj-shown': 'visible',
      'tj-hidden': 'visible',
    });
    expect(Object.keys(PUSH_CHANNELS)).toEqual(['tj-theme', 'tj-opacity', 'tj-mode', 'tj-shown', 'tj-hidden']);
    expect(Object.isFrozen(PUSH_CHANNELS)).toBe(true);
  });
});

describe('buildSnapshot', () => {
  it('설정의 theme · opacity 와 main 의 mode · visible 을 모은다', () => {
    expect(
      buildSnapshot({ settings: { ...DEFAULT_SETTINGS, theme: 'light', opacity: 64 }, mode: 'online', visible: false }),
    ).toEqual({ theme: 'light', opacity: 64, mode: 'online', visible: false });
  });
  it('나머지 설정 키는 싣지 않는다', () => {
    const snapshot = buildSnapshot({ settings: { ...DEFAULT_SETTINGS, pinned: true }, mode: 'solo', visible: true });
    expect(Object.keys(snapshot).sort()).toEqual(['mode', 'opacity', 'theme', 'visible']);
  });
  it('PUSH_CHANNELS 의 모든 값이 스냅샷 키에 있다', () => {
    const snapshot = buildSnapshot({ settings: DEFAULT_SETTINGS, mode: 'solo', visible: true });
    for (const field of Object.values(PUSH_CHANNELS)) expect(Object.keys(snapshot)).toContain(field);
  });
});
