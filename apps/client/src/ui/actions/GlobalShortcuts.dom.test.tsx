// Phase 8 Task 2 — the app-wide shortcut dispatcher (browser lane). Proves a
// keyboard chord fires its registered action end-to-end, that the consolidated
// digit-key view switching reaches the SceneManager (via viewerController),
// and that bare-key chords honor the editable-target guard (isEditableTarget).
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../i18n';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import { registerActiveSceneManager } from '../../engine/viewerController';
import type { SceneManager } from '../../engine/SceneManager';
import type { StandardView } from '../../engine/standardViews';
import { usePersistenceStore } from '../../state/persistenceStore';
import { useUiOverlayStore } from '../../state/uiOverlayStore';

function Harness() {
  useGlobalShortcuts();
  return <input data-testid="typing-field" />;
}

function resetOverlay(): void {
  useUiOverlayStore.setState({ commandPaletteOpen: false, shortcutsHelpOpen: false });
}

beforeEach(resetOverlay);
afterEach(() => {
  cleanup();
  registerActiveSceneManager(null);
  resetOverlay();
});

describe('useGlobalShortcuts — dispatcher', () => {
  it('Cmd/Ctrl+K toggles the command palette (a chord fires its action)', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(true);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(false);
  });

  it('? toggles the shortcuts help overlay', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: '?' });
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(true);
  });

  it('a bare ? is ignored while an editable field is focused (isEditableTarget)', () => {
    const { getByTestId } = render(<Harness />);
    const input = getByTestId('typing-field') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: '?' });
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(false);
  });

  it('digit keys 1–6 drive the standard views via the registered view actions', () => {
    const applied: StandardView[] = [];
    const stub = {
      setStandardView: (view: StandardView) => {
        applied.push(view);
      },
    } as unknown as SceneManager;
    registerActiveSceneManager(stub);

    render(<Harness />);
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: '2' });
    fireEvent.keyDown(window, { key: '6' });
    // STANDARD_VIEW_KEY_ORDER: 1=front, 2=buccal, 6=occlusal.
    expect(applied).toEqual(['front', 'buccal', 'occlusal']);
  });

  it('a disabled save chord still suppresses the browser default (preventDefaultWhenDisabled)', () => {
    usePersistenceStore.setState({ status: 'idle' }); // nothing to save ⇒ disabled
    render(<Harness />);
    // fireEvent returns false when the event's default was prevented.
    const notPrevented = fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(notPrevented).toBe(false);
  });

  it('a disabled view chord (no scene mounted) is left un-prevented, falling through', () => {
    registerActiveSceneManager(null); // view actions disabled
    render(<Harness />);
    const notPrevented = fireEvent.keyDown(window, { key: '1' });
    expect(notPrevented).toBe(true);
  });

  it('digit keys do nothing while an editable field is focused', () => {
    const applied: StandardView[] = [];
    registerActiveSceneManager({
      setStandardView: (view: StandardView) => applied.push(view),
    } as unknown as SceneManager);

    const { getByTestId } = render(<Harness />);
    const input = getByTestId('typing-field') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: '1' });
    expect(applied).toEqual([]);
  });
});
