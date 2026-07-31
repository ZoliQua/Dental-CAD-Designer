// Phase 8 Task 2 — onboarding tour DOM tests (browser lane). First-run
// auto-open, step navigation, dismiss + persistence, and re-trigger via the
// registered action (proving it never re-nags once seen).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { OnboardingTour } from './OnboardingTour';
import { getActionById } from './actions/registry';
import { useUiOverlayStore } from '../state/uiOverlayStore';

const TOUR_SEEN_KEY = 'dqcad.tour.seen';

function resetTour(seen: boolean): void {
  window.localStorage.removeItem(TOUR_SEEN_KEY);
  useUiOverlayStore.setState({ tourOpen: false, tourStep: 0, tourSeen: seen });
}

beforeEach(() => resetTour(false));
afterEach(() => {
  cleanup();
  resetTour(false);
});

describe('OnboardingTour', () => {
  it('auto-opens on first run and shows step 1 of 4 on the import step', async () => {
    render(<OnboardingTour />);
    await waitFor(() => expect(screen.getByTestId('onboarding-tour')).toBeTruthy());
    const dialog = screen.getByTestId('onboarding-tour');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByTestId('onboarding-tour-progress').textContent).toContain('1');
    // Import step is first; its title comes from i18n (tour.steps.import.title).
    expect(screen.getByTestId('onboarding-tour-title').textContent).toBeTruthy();
    // Back is disabled on the first step; skip is always available.
    expect((screen.getByTestId('onboarding-tour-back') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('onboarding-tour-skip')).toBeTruthy();
  });

  it('walks forward and back through the steps to the Done control', async () => {
    const user = userEvent.setup();
    render(<OnboardingTour />);
    await waitFor(() => expect(screen.getByTestId('onboarding-tour')).toBeTruthy());

    await user.click(screen.getByTestId('onboarding-tour-next')); // -> step 2
    expect(screen.getByTestId('onboarding-tour-progress').textContent).toContain('2');
    await user.click(screen.getByTestId('onboarding-tour-back')); // -> step 1
    expect(screen.getByTestId('onboarding-tour-progress').textContent).toContain('1');

    // Advance to the last step: Next appears as Done there.
    await user.click(screen.getByTestId('onboarding-tour-next'));
    await user.click(screen.getByTestId('onboarding-tour-next'));
    await user.click(screen.getByTestId('onboarding-tour-next'));
    expect(screen.getByTestId('onboarding-tour-progress').textContent).toContain('4');
    expect(screen.getByTestId('onboarding-tour-done')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-tour-next')).toBeNull();
  });

  it('Skip dismisses, persists the seen flag, and does NOT auto-open again', async () => {
    const user = userEvent.setup();
    render(<OnboardingTour />);
    await waitFor(() => expect(screen.getByTestId('onboarding-tour')).toBeTruthy());

    await user.click(screen.getByTestId('onboarding-tour-skip'));
    expect(useUiOverlayStore.getState().tourOpen).toBe(false);
    expect(useUiOverlayStore.getState().tourSeen).toBe(true);
    expect(window.localStorage.getItem(TOUR_SEEN_KEY)).toBe('true');

    // Re-mount with the seen flag set: no auto-open.
    cleanup();
    render(<OnboardingTour />);
    // Give the mount effect a chance to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId('onboarding-tour')).toBeNull();
  });

  it('traps Tab focus within the dialog (a11y focus trap wraps both directions)', async () => {
    render(<OnboardingTour />);
    await waitFor(() => expect(screen.getByTestId('onboarding-tour')).toBeTruthy());
    const dialog = screen.getByTestId('onboarding-tour');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled])'),
    );
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    // Tab from the last focusable wraps to the first.
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    // Shift+Tab from the first wraps to the last.
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('is re-triggerable via the tour.show action even after being seen', async () => {
    useUiOverlayStore.setState({ tourSeen: true, tourOpen: false });
    render(<OnboardingTour />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('onboarding-tour')).toBeNull();

    // The registered "Show onboarding tour" action re-opens it at step 0.
    getActionById('tour.show')!.run();
    await waitFor(() => expect(screen.getByTestId('onboarding-tour')).toBeTruthy());
    expect(screen.getByTestId('onboarding-tour-progress').textContent).toContain('1');
  });
});
