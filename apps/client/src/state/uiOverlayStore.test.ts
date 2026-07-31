// Phase 8 Task 2 — uiOverlayStore transitions (node lane). The localStorage
// persistence of the tour-seen flag is exercised in the browser lane
// (OnboardingTour.dom.test.tsx); here we cover the pure in-memory logic:
// mutual-exclusion of the two modals, tour step clamping, and finishTour
// marking the tour seen + closed.
import { beforeEach, describe, expect, it } from 'vitest';
import { TOUR_STEP_COUNT, useUiOverlayStore } from './uiOverlayStore';

beforeEach(() => {
  useUiOverlayStore.setState({
    commandPaletteOpen: false,
    shortcutsHelpOpen: false,
    tourOpen: false,
    tourStep: 0,
    tourSeen: false,
  });
});

describe('uiOverlayStore — overlays are mutually exclusive', () => {
  it('opening the palette closes the help overlay and vice versa', () => {
    const store = useUiOverlayStore.getState();
    store.openShortcutsHelp();
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(true);
    store.openCommandPalette();
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(true);
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(false);
    store.toggleShortcutsHelp();
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(true);
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(false);
  });

  it('toggles open/closed', () => {
    const store = useUiOverlayStore.getState();
    store.toggleCommandPalette();
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(true);
    store.toggleCommandPalette();
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(false);
  });
});

describe('uiOverlayStore — tour', () => {
  it('startTour opens at step 0; steps clamp to the valid range', () => {
    const store = useUiOverlayStore.getState();
    store.setTourStep(2);
    store.startTour();
    expect(useUiOverlayStore.getState().tourOpen).toBe(true);
    expect(useUiOverlayStore.getState().tourStep).toBe(0);

    store.prevTourStep();
    expect(useUiOverlayStore.getState().tourStep).toBe(0); // clamped at floor

    for (let i = 0; i < TOUR_STEP_COUNT + 3; i += 1) {
      useUiOverlayStore.getState().nextTourStep();
    }
    expect(useUiOverlayStore.getState().tourStep).toBe(TOUR_STEP_COUNT - 1); // clamped at ceiling
  });

  it('finishTour closes the tour and marks it seen', () => {
    const store = useUiOverlayStore.getState();
    store.startTour();
    store.finishTour();
    expect(useUiOverlayStore.getState().tourOpen).toBe(false);
    expect(useUiOverlayStore.getState().tourSeen).toBe(true);
  });
});
