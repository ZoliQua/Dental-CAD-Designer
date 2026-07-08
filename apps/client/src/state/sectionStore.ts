// apps/client/src/state/sectionStore.ts
//
// UI-facing snapshot of the cross-section tool (Task 10) — same layering
// pattern as state/heatmapStore.ts/state/toolStore.ts: engine/section.ts is
// the sole writer (publishes after every state change); ui/SectionPanel.tsx
// only ever reads this store and calls back into `sectionEngine`'s exported
// methods — never mutates this store directly.
//
// Deliberately holds only LIGHTWEIGHT/summary state (axis, slider values,
// status, a plain plane point/normal, a point COUNT) — the actual heavy
// polyline/cap geometry lives in `sectionEngine` itself (private fields),
// exposed via getters (`getOutline`/`getCaps`/`getClipPlane`) that
// ui/Viewport.tsx reads directly when re-syncing SceneManager — the same
// "engine keeps the buffers, store only signals that something changed"
// split state/heatmapStore.ts's doc calls out for `HeatmapEngine`'s colors.
import { create } from 'zustand';

export type SectionAxis = 'x' | 'y' | 'z' | 'custom';

export interface SectionPlaneSummary {
  point: readonly [number, number, number];
  normal: readonly [number, number, number];
}

export type SectionStatus = 'idle' | 'running' | 'error';

interface SectionState {
  /** Whether the section tool is active at all — when false, no plane is
   * computed, no worker jobs run, and SceneManager's outline/cap/clip are
   * all cleared. */
  enabled: boolean;
  /** Which axis preset (through the current scene bbox center) is active,
   * or 'custom' for the arbitrary-plane sliders (position along normal +
   * two rotation angles — this task's brief). Picking a preset resets
   * `offsetMm`/`yawDeg`/`pitchDeg` to 0 (plane through the exact bbox
   * center, axis-aligned); 'custom' keeps whatever the sliders currently
   * say. */
  axis: SectionAxis;
  /** Distance (mm) the plane is moved along its normal from the scene bbox
   * center anchor. */
  offsetMm: number;
  /** Rotation (degrees) applied to the base axis normal — yaw first (around
   * world Y), then pitch (around the yaw-rotated X) — see
   * engine/section.ts's `eulerNormal` for the exact composition. */
  yawDeg: number;
  pitchDeg: number;
  /** Whether to also request the filled cap (manifold-3d `sectionCap`,
   * display-only — see that function's doc) alongside the outline. */
  showCap: boolean;
  /** Whether a THREE.js clip plane is currently applied to every mesh (see
   * engine/SceneManager.ts's `setSectionClipPlane`). */
  clipEnabled: boolean;
  status: SectionStatus;
  error: string | null;
  /** The plane actually used for the last completed/in-flight run — `null`
   * before the tool has ever computed one. */
  plane: SectionPlaneSummary | null;
  /** Total point count across every outline polyline from the last
   * completed run — for a lightweight "N points" status line; `0` while
   * `status !== 'idle'` or before any run. */
  pointCount: number;
  setEnabled: (enabled: boolean) => void;
  setAxis: (axis: SectionAxis) => void;
  setOffsetMm: (mm: number) => void;
  setYawDeg: (deg: number) => void;
  setPitchDeg: (deg: number) => void;
  setShowCap: (show: boolean) => void;
  setClipEnabled: (enabled: boolean) => void;
  setRunning: () => void;
  setResult: (input: { plane: SectionPlaneSummary; pointCount: number }) => void;
  setError: (message: string) => void;
  clear: () => void;
}

const INITIAL_STATE: Pick<
  SectionState,
  | 'enabled'
  | 'axis'
  | 'offsetMm'
  | 'yawDeg'
  | 'pitchDeg'
  | 'showCap'
  | 'clipEnabled'
  | 'status'
  | 'error'
  | 'plane'
  | 'pointCount'
> = {
  enabled: false,
  axis: 'z',
  offsetMm: 0,
  yawDeg: 0,
  pitchDeg: 0,
  showCap: true,
  clipEnabled: false,
  status: 'idle',
  error: null,
  plane: null,
  pointCount: 0,
};

export const useSectionStore = create<SectionState>((set) => ({
  ...INITIAL_STATE,
  setEnabled: (enabled) => set({ enabled }),
  setAxis: (axis) => set({ axis }),
  setOffsetMm: (offsetMm) => set({ offsetMm }),
  setYawDeg: (yawDeg) => set({ yawDeg }),
  setPitchDeg: (pitchDeg) => set({ pitchDeg }),
  setShowCap: (showCap) => set({ showCap }),
  setClipEnabled: (clipEnabled) => set({ clipEnabled }),
  setRunning: () => set({ status: 'running', error: null }),
  setResult: ({ plane, pointCount }) => set({ status: 'idle', error: null, plane, pointCount }),
  setError: (message) => set({ status: 'error', error: message, pointCount: 0 }),
  clear: () => set({ ...INITIAL_STATE }),
}));
