// Phase 8 Task 2 — keyboard-shortcut primitives (pure, framework-free).
//
// The action registry (registry.ts) is the single source of truth for WHICH
// actions exist and WHAT they do; this module owns the small, pure vocabulary
// for describing and matching a key CHORD, plus display formatting. Kept
// separate (and DOM-free) so it is node-lane unit-testable without a browser:
// `matchesShortcut` takes a plain `{ key, metaKey, ctrlKey, altKey, shiftKey }`
// shape (a real `KeyboardEvent` satisfies it), never touches `window`.
//
// Cross-platform "primary" modifier: macOS uses Cmd (event.metaKey), every
// other platform uses Ctrl (event.ctrlKey) — a binding declares
// `primaryModifier: true` and this module resolves it per-event (either flag
// counts as "primary held") and per-platform for DISPLAY. This mirrors the
// existing App.tsx `isSaveShortcut` (metaKey || ctrlKey) that Task 2 replaces.

/** A single key chord bound to a registered action. */
export interface ShortcutBinding {
  /** The `KeyboardEvent.key` to match. Single ASCII letters match
   * case-insensitively (so Cmd+S fires whether or not Shift/CapsLock is on);
   * everything else (digits, '?', named keys) matches exactly. */
  readonly key: string;
  /** Requires the platform primary modifier (Cmd on macOS / Ctrl elsewhere).
   * When false/omitted, the chord matches ONLY when no primary modifier is
   * held (so a bare `1` never fires while Cmd+1 is pressed). */
  readonly primaryModifier?: boolean;
  /** When defined, `event.shiftKey` must equal it. When omitted, Shift is not
   * consulted (e.g. `?` already encodes Shift in its `key`). */
  readonly shift?: boolean;
  /** When true the chord still fires while an editable element (input,
   * textarea, select, contentEditable) has focus. Default false — a bare
   * `1` or `?` must never hijack typing. The save chord opts in, matching the
   * pre-Task-2 App.tsx behavior (Cmd/Ctrl+S saved even from a focused field).*/
  readonly allowInEditable?: boolean;
}

/** The minimal shape `matchesShortcut` reads off a keyboard event — a real
 * `KeyboardEvent` structurally satisfies this, and a test can pass a plain
 * object literal (no `new KeyboardEvent` / DOM needed). */
export interface KeyChordEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const SINGLE_LETTER = /^[a-z]$/i;

/**
 * True iff `event` is exactly the chord `binding` describes. Alt is never part
 * of any binding, so an Alt-held event never matches (prevents clobbering
 * OS/AltGr composition). Determinism: a pure function of its two arguments.
 */
export function matchesShortcut(event: KeyChordEvent, binding: ShortcutBinding): boolean {
  if (event.altKey) {
    return false;
  }
  const primaryHeld = event.metaKey || event.ctrlKey;
  if (Boolean(binding.primaryModifier) !== primaryHeld) {
    return false;
  }
  if (binding.shift !== undefined && event.shiftKey !== binding.shift) {
    return false;
  }
  if (SINGLE_LETTER.test(binding.key)) {
    return event.key.toLowerCase() === binding.key.toLowerCase();
  }
  return event.key === binding.key;
}

/**
 * Whether a keyboard event's target is a text-editable element — a bare-key
 * shortcut must skip these so it never eats the user's typing. Identical
 * semantics to the (previously duplicated) guards in engine/SceneManager.ts
 * and ui/MarginOverlay.tsx, now consolidated here as the one implementation.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** True on macOS — used only for DISPLAY (⌘ vs Ctrl). Matching never depends
 * on this (both metaKey and ctrlKey count as "primary" everywhere). Guarded
 * for non-browser (node test) environments where `navigator` is absent. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const platform = navigator.platform ?? '';
  const ua = navigator.userAgent ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /mac os x/i.test(ua);
}

/** A special-key display map (locale-invariant symbols; NOT UI copy). */
const KEY_DISPLAY: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
};

/**
 * A human-readable chord string for the help overlay / palette hint — e.g.
 * `⌘K` / `Ctrl+K`, `?`, `1`. Symbols only (no translatable prose): the
 * per-locale hardcoded-string guard treats these as unit-like glyphs, and the
 * ACTION label beside them is what carries the localized meaning.
 */
export function formatShortcut(binding: ShortcutBinding, mac = isMacPlatform()): string {
  const parts: string[] = [];
  if (binding.primaryModifier) {
    parts.push(mac ? '⌘' : 'Ctrl');
  }
  if (binding.shift) {
    parts.push(mac ? '⇧' : 'Shift');
  }
  const keyLabel = KEY_DISPLAY[binding.key] ?? (SINGLE_LETTER.test(binding.key)
    ? binding.key.toUpperCase()
    : binding.key);
  parts.push(keyLabel);
  // macOS convention concatenates modifier glyphs (⌘K); others join with '+'.
  return mac ? parts.join('') : parts.join('+');
}
