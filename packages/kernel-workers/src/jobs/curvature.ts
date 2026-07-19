// jobs/curvature.ts — computeCurvature (Phase 2 Task 3): per-vertex mean
// (H) and Gaussian (K) curvature, plus principal curvatures (k1/k2), via
// @dqcad/kernel's curvature/ module (cotangent-weighted Laplace-Beltrami +
// Meyer et al. mixed Voronoi areas — see that module's curvature.ts for
// every formula/sign-convention/error-bound/boundary-policy doc).
//
// ## Per-worker result cache (Phase 3 Task 1 housekeeping: "jobs/offset.ts +
// jobs/curvature.ts stop rebuilding per call ... unify on contentHash-keyed
// per-worker caches", following jobs/bvh.ts's `bvhCache` pattern)
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
// contentHash alone is therefore a complete, valid cache key.
//
// `curvatureCache` below stores the CANONICAL (never-transferred) result;
// every return path clones it first — see `cloneResult`'s doc for why
// (Comlink's zero-copy transfer would otherwise detach the cache's own
// buffers on the very first response, before any "second call" could ever
// benefit). apps/client/src/engine/workers.ts's `ensureBvhBuilt` +
// `affinityKey: contentHash` (mirroring measurePointToSurface/raycastMesh's
// call-site convention) is what makes "build once, query many times against
// the SAME worker's cache" actually hold for engine/curvature.ts's caller.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import { computeCurvature, type IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { onBvhRelease, requireCachedBvh } from './bvh.ts';

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

/** Per-worker cache — see this file's module doc. Keyed by contentHash
 * alone (see that doc for why no other key component is needed). */
const curvatureCache = new Map<string, ComputeCurvatureResult>();

// Evict this cache's entry whenever the SAME contentHash's BVH is released
// (jobs/bvh.ts's `releaseBvh`) — mirrors jobs/geodesic.ts's `halfedgeCache`
// eviction: a released mesh's curvature job would fail on
// `requireCachedBvh` anyway (for a cache MISS), and a still-cached HIT for
// it is pure leaked memory otherwise.
onBvhRelease((contentHash) => {
  curvatureCache.delete(contentHash);
});

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

  const cached = curvatureCache.get(payload.contentHash);
  if (cached) {
    // Cache hit: the whole point of this task's brief — skip the O(vertices
    // + edges) recompute entirely, pay only a cheap buffer clone.
    ctx.progress(1);
    return cloneResult(cached);
  }

  const { mesh }: { mesh: IndexedMesh } = requireCachedBvh(payload.contentHash);
  const result = computeCurvature(mesh);
  curvatureCache.set(payload.contentHash, result);
  ctx.progress(1);
  return cloneResult(result);
};
