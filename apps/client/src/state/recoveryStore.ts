// apps/client/src/state/recoveryStore.ts
//
// Phase 8 Task 4 — UI-facing state for the crash-recovery PROMPT (zustand).
// Same "state" layering as persistenceStore.ts / uiOverlayStore.ts: pure state,
// depends on nothing but plain local types (no engine/, no ui/). The engine
// coordinator (engine/recovery.ts) publishes into this store after launch-time
// detection; ui/RecoveryPrompt.tsx only reads it and calls back into
// recovery.ts's actions (it never mutates this store directly).
import { create } from 'zustand';

/**
 * `hidden` — no prompt (nothing to recover, or the user resolved it).
 * `recoverable` — a valid pre-crash snapshot was found; offer Restore/Discard.
 * `restoring` — the user chose Restore and it is in progress.
 * `corrupt` — a snapshot was found but failed integrity/shape checks; it is
 *   NOT restored, the user is informed and acknowledges before it is discarded.
 * `error` — a Restore attempt failed (e.g. server down); the snapshot is kept
 *   for retry, the failure is shown (never a silent loss).
 */
export type RecoveryPromptKind = 'hidden' | 'recoverable' | 'restoring' | 'corrupt' | 'error';

/** Non-PHI summary of the pending snapshot, shown in the prompt. Deliberately
 * only metadata (case name + when + op count) — never the case contents. */
export interface RecoverablePromptInfo {
  caseName: string;
  /** ISO-8601 — formatted for display only. */
  snapshotAt: string;
  journalOperationCount: number;
}

interface RecoveryState {
  kind: RecoveryPromptKind;
  /** Present when `kind === 'recoverable' | 'restoring' | 'error'`. */
  info: RecoverablePromptInfo | null;
  /** Detection reason when `kind === 'corrupt'`, or the failure message when
   * `kind === 'error'`. */
  detail: string | null;
  showRecoverable: (info: RecoverablePromptInfo) => void;
  showCorrupt: (reason: string) => void;
  setRestoring: () => void;
  setError: (message: string) => void;
  hide: () => void;
}

export const useRecoveryStore = create<RecoveryState>((set) => ({
  kind: 'hidden',
  info: null,
  detail: null,
  showRecoverable: (info) => set({ kind: 'recoverable', info, detail: null }),
  showCorrupt: (reason) => set({ kind: 'corrupt', info: null, detail: reason }),
  setRestoring: () => set((state) => ({ kind: 'restoring', info: state.info, detail: null })),
  setError: (message) => set((state) => ({ kind: 'error', info: state.info, detail: message })),
  hide: () => set({ kind: 'hidden', info: null, detail: null }),
}));
