// apps/client/src/engine/lodPolicy.ts
//
// Pure render-LOD policy (Phase 2 Task 10): the triangle budget, the
// target-size rule, and the "should this mesh render via its LOD copy?"
// decision. Lives in its own dependency-free leaf module (only the
// `LodMode` type from state/lodStore.ts) so BOTH engine/lod.ts (the build
// orchestrator, which imports caseStore) and engine/caseStore.ts (the
// render-node producer, which lod.ts imports) can use it without an import
// cycle — the exact same reasoning engine/renderNode.ts documents for the
// caseStore <-> SceneManager pair.
import type { LodMode } from '../state/lodStore';

/**
 * Triangle budget above which a mesh gets an LOD render copy in `'auto'`
 * mode. RENDER-PERFORMANCE constant, NOT clinical (this task's brief —
 * which is why it lives here in the engine, not in
 * packages/clinical-profiles: it bounds what the GPU/scene graph is asked
 * to draw each frame and has zero bearing on any computed geometry, QC
 * gate, or exported result). 500k triangles ≈ 2 typical full-arch scans
 * (~250k each — see the Task 10 timing evidence): a scene at/below that
 * renders comfortably; meshes pushing past it individually are where a
 * draw-cost cap starts paying for itself.
 */
export const RENDER_LOD_TRIANGLE_BUDGET = 500_000;

/**
 * LOD target = this fraction of the input triangle count (capped at the
 * budget, so an LOD never itself exceeds what the budget deems renderable).
 * 0.2 matches this task's own acceptance ratio ("sphere decimated to 20%":
 * quality verified analytically at exactly this reduction) — also a
 * render-perf constant, not clinical, same reasoning as the budget above.
 */
export const RENDER_LOD_TARGET_FRACTION = 0.2;

/**
 * Floor below which `'on'` (the dev "force LOD for inspection" toggle — see
 * `LodMode`'s doc in state/lodStore.ts) still does NOT force a build (Phase
 * 2 Task 10 fix batch, item 1b: "forced-on must not decimate meshes already
 * under budget"). Forcing a decimation on a mesh with only a handful of
 * triangles buys nothing (it was already essentially free to render at full
 * res) while needlessly producing a coarse — possibly near-degenerate —
 * result purely because the dev toggle happens to be on; that widens
 * exposure for no benefit, the same reasoning this fix batch applies to
 * measurement picking. `'on'` still forces LOD for any REAL mesh below the
 * render-perf budget (its documented "inspect LOD quality below the
 * budget" purpose) — this only excludes trivially small ones. Chosen well
 * above `decimate.ts`'s own topology floor (a closed manifold mesh cannot
 * decimate below ~4 triangles), so anything at/above this size still yields
 * a meaningfully-reduced, non-degenerate LOD when forced.
 */
export const MIN_LOD_FORCE_TRIANGLE_COUNT = 64;

/** Whether a mesh of `triangleCount` triangles should render via an LOD
 * copy under `mode` — the pure threshold logic (unit-tested directly, per
 * this task's brief). `'on'` forces LOD regardless of the render-perf
 * budget (dev inspection — see `LodMode`'s doc in state/lodStore.ts), but
 * not below `MIN_LOD_FORCE_TRIANGLE_COUNT` — see that constant's doc. */
export function shouldUseLod(mode: LodMode, triangleCount: number): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return triangleCount > MIN_LOD_FORCE_TRIANGLE_COUNT;
  return triangleCount > RENDER_LOD_TRIANGLE_BUDGET;
}

/** The decimation target for a `triangleCount`-triangle mesh — see
 * `RENDER_LOD_TARGET_FRACTION`'s doc. */
export function lodTargetTriangleCount(triangleCount: number): number {
  return Math.min(RENDER_LOD_TRIANGLE_BUDGET, Math.round(triangleCount * RENDER_LOD_TARGET_FRACTION));
}
