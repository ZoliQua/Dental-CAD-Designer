// jobs/margin.ts — proposeMargin (Phase 3 Task 4): @dqcad/kernel's margin/
// module (`proposeMarginLoop` — curvature-ridge (k2) bidirectional crest
// walk + curvature-adaptive anchor simplification; see that module's
// marginRidge.ts for the method, `@errorBound`, and determinism notes) as a
// single worker job.
//
// ## Per-worker caches (mirrors jobs/geodesic.ts's `halfedgeCache` /
// jobs/curvature.ts's `curvatureCache` — see those files' module docs for
// the full "why a per-worker cache, why contentHash" writeup)
//
// `buildBvh` must have been called for `payload.contentHash` on THIS worker
// first (jobs/bvh.ts's `requireCachedBvh`) — this job builds neither the
// BVH nor the halfedge overlay nor curvature itself if a cached copy already
// exists; each is a real, non-trivial per-call cost (curvature especially —
// O(vertices + edges)) that a repeated `proposeMargin` call against the SAME
// mesh (e.g. re-proposing after the user nudges the seed) would otherwise
// pay again for no reason. `halfedgeCache`/`curvatureCache` below are
// DUPLICATED from geodesic.ts's/curvature.ts's own module-private caches
// (not imported/shared) — same established convention those two files
// already follow independently for the same overlay/result, mirroring this
// repo's "duplicated rather than shared... N lines of fixture data, not
// shared logic" precedent for small, domain-local per-worker state (this is
// admittedly a REPEATED shape now across 3 files, not just fixture data —
// see this task's report for the housekeeping note this leaves for a future
// consolidation pass, out of THIS task's scope).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  buildHalfedge,
  computeCurvature,
  proposeMarginLoop,
  MARGIN_SEARCH_RADIUS_MM,
  NoRidgeFoundError,
  NoClosureError,
  type CurvatureResult,
  type HalfedgeMesh,
  type IndexedMesh,
  type SurfacePoint,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { onBvhRelease, requireCachedBvh } from './bvh.ts';
import type { Vec3Payload } from './shared.ts';

export { NoRidgeFoundError, NoClosureError };

const halfedgeCache = new Map<string, HalfedgeMesh>();
const curvatureCache = new Map<string, CurvatureResult>();

onBvhRelease((contentHash) => {
  halfedgeCache.delete(contentHash);
  curvatureCache.delete(contentHash);
});

function requireCachedHalfedge(contentHash: string, mesh: IndexedMesh): HalfedgeMesh {
  const cached = halfedgeCache.get(contentHash);
  if (cached) return cached;
  const hm = buildHalfedge(mesh);
  halfedgeCache.set(contentHash, hm);
  return hm;
}

function requireCachedCurvature(contentHash: string, mesh: IndexedMesh, hm: HalfedgeMesh): CurvatureResult {
  const cached = curvatureCache.get(contentHash);
  if (cached) return cached;
  const result = computeCurvature(mesh, hm);
  curvatureCache.set(contentHash, result);
  return result;
}

/** Worker-safe `SurfacePoint` shape — mirrors jobs/geodesic.ts's own
 * `SurfacePointPayload` (a separate, structurally-identical type per this
 * repo's established per-domain-module convention, not imported across
 * domain files — see jobs/registry.ts's re-export of BOTH under distinct
 * names, `SurfacePointPayload` and `SplineSurfacePointPayload`, for the
 * existing precedent this follows). */
export interface MarginSurfacePointPayload {
  triangleIndex: number;
  barycentric: Vec3Payload;
}

function toSurfacePoint(sp: MarginSurfacePointPayload): SurfacePoint {
  return { triangleIndex: sp.triangleIndex, barycentric: sp.barycentric as SurfacePoint['barycentric'] };
}

export interface ProposeMarginPayload {
  contentHash: string;
  seed: MarginSurfacePointPayload;
  /** See `ProposeMarginLoopOptions` (@dqcad/kernel) — all optional, kernel
   * defaults apply when omitted. */
  searchRadiusMm?: number;
  walkRadiusMm?: number;
  minRidgeStrength?: number;
  closureToleranceMm?: number;
  lookaheadSteps?: number;
  maxStepsPerDirection?: number;
  anchorAngleBudgetRad?: number;
  anchorMaxSpacingMm?: number;
}

