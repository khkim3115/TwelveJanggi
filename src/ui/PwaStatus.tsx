// 서비스 워커를 등록하고(앱 전체에서 여기 한 곳), 상태에 따라 아래쪽 알림을 띄운다.
//  · offlineReady: 오프라인 캐시 완료 → 인터넷 없이 혼자 하기 가능(잠시 뒤 저절로 닫힌다).
//  · needRefresh: 새 버전 배포됨 → '업데이트'를 누르면 새 서비스 워커를 적용하고 새로고침한다.
// 알림은 홈에서만 띄운다 — 새로고침은 진행 중인 판(혼자 하기는 메모리에만 있다)을 날리고 온라인 방에서도 빼내므로
// 대국·대기실 화면에서는 숨겨 두었다가 홈으로 돌아오면 다시 보인다(알림이 채팅·조작 버튼을 가리지도 않는다).
// 업데이트를 적용하면 같은 앱의 다른 탭도 함께 새로고침된다 — 옛 해시 청크가 캐시에서 지워지므로 필요한 동작.
import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useAppStore } from '../store/appStore';

export function PwaStatus() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const onHome = useAppStore((s) => s.screen === 'home');

  useEffect(() => {
    if (!offlineReady || !onHome) return;
    const t = window.setTimeout(() => setOfflineReady(false), 6000);
    return () => window.clearTimeout(t);
  }, [offlineReady, onHome, setOfflineReady]);

  if (!onHome || (!offlineReady && !needRefresh)) return null;

  return (
    <div className="pwa-toast" role="status">
      {needRefresh ? (
        <>
          <span>새 버전이 준비됐어요.</span>
          <button className="pwa-toast-btn" onClick={() => void updateServiceWorker(true)}>
            업데이트
          </button>
          <button className="pwa-toast-close" onClick={() => setNeedRefresh(false)} aria-label="알림 닫기">
            ✕
          </button>
        </>
      ) : (
        <>
          <span>오프라인 준비 완료 — 이제 인터넷 없이도 혼자 하기를 할 수 있어요.</span>
          <button className="pwa-toast-close" onClick={() => setOfflineReady(false)} aria-label="알림 닫기">
            ✕
          </button>
        </>
      )}
    </div>
  );
}
