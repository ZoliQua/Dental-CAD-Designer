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

/** Overlap-mode preset for the pair being registered — see
 * engine/alignment.ts's `OVERLAP_MODE_FULL_OUTLIER_REJECTION_FRACTION` /
 * `OVERLAP_MODE_PARTIAL_OUTLIER_REJECTION_FRACTION` for the actual
 * `icpRefine` `outlierRejectionFraction` each preset maps to (that mapping
 * is an ICP algorithm-tuning concern, so it lives in the engine layer, not
 * here — this store only owns the UI-facing CHOICE of preset, same as it
 * owns `phase`/`awaitingSide` and every other session field). */
export type AlignmentOverlapMode = 'full' | 'partial';

/** Documented default for a brand-new alignment session: `'partial'`. This
 * tool's PRIMARY clinical use is bite/situ registration (PLAN.md §6.3:
 * "Optional alignment step: ICP fine-registration (e.g. situ scan → prep
 * scan)") — a situ/bite scan inherently only covers the occlusal contact
 * patch, never the whole opposing arch, so it is a PARTIAL-overlap pairing
 * by construction. Defaulting to the preset the COMMON case needs protects
 * the primary workflow from silently plateauing well short of convergence
 * (see engine/alignment.ts's module doc, "IMPORTANT" note: the previous
 * always-0.10 behavior measured a ~2.4mm RMS plateau — never converging —
 * on exactly this kind of pair). A full-coverage same-region
 * re-registration (the secondary use) requires an explicit switch to
 * `'full'`; per this file's `reset()`, EVERY new session starts back at
 * this default rather than remembering the previous session's choice, so a
 * one-off 'full' pick never silently leaks into the next (different) case. */
export const DEFAULT_ALIGNMENT_OVERLAP_MODE: AlignmentOverlapMode = 'partial';

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
  /** Which overlap-mode preset this run used — journaled verbatim on
   * confirm (engine/alignment.ts's `confirm()`) so a replay/audit can see
   * WHICH preset the operator chose, not just the numeric fraction it
   * resolved to. */
  overlapMode: AlignmentOverlapMode;
  /** The actual `icpRefine`/`icpRegister` `outlierRejectionFraction` this
   * run used — derived from `overlapMode` via engine/alignment.ts's
   * `overlapModeOutlierRejectionFraction` at `run()` time and captured here
   * verbatim (same "journal what actually happened" reasoning as `seed`). */
  outlierRejectionFraction: number;
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
  /** The overlap-mode preset the NEXT `run()` will use — see
   * `DEFAULT_ALIGNMENT_OVERLAP_MODE`'s doc. Settable any time via
   * `setOverlapMode` (ui/AlignmentPanel.tsx only exposes the selector while
   * `phase === 'idle'`, same "settings before Start" placement as the mesh
   * selectors, but nothing at the store/engine level requires that). */
  overlapMode: AlignmentOverlapMode;
  /** Fractional progress in [0, 1] while `phase === 'running'`. */
  progress: number;
  result: AlignmentResult | null;
  error: string | null;
  startPicking: (srcNodeId: string, dstNodeId: string) => void;
  recordPick: (pairCount: number, awaitingSide: 'src' | 'dst') => void;
  setOverlapMode: (overlapMode: AlignmentOverlapMode) => void;
  setRunning: () => void;
  setProgress: (progress: number) => void;
  setResult: (result: AlignmentResult) => void;
  setError: (error: string) => void;
  reset: () => void;
}

const INITIAL_STATE: Omit<
  AlignmentState,
  'startPicking' | 'recordPick' | 'setOverlapMode' | 'setRunning' | 'setProgress' | 'setResult' | 'setError' | 'reset'
> = {
  srcNodeId: null,
  dstNodeId: null,
  phase: 'idle',
  pairCount: 0,
  awaitingSide: 'src',
  overlapMode: DEFAULT_ALIGNMENT_OVERLAP_MODE,
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
  setOverlapMode: (overlapMode) => set({ overlapMode }),
  setRunning: () => set({ phase: 'running', progress: 0, error: null }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) => set({ phase: 'preview', progress: 1, result }),
  setError: (error) => set({ phase: 'error', error }),
  reset: () => set({ ...INITIAL_STATE }),
}));
