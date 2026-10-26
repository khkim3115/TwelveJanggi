// 패치노트(체인지로그)의 단일 진실원본. 순수 데이터 모듈 — React/DOM 의존 없음.
// 새 버전을 낼 때 CHANGELOG 맨 위(index 0)에 항목을 추가하면 LATEST_VERSION 이 자동 갱신되고
// 헤더 NEW 배지·자동 노출이 동작한다. (package.json 버전과는 분리 — 여기가 사용자에게 보이는 버전.)

/** 변경 종류. 칩 색/아이콘/라벨의 키. 순서가 곧 상세 화면의 그룹 표시 순서. */
export const CHANGE_TYPES = ['feature', 'improvement', 'fix'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** 종류별 표시 메타(라벨·이모지). 색은 index.css 의 .pn-chip-{type} 가 담당. */
export const CHANGE_TYPE_META: Record<ChangeType, { ko: string; emoji: string }> = {
  feature: { ko: '새 기능', emoji: '✨' },
  improvement: { ko: '개선', emoji: '🔧' },
  fix: { ko: '버그 수정', emoji: '🐛' },
};

export interface ChangeItem {
  type: ChangeType;
  text: string;
}

export interface ChangelogEntry {
  /** 사용자에게 보이는 버전(단일 진실원본). 'seen' 추적 키로도 쓰임. */
  version: string;
  /** 배포일 ISO 'YYYY-MM-DD'. */
  date: string;
  /** 목록에 노출되는 한 줄 요약. */
  title: string;
  changes: ChangeItem[];
}

/** 최신이 [0]. 날짜 내림차순 유지(테스트로 강제). */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.2.0',
    date: '2026-10-26',
    title: '다듬기 — 보드게임 모음 · 방향키로 두기 · 비공개 채팅',
    changes: [
      {
        type: 'feature',
        text: '🎲 화면 맨 위 왼쪽의 ‘← 보드게임 모음’을 누르면 요트다이스 · 나인 멘스 모리스 · 스플랜더가 있는 보드게임 모음으로 갑니다(앱으로 설치해 열었을 때는 이 링크가 보이지 않아요). 보드게임 모음에서도 이제 십이장기를 바로 고를 수 있어요.',
      },
      {
        type: 'improvement',
        text: '⌨️ 판에서 방향키로 칸을 옮길 수 있어요. Tab 한 번으로 판에 들어가 방향키로 옮기고 Enter·Space 로 고르거나 둡니다(전에는 열두 칸을 Tab 으로 하나씩 지나야 했어요). 화면 낭독기는 판을 4행 3열 표로 읽어요.',
      },
      {
        type: 'improvement',
        text: '🔒 온라인 채팅은 이제 같은 방에 들어온 두 사람만 읽고 쓸 수 있어요. 새로고침하거나 대국 중에 다시 들어와도 최근 대화가 남아 있습니다.',
      },
      {
        type: 'improvement',
        text: '💡 손패를 놓으라는 힌트는 이제 놓을 칸에 그 말을 반투명하게 그려 보여 줘요.',
      },
      {
        type: 'improvement',
        text: '🏁 도움말 · 설정 · 패치노트 · 피드백 창을 보는 사이에 판이 끝나면, 결과 창은 그 창을 닫은 뒤에 떠요. 쓰던 피드백이 사라지지 않습니다.',
      },
      {
        type: 'improvement',
        text: '↺ 판 중간에 N 키를 누르면 새 게임 대신 안내만 떠요 — 실수로 판을 날리지 않게요. 판 중간에 새로 시작하려면 ↺ 새 게임 버튼을 누르세요.',
      },
      {
        type: 'fix',
        text: '🔍 라이트 · 다크 테마에서 흐리게 보이던 작은 글자(패치노트 칩 · 기권 버튼 · NEW 배지 · 고른 난이도 설명 등)를 또렷하게 고쳤어요.',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-21',
    title: '첫 공개 — 난이도별 AI 와 십이장기 한 판',
    changes: [
      {
        type: 'feature',
        text: '🟩 3×4 판 위의 王·將·相·子 로 두는 십이장기를 웹에서 바로 즐길 수 있어요. 잡은 말은 내 손패가 되어 상대 진영을 뺀 빈칸에 다시 놓을 수 있습니다.',
      },
      {
        type: 'feature',
        text: '🤖 난이도를 골라 AI 와 둘 수 있어요 — 쉬움(한 수 앞) · 보통(네 수 앞) · 어려움(걸린 말·입성 위협까지 계산).',
      },
      {
        type: 'feature',
        text: '🟥 선후공을 고를 수 있어요 — 녹(내가 먼저) · 적(AI 가 먼저) · 랜덤. 보통·어려움에서는 먼저 두는 녹이 유리합니다.',
      },
      {
        type: 'feature',
        text: '💡 막히면 힌트 버튼을 눌러 보세요. 지금 국면에서 가장 좋은 수를 판 위에 표시해 줍니다(이동은 화살표, 손패 놓기는 놓을 칸).',
      },
      {
        type: 'feature',
        text: '🌐 친구와 온라인 1:1 대전을 할 수 있어요. 방을 만들어 6자리 코드를 알려 주면 같은 방에서 두고, 채팅도 됩니다. 녹·적은 시작할 때 무작위로 정해집니다.',
      },
      {
        type: 'feature',
        text: '📲 앱으로 설치할 수 있어요. 설치하면 주소창 없는 독립 창으로 뜨고, 혼자 하기는 인터넷 없이도 즐길 수 있습니다.',
      },
    ],
  },
];

/** 가장 최신 버전 문자열. NEW 배지·자동 노출의 기준값. */
export const LATEST_VERSION = CHANGELOG[0].version;

/**
 * seenVersion(마지막으로 확인한 버전) 기준 '아직 못 본' 최신 항목 개수.
 * 목록 상단부터 이 개수만큼 NEW 로 표시한다.
 * - 확인 버전을 목록에서 찾으면: 그 위(더 최신)에 있는 항목 수.
 * - 못 찾으면(최초 방문 '' 또는 알 수 없는 버전): 최신 1개만 — 전부 NEW 는 과하므로.
 */
export function unseenCount(seenVersion: string): number {
  const idx = CHANGELOG.findIndex((e) => e.version === seenVersion);
  return idx >= 0 ? idx : 1;
}

const MS_PER_DAY = 86_400_000;

function isoToUtcDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/**
 * 'YYYY-MM-DD' 를 한국어 상대 시간으로. UTC 기준 일수 차이로 계산해 TZ 에 무관하게 결정적.
 * (테스트 위해 now 주입 가능; 런타임에선 Date.now() 기본값.)
 */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const days = Math.floor(nowMs / MS_PER_DAY) - isoToUtcDay(iso);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  if (days < 30) return `${Math.floor(days / 7)}주 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}
