// computeCurvature job tests (Phase 2 Task 3) — worker round-trip wiring
// (transferables, progress, cancellation) for the computeCurvature job. The
// curvature ALGORITHM itself (cotan weights, mixed Voronoi areas, H/K/k1/k2
// formulas, sign conventions, boundary policy) is exhaustively covered at
// the kernel level (packages/kernel/src/curvature/*.test.ts) — these tests
// only prove the job wires @dqcad/kernel's `computeCurvature` through a
// real worker correctly.
import { afterEach, describe, expect, it } from 'vitest';
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

describe('WorkerPool — computeCurvature', () => {
  it('computes per-vertex H/K/k1/k2, reports progress ending at 1, and transfers buffers', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = octahedronBuffers();
    const sourcePositionsBuffer = positions.buffer;
    const sourceIndicesBuffer = indices.buffer;
    const progressValues: number[] = [];

    const result = await pool.run(
      'computeCurvature',
      { positions, indices },
      { transfer: [positions.buffer, indices.buffer], onProgress: (fraction) => progressValues.push(fraction) },
    );

    expect(sourcePositionsBuffer.byteLength).toBe(0); // moved, not copied
    expect(sourceIndicesBuffer.byteLength).toBe(0);
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
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run('computeCurvature', { positions, indices }, { signal: controller.signal }),
    ).rejects.toThrow(JobCancelledError);
  });

  it('rejects a non-Float64 positions payload (kernel Float64 rule)', async () => {
    const pool = createPool({ size: 1 });
    const { indices } = octahedronBuffers();
    await expect(
      pool.run('computeCurvature', {
        // @ts-expect-error — deliberately wrong typed-array kind, to exercise requireMeshPayload's guard.
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices,
      }),
    ).rejects.toThrow(/Float64Array/);
  });
});
