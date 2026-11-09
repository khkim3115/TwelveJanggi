// 트레이 창의 Esc 숨기기(설계 §5.4) — 리스너 등록 순서에 기대지 않는다.
// - 캡처 단계: 그 이벤트가 시작될 때의 isDialogOpen() 을 찍어 둔다(이벤트를 열쇠로 하는 WeakMap). window 의 캡처 리스너는 어떤 처리기보다
//   먼저 돌아서 대화상자의 처리기(useDialog 의 window 리스너 · React onKeyDown)가 언제 걸렸든 상관없다.
// - 버블 단계: 순수 함수 escAction 으로 정하고, 'hide' 면 preventDefault 한 뒤 숨긴다(✕ 와 같은 tjDesktop.hide()).
// 이유: 대화상자는 Esc 로 스스로 닫히고, React 19 는 닫기를 마이크로태스크에서 커밋하며, 실제 키 입력은 리스너 사이마다 마이크로태스크를
// 돌린다. 버블 단계에서 그때의 isDialogOpen() 을 보면 대화상자를 닫은 같은 Esc 로 창까지 숨는다. 결정을 버블에서 하므로 React 의
// stopPropagation(비모달 채팅 등 — #25)이 막은 Esc 는 여기에 닿지 않는다.
// 대상(event.target)은 보지 않는다 — 투명도 슬라이더에 포커스가 있어도 Esc 는 숨긴다.

/** escAction 이 보는 키 이벤트의 면(KeyboardEvent 가 그대로 맞는다). */
export interface EscInput {
  key: string;
  isComposing: boolean;
  repeat: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
}

/** 이 키 이벤트로 창을 숨길까. dialogOpenAtStart 는 그 이벤트가 시작될 때(캡처 단계) 모달이 열려 있었는가다. */
export function escAction(input: EscInput, dialogOpenAtStart: boolean): 'hide' | 'none' {
  // 'Esc' 는 옛 브라우저의 이름이다 — Chromium 은 'Escape' 만 낸다.
  if (input.key !== 'Escape') return 'none';
  // IME 조합을 끝내는 Esc · 누르고 있어 반복되는 Esc · 조합키와 함께 누른 Esc 는 창을 숨기는 뜻이 아니다.
  if (input.isComposing || input.repeat) return 'none';
  if (input.ctrlKey || input.altKey || input.metaKey) return 'none';
  // 안쪽 처리기가 이미 이 Esc 를 썼다.
  if (input.defaultPrevented) return 'none';
  // 대화상자를 닫는 Esc 다 — 그 사이에 닫혔어도 창은 그대로 둔다.
  if (dialogOpenAtStart) return 'none';
  return 'hide';
}

export interface EscDeps {
  /** 지금 열린 모달이 있는가(src/ui/useDialog 의 isDialogOpen). */
  isDialogOpen(): boolean;
  /** 창 숨기기(tjDesktop.hide — 브리지가 없으면 아무것도 하지 않는다). */
  hide(): void;
}

/** 캡처 · 버블 처리기 한 쌍. 기록은 이벤트마다 따로다 — 한 이벤트의 기록이 다음 이벤트로 새지 않는다. */
export function createEscHandlers(deps: EscDeps): { onCapture(e: KeyboardEvent): void; onBubble(e: KeyboardEvent): void } {
  const dialogAtStart = new WeakMap<KeyboardEvent, boolean>();
  return {
    onCapture(e) {
      dialogAtStart.set(e, deps.isDialogOpen());
    },
    onBubble(e) {
      // 캡처 단계를 거치지 않은 이벤트면(처리기를 따로 부른 경우) 지금 값으로 본다.
      if (escAction(e, dialogAtStart.get(e) ?? deps.isDialogOpen()) !== 'hide') return;
      e.preventDefault();
      deps.hide();
    },
  };
}

/** target(window)의 keydown 에 캡처 · 버블 처리기를 하나씩 건다. 돌려준 함수가 둘 다 뗀다. */
export function installEscHandlers(target: Window, deps: EscDeps): () => void {
  const { onCapture, onBubble } = createEscHandlers(deps);
  target.addEventListener('keydown', onCapture, true);
  target.addEventListener('keydown', onBubble, false);
  return () => {
    target.removeEventListener('keydown', onCapture, true);
    target.removeEventListener('keydown', onBubble, false);
  };
}