export interface ProposeMarginResult {
  /** Ordered, closed-loop anchors, flattened — one `triangleIndices` entry
   * and 3 `barycentric` entries per anchor (same convention as
   * jobs/geodesic.ts's `flattenPoints`). Split back via
   * `triangleIndices[i]`/`barycentric[i*3..i*3+2]`. */
  triangleIndices: Uint32Array;
  barycentric: Float64Array;
  closed: true;
  /** Per-segment confidence, `triangleIndices.length` entries, same order
   * (`segmentConfidence[i]` covers anchor `i` -> anchor `(i+1) %
   * anchorCount`) — see `ProposeMarginLoopResult.segmentConfidence`
   * (@dqcad/kernel). */
  segmentConfidence: Float64Array;
  walkVertexCount: number;
  closureDeviationMm: number;
  searchRadiusMm: number;
}

/**
 * `proposeMargin`: curvature-ridge margin-loop auto-proposal on the mesh
 * cached under `payload.contentHash` (`buildBvh` must have been called for
 * it on THIS worker first — see this file's module doc). ONE synchronous,
 * non-yielding kernel call (same cancellation/progress granularity as
 * jobs/geodesic.ts's `geodesicPathJob` — a single checkpoint before starting
 * is this project's established pattern for this shape of job; the real
 * 250k-tri upperjaw fixture's own measured runtime — see this task's
 * report — is well under the sub-second scale that would ever need a
 * mid-call cancellation checkpoint).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if `buildBvh` was never called
 * for `payload.contentHash` on this worker.
 * @throws {NoRidgeFoundError} (@dqcad/kernel) if no ridge locus exists
 * within the bounded search region around `payload.seed`.
 * @throws {NoClosureError} (@dqcad/kernel) if a ridge is found but the walk
 * never closes into a loop.
 */
export const proposeMarginJob = async (payload: ProposeMarginPayload, ctx: JobContext): Promise<ProposeMarginResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh } = requireCachedBvh(payload.contentHash);
  const hm = requireCachedHalfedge(payload.contentHash, mesh);
  const curvature = requireCachedCurvature(payload.contentHash, mesh, hm);
  const seed = toSurfacePoint(payload.seed);

  const result = proposeMarginLoop(mesh, hm, curvature, seed, {
    searchRadiusMm: payload.searchRadiusMm,
    walkRadiusMm: payload.walkRadiusMm,
    minRidgeStrength: payload.minRidgeStrength,
    closureToleranceMm: payload.closureToleranceMm,
    lookaheadSteps: payload.lookaheadSteps,
    maxStepsPerDirection: payload.maxStepsPerDirection,
    anchorAngleBudgetRad: payload.anchorAngleBudgetRad,
    anchorMaxSpacingMm: payload.anchorMaxSpacingMm,
  });

  ctx.progress(1);
  const triangleIndices = new Uint32Array(result.anchors.length);
  const barycentric = new Float64Array(result.anchors.length * 3);
  for (let i = 0; i < result.anchors.length; i++) {
    const a = result.anchors[i]!;
    triangleIndices[i] = a.triangleIndex;
    barycentric[i * 3] = a.barycentric[0];
    barycentric[i * 3 + 1] = a.barycentric[1];
    barycentric[i * 3 + 2] = a.barycentric[2];
  }
  return {
    triangleIndices,
    barycentric,
    closed: result.closed,
    segmentConfidence: Float64Array.from(result.segmentConfidence),
    walkVertexCount: result.walkVertexCount,
    closureDeviationMm: result.closureDeviationMm,
    searchRadiusMm: result.searchRadiusMm,
  };
};

/** Re-exported so callers (and tests) can reference the default without a
 * direct `@dqcad/kernel` import in engine code — mirrors kernel-workers'
 * own top-level `index.ts` re-export precedent (e.g. `DEFAULT_MAX_BOUNDARY_EDGES`). */
export { MARGIN_SEARCH_RADIUS_MM };
