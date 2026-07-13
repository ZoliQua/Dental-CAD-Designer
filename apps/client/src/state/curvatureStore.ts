// apps/client/src/state/curvatureStore.ts
//
// UI-facing snapshot of the per-vertex curvature overlay (Phase 2 Task 3) —
// same "engine is the sole writer, ui only reads" layering as
// state/heatmapStore.ts (see that file's module doc); engine/curvature.ts
// is the sole writer here. Deliberately its own store (mirrors
// heatmapStore's own "not folded into toolStore" reasoning) — curvature
// operates on a SINGLE selected mesh with a scalar-field choice (H or K), a
// different shape/lifecycle than the two-mesh heatmap.
//
// This is Phase 3 scaffolding (margin-ridge detection will build on top of
// this same H/K overlay) — kept intentionally small per this task's brief.
import { create } from 'zustand';

export type CurvatureField = 'H' | 'K';
export type CurvatureStatus = 'idle' | 'running' | 'done' | 'error';

export interface CurvatureStats {
  min: number;
  max: number;
  mean: number;
}

export interface CurvatureRange {
  min: number;
  max: number;
}

interface CurvatureState {
  /** SceneNode id of the mesh currently being colored — `null` until a run
   * has been started. */
  nodeId: string | null;
  field: CurvatureField;
  status: CurvatureStatus;
  /** Fractional progress in [0, 1] while `status === 'running'`. */
  progress: number;
  error: string | null;
  stats: CurvatureStats | null;
  /** The display range CURRENTLY applied to the overlay's colors — either
   * the auto-computed percentile range or a user-supplied manual override
   * (see `autoRange`). `null` before any run has completed. */
  range: CurvatureRange | null;
  autoRange: boolean;
  /** Whether the overlay's per-vertex colors are currently applied to the
   * viewer (togglable independently of having a computed result). */
  visible: boolean;
  setRun: (input: { nodeId: string; field: CurvatureField }) => void;
  setProgress: (progress: number) => void;
  setResult: (input: { stats: CurvatureStats; range: CurvatureRange }) => void;
  setError: (error: string) => void;
  setRange: (range: CurvatureRange, autoRange: boolean) => void;
  setVisible: (visible: boolean) => void;
  clear: () => void;
}

const INITIAL_STATE: Omit<
  CurvatureState,
  'setRun' | 'setProgress' | 'setResult' | 'setError' | 'setRange' | 'setVisible' | 'clear'
> = {
  nodeId: null,
  field: 'H',
  status: 'idle',
  progress: 0,
  error: null,
  stats: null,
  range: null,
  autoRange: true,
  visible: false,
};

export const useCurvatureStore = create<CurvatureState>((set) => ({
  ...INITIAL_STATE,
  setRun: ({ nodeId, field }) => set({ nodeId, field, status: 'running', progress: 0, error: null, stats: null }),
  setProgress: (progress) => set({ progress }),
  setResult: ({ stats, range }) => set({ status: 'done', progress: 1, stats, range, autoRange: true, visible: true }),
  setError: (error) => set({ status: 'error', error }),
  setRange: (range, autoRange) => set({ range, autoRange }),
  setVisible: (visible) => set({ visible }),
  clear: () => set({ ...INITIAL_STATE }),
}));
