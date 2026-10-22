// 방 채팅 — 떠 있는 토글 패널(로비·대국 공용). 오른쪽 아래 버튼을 누르면 열린다.
// 읽은 수는 스토어에 둔다 — 대기실에서 대국으로 넘어가면 이 컴포넌트가 새로 그려지기 때문.
import { useEffect, useRef, useState } from 'react';
import { CHAT_MAX_LEN } from '../lib/chat';
import { useMultiplayerStore } from '../store/multiplayerStore';

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ChatPanel() {
  const messages = useMultiplayerStore((s) => s.messages);
  const chatCount = useMultiplayerStore((s) => s.chatCount);
  const chatSeen = useMultiplayerStore((s) => s.chatSeen);
  const live = useMultiplayerStore((s) => s.live);
  const myUserId = useMultiplayerStore((s) => s.myUserId);
  const sendChat = useMultiplayerStore((s) => s.sendChat);
  const markChatSeen = useMultiplayerStore((s) => s.markChatSeen);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  // 패널이 열려 있는 동안 도착한 메시지는 읽음 처리.
  useEffect(() => {
    if (open) markChatSeen();
  }, [open, chatCount, markChatSeen]);

  // 새 메시지가 오면 맨 아래로(패널이 열려 있을 때만).
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'end' });
  }, [open, messages]);

  // 열면 입력칸으로, 닫으면 채팅 버튼으로 초점을 옮긴다.
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
    else if (wasOpen.current) fabRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  const unread = open ? 0 : Math.max(0, chatCount - chatSeen);

  function submit() {
    // 연결이 끊겨 못 보냈으면 입력을 그대로 둔다 — 다시 붙으면 그대로 보내면 된다.
    if (sendChat(draft)) setDraft('');
  }

  if (!open) {
    return (
      <button
        ref={fabRef}
        className="chat-fab"
        onClick={() => setOpen(true)}
        aria-label={unread > 0 ? `채팅 열기 — 새 메시지 ${unread}개` : '채팅 열기'}
      >
        <span aria-hidden="true">💬</span>
        {unread > 0 && (
          <span className="chat-badge" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      className="chat-panel"
      role="dialog"
      aria-label="방 채팅"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <div className="chat-head">
        <span className="chat-title">채팅</span>
        <button className="chat-close" onClick={() => setOpen(false)} aria-label="채팅 닫기">
          ✕
        </button>
      </div>

      <div className="chat-msgs" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-empty">아직 메시지가 없어요. 먼저 인사를 건네 보세요!</div>
        ) : (
          messages.map((m) => {
            const mine = m.userId === myUserId;
            return (
              <div key={m.id} className={`chat-msg${mine ? ' me' : ''}`}>
                <div className="chat-meta">
                  <span className="chat-name">{mine ? '나' : m.displayName}</span>
                  <span className="chat-time">{hhmm(m.ts)}</span>
                </div>
                <div className="chat-bubble">{m.text}</div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      <div className="chat-input-row">
        <input
          ref={inputRef}
          className="chat-input"
          value={draft}
          maxLength={CHAT_MAX_LEN}
          placeholder={live ? '메시지 입력…' : '연결되면 보낼 수 있어요'}
          aria-label="채팅 메시지"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="chat-send" onClick={submit} disabled={!draft.trim() || !live}>
          전송
        </button>
      </div>
    </div>
  );
}
