// UI-facing snapshot of Task 11's case-persistence flow (zustand) — same
// layering pattern as importStore.ts/appStore.ts: pure state, no engine/ or
// ui/ dependency. apps/client/src/engine/persistence.ts (the only file
// allowed to call the server's /api/cases and /api/meshes routes) publishes
// save status, the active case, and the case-picker's list here; ui/ only
// reads it and calls back into persistence.ts's exported actions (never
// mutates this store directly).
import { create } from 'zustand';

/**
 * `idle` — no case open yet (nothing to save/autosave).
 * `saved` — the open case's server copy matches the in-memory document.
 * `saving` — a save (manual or autosave) is in flight.
 * `unsaved` — the document has mutated since the last successful save; an
 *   autosave is scheduled (see persistence.ts's debounce).
 * `error` — the last save attempt failed (`errorMessage` carries why); the
 *   document is still `unsaved` in effect — the next mutation OR the next
 *   autosave tick OR a manual save retries.
 */
export type SaveStatus = 'idle' | 'saved' | 'saving' | 'unsaved' | 'error';

/** Minimal case listing shape — deliberately NOT imported from anywhere
 * server-specific (this is the "state" layer; it depends on nothing but
 * plain local types, per the ui -> engine|state|shared-types boundary). */
export interface CaseSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

interface PersistenceState {
  status: SaveStatus;
  errorMessage: string | null;
  activeCaseId: string | null;
  activeCaseName: string | null;
  lastSavedAt: string | null;
  cases: CaseSummary[];
  casesLoading: boolean;
  casesError: string | null;
  isPickerOpen: boolean;
  setStatus: (status: SaveStatus, errorMessage?: string | null) => void;
  setActiveCase: (params: { id: string; name: string } | null) => void;
  setLastSavedAt: (lastSavedAt: string | null) => void;
  setCases: (cases: CaseSummary[]) => void;
  setCasesLoading: (casesLoading: boolean) => void;
  setCasesError: (casesError: string | null) => void;
  setPickerOpen: (isPickerOpen: boolean) => void;
}

export const usePersistenceStore = create<PersistenceState>((set) => ({
  status: 'idle',
  errorMessage: null,
  activeCaseId: null,
  activeCaseName: null,
  lastSavedAt: null,
  cases: [],
  casesLoading: false,
  casesError: null,
  isPickerOpen: false,
  setStatus: (status, errorMessage = null) => set({ status, errorMessage }),
  setActiveCase: (params) =>
    set({ activeCaseId: params?.id ?? null, activeCaseName: params?.name ?? null }),
  setLastSavedAt: (lastSavedAt) => set({ lastSavedAt }),
  setCases: (cases) => set({ cases }),
  setCasesLoading: (casesLoading) => set({ casesLoading }),
  setCasesError: (casesError) => set({ casesError }),
  setPickerOpen: (isPickerOpen) => set({ isPickerOpen }),
}));
