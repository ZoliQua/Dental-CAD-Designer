// jobs/curvature.ts — computeCurvature (Phase 2 Task 3): per-vertex mean
// (H) and Gaussian (K) curvature, plus principal curvatures (k1/k2), via
// @dqcad/kernel's curvature/ module (cotangent-weighted Laplace-Beltrami +
// Meyer et al. mixed Voronoi areas — see that module's curvature.ts for
// every formula/sign-convention/error-bound/boundary-policy doc).
//
// ## Per-worker result cache (Phase 3 Task 1 housekeeping: "jobs/offset.ts +
// jobs/curvature.ts stop rebuilding per call ... unify on contentHash-keyed
// per-worker caches", following jobs/bvh.ts's `bvhCache` pattern; Phase 4
// Task 1 carry-in: consolidated with jobs/margin.ts's own independent
// curvature cache into `jobs/meshCache.ts`'s single shared pair — see that
// file's module doc)
//
// Like jobs/geodesic.ts, this job takes a `contentHash` (NOT the raw mesh
// buffers) and requires `buildBvh` to have already been called for that
// contentHash ON THIS WORKER (jobs/bvh.ts's `requireCachedBvh`) — repeated
// curvature requests for the SAME mesh (e.g. re-opening the curvature
// overlay, or a future margin-ridge-detection consumer querying the same
// field twice) skip both the buffer re-send AND the full cotan-Laplacian /
// mixed-Voronoi-area recompute, which is the expensive part (O(vertices +
// edges), not free at real-scan scale). Curvature is a pure function of the
// mesh ALONE (no parameters, unlike jobs/offset.ts's distanceMm/pitchMm) —
// contentHash alone is therefore a complete, valid cache key. This job now
// ALSO caches its halfedge overlay (via the same shared
// `requireCachedHalfedge`) — a happy side effect of consolidation: a LATER
// margin/axis/blockout/geodesic call for the SAME mesh reuses the halfedge
// overlay this job built, and vice versa, regardless of call order.
//
// `curvatureCache` (in jobs/meshCache.ts) stores the CANONICAL
// (never-transferred) result; every return path clones it first — see
// `cloneResult`'s doc for why (Comlink's zero-copy transfer would otherwise
// detach the cache's own buffers on the very first response, before any
// "second call" could ever benefit). apps/client/src/engine/workers.ts's
// `ensureBvhBuilt` + `affinityKey: contentHash` (mirroring
// measurePointToSurface/raycastMesh's call-site convention) is what makes
// "build once, query many times against the SAME worker's cache" actually
// hold for engine/curvature.ts's caller.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import type { IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireCachedBvh } from './bvh.ts';
import { requireCachedCurvature, requireCachedHalfedge } from './meshCache.ts';

export interface ComputeCurvaturePayload {
  contentHash: string;
}

export interface ComputeCurvatureResult {
  /** Signed mean curvature per vertex, mm^-1. */
  H: Float64Array;
  /** Gaussian curvature per vertex, mm^-2. */
  K: Float64Array;
  /** Larger principal curvature (k1 >= k2), mm^-1. */
  k1: Float64Array;
  /** Smaller principal curvature, mm^-1. */
  k2: Float64Array;
  /** `1` for a boundary/isolated vertex (H/K/k1/k2 are `0`, not meaningful
   * there — see @dqcad/kernel's curvature.ts "Boundary policy" doc), `0`
   * otherwise. */
  isBoundary: Uint8Array;
  /** Mixed Voronoi area per vertex, mm^2. */
  mixedArea: Float64Array;
}

/** Deep-clones a `ComputeCurvatureResult`'s typed arrays. REQUIRED before
 * ever returning a value that came out of `curvatureCache`: jobs/registry.ts's
 * `runJob` auto-transfers (zero-copy, via `transferablesOf`) every top-level
 * typed-array field of a job's result back to the caller — transferring an
 * `ArrayBuffer` DETACHES it in the sender (this worker) too, so returning
 * the cached master directly would neuter the very cache entry a later hit
 * needs. Applied on EVERY return path (including the first, cache-miss
 * call) — the cache always holds an untransferred master. */
function cloneResult(result: ComputeCurvatureResult): ComputeCurvatureResult {
  return {
    H: result.H.slice(),
    K: result.K.slice(),
    k1: result.k1.slice(),
    k2: result.k2.slice(),
    isBoundary: result.isBoundary.slice(),
    mixedArea: result.mixedArea.slice(),
  };
}

/**
 * `computeCurvature` job — see this file's module doc for the per-worker
 * cache contract. `buildBvh` must have been called for `payload.contentHash`
 * on THIS worker first (jobs/bvh.ts).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if `buildBvh` was never called
 * for `payload.contentHash` on this worker AND this worker has no cached
 * curvature result for it either (a genuine cache miss with no mesh to
 * compute from).
 */
export const computeCurvatureJob = async (
  payload: ComputeCurvaturePayload,
  ctx: JobContext,
): Promise<ComputeCurvatureResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh }: { mesh: IndexedMesh } = requireCachedBvh(payload.contentHash);
  const hm = requireCachedHalfedge(payload.contentHash, mesh);
  const result = requireCachedCurvature(payload.contentHash, mesh, hm);
  ctx.progress(1);
  return cloneResult(result);
};
