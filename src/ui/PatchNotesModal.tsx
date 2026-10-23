// 패치노트 모달(마스터-디테일). HelpPanel 패턴을 따른다: 백드롭 클릭/ESC 닫기, role=dialog.
// 목록(버전별 한 줄 요약) → 항목 클릭 → 상세(종류별 그룹). 콘텐츠는 data/changelog.ts(단일 진실원본).
import { useEffect, useState } from 'react';
import {
  CHANGELOG,
  CHANGE_TYPES,
  CHANGE_TYPE_META,
  LATEST_VERSION,
  relativeTime,
  unseenCount,
} from '../data/changelog';
import type { ChangeType } from '../data/changelog';
import { useAppStore } from '../store/appStore';
import { useDialog } from './useDialog';

/** 한 항목에 등장하는 변경 종류를 CHANGE_TYPES 순서대로. */
function typesIn(changes: { type: ChangeType }[]): ChangeType[] {
  return CHANGE_TYPES.filter((t) => changes.some((c) => c.type === t));
}

function Chip({ type }: { type: ChangeType }) {
  const meta = CHANGE_TYPE_META[type];
  return (
    <span className={`pn-chip pn-chip-${type}`}>
      <span aria-hidden="true">{meta.emoji}</span> {meta.ko}
    </span>
  );
}

export function PatchNotesModal({ onClose }: { onClose: () => void }) {
  // 모달이 열린 시점의 '확인한 버전'. 닫을 때 스토어가 최신으로 올리지만, 표시 중엔 직전 값이라 NEW 판정에 사용.
  const seenVersion = useAppStore((s) => s.seenVersion);
  // null = 목록, number = 해당 인덱스 상세.
  const [detailIndex, setDetailIndex] = useState<number | null>(null);

  // ESC: 상세면 목록으로, 목록이면 닫기.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (detailIndex !== null) setDetailIndex(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailIndex, onClose]);

  // 미확인(NEW) 판정: 목록 상단부터 unseenCount 개수만큼.
  const newCount = unseenCount(seenVersion);
  const isNew = (i: number) => i < newCount;

  const detail = detailIndex !== null ? CHANGELOG[detailIndex] : null;
  // 초점 이동·가두기·복귀만 공용 훅에 맡긴다(ESC 는 위의 목록/상세 규칙을 따른다).
  const cardRef = useDialog<HTMLDivElement>();

  return (
    <div className="patchnotes" onClick={onClose}>
      <div
        ref={cardRef}
        className="patchnotes-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="패치노트"
      >
        <div className="pn-top">
          <div className="pn-top-left">
            {detail ? (
              <>
                <button className="pn-back" onClick={() => setDetailIndex(null)} aria-label="목록으로">
                  ←
                </button>
                <h3>v{detail.version}</h3>
              </>
            ) : (
              <h3>📋 패치노트</h3>
            )}
          </div>
          <button className="pn-x" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        {detail === null ? (
          <div className="pn-list">
            {CHANGELOG.map((e, i) => (
              <button key={e.version} className="pn-row" onClick={() => setDetailIndex(i)}>
                <div className="pn-row-head">
                  <span className="pn-ver">v{e.version}</span>
                  {isNew(i) && <span className="pn-new">NEW</span>}
                  <span className="pn-date">{relativeTime(e.date)}</span>
                </div>
                <div className="pn-row-title">{e.title}</div>
                <div className="pn-chips">
                  {typesIn(e.changes).map((t) => (
                    <Chip key={t} type={t} />
                  ))}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="pn-detail">
            <div className="pn-detail-head">
              {isNew(detailIndex!) && <span className="pn-new">NEW</span>}
              <span className="pn-date">{relativeTime(detail.date)}</span>
            </div>
            <p className="pn-detail-title">{detail.title}</p>
            {typesIn(detail.changes).map((t) => (
              <div key={t} className="pn-group">
                <Chip type={t} />
                <ul className="pn-items">
                  {detail.changes
                    .filter((c) => c.type === t)
                    .map((c, k) => (
                      <li key={k}>{c.text}</li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div className="pn-foot">
          <span className="pn-cur">현재 버전 v{LATEST_VERSION}</span>
          <button className="btn-ghost" onClick={onClose} autoFocus>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
