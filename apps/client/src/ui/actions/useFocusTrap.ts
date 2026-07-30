// Phase 8 Task 2 — a11y focus trap shared by the command palette, the
// shortcuts-help overlay, and the onboarding tour. All three are modal: while
// open, Tab must cycle within the dialog (never escape to the page behind),
// Escape must dismiss, and closing must restore focus to wherever it was.
//
// Pure DOM (no external dep). Runs only in the browser; a no-op guard keeps it
// safe to import under the node test environment (no `document`).
import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * While `active`, traps Tab focus inside `containerRef`, routes Escape to
 * `onEscape`, moves initial focus into the dialog, and restores focus to the
 * previously-focused element when it deactivates.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') {
      return;
    }
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Initial focus: the first focusable element, else the container itself
    // (it carries tabIndex={-1} so it can hold focus for the trap).
    const initial = focusableWithin(container);
    if (initial.length > 0) {
      initial[0]!.focus();
    } else {
      container.focus();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = focusableWithin(container!);
      if (focusable.length === 0) {
        event.preventDefault();
        container!.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeEl = document.activeElement;
      if (event.shiftKey) {
        if (activeEl === first || !container!.contains(activeEl)) {
          event.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container!.contains(activeEl)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previouslyFocused !== null && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef, onEscape]);
}
