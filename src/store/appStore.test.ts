// 창 열림 상태의 계약 — 결과 창은 다른 창(도움말·설정·패치노트·피드백)이 열려 있으면 그 창이 닫힌 뒤에 뜬다(#10).
// 그래서 '창이 열렸는가'를 한 곳(isPanelOpen)에서 판단하고, 새 창을 더할 때 빠뜨리지 않게 지킨다.
import { beforeEach, describe, expect, it } from 'vitest';
import { isPanelOpen, useAppStore } from './appStore';

const initial = useAppStore.getState();
beforeEach(() => useAppStore.setState(initial, true));

describe('창 열림', () => {
  it('처음에는 열린 창이 없다', () => {
    expect(isPanelOpen(useAppStore.getState())).toBe(false);
  });

  it('도움말·설정·패치노트·피드백 중 하나라도 열리면 true', () => {
    const opens = [
      () => useAppStore.getState().setHelpOpen(true),
      () => useAppStore.getState().setSettingsOpen(true),
      () => useAppStore.getState().openPatchNotes(),
      () => useAppStore.getState().setFeedbackOpen(true),
    ];
    for (const open of opens) {
      useAppStore.setState(initial, true);
      open();
      expect(isPanelOpen(useAppStore.getState())).toBe(true);
    }
  });

  it("'…Open' 으로 끝나는 불리언 상태는 모두 창으로 센다 — 새 창을 더하고 빠뜨리지 않게", () => {
    const keys = Object.entries(initial)
      .filter(([k, v]) => typeof v === 'boolean' && k.endsWith('Open'))
      .map(([k]) => k)
      .sort();
    expect(keys).toEqual(['feedbackOpen', 'helpOpen', 'patchNotesOpen', 'settingsOpen']);
    for (const k of keys) {
      useAppStore.setState({ ...initial, [k]: true }, true);
      expect(isPanelOpen(useAppStore.getState()), k).toBe(true);
    }
  });

  it('화면이 바뀌면 도움말·설정은 닫힌다(헤더가 화면마다 새로 뜨던 동작)', () => {
    const s = useAppStore.getState();
    s.setHelpOpen(true);
    s.setSettingsOpen(true);
    s.setScreen('mpgame');
    const after = useAppStore.getState();
    expect([after.helpOpen, after.settingsOpen, isPanelOpen(after)]).toEqual([false, false, false]);
  });
});
