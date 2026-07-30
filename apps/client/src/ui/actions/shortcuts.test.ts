// Phase 8 Task 2 — pure unit tests for the shortcut primitives + fuzzy matcher
// (node lane; no DOM). These are the falsifiable core the registry/dispatcher
// build on: chord matching, editable-target detection, display formatting, and
// deterministic fuzzy ranking.
import { describe, expect, it } from 'vitest';
// isEditableTarget relies on `instanceof HTMLElement` (no HTMLElement in the
// node lane) — it is covered behaviorally in the browser-lane
// GlobalShortcuts.dom.test.tsx (a bare digit is ignored while an input is
// focused, but Cmd/Ctrl+S still saves).
import { fuzzyMatch } from './fuzzy';
import { formatShortcut, isMacPlatform, matchesShortcut, type KeyChordEvent } from './shortcuts';

function chord(partial: Partial<KeyChordEvent> & { key: string }): KeyChordEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe('matchesShortcut', () => {
  it('matches a bare digit only when no primary modifier is held', () => {
    const binding = { key: '1' };
    expect(matchesShortcut(chord({ key: '1' }), binding)).toBe(true);
    expect(matchesShortcut(chord({ key: '1', metaKey: true }), binding)).toBe(false);
    expect(matchesShortcut(chord({ key: '1', ctrlKey: true }), binding)).toBe(false);
    expect(matchesShortcut(chord({ key: '2' }), binding)).toBe(false);
  });

  it('matches the primary-modifier save chord on EITHER meta or ctrl (cross-platform)', () => {
    const binding = { key: 's', primaryModifier: true };
    expect(matchesShortcut(chord({ key: 's', metaKey: true }), binding)).toBe(true);
    expect(matchesShortcut(chord({ key: 'S', ctrlKey: true }), binding)).toBe(true); // case-insensitive
    expect(matchesShortcut(chord({ key: 's' }), binding)).toBe(false); // no modifier
  });

  it('never matches when Alt is held (AltGr / OS composition safety)', () => {
    expect(matchesShortcut(chord({ key: 's', metaKey: true, altKey: true }), { key: 's', primaryModifier: true })).toBe(
      false,
    );
    expect(matchesShortcut(chord({ key: '1', altKey: true }), { key: '1' })).toBe(false);
  });

  it('matches the ? chord (no primary modifier) exactly by key', () => {
    const binding = { key: '?' };
    expect(matchesShortcut(chord({ key: '?', shiftKey: true }), binding)).toBe(true);
    expect(matchesShortcut(chord({ key: '?', metaKey: true }), binding)).toBe(false);
  });

  it('enforces shift only when the binding specifies it', () => {
    expect(matchesShortcut(chord({ key: 'a', shiftKey: true }), { key: 'a' })).toBe(true);
    expect(matchesShortcut(chord({ key: 'a', shiftKey: true }), { key: 'a', shift: false })).toBe(false);
    expect(matchesShortcut(chord({ key: 'a', shiftKey: true }), { key: 'a', shift: true })).toBe(true);
  });
});

describe('formatShortcut', () => {
  it('renders mac glyphs vs. windows/linux text', () => {
    expect(formatShortcut({ key: 'k', primaryModifier: true }, true)).toBe('⌘K');
    expect(formatShortcut({ key: 'k', primaryModifier: true }, false)).toBe('Ctrl+K');
    expect(formatShortcut({ key: '1' }, true)).toBe('1');
    expect(formatShortcut({ key: '?' }, false)).toBe('?');
    expect(formatShortcut({ key: 'Delete' }, false)).toBe('Delete');
  });

  it('renders shift + a special-key glyph', () => {
    expect(formatShortcut({ key: 'k', primaryModifier: true, shift: true }, true)).toBe('⌘⇧K');
    expect(formatShortcut({ key: 'a', shift: true }, false)).toBe('Shift+A');
    expect(formatShortcut({ key: 'Escape' }, false)).toBe('Esc');
    expect(formatShortcut({ key: ' ' }, false)).toBe('Space');
    expect(formatShortcut({ key: 'ArrowUp' }, true)).toBe('↑');
  });

  it('isMacPlatform returns a boolean (false under the node lane — no navigator)', () => {
    expect(typeof isMacPlatform()).toBe('boolean');
  });
});

describe('fuzzyMatch', () => {
  it('matches an empty query with score 0 (shows everything)', () => {
    expect(fuzzyMatch('', 'Save case')).toEqual({ matched: true, score: 0 });
  });

  it('is a case-insensitive subsequence match', () => {
    expect(fuzzyMatch('sv', 'Save case').matched).toBe(true);
    expect(fuzzyMatch('SAVE', 'Save case').matched).toBe(true);
    expect(fuzzyMatch('xyz', 'Save case').matched).toBe(false);
  });

  it('ranks a prefix hit above a scattered subsequence', () => {
    const prefix = fuzzyMatch('sa', 'Save case');
    const scattered = fuzzyMatch('sa', 'Onlay stage a');
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  it('ranks a contiguous run above a broken one for the same query length', () => {
    const contiguous = fuzzyMatch('com', 'Command palette');
    const broken = fuzzyMatch('com', 'Close modal xxx');
    expect(contiguous.score).toBeGreaterThan(broken.score);
  });
});
