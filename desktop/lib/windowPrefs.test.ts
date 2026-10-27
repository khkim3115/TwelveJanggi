// desktop/lib/windowPrefs.cjs 시험 — 트레이 창의 webPreferences 공장(설계 §5.5). 실제 앱과 스모크가 이 공장 하나에서 만든다.
// 키가 정확히 네 개이고 값이 계약 그대로다. additionalArguments 는 없다(비어 있지 않으면 44.x/45 의 spare renderer 를 못 쓴다).
// 공장은 preload 경로 하나만 받는다 — 스모크 입력이 없다는 것을 인자 수와 '무시되는 추가 인자'로 고정한다.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { trayWindowPreferences } = require('./windowPrefs.cjs') as typeof import('./windowPrefs.cjs');

// 한글 · 공백이 든 Windows 경로 — 사용자 폴더 'C:\Users\홍 길동\' 대비. 값은 그대로 나가야 한다(경로를 고치지 않는다).
const PRELOAD = 'C:\\Users\\홍 길동\\TwelveJanggi\\desktop\\preload.js';

describe('trayWindowPreferences', () => {
  it('정확히 { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } 다', () => {
    expect(trayWindowPreferences(PRELOAD)).toStrictEqual({
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
  });

  it('키가 정확히 네 개다 — 더한 키가 조용히 보안 설정을 바꾸지 못한다', () => {
    expect(Object.keys(trayWindowPreferences(PRELOAD)).sort()).toStrictEqual(['contextIsolation', 'nodeIntegration', 'preload', 'sandbox']);
    expect(trayWindowPreferences(PRELOAD)).not.toHaveProperty('additionalArguments');
  });

  it.each(['/home/홍 길동/desktop/preload.js', 'preload.js', '', 'D:\\Google Drive\\r\\preload.js'])('preload 경로는 그대로 담는다: %j', (preload) => {
    expect(trayWindowPreferences(preload).preload).toBe(preload);
  });

  it('호출마다 새 객체다 — 한 창이 고친 값이 다른 창에 번지지 않는다', () => {
    const a = trayWindowPreferences(PRELOAD);
    const b = trayWindowPreferences(PRELOAD);
    expect(a).not.toBe(b);
    (a as { sandbox: boolean }).sandbox = false;
    expect(b.sandbox).toBe(true);
    expect(trayWindowPreferences(PRELOAD).sandbox).toBe(true);
  });

  it('인자는 preload 경로 하나뿐이다 — 추가 인자(스모크 표시 등)는 결과를 바꾸지 못한다', () => {
    expect(trayWindowPreferences.length).toBe(1);
    const withExtra = (trayWindowPreferences as (...args: unknown[]) => unknown)(PRELOAD, { smoke: true }, ['--tj-smoke'], true);
    expect(withExtra).toStrictEqual(trayWindowPreferences(PRELOAD));
  });
});
