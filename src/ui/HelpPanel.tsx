// 규칙·조작 도움말. 처음 방문하면 한 번 자동으로 열린다(생소한 규칙의 게임이라 필요).
// 말마다 3×3 그림으로 갈 수 있는 칸을 보여 준다 — 보드 위 말의 방향 눈금과 같은 표(KIND_DIRS)에서 나온다.
//
// 용어: '진영'은 각자 가까운 맨 끝 줄(승격·입성·놓기 금지의 기준)만 뜻한다. 녹/적 편은 '선후공'으로 부른다.
import { useRef } from 'react';
import { HU, JA, JANG, KING, KIND_DIRS, SANG, type Kind } from '../core/board';
import { DEFAULT_RULES } from '../core/rules';
import { KIND_HANJA, KIND_NAME } from '../core/view';
import { activeCommunityLinks } from '../data/links';
import { Piece } from './Piece';
import { SEAT_NOTE } from './SeatPicker';
import { useDialog } from './useDialog';

const PIECE_NOTES: readonly (readonly [Kind, string])[] = [
  [KING, '8방향으로 한 칸. 잡히면 집니다.'],
  [JANG, '앞·뒤·왼쪽·오른쪽으로 한 칸.'],
  [SANG, '대각선으로 한 칸.'],
  [JA, '앞으로만 한 칸. 상대 진영에 들어가면 侯 가 됩니다.'],
  [HU, '뒤쪽 대각선만 빼고 6방향으로 한 칸.'],
];

/** 가운데 말과 갈 수 있는 이웃 칸(점)을 그린 3×3 그림. */
function MoveDiagram({ kind }: { kind: Kind }) {
  const reach = new Set(KIND_DIRS[kind].map(([dr, dc]) => `${dr},${dc}`));
  return (
    <svg className="help-diagram" viewBox="0 0 150 150" aria-hidden="true">
      {[-1, 0, 1].map((dr) =>
        [-1, 0, 1].map((dc) => (
          <rect
            key={`${dr},${dc}`}
            className={`help-cell${reach.has(`${dr},${dc}`) ? ' help-cell-on' : ''}`}
            x={(dc + 1) * 50}
            y={(dr + 1) * 50}
            width={50}
            height={50}
          />
        )),
      )}
      {KIND_DIRS[kind].map(([dr, dc]) => (
        <circle key={`d${dr},${dc}`} className="help-dot" cx={(dc + 1) * 50 + 25} cy={(dr + 1) * 50 + 25} r={7} />
      ))}
      <g transform="translate(75 75) scale(0.62)">
        <Piece kind={kind} side={1} />
      </g>
    </svg>
  );
}

export function HelpPanel({ onClose }: { onClose: () => void }) {
  // 닫기 버튼에 초점을 주되 스크롤은 하지 않는다 — autoFocus 는 긴 도움말을 맨 아래로 내려 버린다.
  const okRef = useRef<HTMLButtonElement>(null);
  const cardRef = useDialog<HTMLDivElement>(onClose, okRef);
  const links = activeCommunityLinks();

  return (
    <div className="help" onClick={onClose}>
      <div
        ref={cardRef}
        className="help-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="도움말"
      >
        <div className="help-top">
          <h3>❓ 십이장기 규칙</h3>
          <button className="pn-x" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="help-body">
          <p className="help-lead">
            가로 3칸, 세로 4칸 판에서 <b>王·將·相·子</b> 네 말로 두는 작은 장기입니다. 말은 모두 한 칸씩 움직이고,
            잡은 말은 내 편이 되어 다시 놓을 수 있어요. 각자 가까운 맨 끝 줄이 자기 <b>진영</b>입니다.
          </p>

          <h4>말의 움직임</h4>
          <p className="help-small">
            말 가장자리의 작은 삼각형이 갈 수 있는 방향입니다. 아래 그림은 내 말 기준(화면 위쪽이 앞)이고, 거꾸로 놓인 상대
            말은 방향도 거꾸로입니다.
          </p>
          <ul className="help-pieces">
            {PIECE_NOTES.map(([kind, note]) => (
              <li key={kind}>
                <MoveDiagram kind={kind} />
                <span>
                  <b>
                    {KIND_HANJA[kind]} {KIND_NAME[kind]}
                  </b>
                  <br />
                  {note}
                </span>
              </li>
            ))}
          </ul>

          <h4>잡기와 손패</h4>
          <ul className="help-list">
            <li>상대 말이 있는 칸으로 가면 그 말을 잡습니다. 잡은 말은 <b>내 손패</b>가 됩니다.</li>
            <li>
              내 차례에 손패 하나를 <b>빈칸에 놓는 것</b>도 한 수입니다. 단 <b>상대 진영(상대 쪽 맨 끝 줄)에는 놓을 수 없어요</b>.
            </li>
            <li>侯 를 잡으면 子 로 돌아와 손패에 들어갑니다. 놓은 子 는 다시 움직여 상대 진영에 들어가야 侯 가 됩니다.</li>
          </ul>

          <h4>승패</h4>
          <ul className="help-list">
            <li>상대 <b>王 을 잡으면</b> 승리.</li>
            <li>
              내 <b>王 이 상대 진영에 들어가(입성) 한 턴을 버티면</b> 승리 — 들어간 뒤 상대가 그 王 을 잡지 못하고 내 차례가
              돌아오면 이깁니다.
            </li>
            <li>장군(체크) 규칙은 없습니다. 王 을 잡히는 칸으로 옮기는 수도 둘 수 있으니 직접 살펴야 해요.</li>
            <li>둘 수 있는 수가 하나도 없으면 패배.</li>
            <li>
              같은 국면(판·손패·차례)이 {DEFAULT_RULES.repetitionLimit}번 나오면 <b>무승부</b>.
            </li>
          </ul>

          <h4>선후공</h4>
          <ul className="help-list">
            <li>{SEAT_NOTE}</li>
          </ul>

          <h4>조작</h4>
          <ul className="help-list">
            <li>내 말을 누르면 갈 수 있는 칸에 점이 찍힙니다. 잡을 수 있는 말은 붉은 테, 승격하는 칸에는 侯 표시가 붙어요.</li>
            <li>손패를 누른 뒤 빈칸을 누르면 놓입니다. 고른 것을 다시 누르면 선택이 풀려요.</li>
            <li>
              키보드: <b>Tab</b> 으로 판에 들어가 <b>방향키</b>로 칸을 옮기고, <b>Enter</b>·<b>Space</b> 로 고르거나 둡니다.
            </li>
            <li>
              <b>💡 힌트</b>(H) 지금 국면의 최선수를 보여 줍니다 — 말 이동은 화살표로, 손패 놓기는 금색 테를 두른 손패와 놓을
              칸으로. <b>↩ 되돌리기</b>(Z) 내 마지막 차례로 되감습니다. <b>↺ 새 게임</b>(N).
            </li>
          </ul>

          {links.length > 0 && (
            <>
              <h4>커뮤니티</h4>
              <ul className="help-list">
                {links.map((l) => (
                  <li key={l.id}>
                    <a href={l.url} target="_blank" rel="noreferrer noopener">
                      {l.emoji} {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="help-foot">
          <button className="btn-primary" onClick={onClose} ref={okRef}>
            알겠어요
          </button>
        </div>
      </div>
    </div>
  );
}
