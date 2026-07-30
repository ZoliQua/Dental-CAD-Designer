// Phase 8 Task 2 — UI overlay state (zustand): command palette, shortcuts-help
// overlay, and the onboarding tour. Same "state" layering as appStore.ts /
// persistenceStore.ts: pure state, depends on nothing but plain local types
// (no engine/, no ui/, no kernel). ui/ components subscribe; ui/ dispatchers
// (the global-shortcut hook, the registered actions) call these setters.
//
// Only ONE piece here is persisted: the tour's seen/not-seen flag, in
// localStorage — a boolean, NO PHI (the brief's constraint). Everything else
// (which overlay is open, the tour step) is ephemeral session UI state.
import { create } from 'zustand';

/** Ordered onboarding steps — import → design → QC → export (the brief's
 * happy path). The count is the single source of truth for the tour's
 * progress ("Step n of N") and its next/last-step logic. */
export const TOUR_STEP_IDS = ['import', 'design', 'qc', 'export'] as const;
export type TourStepId = (typeof TOUR_STEP_IDS)[number];
export const TOUR_STEP_COUNT = TOUR_STEP_IDS.length;

const TOUR_SEEN_STORAGE_KEY = 'dqcad.tour.seen';

// Same guard rationale as appStore.ts: gate on `window` so we never touch
// Node 22+'s throwing `localStorage` stub under the node test environment.
function hasWorkingLocalStorage(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const storage = window.localStorage;
    return typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
  } catch {
    return false;
  }
}

function readTourSeen(): boolean {
  if (!hasWorkingLocalStorage()) {
    return false;
  }
  return window.localStorage.getItem(TOUR_SEEN_STORAGE_KEY) === 'true';
}

function persistTourSeen(seen: boolean): void {
  if (hasWorkingLocalStorage()) {
    window.localStorage.setItem(TOUR_SEEN_STORAGE_KEY, seen ? 'true' : 'false');
  }
}

interface UiOverlayState {
  commandPaletteOpen: boolean;
  shortcutsHelpOpen: boolean;
  /** The tour panel is visible. Independent of `tourSeen`: re-triggering the
   * tour opens it without clearing the seen flag. */
  tourOpen: boolean;
  /** 0-based index into TOUR_STEP_IDS. */
  tourStep: number;
  /** Persisted: has the user finished/dismissed the first-run tour at least
   * once. `false` (fresh install / cleared storage) ⇒ first-run auto-open. */
  tourSeen: boolean;

  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;

  openShortcutsHelp: () => void;
  closeShortcutsHelp: () => void;
  toggleShortcutsHelp: () => void;

  /** Open the tour at step 0 (both first-run and re-trigger). */
  startTour: () => void;
  setTourStep: (step: number) => void;
  nextTourStep: () => void;
  prevTourStep: () => void;
  /** Close the tour AND mark it seen (persisted) — used by Skip/Done and the
   * Escape/backdrop dismiss. First-run never re-appears after this. */
  finishTour: () => void;
}

function clampStep(step: number): number {
  if (step < 0) {
    return 0;
  }
  if (step > TOUR_STEP_COUNT - 1) {
    return TOUR_STEP_COUNT - 1;
  }
  return step;
}

export const useUiOverlayStore = create<UiOverlayState>((set) => ({
  commandPaletteOpen: false,
  shortcutsHelpOpen: false,
  tourOpen: false,
  tourStep: 0,
  tourSeen: readTourSeen(),

  // ALL THREE modals (palette, help, tour) are mutually exclusive: opening any
  // one closes the other two so exactly one modal focus trap is ever active
  // (a11y — two live useFocusTrap listeners would fight over Tab, and a single
  // Escape would fire BOTH onEscape handlers). Crucially, opening the palette
  // or help CLOSES the tour WITHOUT marking it seen (`tourSeen` untouched): an
  // Escape the user meant for the palette must never silently, permanently
  // dismiss an unfinished first-run tour — only finishTour() persists seen.
  openCommandPalette: () =>
    set({ commandPaletteOpen: true, shortcutsHelpOpen: false, tourOpen: false }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  toggleCommandPalette: () =>
    set((state) =>
      state.commandPaletteOpen
        ? { commandPaletteOpen: false }
        : { commandPaletteOpen: true, shortcutsHelpOpen: false, tourOpen: false },
    ),

  openShortcutsHelp: () =>
    set({ shortcutsHelpOpen: true, commandPaletteOpen: false, tourOpen: false }),
  closeShortcutsHelp: () => set({ shortcutsHelpOpen: false }),
  toggleShortcutsHelp: () =>
    set((state) =>
      state.shortcutsHelpOpen
        ? { shortcutsHelpOpen: false }
        : { shortcutsHelpOpen: true, commandPaletteOpen: false, tourOpen: false },
    ),

  startTour: () =>
    set({ tourOpen: true, tourStep: 0, commandPaletteOpen: false, shortcutsHelpOpen: false }),
  setTourStep: (step) => set({ tourStep: clampStep(step) }),
  nextTourStep: () => set((state) => ({ tourStep: clampStep(state.tourStep + 1) })),
  prevTourStep: () => set((state) => ({ tourStep: clampStep(state.tourStep - 1) })),
  finishTour: () => {
    persistTourSeen(true);
    set({ tourOpen: false, tourSeen: true });
  },
}));
