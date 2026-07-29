// apps/client/src/state/exportStore.ts
//
// UI-facing snapshot of the manufacturing-export flow (Phase 7 Task 3) —
// same layering pattern as state/crownStore.ts / cavityStore.ts:
// engine/exportFlow.ts is the SOLE writer (it pushes a per-restoration
// snapshot after every state change via `apply`), and the Task 7 export
// panel only ever READS this store and calls back into `exportFlowEngine`.
// Depends only on `@dqcad/shared-types` (CLAUDE.md layer rule:
// state -> shared-types).
//
// Every refusal is a VISIBLE, i18n-keyed state (the 19b lesson): the engine
// never returns without either a `refused`/`error` snapshot or a
// `done` one — there is no silent-no-op path, and this store is where that
// visibility lives. The `stale` state is the P5-T8 cascade discipline
// extended to exports: a design edit after an export — or a QC re-run that
// withdraws the acknowledgment that authorized it — flips the snapshot to
// `stale` (derived from hashes + the current report by the engine's
// `isExportRecordStale`, not hand-maintained).
import { create } from 'zustand';
import type { ExportFormat } from '@dqcad/shared-types';

/** Why an export was refused — each code maps 1:1 to an i18n key (see
 * engine/exportWorkflow.ts's `EXPORT_REFUSAL_I18N_KEY`). Mirrors the
 * engine's union at the layer boundary (the crownStore "duplicate the
 * trivial shape" convention). */
export type ExportRefusalCode =
  | 'noFinalMesh'
  | 'qcMissing'
  | 'qcStale'
  | 'gatesFailing'
  | 'finalMeshUnavailable';

export type ExportStateName = 'idle' | 'refused' | 'exporting' | 'done' | 'stale' | 'error';

/** One restoration's export status snapshot. */
export interface ExportStatusSnapshot {
  state: ExportStateName;
  /** Format of the in-flight/completed export, `null` in `idle`/`refused`. */
  format: ExportFormat | null;
  /** Set iff `state === 'refused'`. */
  refusalCode: ExportRefusalCode | null;
  /** The failing UNACKNOWLEDGED gate ids behind a `gatesFailing` refusal
   * (empty otherwise) — the panel renders the list, i18n'd. */
  failingGates: readonly string[];
  /** SHA-256 of the exported bytes (`done`/`stale`), else `null`. */
  bytesSha256: string | null;
  byteLength: number | null;
  progress: number;
  /** Set iff `state === 'error'` (the honest-failure surface). */
  error: string | null;
}

export const IDLE_EXPORT_STATUS: ExportStatusSnapshot = {
  state: 'idle',
  format: null,
  refusalCode: null,
  failingGates: [],
  bytesSha256: null,
  byteLength: null,
  progress: 0,
  error: null,
};

export interface ExportState {
  /** Per-restoration snapshots, keyed by `Restoration.id`. Absent key ⇒
   * `IDLE_EXPORT_STATUS` (use `selectExportStatus`). */
  byRestoration: Readonly<Record<string, ExportStatusSnapshot>>;
  /** Single writer seam — replaces the whole snapshot for one restoration. */
  apply: (restorationId: string, snapshot: ExportStatusSnapshot) => void;
  reset: () => void;
}

/** Read helper: a restoration with no recorded export activity is `idle`. */
export function selectExportStatus(state: ExportState, restorationId: string): ExportStatusSnapshot {
  return state.byRestoration[restorationId] ?? IDLE_EXPORT_STATUS;
}

export const useExportStore = create<ExportState>((set) => ({
  byRestoration: {},
  apply: (restorationId, snapshot) =>
    set((state) => ({ byRestoration: { ...state.byRestoration, [restorationId]: snapshot } })),
  reset: () => set({ byRestoration: {} }),
}));
