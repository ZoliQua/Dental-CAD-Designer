// apps/client/src/state/axisStore.ts
//
// UI-facing snapshot of the insertion-axis tool (Phase 3 Task 9) — same
// layering pattern as state/sectionStore.ts/state/marginStore.ts:
// engine/axis.ts is the sole writer (publishes after every state change);
// ui/AxisPanel.tsx only ever reads this store and calls back into
// `axisEngine`'s exported methods. Deliberately holds only LIGHTWEIGHT
// summary state (direction, angle sliders, ranked candidate SCALARS,
// per-abutment readout) — the actual heatmap COLOR buffer (a
// mesh-vertex-count-sized Float32Array, recomputed on every slider tick)
// lives in `axisEngine` itself (private field), exposed via
// `getHeatmapOverlay()` for ui/Viewport.tsx to read directly when
// re-syncing SceneManager — the same "engine keeps the buffers, store only
// signals that something changed" split state/heatmapStore.ts's doc calls
// out for `HeatmapEngine`'s colors; here signaled via `heatmapGeneration`
// (bumped on every recompute) rather than the color buffer itself.
import { create } from 'zustand';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';

export type AxisToolStatus = 'idle' | 'suggesting' | 'active' | 'error';

/** Where the CURRENT `direction` came from — journaled as `axis-set`
 * provenance (this task's brief: "axis + params + suggestion provenance").
 * `'suggested'`: unedited since the last `runSuggest()`. `'manual'`: at
 * least one slider edit has happened since (even if the user dragged back
 * to numerically the same direction — provenance tracks the GESTURE, not a
 * post-hoc geometric comparison). */
export type AxisAdjustmentSource = 'suggested' | 'manual';

/** One evaluated candidate's summary — mirrors
 * `@dqcad/kernel-workers`' `SuggestAxisCandidatePayload` (this store may
 * not import kernel-workers directly — CLAUDE.md layer rule, `state` ->
 * `shared-types` only — so this is the same "duplicate the trivial shape at
 * the layer boundary" convention state/marginStore.ts's own
 * `MarginValidationSnapshot` doc documents). */
export interface AxisCandidateSummary {
  direction: Vec3;
  scoreMm3: number;
  undercutAreaMm2: number;
  maxDepthMm: number;
  undercutTriangleCount: number;
}

/** Per-abutment undercut readout at the CURRENT direction (this task's
 * brief: "per-abutment readout for bridges") — populated for every
 * margin-bearing tooth on the restoration, length 1 for a
 * crown/inlay/onlay. */
export interface AxisAbutmentReadout {
  tooth: FdiTooth;
  undercutAreaMm2: number;
  maxDepthMm: number;
  undercutTriangleCount: number;
  regionTriangleCount: number;
}

interface AxisToolState {
  restorationId: string | null;
  targetNodeId: string | null;
  /** Margin-bearing teeth on the restoration (abutments; excludes pontics)
   * — same order as `perAbutment`. Empty until `start()` AND at least one
   * confirmed margin line exists. */
  abutmentTeeth: readonly FdiTooth[];
  status: AxisToolStatus;
  busy: boolean;
  /** `suggestAxis`'s own progress fraction (0..1) while `status ===
   * 'suggesting'`. */
  progress: number;
  error: string | null;
  /** The CURRENT candidate axis direction — always a valid (though not
   * necessarily unit-length as STORED; the kernel normalizes on use)
   * Vec3. Starts at the restoration's persisted `insertionAxis` (or the
   * placeholder default) until the user runs a suggestion or drags a
   * slider. */
  direction: Vec3;
  /** Manual-adjust spherical angle sliders, degrees — `direction =
   * sphericalToDirection(azimuthDeg, elevationDeg)` (engine/axis.ts's pure
   * helper; kept OUT of this store per its "no geometry math" convention —
   * see ui/ layer rule). Kept in sync with `direction` in both directions:
   * `runSuggest()`/`applySuggestedCandidate()` re-derive these from the
   * winning direction, `setAzimuthDeg`/`setElevationDeg` re-derive
   * `direction` from these. */
  azimuthDeg: number;
  elevationDeg: number;
  source: AxisAdjustmentSource;
  /** Ranked candidates from the last `runSuggest()` call (best first) — for
   * a "try the next-best axis" UI list. Empty until a suggestion has run
   * this session. */
  ranked: readonly AxisCandidateSummary[];
  perAbutment: readonly AxisAbutmentReadout[];
  heatmapVisible: boolean;
  /** Bumped every time `axisEngine` recomputes the heatmap color buffer —
   * see this file's top-of-file doc. `0` = no heatmap computed yet. */
  heatmapGeneration: number;
  /** `true` while a heatmap recompute is in flight — lets the UI show a
   * subtle "updating" indicator without gating the slider itself (the
   * heatmap update is throttled/best-effort, per this task's brief — the
   * slider must never feel gated on it). */
  heatmapBusy: boolean;
  /** `true` immediately after a successful `confirmAxis()` — reset to
   * `false` by any further slider edit or a fresh `runSuggest()` (mirrors
   * state/marginStore.ts's own `confirmed` reset-on-edit convention). */
  confirmed: boolean;

