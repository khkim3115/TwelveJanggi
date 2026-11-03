// desktop/lib/permissions.cjs 시험 — 권한 · 다운로드 · 클라이언트 인증서(설계 §5.7 체크리스트 5).
// Electron 은 처리기가 없으면 권한을 모두 허락하고 다운로드를 받는다 — 그래서 허용은 목록으로, 나머지는 거부로 둔다.
// 가짜 객체만 쓴다(electron 은 import 하지 않는다).
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { ALLOWED_PERMISSIONS, denyDownload, isPermissionAllowed, selectNoCertificate } =
  require('./permissions.cjs') as typeof import('./permissions.cjs');

/** request 처리기가 details.requestingUrl 로 받는 전체 URL. */
const PAGE = 'app://twelvejanggi/tray.html';
/** check 처리기가 requestingOrigin 으로 받는 출처 — 끝에 '/' 가 붙는다. */
const ORIGIN_SLASH = 'app://twelvejanggi/';

describe('ALLOWED_PERMISSIONS', () => {
  it('notifications · clipboard-sanitized-write 둘뿐이고 얼려 있다', () => {
    expect(ALLOWED_PERMISSIONS).toStrictEqual(['notifications', 'clipboard-sanitized-write']);
    expect(Object.isFrozen(ALLOWED_PERMISSIONS)).toBe(true);
  });
});

describe('isPermissionAllowed', () => {
  describe.each(['notifications', 'clipboard-sanitized-write'])('허용 권한 %s', (permission) => {
    it('request 처리기의 모양(requestingUrl) · check 처리기의 모양(requestingOrigin) · 둘 다 — 앱이면 허용한다', () => {
      expect(isPermissionAllowed({ permission, requestingUrl: PAGE })).toBe(true);
      expect(isPermissionAllowed({ permission, requestingOrigin: ORIGIN_SLASH })).toBe(true);
      expect(isPermissionAllowed({ permission, requestingUrl: PAGE, requestingOrigin: ORIGIN_SLASH })).toBe(true);
      expect(isPermissionAllowed({ permission, requestingUrl: 'app://twelvejanggi/tray.html?smoke' })).toBe(true);
    });

    // 요청한 쪽이 앱이 아니다 — 각 필드 하나만 · 둘 다 틀린 경우, 그리고 한쪽만 앱인 어긋남.
    it.each(['app://twelvejanggi.evil/', 'app://TwelveJanggi/', 'https://khkim3115.github.io/', 'app://other/', 'file:///C:/tray.html', 'null', ''])(
      '출처 %j 는 거부한다',
      (bad) => {
        expect(isPermissionAllowed({ permission, requestingUrl: bad })).toBe(false);
        expect(isPermissionAllowed({ permission, requestingOrigin: bad })).toBe(false);
        expect(isPermissionAllowed({ permission, requestingUrl: bad, requestingOrigin: bad })).toBe(false);
        expect(isPermissionAllowed({ permission, requestingUrl: PAGE, requestingOrigin: bad })).toBe(false);
        expect(isPermissionAllowed({ permission, requestingUrl: bad, requestingOrigin: ORIGIN_SLASH })).toBe(false);
      },
    );

    it('요청한 쪽을 가리키는 값이 하나도 없으면 거부한다', () => {
      expect(isPermissionAllowed({ permission })).toBe(false);
      expect(isPermissionAllowed({ permission, requestingUrl: undefined, requestingOrigin: undefined })).toBe(false);
    });

    it('문자열이 아닌 출처(null 등)는 거부한다', () => {
      expect(isPermissionAllowed({ permission, requestingUrl: null as unknown as string })).toBe(false);
      expect(isPermissionAllowed({ permission, requestingOrigin: 1 as unknown as string })).toBe(false);
    });
  });

  it.each([
    'geolocation',
    'media',
    'display-capture',
    'clipboard-read',
    'openExternal',
    'midi',
    'midiSysex',
    'fullscreen',
    'fileSystem',
    'hid',
    'usb',
    'serial',
    'pointerLock',
    'unknown',
    'Notifications', // 대소문자 그대로
    'notifications ',
    '__proto__',
    'constructor',
    'toString',
    '',
  ])('허용 목록 밖 권한 %j 은 앱이 요청해도 거부한다', (permission) => {
    expect(isPermissionAllowed({ permission, requestingUrl: PAGE })).toBe(false);
    expect(isPermissionAllowed({ permission, requestingOrigin: ORIGIN_SLASH })).toBe(false);
    expect(isPermissionAllowed({ permission, requestingUrl: PAGE, requestingOrigin: ORIGIN_SLASH })).toBe(false);
  });

  it('문자열이 아닌 권한은 거부한다(배열은 목록의 글자와 같아 보여도 통과하지 못한다)', () => {
    for (const permission of [undefined, null, 1, {}, ['notifications']]) {
      expect(isPermissionAllowed({ permission: permission as unknown as string, requestingUrl: PAGE })).toBe(false);
    }
  });
});

describe('denyDownload', () => {
  it('will-download 를 취소한다(preventDefault 한 번)', () => {
    const event = { preventDefault: vi.fn() };
    expect(denyDownload(event)).toBeUndefined();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('리스너로 쓰일 때 따라오는 인자(item · webContents · frame)는 쓰지 않는다', () => {
    const event = { preventDefault: vi.fn() };
    (denyDownload as (...args: unknown[]) => void)(event, { item: 1 }, { webContents: 1 }, null);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('selectNoCertificate', () => {
  it('인증서 없이 진행한다 — preventDefault 한 뒤 마지막 인자 callback 을 인자 없이 부른다', () => {
    const calls: string[] = [];
    const event = { preventDefault: vi.fn(() => calls.push('preventDefault')) };
    const callback = vi.fn((...args: unknown[]) => calls.push(`callback(${args.length})`));
    // select-client-certificate 리스너의 나머지 인자: webContents, url, certificateList, callback
    selectNoCertificate(event, { id: 1 }, 'https://mtls.example/', [{ subjectName: 'a' }], callback);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(); // 인증서를 고르지 않는다
    expect(calls).toStrictEqual(['preventDefault', 'callback(0)']); // 결정(preventDefault)이 callback 보다 먼저
  });

  it('callback 이 던져도 preventDefault 는 이미 걸려 있다', () => {
    const event = { preventDefault: vi.fn() };
    const boom = (): void => {
      throw new Error('boom');
    };
    expect(() => selectNoCertificate(event, null, '', [], boom)).toThrow('boom');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('callback 이 없거나 함수가 아니면 preventDefault 만 하고 던지지 않는다', () => {
    for (const rest of [[], [null, 'https://x/', []], [null, 'https://x/', [], 'callback']]) {
      const event = { preventDefault: vi.fn() };
      expect(() => selectNoCertificate(event, ...rest)).not.toThrow();
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    }
  });
});
