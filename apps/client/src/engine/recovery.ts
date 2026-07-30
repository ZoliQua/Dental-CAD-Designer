// apps/client/src/engine/recovery.ts
//
// Phase 8 Task 4 — the crash-recovery COORDINATOR: the thin seam that ties the
// storage-agnostic detection logic (engine/crashRecovery.ts) to the user-facing
// prompt (state/recoveryStore.ts → ui/RecoveryPrompt.tsx) and to the
// server-aware restore (engine/persistence.ts). It owns the pending detection
// result between launch and the user's explicit Restore/Discard choice.
//
// Import direction (acyclic): recovery.ts → { crashRecovery, persistence,
// state }. crashRecovery.ts imports NEITHER persistence nor recovery, and
// persistence.ts imports only crashRecovery's leaf `clearLocalSnapshot`.
import type { CaseDocument } from '@dqcad/shared-types';
import { useRecoveryStore } from '../state/recoveryStore';
import {
  clearLocalSnapshot,
  detectRecovery,
  startLocalSnapshotTracking,
  type RecoveryMarker,
} from './crashRecovery';
import { restoreFromLocalSnapshot } from './persistence';

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The detection result held between launch and the user's decision. Populated
// only for a `recoverable` outcome (a `corrupt` one needs no document).
let pendingDocument: CaseDocument | null = null;
let pendingMarker: RecoveryMarker | null = null;

/**
 * Runs ONCE at launch (called from ui/App.tsx): starts the debounced local
 * crash-safe autosave, then detects whether the previous session left
 * recoverable un-synced work and, if so, publishes the prompt state. Never
 * throws (a boot-time step must not crash the app); a detection failure just
 * leaves the app in its normal no-prompt state.
 */
export async function initRecovery(): Promise<void> {
  startLocalSnapshotTracking();
  let detection;
  try {
    detection = await detectRecovery();
  } catch {
    return;
  }
  if (detection.kind === 'recoverable') {
    pendingDocument = detection.document;
    pendingMarker = detection.marker;
    useRecoveryStore.getState().showRecoverable({
      caseName: detection.marker.caseName,
      snapshotAt: detection.marker.snapshotAt,
      journalOperationCount: detection.marker.journalOperationCount,
    });
  } else if (detection.kind === 'corrupt') {
    // Surface it — do NOT silently discard a corrupt snapshot (the user
    // acknowledges first, via `dismissRecovery`, which then clears it).
    useRecoveryStore.getState().showCorrupt(detection.reason);
  }
}

/**
 * The user chose RESTORE. Installs the pre-crash document (state-identical) via
 * persistence.ts. On success the prompt closes; on failure it stays open in the
 * `error` state and the snapshot is PRESERVED for retry (never discarded on a
 * failed restore — e.g. the server was down).
 */
export async function acceptRecovery(): Promise<void> {
  if (pendingDocument === null || pendingMarker === null) {
    useRecoveryStore.getState().hide();
    return;
  }
  useRecoveryStore.getState().setRestoring();
  try {
    await restoreFromLocalSnapshot(pendingDocument, pendingMarker.caseId, pendingMarker.caseName);
    pendingDocument = null;
    pendingMarker = null;
    useRecoveryStore.getState().hide();
  } catch (error) {
    useRecoveryStore.getState().setError(errorMessageOf(error));
  }
}

/**
 * The user chose DISCARD (for a recoverable snapshot) or acknowledged a corrupt
 * one. Clears the local snapshot and keeps the server version untouched — an
 * explicit choice, never a silent overwrite of either side.
 */
export async function dismissRecovery(): Promise<void> {
  pendingDocument = null;
  pendingMarker = null;
  await clearLocalSnapshot();
  useRecoveryStore.getState().hide();
}

/** TEST-ONLY: clears the pending detection held by this coordinator. */
export function resetRecoveryCoordinatorForTests(): void {
  pendingDocument = null;
  pendingMarker = null;
}
