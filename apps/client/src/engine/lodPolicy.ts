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

/** Whether a mesh of `triangleCount` triangles should render via an LOD
 * copy under `mode` — the pure threshold logic (unit-tested directly, per
 * this task's brief). Note `'on'` forces LOD REGARDLESS of size (dev
 * inspection — see `LodMode`'s doc in state/lodStore.ts). */
export function shouldUseLod(mode: LodMode, triangleCount: number): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return triangleCount > RENDER_LOD_TRIANGLE_BUDGET;
}

/** The decimation target for a `triangleCount`-triangle mesh — see
 * `RENDER_LOD_TARGET_FRACTION`'s doc. */
export function lodTargetTriangleCount(triangleCount: number): number {
  return Math.min(RENDER_LOD_TRIANGLE_BUDGET, Math.round(triangleCount * RENDER_LOD_TARGET_FRACTION));
}
