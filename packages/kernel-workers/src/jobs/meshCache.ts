// jobs/meshCache.ts — Phase 4 Task 1 carry-in: the CONSOLIDATED per-worker
// halfedge/curvature cache, replacing the 4 independent `halfedgeCache`
// copies (jobs/geodesic.ts, jobs/margin.ts, jobs/axis.ts, jobs/blockout.ts)
// and the 2 independent `curvatureCache` copies (jobs/curvature.ts,
// jobs/margin.ts) this task's brief calls out ("curvature 2x, halfedge 4x
// per contentHash — consolidate before Phase 4's new job families multiply
// them further").
//
// ## Why this was safe to consolidate NOW (it wasn't an accident that it
// stayed duplicated through Phase 2/3)
//
// Every one of the 6 duplicated caches this file replaces used the EXACT
// SAME shape — `Map<contentHash, T>`, built lazily via `buildHalfedge(mesh)`
// / `computeCurvature(mesh, hm)`, evicted via an `onBvhRelease` listener —
// independently arrived at by 5 different files (jobs/geodesic.ts's own
// module doc even names this: "duplicated per this repo's established
// per-domain-module convention... admittedly a REPEATED shape now across 3
// files"). `buildHalfedge`/`computeCurvature` are PURE functions of `mesh`
// alone (computeCurvature's own doc: "Builds its own HalfedgeMesh internally
// ... unless the caller already has one" — passing a shared, externally
// -built `HalfedgeMesh` produces the IDENTICAL `CurvatureResult` a
// job-private one would, since `buildHalfedge` itself is a pure,
// deterministic function of `mesh`) — so replacing 6 independent Maps with
// ONE shared pair changes WHICH cache instance a lookup hits, never WHAT
// VALUE it computes. This is proven, not just argued: every job/golden test
// touching curvature or halfedge-dependent output (geodesicJobs, marginJobs,
// axisJobs, blockoutJobs, curvatureJob, plus every golden suite) is run
// unchanged after this consolidation, and NONE of their pinned hashes moved
// — see this task's report for the full re-run.
//
// ## Shape: mirrors jobs/bvh.ts's `bvhCache` — the canonical per-worker
// -cache pattern this repo already established
//
// Same "module-level `Map`, lifetime of this worker thread" convention
// (jobs/bvh.ts's own module doc), same `onBvhRelease` eviction hook (both
// caches below register a listener that deletes their entry for a released
// contentHash — a released mesh's halfedge/curvature jobs would fail on
// `requireCachedBvh` anyway, so a still-cached entry for it is pure leaked
// memory, same reasoning `jobs/geodesic.ts`'s original `halfedgeCache`
// already documented).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import { buildHalfedge, computeCurvature, type CurvatureResult, type HalfedgeMesh, type IndexedMesh } from '@dqcad/kernel';
import { onBvhRelease } from './bvh.ts';

const halfedgeCache = new Map<string, HalfedgeMesh>();
const curvatureCache = new Map<string, CurvatureResult>();

onBvhRelease((contentHash) => {
  halfedgeCache.delete(contentHash);
  curvatureCache.delete(contentHash);
});

/**
 * Returns the cached `HalfedgeMesh` for `contentHash` on THIS worker,
 * building (and caching) it on first use. Shared by every job that needs a
 * halfedge overlay: jobs/geodesic.ts, jobs/margin.ts, jobs/axis.ts,
 * jobs/blockout.ts, jobs/curvature.ts.
 */
export function requireCachedHalfedge(contentHash: string, mesh: IndexedMesh): HalfedgeMesh {
  const cached = halfedgeCache.get(contentHash);
  if (cached) return cached;
  const hm = buildHalfedge(mesh);
  halfedgeCache.set(contentHash, hm);
  return hm;
}

/**
 * Returns the cached `CurvatureResult` for `contentHash` on THIS worker,
 * computing (and caching) it on first use — reuses `hm` (never rebuilds a
 * halfedge overlay internally; pass `requireCachedHalfedge`'s own result).
 * Shared by jobs/curvature.ts and jobs/margin.ts (previously two
 * independent `curvatureCache` copies — see this file's module doc).
 */
export function requireCachedCurvature(contentHash: string, mesh: IndexedMesh, hm: HalfedgeMesh): CurvatureResult {
  const cached = curvatureCache.get(contentHash);
  if (cached) return cached;
  const result = computeCurvature(mesh, hm);
  curvatureCache.set(contentHash, result);
  return result;
}

/** TEST-ONLY: exposes the two caches' current sizes, so cache-consolidation
 * determinism/sharing tests (meshCache.test.ts) can assert a SECOND job for
 * the same contentHash reuses (does not grow) the cache, without reaching
 * into module-private state via any other means. */
export function __testOnlyCacheSizes(): { halfedge: number; curvature: number } {
  return { halfedge: halfedgeCache.size, curvature: curvatureCache.size };
}
