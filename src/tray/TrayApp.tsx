import { useEffect, useState } from 'react';
import { desktop } from './desktop';

/**
 * 트레이 앱 창의 화면(#20 골격) — 제목 줄(이름 + 앱 버전)과 자리표시 한 문단뿐이다. 혼자 하기 · 온라인 대전 화면은 #24 · #25.
 * 버전은 브리지에서 받는다. 브리지가 없거나(브라우저 개발) 받지 못하면 버전은 그리지 않는다.
 */
export function TrayApp() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    desktop()
      ?.getAppInfo()
      .then((info) => {
        if (alive) setVersion(info.version);
      })
      // 버전은 곁들이는 정보다 — 실패해도 화면은 그대로 둔다(IPC 가 되는지는 스모크 ipc 검사가 본다).
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="tapp-app">
      <h1 className="tapp-title">십이장기</h1>
      {version && <span className="tapp-version">{version}</span>}
      <p className="tapp-placeholder">곧 이 창에서 혼자 하기와 온라인 대전을 할 수 있어요.</p>
    </main>
  );
}
