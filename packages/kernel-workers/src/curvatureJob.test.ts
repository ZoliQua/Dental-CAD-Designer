// computeCurvature job tests (Phase 2 Task 3; Phase 3 Task 1 housekeeping:
// contentHash-keyed per-worker result cache) — worker round-trip wiring
// (transferables, progress, cancellation, caching) for the computeCurvature
// job. The curvature ALGORITHM itself (cotan weights, mixed Voronoi areas,
// H/K/k1/k2 formulas, sign conventions, boundary policy) is exhaustively
// covered at the kernel level (packages/kernel/src/curvature/*.test.ts) —
// these tests only prove the job wires @dqcad/kernel's `computeCurvature`
// through a real worker correctly, PLUS the cache/eviction contract added by
// this housekeeping task (jobs/curvature.ts's module doc).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
import { intake, type IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];

function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

// Outward-wound unit octahedron (radius 1, centered at the origin) — a
// small, well-known closed manifold (same shape family as
// packages/kernel/src/halfedge/halfedge.test-fixtures.ts's
// `octahedronMesh`, reconstructed here rather than imported since
// kernel-workers may depend on @dqcad/kernel but not on its TEST-ONLY
// fixture files).
function octahedronBuffers(): { positions: Float64Array; indices: Uint32Array } {
  const positions = new Float64Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
  const indices = Uint32Array.from(
    [
      [0, 2, 4],
      [2, 1, 4],
      [1, 3, 4],
      [3, 0, 4],
      [2, 0, 5],
      [1, 2, 5],
      [3, 1, 5],
      [0, 3, 5],
    ].flat(),
  );
  return { positions, indices };
}

const CONTENT_HASH = 'octahedron-test-hash';

async function buildBvhFor(
  pool: WorkerPool,
  contentHash: string,
  positions: Float64Array,
  indices: Uint32Array,
): Promise<void> {
  await pool.run('buildBvh', { contentHash, positions, indices });
}

