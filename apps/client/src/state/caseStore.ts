// UI-facing snapshot of the case document (zustand). Same layering pattern
// as state/appStore.ts: this "state" layer depends only on
// @dqcad/shared-types (never on engine/ or ui/) — apps/client/src/engine/
// caseStore.ts (the CANONICAL, imperative owner of case state) publishes a
// fresh `CaseDocument` snapshot into this store after every mutation; ui/
// only ever reads it via `useCaseStore`, never mutates it directly.
import { create } from 'zustand';
import type { CaseDocument } from '@dqcad/shared-types';

/**
 * The empty case shell a fresh session starts from. `settings` is a
 * placeholder — Phase 1 has no material-profile selection UI yet, so these
 * are intentionally blank rather than a fabricated clinical default (see
 * CLAUDE.md: "Clinical defaults live in clinical-profiles/ only").
 * `id`/`createdAt` are stamped once at module load, not per-import.
 */
export function createEmptyCaseDocument(): CaseDocument {
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    meshes: [],
    scene: [],
    restorations: [],
    history: [],
    settings: { materialProfileId: '', profileVersion: '' },
  };
}

interface CaseStoreState {
  document: CaseDocument;
  /** The currently click-picked SceneNode id (engine/caseStore.ts's
   * `setSelectedNodeId`), or `null` when nothing is selected. Deliberately
   * NOT a field on `CaseDocument` — selection is ephemeral viewer UI state,
   * not part of the persisted/exported case (Task 11), so it gets its own
   * slice here rather than polluting the document schema. Consumed by
   * ui/Viewport.tsx (round-trips into SceneManager's highlight) and, from
   * Task 7 on, by the measurement tools. */
  selectedNodeId: string | null;
  setDocument: (document: CaseDocument) => void;
  setSelectedNodeId: (selectedNodeId: string | null) => void;
}

export const useCaseStore = create<CaseStoreState>((set) => ({
  document: createEmptyCaseDocument(),
  selectedNodeId: null,
  setDocument: (document) => set({ document }),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
}));
