// apps/client/src/state/heatmapStore.ts
//
// UI-facing snapshot of the surface-distance heatmap (Task 9) — same
// layering pattern as state/toolStore.ts: engine/heatmap.ts is the sole
// writer (publishes after every state change), ui/SurfaceDistancePanel.tsx
// only ever reads this store and calls back into heatmapEngine's exported
// methods (run/setVisible/setRange/clear) — never mutates this store
// directly. Deliberately its own store (not folded into state/toolStore.ts)
// since a heatmap run operates on two whole MESHES, not measurement-tool
// picks — a different UX/lifecycle entirely (see engine/heatmap.ts's module
// doc).
//
// This file intentionally only ever holds primitive/typed-array data, never
// a @dqcad/kernel-workers type — the `state` layer's boundary policy
// (eslint.config.js) only allows `state -> shared-types`, not
// `state -> kernel-workers`.
import { create } from 'zustand';

export interface HeatmapStats {
  min: number;
  max: number;
  mean: number;
  rms: number;
}

export interface HeatmapRange {
  min: number;
  max: number;
}

export type HeatmapStatus = 'idle' | 'running' | 'done' | 'error';

interface HeatmapState {
  /** SceneNode ids of the two meshes being compared — `sourceNodeId`'s
   * vertices are queried against `targetNodeId`'s surface (see
   * engine/heatmap.ts's `run`). `null` until a run has been started. */
  sourceNodeId: string | null;
  targetNodeId: string | null;
  signed: boolean;
  status: HeatmapStatus;
  /** Fractional progress in [0, 1] while `status === 'running'`. */
  progress: number;
  error: string | null;
  stats: HeatmapStats | null;
  /** The display range CURRENTLY applied to the heatmap's colors — either
   * the auto-computed percentile range or a user-supplied manual override
   * (see `autoRange`). `null` before any run has completed. */
  range: HeatmapRange | null;
  /** True while `range` is the auto-computed one; false once the user has
   * supplied a manual override via `heatmapEngine.setRange`. */
  autoRange: boolean;
  /** Whether the heatmap's per-vertex colors are currently applied to the
   * viewer (togglable independently of having a computed result — Task 9's
   * brief: "heatmap togglable per mesh pair"). */
  visible: boolean;
  setRun: (input: { sourceNodeId: string; targetNodeId: string; signed: boolean }) => void;
  setProgress: (progress: number) => void;
  setResult: (input: { stats: HeatmapStats; range: HeatmapRange }) => void;
  setError: (error: string) => void;
  setRange: (range: HeatmapRange, autoRange: boolean) => void;
  setVisible: (visible: boolean) => void;
  clear: () => void;
}

const INITIAL_STATE: Omit<
  HeatmapState,
  'setRun' | 'setProgress' | 'setResult' | 'setError' | 'setRange' | 'setVisible' | 'clear'
> = {
  sourceNodeId: null,
  targetNodeId: null,
  signed: false,
  status: 'idle',
  progress: 0,
  error: null,
  stats: null,
  range: null,
  autoRange: true,
  visible: false,
};

export const useHeatmapStore = create<HeatmapState>((set) => ({
  ...INITIAL_STATE,
  setRun: ({ sourceNodeId, targetNodeId, signed }) =>
    set({
      sourceNodeId,
      targetNodeId,
      signed,
      status: 'running',
      progress: 0,
      error: null,
      stats: null,
    }),
  setProgress: (progress) => set({ progress }),
  setResult: ({ stats, range }) => set({ status: 'done', progress: 1, stats, range, autoRange: true, visible: true }),
  setError: (error) => set({ status: 'error', error }),
  setRange: (range, autoRange) => set({ range, autoRange }),
  setVisible: (visible) => set({ visible }),
  clear: () => set({ ...INITIAL_STATE }),
}));
