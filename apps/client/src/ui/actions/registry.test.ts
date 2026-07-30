// Phase 8 Task 2 — the action registry as the SINGLE SOURCE OF TRUTH (node
// lane). Proves: the list is frozen and consumer-shared; ids are unique;
// global shortcut chords never clash; the 19b enabled() predicates reflect
// live store state; and every labelKey resolves in the i18n resources.
import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import en from '../../i18n/en.json';
import { registerActiveSceneManager } from '../../engine/viewerController';
import type { SceneManager } from '../../engine/SceneManager';
import type { StandardView } from '../../engine/standardViews';
import { useCaseStore } from '../../state/caseStore';
import { useMarginStore } from '../../state/marginStore';
import { usePersistenceStore } from '../../state/persistenceStore';
import { useUiOverlayStore } from '../../state/uiOverlayStore';
import {
  ACTION_GROUP_ORDER,
  APP_ACTIONS,
  actionShortcuts,
  getActionById,
  getAppActions,
  getGlobalShortcutActions,
  isActionEnabled,
} from './registry';
import type { ShortcutBinding } from './shortcuts';

function resolveKey(root: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, part) => {
    if (node !== null && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, root);
}

function chordSignature(binding: ShortcutBinding): string {
  return `${binding.primaryModifier ? 'P' : ''}${binding.shift ? 'S' : ''}:${binding.key.toLowerCase()}`;
}

describe('registry — single source of truth', () => {
  it('is frozen and getAppActions returns the very same shared list', () => {
    expect(Object.isFrozen(APP_ACTIONS)).toBe(true);
    expect(getAppActions()).toBe(APP_ACTIONS);
  });

  it('has unique action ids', () => {
    const ids = APP_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every action carries a known group and an i18n-resolvable label', () => {
    for (const action of APP_ACTIONS) {
      expect(ACTION_GROUP_ORDER, action.id).toContain(action.group);
      expect(typeof resolveKey(en, action.labelKey), `${action.id} -> ${action.labelKey}`).toBe('string');
    }
    for (const group of ACTION_GROUP_ORDER) {
      expect(typeof resolveKey(en, `actions.group.${group}`)).toBe('string');
    }
  });

  it('consolidates the expected actions (save, 6 views, export, margin delete, overlays)', () => {
    expect(getActionById('case.save')).toBeDefined();
    expect(getActionById('export.releaseSelected')).toBeDefined();
    expect(getActionById('restoration.deleteMarginAnchors')).toBeDefined();
    expect(getActionById('help.commandPalette')).toBeDefined();
    expect(getActionById('help.shortcuts')).toBeDefined();
    expect(getActionById('tour.show')).toBeDefined();
    const views = APP_ACTIONS.filter((a) => a.id.startsWith('view.'));
    expect(views).toHaveLength(6);
    // Digits 1..6, in order.
    expect(views.map((v) => v.shortcut?.key)).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});

describe('registry — global shortcut dispatch set', () => {
  it('global shortcut actions exclude the contextual margin-delete and the palette-only export', () => {
    const globalIds = getGlobalShortcutActions().map((a) => a.id);
    expect(globalIds).not.toContain('restoration.deleteMarginAnchors'); // contextual
    expect(globalIds).not.toContain('export.releaseSelected'); // no chord
    expect(globalIds).toContain('case.save');
    expect(globalIds).toContain('view.front');
    expect(globalIds).toContain('help.commandPalette');
  });

  it('no two GLOBAL chords collide (a keydown is unambiguous)', () => {
    const signatures = getGlobalShortcutActions().flatMap((a) =>
      actionShortcuts(a).map(chordSignature),
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('margin-delete is contextual and responds to Delete AND Backspace', () => {
    const action = getActionById('restoration.deleteMarginAnchors')!;
    expect(action.scope).toBe('contextual');
    expect(actionShortcuts(action).map((b) => b.key)).toEqual(['Delete', 'Backspace']);
  });
});

describe('registry — 19b enabled() predicates track live store state', () => {
  beforeEach(() => {
    usePersistenceStore.setState({ status: 'idle' });
    useCaseStore.setState({ selectedRestorationId: null });
    useMarginStore.setState({ phase: 'idle', selectedAnchorIndex: null, selectedAnchorIndices: new Set() });
  });

  it('save is disabled when idle/saving, enabled once there is a dirty case', () => {
    const save = getActionById('case.save')!;
    usePersistenceStore.setState({ status: 'idle' });
    expect(isActionEnabled(save)).toBe(false);
    usePersistenceStore.setState({ status: 'saving' });
    expect(isActionEnabled(save)).toBe(false);
    usePersistenceStore.setState({ status: 'unsaved' });
    expect(isActionEnabled(save)).toBe(true);
    // The save chord still suppresses the browser Save dialog even when
    // disabled (preventDefaultWhenDisabled).
    expect(save.preventDefaultWhenDisabled).toBe(true);
  });

  it('export is disabled without a selected restoration', () => {
    const exp = getActionById('export.releaseSelected')!;
    expect(isActionEnabled(exp)).toBe(false);
    useCaseStore.setState({ selectedRestorationId: 'restoration-1' });
    expect(isActionEnabled(exp)).toBe(true);
  });

  it('view actions are disabled when no SceneManager is mounted (node lane)', () => {
    // engine/viewerController has no active SceneManager under the node test
    // environment, so every view action reports disabled — a faithful 19b
    // signal (a digit chord is left un-prevented, matching the old behavior).
    expect(isActionEnabled(getActionById('view.front')!)).toBe(false);
  });

  afterEach(() => registerActiveSceneManager(null));

  it('a view action becomes enabled and its run() calls setStandardView once a scene is mounted', () => {
    const applied: StandardView[] = [];
    registerActiveSceneManager({
      setStandardView: (view: StandardView) => applied.push(view),
    } as unknown as SceneManager);
    const front = getActionById('view.front')!;
    expect(isActionEnabled(front)).toBe(true);
    front.run();
    expect(applied).toEqual(['front']);
  });

  it('the overlay actions run() toggle the ui overlay store', () => {
    useUiOverlayStore.setState({ commandPaletteOpen: false, shortcutsHelpOpen: false, tourOpen: false });
    getActionById('help.commandPalette')!.run();
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(true);
    getActionById('help.shortcuts')!.run();
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(true);
    getActionById('tour.show')!.run();
    expect(useUiOverlayStore.getState().tourOpen).toBe(true);
  });

  it('margin delete is enabled only during the active phase with a selection', () => {
    const del = getActionById('restoration.deleteMarginAnchors')!;
    expect(isActionEnabled(del)).toBe(false);
    useMarginStore.setState({ phase: 'active', selectedAnchorIndex: 2 });
    expect(isActionEnabled(del)).toBe(true);
    useMarginStore.setState({ selectedAnchorIndex: null, selectedAnchorIndices: new Set([1, 3]) });
    expect(isActionEnabled(del)).toBe(true);
    useMarginStore.setState({ phase: 'idle' });
    expect(isActionEnabled(del)).toBe(false);
  });
});
