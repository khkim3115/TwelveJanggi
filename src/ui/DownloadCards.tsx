// 앱으로 받기 — PWA 설치 안내. 이미 설치한 앱(독립 창)으로 열었으면 그리지 않는다.
import { InstallButton, useStandalone } from './InstallButton';

export function DownloadCards() {
  const standalone = useStandalone();
  if (standalone) return null;
  return (
    <section className="home-card">
      <h2>📥 앱으로 받기</h2>
      <p className="home-card-sub">
        브라우저에 설치하면 주소창 없는 독립 창으로 뜨고, 혼자 하기는 <b>인터넷 없이도</b> 돌아갑니다 — AI 계산이 전부
        기기 안에서 일어나요.
      </p>
      <InstallButton />
      <p className="home-note">
        버튼이 안 보이면 주소창 오른쪽의 설치(⊕) 아이콘이나 브라우저 메뉴의 ‘앱 설치’를, iPhone·iPad 에서는 Safari 의
        공유 버튼 → ‘홈 화면에 추가’를 쓰세요.
      </p>
    </section>
  );
}
