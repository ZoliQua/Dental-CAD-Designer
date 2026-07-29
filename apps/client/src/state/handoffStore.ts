// apps/client/src/state/handoffStore.ts
//
// Phase 7 Task 7 — the UI-facing snapshot of the SERVER handoff: the
// independent export re-validation result (`POST /api/restorations/:id/export`)
// and the case-archive export/import flow. Same layering as
// state/exportStore.ts: engine/handoff.ts is the SOLE writer and the export
// panel only READS this store.
//
// Two distinct concerns, deliberately kept honest:
//  - RELEASE (per restoration): the T3 client-side journaled export produced
//    the bytes; the server independently re-validates them and only then
//    RELEASES the file. A `released` snapshot carries the download + the two
//    traceability doc links (the T5 routes). A `mismatch` snapshot carries the
//    server's honest diagnostic (the 409 bug-report payload — what diverged),
//    NEVER a retry-to-green affordance (the 19b discipline: every refusal is a
//    visible state).
//  - ARCHIVE (global, one at a time): export streams the `.dqca` down; import
//    posts an archive and either creates a new case, reports a conflict the
//    user must confirm to overwrite (invariant 5: no silent mutation), or
//    reports the import result — including how many imported release rows are
//    stamped `importedUnverified` (T6 F-B1: the trust boundary is visible to
//    the user, not just in the DB).
//
// Depends only on nothing but zustand (state -> nothing, the leaf convention).
import { create } from 'zustand';

export type ReleaseStateName = 'idle' | 'releasing' | 'released' | 'mismatch' | 'error';

/** One field the server report disagreed with the client report on (the 409
 * `export-qc-mismatch` bug-report payload — rendered verbatim, honestly). */
export interface ReleaseDifference {
  path: string;
  server: unknown;
  client: unknown;
}

/** A released manufacturing file + its traceability docs (the T4/T5 success
 * response). The bytes live server-side, content-addressed; the panel links
 * to them. */
export interface ReleasedFile {
  exportId: string;
  format: string;
  bytesSha256: string;
  reimportMeshHash: string;
  byteLength: number;
  downloadPath: string;
  traceabilityJsonPath: string;
  traceabilityHtmlPath: string;
  releasedAt: string;
  alreadyStored: boolean;
}

/** The honest failure surface — a server refusal/mismatch (or a local
 * pre-flight refusal), rendered as WHAT diverged, never as "try again". */
export interface ReleaseFailure {
  /** The server error code (`export-qc-mismatch`, `export-gates-failing`,
   * `export-outer-envelope-mismatch`, `export-journal-hash-mismatch`, …) or a
   * local code (`no-live-context`, `request-unavailable`). Maps 1:1 to an
   * i18n key via engine/handoff.ts's RELEASE_FAILURE_I18N_KEY. */
  code: string;
  /** The server/local human message verbatim (untranslated technical detail). */
  message: string;
  httpStatus: number | null;
  diagnosticId: string | null;
  /** Present on `export-qc-mismatch` — the per-field diff. */
  differences: ReleaseDifference[] | null;
  /** Present on `export-gates-failing` — the failing unacknowledged gates. */
  failingGates: string[] | null;
}

export interface ReleaseSnapshot {
  state: ReleaseStateName;
  released: ReleasedFile | null;
  failure: ReleaseFailure | null;
}

export const IDLE_RELEASE: ReleaseSnapshot = { state: 'idle', released: null, failure: null };

export type ArchiveStateName =
  | 'idle'
  | 'exporting'
  | 'importing'
  | 'conflict'
  | 'imported'
  | 'error';

/** The import counts the server reports (T6) — `exportRows` is the count of
 * imported release rows stamped `importedUnverified`. */
export interface ArchiveImportCounts {
  scans: number;
  finalMeshes: number;
  exportRows: number;
  exportBytes: number;
}

export interface ArchiveSnapshot {
  state: ArchiveStateName;
  /** `imported` result. */
  importedCaseId: string | null;
  overwritten: boolean;
  counts: ArchiveImportCounts | null;
  /** `conflict`: the case id an import would overwrite (needs confirm). */
  conflictCaseId: string | null;
  /** `error`: the human message. */
  error: string | null;
}

export const IDLE_ARCHIVE: ArchiveSnapshot = {
  state: 'idle',
  importedCaseId: null,
  overwritten: false,
  counts: null,
  conflictCaseId: null,
  error: null,
};

export interface HandoffState {
  /** Per-restoration release snapshots (absent key ⇒ IDLE_RELEASE). */
  release: Readonly<Record<string, ReleaseSnapshot>>;
  archive: ArchiveSnapshot;
  applyRelease: (restorationId: string, snapshot: ReleaseSnapshot) => void;
  applyArchive: (snapshot: ArchiveSnapshot) => void;
  reset: () => void;
}

export function selectRelease(state: HandoffState, restorationId: string): ReleaseSnapshot {
  return state.release[restorationId] ?? IDLE_RELEASE;
}

export const useHandoffStore = create<HandoffState>((set) => ({
  release: {},
  archive: IDLE_ARCHIVE,
  applyRelease: (restorationId, snapshot) =>
    set((state) => ({ release: { ...state.release, [restorationId]: snapshot } })),
  applyArchive: (snapshot) => set({ archive: snapshot }),
  reset: () => set({ release: {}, archive: IDLE_ARCHIVE }),
}));
