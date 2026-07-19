// apps/client/src/state/lodStore.ts
//
// UI-facing snapshot of the render-LOD subsystem (Phase 2 Task 10) — same
// layering pattern as state/heatmapStore.ts: engine/lod.ts is the sole
// writer of the STATUS fields (publishes after every build state change);
// ui/StatusBar.tsx's dev toggle writes `mode` (the one user-driven field,
// same direction as state/viewerStore.ts's wireframe toggle) and only ever
// READS everything else.
//
// LODs are RENDER-ONLY (the task's hard invariant — see engine/lod.ts's
// module doc): nothing in this store ever references, let alone alters, a
// mesh's Float64 kernel master buffers.
import { create } from 'zustand';

/**
 * The dev-panel LOD override (this task's brief: "toggle in dev panel to
 * force LOD on/off for inspection"):
 *  - 'auto' (default): meshes above the engine triangle budget
 *    (engine/lod.ts's `RENDER_LOD_TRIANGLE_BUDGET`) render their LOD copy
 *    once built; everything else renders full-res.
 *  - 'on': every mesh above `engine/lodPolicy.ts`'s
 *    `MIN_LOD_FORCE_TRIANGLE_COUNT` floor renders its LOD copy (built on
 *    demand) — for inspecting LOD quality on meshes below the render
 *    budget. Trivially small meshes (at/under that floor) are excluded even
 *    when forced on: decimating a handful of triangles buys nothing and
 *    only risks a near-degenerate result (Phase 2 Task 10 fix batch).
 *  - 'off': every mesh renders full-res, even above the budget — for
 *    comparing against / bypassing a suspect LOD.
 */
export type LodMode = 'auto' | 'on' | 'off';

export type LodBuildStatus = 'building' | 'ready' | 'error';

interface LodState {
  mode: LodMode;
  /** contentHash -> build status for every mesh the engine has started an
   * LOD build for this session. Replaced wholesale on every publish (a
   * session has at most a handful of meshes — see engine/meshStore.ts's
   * scale assumptions). */
  buildStatus: Readonly<Record<string, LodBuildStatus>>;
  setMode: (mode: LodMode) => void;
  setBuildStatus: (buildStatus: Readonly<Record<string, LodBuildStatus>>) => void;
}

export const useLodStore = create<LodState>((set) => ({
  mode: 'auto',
  buildStatus: {},
  setMode: (mode) => set({ mode }),
  setBuildStatus: (buildStatus) => set({ buildStatus }),
}));
