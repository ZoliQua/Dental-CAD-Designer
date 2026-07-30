// Phase 8 Task 2 — the action registry: the SINGLE SOURCE OF TRUTH for every
// keyboard-triggerable / palette-runnable command in the app.
//
// Three consumers READ this one list and nothing else:
//   • ui/actions/useGlobalShortcuts.ts — the app-wide keydown dispatcher
//     (matches each GLOBAL action's `shortcut` and runs it).
//   • ui/CommandPalette.tsx — renders the SAME actions as a fuzzy-searchable
//     list (no second definition anywhere).
//   • ui/ShortcutsHelpOverlay.tsx — lists the actions that carry a shortcut.
// A registered action never re-implements engine/geometry logic: its `run()`
// only CALLS an existing engine/store function (setStandardView, saveActiveCase,
// handoffController.exportAndRelease, marginEditor.delete*, the overlay store).
// This keeps the layer rule intact (ui → engine/state; zero kernel import).
//
// 19b discipline: an action that cannot currently run exposes `enabled() ===
// false`. The palette shows it disabled and refuses to run it; the global
// dispatcher skips its run() (see `preventDefaultWhenDisabled` for the one
// exception — the save chord still suppresses the browser Save dialog).
import { getActiveSceneManager } from '../../engine/viewerController';
import { saveActiveCase } from '../../engine/persistence';
import { handoffController } from '../../engine/handoff';
import { marginEditor } from '../../engine/marginEditor';
import { STANDARD_VIEW_KEY_ORDER } from '../../engine/standardViews';
import { useCaseStore } from '../../state/caseStore';
import { useMarginStore } from '../../state/marginStore';
import { usePersistenceStore } from '../../state/persistenceStore';
import { useUiOverlayStore } from '../../state/uiOverlayStore';
import type { ShortcutBinding } from './shortcuts';

/** Grouping for the palette / help overlay (each maps to an i18n label under
 * `actions.group.*`). */
export type ActionGroup = 'view' | 'case' | 'restoration' | 'help';

export const ACTION_GROUP_ORDER: readonly ActionGroup[] = ['view', 'case', 'restoration', 'help'];

export interface AppAction {
  /** Stable, unique id (also used as React key + test handle). */
  readonly id: string;
  /** i18n key for the human label (never a raw string — the hardcoded-string
   * guard + locale parity both cover this via the JSON resources). */
  readonly labelKey: string;
  readonly group: ActionGroup;
  /** 'global' actions are dispatched app-wide by useGlobalShortcuts; a
   * 'contextual' action is dispatched by its host component (its shortcut is
   * only live in that context) but still appears in the palette/help. */
  readonly scope: 'global' | 'contextual';
  /** Primary key chord (if any). Palette-only actions omit it. */
  readonly shortcut?: ShortcutBinding;
  /** Extra chords that also fire this action (e.g. Backspace alongside
   * Delete). Shown in help alongside the primary. */
  readonly aliasShortcuts?: readonly ShortcutBinding[];
  /** 19b: false ⇒ disabled (palette greys it out, dispatcher skips run()).
   * Omitted ⇒ always enabled. Reads live store/engine state each call. */
  readonly enabled?: () => boolean;
  /** For a matched GLOBAL shortcut whose action is disabled: preventDefault
   * anyway (suppress the browser default) but do not run. Only the save chord
   * sets this — Cmd/Ctrl+S must kill the browser Save dialog even with no
   * case to save, matching pre-Task-2 App.tsx behavior. */
  readonly preventDefaultWhenDisabled?: boolean;
  readonly run: () => void;
}

// --- view navigation (consolidates the SceneManager digit-key handler) ------
// The 6 standard views, bound to digits 1–6 in STANDARD_VIEW_KEY_ORDER — the
// same ordering the ViewerToolbar already shows as its key hints, kept as the
// one source. Disabled (and the digit chord left un-prevented) when no scene
// is mounted, exactly as the old SceneManager listener (which only existed
// while a SceneManager was alive) behaved.
const viewActions: AppAction[] = STANDARD_VIEW_KEY_ORDER.map((view, index) => ({
  id: `view.${view}`,
  labelKey: `viewer.view.${view}`,
  group: 'view' as const,
  scope: 'global' as const,
  shortcut: { key: String(index + 1) },
  enabled: () => getActiveSceneManager() !== null,
  run: () => {
    getActiveSceneManager()?.setStandardView(view);
  },
}));

