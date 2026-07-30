// Phase 8 Task 2 — shortcuts help overlay DOM tests (browser lane). Toggle,
// content (reads the same registry), a11y close paths.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { ShortcutsHelpOverlay } from './ShortcutsHelpOverlay';
import { useUiOverlayStore } from '../state/uiOverlayStore';

function resetOverlay(): void {
  useUiOverlayStore.setState({ commandPaletteOpen: false, shortcutsHelpOpen: false });
}

beforeEach(resetOverlay);
afterEach(() => {
  cleanup();
  resetOverlay();
});

describe('ShortcutsHelpOverlay', () => {
  it('is hidden until opened, then shows a modal dialog listing registry shortcuts', () => {
    const { rerender } = render(<ShortcutsHelpOverlay />);
    expect(screen.queryByTestId('shortcuts-help')).toBeNull();

    useUiOverlayStore.getState().openShortcutsHelp();
    rerender(<ShortcutsHelpOverlay />);

    const dialog = screen.getByTestId('shortcuts-help');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    // Grouped: the 6 view actions and the help chords appear as rows.
    expect(screen.getByTestId('shortcuts-help-group-view')).toBeTruthy();
    expect(screen.getByTestId('shortcuts-help-row-view.front')).toBeTruthy();
    expect(screen.getByTestId('shortcuts-help-row-help.commandPalette')).toBeTruthy();
    expect(screen.getByTestId('shortcuts-help-row-help.shortcuts')).toBeTruthy();
    // The margin-delete contextual action shows BOTH of its chords.
    const marginRow = screen.getByTestId('shortcuts-help-row-restoration.deleteMarginAnchors');
    expect(marginRow.querySelectorAll('kbd').length).toBe(2);
    // Palette-only export (no chord) is NOT listed here.
    expect(screen.queryByTestId('shortcuts-help-row-export.releaseSelected')).toBeNull();
  });

  it('closes via the close button and via Escape', async () => {
    const user = userEvent.setup();
    useUiOverlayStore.getState().openShortcutsHelp();
    render(<ShortcutsHelpOverlay />);

    await user.click(screen.getByTestId('shortcuts-help-close'));
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(false);

    useUiOverlayStore.getState().openShortcutsHelp();
    cleanup();
    render(<ShortcutsHelpOverlay />);
    await user.keyboard('{Escape}');
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(false);
  });
});
