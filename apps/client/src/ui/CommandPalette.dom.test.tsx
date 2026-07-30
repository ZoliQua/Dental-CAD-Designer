// Phase 8 Task 2 — command palette DOM tests (browser lane). Covers the
// critical paths from the brief: open, filter, run, close, and the 19b
// discipline (a disabled action never runs). Real component, real events, no
// mocks — the palette reads the real registry.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { CommandPalette } from './CommandPalette';
import { useCaseStore } from '../state/caseStore';
import { useUiOverlayStore } from '../state/uiOverlayStore';

function resetOverlay(): void {
  useUiOverlayStore.setState({
    commandPaletteOpen: false,
    shortcutsHelpOpen: false,
    tourOpen: false,
    tourStep: 0,
  });
}

beforeEach(() => {
  resetOverlay();
  useCaseStore.setState({ selectedRestorationId: null });
});

afterEach(() => {
  cleanup();
  resetOverlay();
});

describe('CommandPalette', () => {
  it('renders nothing when closed, and a modal dialog when open', () => {
    const { rerender } = render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette')).toBeNull();

    useUiOverlayStore.getState().openCommandPalette();
    rerender(<CommandPalette />);

    const dialog = screen.getByTestId('command-palette');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The listbox + at least the always-available help actions are present.
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByTestId('command-palette-option-help.shortcuts')).toBeTruthy();
  });

  it('filters the registry as the user types, and shows the empty state for no match', async () => {
    const user = userEvent.setup();
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);

    const input = screen.getByTestId('command-palette-input');
    await user.type(input, 'command');
    // The "Command palette" action survives the filter; a view action does not.
    expect(screen.getByTestId('command-palette-option-help.commandPalette')).toBeTruthy();
    expect(screen.queryByTestId('command-palette-option-view.front')).toBeNull();

    await user.clear(input);
    await user.type(input, 'zzzznotacommand');
    expect(screen.getByTestId('command-palette-empty')).toBeTruthy();
  });

  it('runs the highlighted action on Enter and closes (Cmd+K-free path)', async () => {
    const user = userEvent.setup();
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);

    const input = screen.getByTestId('command-palette-input');
    // Filter down to the "Keyboard shortcuts" action, then run it.
    await user.type(input, 'keyboard short');
    await user.keyboard('{Enter}');

    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(false);
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(true);
  });

  it('closes on Escape without running anything', async () => {
    const user = userEvent.setup();
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);
    await user.keyboard('{Escape}');
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(false);
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(false);
  });

  it('19b: a disabled action is greyed and does NOT run when clicked', async () => {
    const user = userEvent.setup();
    // No restoration selected ⇒ export action disabled.
    useCaseStore.setState({ selectedRestorationId: null });
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);

    await user.type(screen.getByTestId('command-palette-input'), 'export');
    const option = screen.getByTestId('command-palette-option-export.releaseSelected');
    expect(option.getAttribute('aria-disabled')).toBe('true');

    await user.click(option);
    // Running a disabled action is a no-op: the palette stays open (runAction
    // returned before close()), nothing was dispatched.
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(true);
  });
});
