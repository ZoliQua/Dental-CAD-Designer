// Phase 8 Task 2 — the ONE app-wide keyboard-shortcut dispatcher.
//
// Replaces three previously scattered `window` keydown listeners:
//   • App.tsx's Cmd/Ctrl+S save handler,
//   • engine/SceneManager.ts's digit-key (1–6) standard-view handler,
// (the MarginOverlay Delete/Backspace handler stays co-located because its
// chord is only live inside that editor — it's a `scope: 'contextual'` action
// this dispatcher deliberately skips; MarginOverlay dispatches it itself.)
//
// It reads the registry (single source of truth) and, per keydown, runs the
// first GLOBAL action whose chord matches — honoring editable-target guards,
// the 19b enabled predicate, and the save chord's browser-dialog suppression.
import { useEffect } from 'react';
import {
  actionShortcuts,
  getGlobalShortcutActions,
  isActionEnabled,
} from './registry';
import { isEditableTarget, matchesShortcut } from './shortcuts';

export function useGlobalShortcuts(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const editable = isEditableTarget(event.target);
      for (const action of getGlobalShortcutActions()) {
        const binding = actionShortcuts(action).find((candidate) =>
          matchesShortcut(event, candidate),
        );
        if (binding === undefined) {
          continue;
        }
        // A bare-key chord must not hijack typing (the save chord opts in).
        if (editable && binding.allowInEditable !== true) {
          continue;
        }
        if (!isActionEnabled(action)) {
          // 19b: a disabled action is a visible no-run, never a hidden bug.
          // The save chord still swallows the event so the browser's Save
          // dialog never appears even with no case to save; every other
          // disabled chord falls through to its default (matching the old
          // SceneManager listener, which simply didn't exist with no scene).
          if (action.preventDefaultWhenDisabled === true) {
            event.preventDefault();
            return;
          }
          continue;
        }
        event.preventDefault();
        action.run();
        return;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
