// 사용자 피드백(버그/건의/기타) 모달. 설정 모달과 같은 패턴(백드롭+ESC 닫기, role=dialog).
// 주 채널: 인앱 폼 → tj_submit_feedback RPC(익명 세션, 서버 검증). 보조: 'GitHub 에 직접 신고' 링크(파워유저).
// Supabase 미설정 시 폼은 비활성, GitHub 링크만 노출(graceful degradation).
import { useMemo, useState } from 'react';
import { LATEST_VERSION } from '../data/changelog';
import { activeCommunityLinks } from '../data/links';
import { isSupabaseConfigured } from '../lib/env';
import {
  buildGithubIssueUrl,
  collectFeedbackMeta,
  FEEDBACK_KIND_LABEL,
  MAX_FEEDBACK_CONTACT,
  MAX_FEEDBACK_MESSAGE,
  submitFeedback,
  validateFeedbackMessage,
  type FeedbackKind,
} from '../lib/feedback';
import { useAppStore } from '../store/appStore';
import { useGameStore } from '../store/gameStore';
import { useDialog } from './useDialog';

const KINDS: FeedbackKind[] = ['bug', 'feature', 'other'];

// 노출할 커뮤니티 링크(url 이 채워진 것만). 런타임에 바뀌지 않아 모듈 레벨에서 한 번만 계산.
const COMMUNITY_LINKS_ACTIVE = activeCommunityLinks();

/** 서버 예외 메시지를 사용자용 한국어로. 미매핑은 일반 안내. */
function errorKo(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? '';
  if (msg.includes('too many submissions')) return '짧은 시간에 너무 많이 보냈어요. 잠시 후 다시 시도해 주세요.';
  if (msg.includes('feedback quota exhausted'))
    return '오늘은 피드백이 많이 몰려 더 받지 못해요. 아래 GitHub 링크로 남겨 주시면 확인할게요.';
  if (msg.includes('not authenticated') || msg.includes('Anonymous sign-ins are disabled'))
    return '세션 준비에 실패했어요. 새로고침 후 다시 시도해 주세요.';
  if (msg.includes('설정되지 않')) return msg;
  return '전송에 실패했어요. 잠시 후 다시 시도해 주세요.';
}

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const screen = useAppStore((s) => s.screen);
  const hintUsed = useGameStore((s) => s.hintUsedThisGame);

  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [honeypot, setHoneypot] = useState(''); // 사람은 비워둠 — 채워지면 서버가 무시
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ESC 닫기·초점 이동·가두기·복귀(기존 모달과 동일).
  const cardRef = useDialog<HTMLDivElement>(onClose);

  // 힌트 사용 여부는 혼자 하기 화면에서만 뜻이 있다 — 온라인 화면에서 보내면 지난 솔로 판의 값이 붙는다.
  const meta = useMemo(
    () =>
      collectFeedbackMeta({ app_version: LATEST_VERSION, screen, hint_used: screen === 'solo' ? hintUsed : undefined }),
    [screen, hintUsed],
  );
  // 보조 GitHub 링크: 현재 입력 중인 종류/내용/메타를 반영(내용 비어도 링크는 생성).
  const githubUrl = buildGithubIssueUrl(kind, message, meta);

  const remaining = MAX_FEEDBACK_MESSAGE - message.length;
  const canSubmit = isSupabaseConfigured && message.trim().length > 0 && !busy;

  async function onSubmit() {
    const v = validateFeedbackMessage(message);
    if (v) {
      setError(v);
      return;
    }
    if (busy || !isSupabaseConfigured) return;
    setBusy(true);
    setError(null);
    try {
      await submitFeedback({ kind, message, contact, honeypot, meta });
      setDone(true);
    } catch (e) {
      setError(errorKo(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings" onClick={onClose}>
      <div
        ref={cardRef}
        className="settings-card fb-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="피드백 보내기"
      >
        <h3>💬 피드백 보내기</h3>

        {done ? (
          <>
            <p className="fb-done">✅ 피드백을 보냈어요. 소중한 의견 감사합니다!</p>
            <button className="settings-close" onClick={onClose} autoFocus>
              닫기
            </button>
          </>
        ) : (
          <>
            <p className="fb-intro">버그 제보나 기능 건의를 남겨 주세요. 계정 없이 익명으로 보내져요.</p>

            <div className="fb-row">
              <span className="fb-label">종류</span>
              <div className="seg">
                {KINDS.map((k) => (
                  <button key={k} className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>
                    {FEEDBACK_KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>

            <label className="field fb-field">
              <span>내용</span>
              <textarea
                className="fb-textarea"
                value={message}
                maxLength={MAX_FEEDBACK_MESSAGE}
                rows={5}
                placeholder={
                  kind === 'bug'
                    ? '어떤 상황에서 무엇이 잘못됐는지 적어 주세요.'
                    : '원하는 기능이나 의견을 자유롭게 적어 주세요.'
                }
                autoFocus
                disabled={!isSupabaseConfigured}
                onChange={(e) => {
                  setMessage(e.target.value);
                  if (error) setError(null);
                }}
              />
              <span className="fb-count">{remaining}</span>
            </label>

            <label className="field fb-field">
              <span>연락처 (선택 — 답변이 필요하면)</span>
              <input
                value={contact}
                maxLength={MAX_FEEDBACK_CONTACT}
                placeholder="이메일 등 (남기지 않아도 돼요)"
                disabled={!isSupabaseConfigured}
                onChange={(e) => setContact(e.target.value)}
              />
            </label>

            {/* 허니팟: 사람 눈엔 안 보이고 키보드/스크린리더에서도 제외. 봇이 채우면 서버가 조용히 무시. */}
            <input
              className="fb-hp"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
            />

            {!isSupabaseConfigured && (
              <div className="fb-note">
                지금은 인앱 제출이 비활성화돼 있어요. 아래 GitHub 링크로 등록해 주세요.
              </div>
            )}
            {error && <div className="mp-error">{error}</div>}

            <div className="go-actions">
              <button className="ghost-btn" onClick={onClose}>
                취소
              </button>
              <button
                className="mp-primary fb-submit"
                disabled={!canSubmit}
                onClick={() => void onSubmit()}
              >
                {busy ? '보내는 중…' : '보내기'}
              </button>
            </div>

            {COMMUNITY_LINKS_ACTIVE.length > 0 && (
              <div className="fb-community">
                {COMMUNITY_LINKS_ACTIVE.map((link) => (
                  <a
                    key={link.id}
                    className="fb-community-link"
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.emoji ? `${link.emoji} ` : ''}
                    {link.label} ↗
                  </a>
                ))}
              </div>
            )}

            <a className="fb-gh" href={githubUrl} target="_blank" rel="noopener noreferrer">
              GitHub 이슈로 직접 등록 ↗ <span className="fb-gh-sub">(GitHub 계정 필요)</span>
            </a>
          </>
        )}
      </div>
    </div>
  );
}
