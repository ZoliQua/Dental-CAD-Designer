// apps/client/src/state/toolStore.ts
//
// UI-facing snapshot of the active measurement tool (zustand) — same
// direction as state/importStore.ts/state/caseStore.ts: engine/ToolManager.ts
// is the sole writer (publishes after every state change), ui/MeasureToolbar.tsx
// / ui/Viewport.tsx only ever read it and call back into ToolManager's
// exported methods (startTool/cancelTool) — never mutate this store
// directly. Deliberately its own store (not folded into state/caseStore.ts's
// `selectedNodeId`-style ephemeral slice) since a measurement tool's
// in-progress state (which tool, how many points picked, in-flight worker
// round trip) has nothing to do with the case DOCUMENT itself.
import { create } from 'zustand';
import type { MeasurementKind } from '@dqcad/shared-types';

interface ToolState {
  /** `null` when no measurement tool is active (ordinary click-to-select
   * mode — see engine/SceneManager.ts's interaction-mode split). */
  activeTool: MeasurementKind | null;
  /** How many surface points have been picked so far for the in-progress
   * measurement — ui/MeasureToolbar.tsx uses this (with the tool's required
   * point count) to render an instructional hint like "pick 2 of 3". */
  pendingPointCount: number;
  /** True while a pick's worker round trip (ensureBvhBuilt + raycastMesh /
   * measurePointToSurface) is in flight — ToolManager.ts ignores further
   * picks while busy, and the toolbar can show a lightweight "measuring…"
   * indicator instead of appearing unresponsive to a rapid second click. */
  busy: boolean;
  /** Last pick/measurement error message, if any — cleared on the next
   * `startTool`/successful pick. */
  error: string | null;
  setActiveTool: (tool: MeasurementKind | null) => void;
  setPendingPointCount: (count: number) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
}

export const useToolStore = create<ToolState>((set) => ({
  activeTool: null,
  pendingPointCount: 0,
  busy: false,
  error: null,
  setActiveTool: (activeTool) => set({ activeTool }),
  setPendingPointCount: (pendingPointCount) => set({ pendingPointCount }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
}));
