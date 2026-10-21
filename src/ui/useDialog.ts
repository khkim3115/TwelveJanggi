// 모달 공통 동작: 열릴 때 초점을 안으로 옮기고(스크롤 없이), Tab 을 모달 안에서만 돌리며,
// ESC 로 닫고, 닫히면 열기 전 초점으로 돌려준다. role="dialog" aria-modal="true" 의 약속을 실제로 지키는 부분.
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param onClose ESC 로 닫을 때 부를 함수(없으면 ESC 무시).
 * @returns 대화상자 카드 요소에 붙일 ref. initialFocus 를 주면 그 요소, 아니면 첫 포커스 가능 요소에 초점.
 */
export function useDialog<T extends HTMLElement>(
  onClose?: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
): RefObject<T | null> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const card = ref.current;
    const first = initialFocus?.current ?? card?.querySelector<HTMLElement>(FOCUSABLE) ?? card;
    first?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !card) return;
      const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // 카드 안이지만 Tab 순서 밖인 곳(초점을 처음 받은 제목 등, tabIndex=-1)에서 Shift+Tab 하면 브라우저는
      // 카드 앞쪽 바깥으로 보낸다 — 첫 칸에서 뒤로 간 것처럼 마지막 칸으로 감는다.
      const offCycle = active !== null && card.contains(active) && !items.includes(active);
      if (e.shiftKey && (active === head || offCycle)) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      } else if (!card.contains(document.activeElement)) {
        e.preventDefault();
        head.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
    // 열릴 때 한 번만 — onClose 가 바뀔 때마다 초점을 다시 옮기면 입력 중인 칸에서 초점이 튄다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ref;
}

/** 지금 열린 모달이 있는가(전역 단축키가 모달 뒤의 판을 건드리지 않게). */
export function isDialogOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null;
}