// --- case save (consolidates the App.tsx Cmd/Ctrl+S handler) ----------------
const saveAction: AppAction = {
  id: 'case.save',
  labelKey: 'actions.case.save',
  group: 'case',
  scope: 'global',
  // allowInEditable mirrors the old handler: Cmd/Ctrl+S saved even from a
  // focused input; preventDefaultWhenDisabled kills the browser Save dialog.
  shortcut: { key: 's', primaryModifier: true, allowInEditable: true },
  preventDefaultWhenDisabled: true,
  // Same gate as the Header save button (disabled when there is nothing to
  // save or a save is already in flight).
  enabled: () => {
    const status = usePersistenceStore.getState().status;
    return status !== 'idle' && status !== 'saving';
  },
  run: () => {
    void saveActiveCase();
  },
};

// --- export the selected restoration (palette-only; no keyboard chord) -------
// Context-gated (19b): disabled with no restoration selected. Uses the default
// STL format (the ExportPanel's own default); firing a full server release
// from a chord would be surprising, so this is palette-only — an explicit,
// deliberate invocation.
const exportAction: AppAction = {
  id: 'export.releaseSelected',
  labelKey: 'actions.export.releaseSelected',
  group: 'restoration',
  scope: 'global',
  enabled: () => useCaseStore.getState().selectedRestorationId !== null,
  run: () => {
    const restorationId = useCaseStore.getState().selectedRestorationId;
    if (restorationId !== null) {
      void handoffController.exportAndRelease(restorationId, 'stl');
    }
  },
};

// --- margin-anchor delete (consolidates the MarginOverlay Delete handler) ----
// CONTEXTUAL: only meaningful while the margin editor is active with a
// selection. The registry owns the binding + run logic (single source);
// MarginOverlay stays the DISPATCH host (its window listener calls this
// action) because the chord is only live inside that editor — the global
// dispatcher deliberately skips contextual actions.
const marginDeleteAction: AppAction = {
  id: 'restoration.deleteMarginAnchors',
  labelKey: 'actions.restoration.deleteMarginAnchors',
  group: 'restoration',
  scope: 'contextual',
  shortcut: { key: 'Delete' },
  aliasShortcuts: [{ key: 'Backspace' }],
  enabled: () => {
    const margin = useMarginStore.getState();
    return (
      margin.phase === 'active' &&
      (margin.selectedAnchorIndices.size > 0 || margin.selectedAnchorIndex !== null)
    );
  },
  run: () => {
    const margin = useMarginStore.getState();
    if (margin.selectedAnchorIndices.size > 0) {
      void marginEditor.deleteSelectedAnchors();
    } else if (margin.selectedAnchorIndex !== null) {
      void marginEditor.deleteSelectedAnchor();
    }
  },
};

// --- overlays: command palette, shortcuts help, onboarding tour --------------
const commandPaletteAction: AppAction = {
  id: 'help.commandPalette',
  labelKey: 'actions.help.commandPalette',
  group: 'help',
  scope: 'global',
  // Chorded modifier ⇒ safe to fire even from a focused field (and needed so
  // the palette's own search input can re-toggle it closed).
  shortcut: { key: 'k', primaryModifier: true, allowInEditable: true },
  run: () => {
    useUiOverlayStore.getState().toggleCommandPalette();
  },
};

const shortcutsHelpAction: AppAction = {
  id: 'help.shortcuts',
  labelKey: 'actions.help.shortcuts',
  group: 'help',
  scope: 'global',
  shortcut: { key: '?' },
  run: () => {
    useUiOverlayStore.getState().toggleShortcutsHelp();
  },
};

const showTourAction: AppAction = {
  id: 'tour.show',
  labelKey: 'actions.tour.show',
  group: 'help',
  scope: 'global',
  run: () => {
    useUiOverlayStore.getState().startTour();
  },
};

/**
 * The complete registry, in display order. Frozen so no consumer can mutate
 * the shared source of truth. Every other export derives from this.
 */
export const APP_ACTIONS: readonly AppAction[] = Object.freeze([
  ...viewActions,
  saveAction,
  exportAction,
  marginDeleteAction,
  commandPaletteAction,
  shortcutsHelpAction,
  showTourAction,
]);

/** All actions (palette shows every one; disabled entries are greyed). */
export function getAppActions(): readonly AppAction[] {
  return APP_ACTIONS;
}

/** Actions the app-wide keydown dispatcher owns (have a shortcut, global). */
export function getGlobalShortcutActions(): readonly AppAction[] {
  return APP_ACTIONS.filter((action) => action.scope === 'global' && action.shortcut !== undefined);
}

/** Every chord an action responds to (primary + aliases). */
export function actionShortcuts(action: AppAction): readonly ShortcutBinding[] {
  return action.shortcut === undefined
    ? []
    : [action.shortcut, ...(action.aliasShortcuts ?? [])];
}

export function getActionById(id: string): AppAction | undefined {
  return APP_ACTIONS.find((action) => action.id === id);
}

/** True when the action may run right now (no predicate ⇒ always). */
export function isActionEnabled(action: AppAction): boolean {
  return action.enabled === undefined ? true : action.enabled();
}
