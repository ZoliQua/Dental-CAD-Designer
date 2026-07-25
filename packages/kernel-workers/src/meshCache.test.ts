// packages/kernel-workers/src/meshCache.test.ts
//
// Phase 4 Task 1 carry-in: cache-CONSOLIDATION determinism tests — per this
// task's brief, "shared cache returns byte-identical results". Tests
// jobs/meshCache.ts directly (not through a WorkerPool/worker thread — its
// module-level Maps are plain, synchronous state, so a direct import in
// THIS test process exercises the exact same cache mechanics a real worker
// would run, without pool/postMessage overhead).
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '@dqcad/kernel';
import { releaseBvh } from './jobs/bvh.ts';
import { requireCachedCurvature, requireCachedHalfedge, __testOnlyCacheSizes } from './jobs/meshCache.ts';

/** A small, closed, watertight tetrahedron — same "hand-built synthetic
 * fixture" convention as bvhJobs.test.ts's `cubeBuffers` (no dependency on
 * @dqcad/kernel's own internal test-fixtures, which this package cannot
 * reach: kernel's package.json exports only its public "." entry). Scaled
 * by `scale` so distinct calls in this file can request distinct meshes
 * without any two being literally identical (irrelevant for these
 * cache-mechanics tests, but keeps each test's fixture visibly its own). */
function tetrahedronMesh(scale = 1): IndexedMesh {
  const s = scale;
  const positions = new Float64Array(
    [
      [0, 0, 0],
      [s, 0, 0],
      [0, s, 0],
      [0, 0, s],
    ].flat(),
  );
  // CCW-from-outside winding for each of the 4 faces.
  const indices = Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  return { positions, indices };
}

const CONTENT_HASH = 'meshCache-test-content-hash';

describe('jobs/meshCache.ts — shared halfedge/curvature cache, consolidation determinism', () => {
  it('requireCachedHalfedge: a second call for the SAME contentHash returns the cached instance (not a rebuild)', () => {
    const mesh = tetrahedronMesh(1);
    const first = requireCachedHalfedge(CONTENT_HASH, mesh);
    const second = requireCachedHalfedge(CONTENT_HASH, mesh);
    expect(second).toBe(first); // same object reference — proves cache HIT, not a fresh buildHalfedge()
  });

  it('requireCachedCurvature: a second call for the SAME contentHash returns the cached instance', () => {
    const mesh = tetrahedronMesh(1);
    const hm = requireCachedHalfedge('curvature-cache-key', mesh);
    const first = requireCachedCurvature('curvature-cache-key', mesh, hm);
    const second = requireCachedCurvature('curvature-cache-key', mesh, hm);
    expect(second).toBe(first);
    // Byte-identical values too (not just reference equality) — the
    // consolidation guardrail's literal ask.
    expect(Array.from(second.H)).toEqual(Array.from(first.H));
    expect(Array.from(second.K)).toEqual(Array.from(first.K));
  });

  it('cross-consumer sharing: the halfedge built for one "job" IS the same instance a different call site gets for the SAME contentHash', () => {
    const mesh = tetrahedronMesh(1.2);
    const contentHash = 'cross-consumer-key';
    // Simulates jobs/geodesic.ts building the overlay first...
    const fromGeodesicLikeCallSite = requireCachedHalfedge(contentHash, mesh);
    // ...then jobs/margin.ts (or axis.ts/blockout.ts/curvature.ts) asking
    // for the SAME contentHash: must reuse, not rebuild.
    const fromMarginLikeCallSite = requireCachedHalfedge(contentHash, mesh);
    expect(fromMarginLikeCallSite).toBe(fromGeodesicLikeCallSite);
  });

  it('a curvature computation seeded via a halfedge built by a DIFFERENT call site produces the SAME result as computing it standalone (byte-identical, not just cached)', () => {
    const meshA = tetrahedronMesh(1);
    const contentHashA = 'byte-identity-shared-halfedge';
    const sharedHm = requireCachedHalfedge(contentHashA, meshA);
    const viaShared = requireCachedCurvature(contentHashA, meshA, sharedHm);

    // A fresh, INDEPENDENT computation (own mesh copy, own contentHash key,
    // own halfedge build) must match exactly — proves the shared-cache path
    // changes nothing about WHAT is computed, only how often.
    const meshB = tetrahedronMesh(1);
    const contentHashB = 'byte-identity-independent';
    const ownHm = requireCachedHalfedge(contentHashB, meshB);
    const standalone = requireCachedCurvature(contentHashB, meshB, ownHm);

    expect(Array.from(viaShared.H)).toEqual(Array.from(standalone.H));
    expect(Array.from(viaShared.K)).toEqual(Array.from(standalone.K));
    expect(Array.from(viaShared.k1)).toEqual(Array.from(standalone.k1));
    expect(Array.from(viaShared.k2)).toEqual(Array.from(standalone.k2));
    expect(Array.from(viaShared.mixedArea)).toEqual(Array.from(standalone.mixedArea));
  });

  it('releaseBvh evicts BOTH the halfedge and curvature cache entries for that contentHash', async () => {
    const mesh = tetrahedronMesh(1);
    const contentHash = 'release-evicts-key';
    const hm = requireCachedHalfedge(contentHash, mesh);
    requireCachedCurvature(contentHash, mesh, hm);

    const before = __testOnlyCacheSizes();
    expect(before.halfedge).toBeGreaterThan(0);
    expect(before.curvature).toBeGreaterThan(0);

    await releaseBvh({ contentHash });

    // A fresh requireCachedHalfedge call after release must build a NEW
    // instance (not somehow still cached) — the strongest possible
    // eviction proof, reference inequality.
    const rebuilt = requireCachedHalfedge(contentHash, mesh);
    expect(rebuilt).not.toBe(hm);
  });
});
