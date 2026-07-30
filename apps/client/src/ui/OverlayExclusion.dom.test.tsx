// Phase 8 Task 2 fix round (F1) — modal overlays are mutually exclusive so two
// focus traps never fight and an Escape meant for one modal cannot silently
// dismiss another. The regression this guards: on first run the tour
// auto-opens; pressing Cmd/Ctrl+K used to stack the palette ON TOP of the tour
// (two live useFocusTrap capture listeners), and a single Escape fired BOTH
// onEscape handlers — closing the palette AND finishTour()-ing the tour
// (persisting tourSeen=true), permanently killing the first-run tour.
//
// Falsifiable: revert the uiOverlayStore mutual-exclusion fix and this fails
// (two dialogs present; tourSeen flips to true on the palette's Escape).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { CommandPalette } from './CommandPalette';
import { OnboardingTour } from './OnboardingTour';
import { ShortcutsHelpOverlay } from './ShortcutsHelpOverlay';
import { useGlobalShortcuts } from './actions/useGlobalShortcuts';
import { useUiOverlayStore } from '../state/uiOverlayStore';

const TOUR_SEEN_KEY = 'dqcad.tour.seen';

// Mirrors App.tsx's composition: the one dispatcher + all three overlays.
function AppOverlays() {
  useGlobalShortcuts();
  return (
    <>
      <CommandPalette />
      <ShortcutsHelpOverlay />
      <OnboardingTour />
    </>
  );
}

function resetFirstRun(): void {
  window.localStorage.removeItem(TOUR_SEEN_KEY);
  useUiOverlayStore.setState({
    commandPaletteOpen: false,
    shortcutsHelpOpen: false,
    tourOpen: false,
    tourStep: 0,
    tourSeen: false,
  });
}

beforeEach(resetFirstRun);
afterEach(() => {
  cleanup();
  resetFirstRun();
});

describe('overlay mutual exclusion (F1)', () => {
  it('Cmd/Ctrl+K over the first-run tour swaps to exactly one modal and does NOT mark the tour seen', async () => {
    const user = userEvent.setup();
    render(<AppOverlays />);

    // First-run tour auto-opens.
    await waitFor(() => expect(screen.getByTestId('onboarding-tour')).toBeTruthy());

    // Open the palette via the real dispatcher (Cmd+K).
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('command-palette')).toBeTruthy());

    // Exactly ONE modal is mounted — the tour closed when the palette opened.
    expect(screen.queryByTestId('onboarding-tour')).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    // Escape (meant for the palette) closes the palette but must NOT persist
    // the tour as seen — the unfinished first-run tour survives for next launch.
    await user.keyboard('{Escape}');
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(false);
    expect(useUiOverlayStore.getState().tourSeen).toBe(false);
    expect(window.localStorage.getItem(TOUR_SEEN_KEY)).not.toBe('true');
  });

  it('opening the help overlay also closes the tour (single trap) without marking it seen', async () => {
    render(<AppOverlays />);
    await waitFor(() => expect(screen.getByTestId('onboarding-tour')).toBeTruthy());

    fireEvent.keyDown(window, { key: '?' });
    await waitFor(() => expect(screen.getByTestId('shortcuts-help')).toBeTruthy());

    expect(screen.queryByTestId('onboarding-tour')).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(useUiOverlayStore.getState().tourSeen).toBe(false);
  });

  it('starting the tour while the palette is open closes the palette (never two modals)', async () => {
    // Seen already ⇒ no auto-open; open the palette, then run the tour action.
    useUiOverlayStore.setState({ tourSeen: true });
    render(<AppOverlays />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('command-palette')).toBeTruthy());

    useUiOverlayStore.getState().startTour();
    await waitFor(() => expect(screen.getByTestId('onboarding-tour')).toBeTruthy());
    expect(screen.queryByTestId('command-palette')).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
