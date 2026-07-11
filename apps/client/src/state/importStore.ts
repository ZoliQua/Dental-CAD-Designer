// UI-facing snapshot of in-flight file imports (zustand) — same layering
// pattern as appStore.ts/caseStore.ts: pure state, depends on nothing from
// engine/ or ui/. apps/client/src/engine/importer.ts (the only file allowed
// to import @dqcad/kernel-workers for this flow — see engine/workers.ts)
// publishes progress/status here as each file moves through
// read -> parse -> (unit confirmation) -> (rescale) -> intake -> register;
// ui/ only reads it and calls back into importer.ts's `cancelImport` /
// `resolveUnitConfirmation` exports (never mutates this store directly).
import { create } from 'zustand';

export type ImportPhase =
  | 'reading'
  | 'parsing'
  | 'awaiting-unit-confirmation'
  | 'rescaling'
  | 'intake'
  | 'registering'
  | 'done'
  | 'cancelled'
  | 'error';

/** Terminal phases — no further progress events are expected once a file
 * reaches one of these; ui/ uses this to decide whether to still show a
 * cancel button. */
export const TERMINAL_IMPORT_PHASES: ReadonlySet<ImportPhase> = new Set(['done', 'cancelled', 'error']);

export interface ImportFileEntry {
  id: string;
  /** Sanitized (basename-only) display name — see importer.ts's
   * `sanitizeBasename`; this is the same string that ends up in the
   * `import-mesh` journal Operation's params. */
  name: string;
  phase: ImportPhase;
  /** Fraction in [0, 1] within the CURRENT phase (progress resets to 0 at
   * each phase transition — each phase is its own worker job/step). */
  progress: number;
  error: string | null;
  /** Set once the mesh is registered (phase 'done') — the key into
   * engine/meshStore.ts and CaseDocument.meshes[].contentHash. */
  meshContentHash: string | null;
}

export interface PendingUnitConfirmation {
  fileId: string;
  fileName: string;
  maxExtentMm: number;
  suspectedUnit: 'cm' | 'um';
  suggestedFactor: number;
}

interface ImportStoreState {
  files: Record<string, ImportFileEntry>;
  /** At most one confirmation is ever pending at a time — importer.ts
   * processes files concurrently but each file's pipeline awaits its own
   * confirmation independently; if two suggestions land "simultaneously"
   * the second simply waits (its promise isn't created until
   * requestUnitConfirmation is called, which importer.ts calls in sequence
   * per file) — see importer.ts's `pendingConfirmations` queue for the
   * exact ordering guarantee. */
  pendingUnitConfirmation: PendingUnitConfirmation | null;
  upsertFile: (entry: ImportFileEntry) => void;
  updateFile: (id: string, patch: Partial<Omit<ImportFileEntry, 'id'>>) => void;
  removeFile: (id: string) => void;
  setPendingUnitConfirmation: (request: PendingUnitConfirmation | null) => void;
}

export const useImportStore = create<ImportStoreState>((set) => ({
  files: {},
  pendingUnitConfirmation: null,
  upsertFile: (entry) => set((state) => ({ files: { ...state.files, [entry.id]: entry } })),
  updateFile: (id, patch) =>
    set((state) => {
      const existing = state.files[id];
      if (!existing) {
        return state;
      }
      return { files: { ...state.files, [id]: { ...existing, ...patch } } };
    }),
  removeFile: (id) =>
    set((state) => {
      if (!(id in state.files)) {
        return state;
      }
      const files = { ...state.files };
      delete files[id];
      return { files };
    }),
  setPendingUnitConfirmation: (request) => set({ pendingUnitConfirmation: request }),
}));
