// apps/client/src/state/alignmentStore.ts
//
// UI-facing snapshot of the alignment tool (Phase 3 Task 3) — same
// layering pattern as state/toolStore.ts/state/heatmapStore.ts:
// engine/alignment.ts is the sole writer (publishes after every state
// change), ui/AlignmentPanel.tsx only ever reads this store and calls back
// into alignmentEngine's exported methods — never mutates this store
// directly. Its own store (not folded into state/toolStore.ts) since
// alignment operates on a MESH PAIR with a multi-step picking + preview +
// explicit-confirm lifecycle, not a single measurement's point picks.
import { create } from 'zustand';

export type AlignmentPhase =
  | 'idle'
  | 'pickingPairs'
  | 'ready'
  | 'running'
  | 'preview'
  | 'applying'
  | 'error';

export interface AlignmentResult {
  /** Column-major 16-number WORLD-frame transform (SceneNode convention) —
   * the CANDIDATE, not yet applied to any SceneNode until the user
   * confirms. */
  transform: readonly number[];
  rmsMm: number;
  inlierFraction: number;
  iterations: number;
  converged: boolean;
  /** Journaled alongside `transform` on confirm — CLAUDE.md invariant 2
   * ("no unseeded randomness... every op is a pure function of its
   * inputs"): the seed ITSELF may be chosen however (here: at `run()` time,
   * from a real entropy source), but it is captured and journaled so the
   * op's output is reproducible from its recorded inputs. */
  seed: number;
  sampleCount: number;
}

interface AlignmentState {
  /** The mesh to be MOVED (src) / the fixed TARGET (dst) — SceneNode ids. */
  srcNodeId: string | null;
  dstNodeId: string | null;
  phase: AlignmentPhase;
  /** How many COMPLETE (src, dst) pairs have been picked so far (0-3). */
  pairCount: number;
  /** Which mesh the NEXT click must land on — 'src' first, then 'dst', per
   * pair, alternating. Meaningless once `pairCount >= 3`. */
  awaitingSide: 'src' | 'dst';
  /** Fractional progress in [0, 1] while `phase === 'running'`. */
  progress: number;
  result: AlignmentResult | null;
  error: string | null;
  startPicking: (srcNodeId: string, dstNodeId: string) => void;
  recordPick: (pairCount: number, awaitingSide: 'src' | 'dst') => void;
  setRunning: () => void;
  setProgress: (progress: number) => void;
  setResult: (result: AlignmentResult) => void;
  setError: (error: string) => void;
  reset: () => void;
}

const INITIAL_STATE: Omit<
  AlignmentState,
  'startPicking' | 'recordPick' | 'setRunning' | 'setProgress' | 'setResult' | 'setError' | 'reset'
> = {
  srcNodeId: null,
  dstNodeId: null,
  phase: 'idle',
  pairCount: 0,
  awaitingSide: 'src',
  progress: 0,
  result: null,
  error: null,
};

export const useAlignmentStore = create<AlignmentState>((set) => ({
  ...INITIAL_STATE,
  startPicking: (srcNodeId, dstNodeId) =>
    set({
      srcNodeId,
      dstNodeId,
      phase: 'pickingPairs',
      pairCount: 0,
      awaitingSide: 'src',
      result: null,
      error: null,
    }),
  recordPick: (pairCount, awaitingSide) =>
    set({ pairCount, awaitingSide, phase: pairCount >= 3 ? 'ready' : 'pickingPairs' }),
  setRunning: () => set({ phase: 'running', progress: 0, error: null }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) => set({ phase: 'preview', progress: 1, result }),
  setError: (error) => set({ phase: 'error', error }),
  reset: () => set({ ...INITIAL_STATE }),
}));