  start: (restorationId: string, targetNodeId: string, abutmentTeeth: readonly FdiTooth[], initialDirection: Vec3) => void;
  setSuggesting: () => void;
  setSuggestProgress: (progress: number) => void;
  setSuggestResult: (input: {
    direction: Vec3;
    azimuthDeg: number;
    elevationDeg: number;
    ranked: readonly AxisCandidateSummary[];
    perAbutment: readonly AxisAbutmentReadout[];
  }) => void;
  setError: (error: string) => void;
  setManualDirection: (input: { direction: Vec3; azimuthDeg: number; elevationDeg: number }) => void;
  setHeatmapVisible: (visible: boolean) => void;
  setHeatmapResult: (input: { perAbutment: readonly AxisAbutmentReadout[] }) => void;
  setHeatmapBusy: (busy: boolean) => void;
  setConfirmed: (confirmed: boolean) => void;
  reset: () => void;
}

const INITIAL: Omit<
  AxisToolState,
  | 'start'
  | 'setSuggesting'
  | 'setSuggestProgress'
  | 'setSuggestResult'
  | 'setError'
  | 'setManualDirection'
  | 'setHeatmapVisible'
  | 'setHeatmapResult'
  | 'setHeatmapBusy'
  | 'setConfirmed'
  | 'reset'
> = {
  restorationId: null,
  targetNodeId: null,
  abutmentTeeth: [],
  status: 'idle',
  busy: false,
  progress: 0,
  error: null,
  direction: [0, 0, 1],
  azimuthDeg: 0,
  elevationDeg: 90,
  source: 'manual',
  ranked: [],
  perAbutment: [],
  heatmapVisible: true,
  heatmapGeneration: 0,
  heatmapBusy: false,
  confirmed: false,
};

export const useAxisStore = create<AxisToolState>((set) => ({
  ...INITIAL,
  start: (restorationId, targetNodeId, abutmentTeeth, initialDirection) =>
    set({
      ...INITIAL,
      restorationId,
      targetNodeId,
      abutmentTeeth,
      direction: initialDirection,
      status: 'active',
    }),
  setSuggesting: () => set({ status: 'suggesting', busy: true, progress: 0, error: null }),
  setSuggestProgress: (progress) => set({ progress }),
  setSuggestResult: ({ direction, azimuthDeg, elevationDeg, ranked, perAbutment }) =>
    set({
      status: 'active',
      busy: false,
      progress: 1,
      error: null,
      direction,
      azimuthDeg,
      elevationDeg,
      source: 'suggested',
      ranked,
      perAbutment,
      confirmed: false,
    }),
  setError: (error) => set({ status: 'active', busy: false, progress: 0, error }),
  setManualDirection: ({ direction, azimuthDeg, elevationDeg }) =>
    set({ direction, azimuthDeg, elevationDeg, source: 'manual', confirmed: false }),
  setHeatmapVisible: (heatmapVisible) => set({ heatmapVisible }),
  setHeatmapResult: ({ perAbutment }) =>
    set((state) => ({ perAbutment, heatmapGeneration: state.heatmapGeneration + 1, heatmapBusy: false })),
  setHeatmapBusy: (heatmapBusy) => set({ heatmapBusy }),
  setConfirmed: (confirmed) => set({ confirmed }),
  reset: () => set({ ...INITIAL }),
}));