describe('WorkerPool — computeCurvature', () => {
  it('computes per-vertex H/K/k1/k2, reports progress ending at 1, and transfers buffers', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = octahedronBuffers();
    await buildBvhFor(pool, CONTENT_HASH, positions.slice(), indices.slice());
    const progressValues: number[] = [];

    const result = await pool.run(
      'computeCurvature',
      { contentHash: CONTENT_HASH },
      { onProgress: (fraction) => progressValues.push(fraction) },
    );

    expect(progressValues).toEqual([0, 1]);

    expect(result.H).toHaveLength(6);
    expect(result.K).toHaveLength(6);
    expect(result.k1).toHaveLength(6);
    expect(result.k2).toHaveLength(6);
    expect(result.isBoundary).toHaveLength(6);
    expect(result.mixedArea).toHaveLength(6);

    // Octahedron is closed (genus 0) — no vertex should be boundary-flagged,
    // and every vertex (a convex corner) has a strictly positive Gaussian
    // curvature and a positive mean curvature (bulges outward).
    for (let v = 0; v < 6; v++) {
      expect(result.isBoundary[v]).toBe(0);
      expect(result.K[v]).toBeGreaterThan(0);
      expect(result.H[v]).toBeGreaterThan(0);
      expect(result.k1[v]!).toBeGreaterThanOrEqual(result.k2[v]!);
    }
  });

  it('is cancellable before it starts', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = octahedronBuffers();
    await buildBvhFor(pool, CONTENT_HASH, positions, indices);
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run('computeCurvature', { contentHash: CONTENT_HASH }, { signal: controller.signal }),
    ).rejects.toThrow(JobCancelledError);
  });

  it('rejects a contentHash with no cached BVH on this worker', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('computeCurvature', { contentHash: 'never-built' }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it(
    'a second call for the SAME contentHash (cache hit, per this file\'s module doc) returns a ' +
      'byte-identical, independently-transferable result',
    async () => {
      const pool = createPool({ size: 1 });
      const { positions, indices } = octahedronBuffers();
      await buildBvhFor(pool, CONTENT_HASH, positions, indices);

      const first = await pool.run('computeCurvature', { contentHash: CONTENT_HASH });
      const second = await pool.run('computeCurvature', { contentHash: CONTENT_HASH });

      // Distinct buffer identities (each response is its own clone — see
      // jobs/curvature.ts's `cloneResult` doc) yet byte-identical content —
      // proves the cache's master arrays survive being transferred out
      // repeatedly, which would fail (zero-length arrays) if a return path
      // ever handed back the cache's own buffer instead of a clone.
      expect(second.H.buffer).not.toBe(first.H.buffer);
      expect(Array.from(second.H)).toEqual(Array.from(first.H));
      expect(Array.from(second.K)).toEqual(Array.from(first.K));
      expect(Array.from(second.k1)).toEqual(Array.from(first.k1));
      expect(Array.from(second.k2)).toEqual(Array.from(first.k2));
      expect(Array.from(second.mixedArea)).toEqual(Array.from(first.mixedArea));
      expect(Array.from(second.isBoundary)).toEqual(Array.from(first.isBoundary));
    },
  );

  it('evicts the cached curvature result when releaseBvh runs for the same contentHash', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = octahedronBuffers();
    await buildBvhFor(pool, CONTENT_HASH, positions, indices);
    await pool.run('computeCurvature', { contentHash: CONTENT_HASH }); // populates the cache
    await pool.run('releaseBvh', { contentHash: CONTENT_HASH });

    // The cache entry is gone AND the BVH is gone — a follow-up call must
    // fail with BvhNotCachedError (no cache to fall back on, no mesh to
    // recompute from), proving eviction actually happened rather than the
    // cache silently outliving the BVH it was keyed alongside.
    await expect(
      pool.run('computeCurvature', { contentHash: CONTENT_HASH }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('cache isolation: releasing a DIFFERENT contentHash does not evict this one', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = octahedronBuffers();
    await buildBvhFor(pool, CONTENT_HASH, positions, indices);
    await buildBvhFor(pool, 'other-hash', positions.slice(), indices.slice());
    await pool.run('computeCurvature', { contentHash: CONTENT_HASH });

    await pool.run('releaseBvh', { contentHash: 'other-hash' });

    // Still cached/buildable — unaffected by the unrelated release.
    await expect(pool.run('computeCurvature', { contentHash: CONTENT_HASH })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Performance guardrail (Phase 3 Task 1 housekeeping's job-cache
// unification) — real arch-case-01 upperjaw fixture (250,128 triangles,
// same fixture geodesicJobs.test.ts's own perf guardrail uses). Proves the
// per-worker result cache (this file's module doc) actually delivers what
// "stop rebuilding per call" promises: a SECOND computeCurvature call for
// the SAME contentHash must be dramatically cheaper than the first (a cache
// MISS, paying the full cotan-Laplacian + mixed-Voronoi-area computation)
// rather than repeating that cost — logged (not hard-gated on an exact
// ratio, matching this repo's other perf-guardrail tests' convention of
// reporting the real number over asserting a brittle one) via console.log
// for the task report.
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const upperjawStlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');

function loadUpperjawMesh(): IndexedMesh {
  const bytes = readFileSync(upperjawStlPath);
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

describe('computeCurvature job — performance guardrail (real upperjaw fixture, cache unification)', () => {
  it(
    'a second computeCurvature call for the SAME contentHash (cache hit) is dramatically faster than the first (cache miss)',
    { timeout: 60_000 },
    async () => {
      const mesh = loadUpperjawMesh();
      const triangleCount = mesh.indices.length / 3;
      expect(triangleCount).toBeGreaterThan(200_000); // sanity: this really is the ~250k-tri fixture

      const pool = createPool({ size: 1 });
      const contentHash = 'upperjaw-curvature-perf';
      const buildStart = performance.now();
      await pool.run('buildBvh', {
        contentHash,
        positions: mesh.positions.slice(),
        indices: mesh.indices.slice(),
      });
      const buildMs = performance.now() - buildStart;

      const missStart = performance.now();
      const first = await pool.run('computeCurvature', { contentHash });
      const missMs = performance.now() - missStart;

      const hitStart = performance.now();
      const second = await pool.run('computeCurvature', { contentHash });
      const hitMs = performance.now() - hitStart;

      expect(first.H.length).toBe(mesh.positions.length / 3);
      expect(Array.from(second.H)).toEqual(Array.from(first.H)); // still byte-identical

      console.log(
        `[computeCurvature cache perf] upperjaw (${triangleCount} triangles): buildBvh ${buildMs.toFixed(1)}ms, ` +
          `cache MISS (first call) ${missMs.toFixed(1)}ms, cache HIT (second call) ${hitMs.toFixed(1)}ms ` +
          `(${(missMs / Math.max(hitMs, 0.01)).toFixed(1)}x faster)`,
      );

      // Not a brittle exact-ratio assertion (machine-dependent) — just proves
      // the cache hit is genuinely cheaper, not accidentally as slow as a
      // full recompute (which would mean the cache isn't actually being hit).
      expect(hitMs).toBeLessThan(missMs);
    },
  );
});
