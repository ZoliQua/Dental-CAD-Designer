// sdf job tests (buildSdf / signedClosestPoint / sampleSdfGrid — Phase 2
// Task 6) — exercised via a real Node worker_threads WorkerPool, same
// rationale as bvhJobs.test.ts / geodesicJobs.test.ts: job logic is
// environment-agnostic, so testing it through the real Comlink transport
// also proves payload shapes and thrown-error names survive the postMessage
// boundary. The SDF algorithm itself (pseudonormal correctness, sign
// convention, grid sampling) is exhaustively covered at the kernel level
// (packages/kernel/src/sdf/*.test.ts) — these tests only prove the jobs wire
// @dqcad/kernel's sdf/ module through a real worker correctly, including the
// per-worker Pseudonormals cache + BVH-release eviction contract (jobs/sdf.ts's
// module doc) and the grid job's progress/cancellation/memory-guard behavior.
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

// ---------------------------------------------------------------------------
// Fixtures: outward-wound unit cube (watertight — same as bvhJobs.test.ts's)
// and an outward-wound octahedron (watertight, different topology — used for
// the cache-eviction test) plus an OPEN grid patch (not watertight — for the
// NonWatertightMeshError rejection test).
// ---------------------------------------------------------------------------

const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const CUBE_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [0, 4, 7],
  [0, 7, 3],
];

function cubeBuffers(): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: new Float64Array(CUBE_CORNERS.flat()),
    indices: Uint32Array.from(CUBE_TRIANGLES.flat()),
  };
}

function octahedronBuffers(radius = 1): { positions: Float64Array; indices: Uint32Array } {
  const positions: [number, number, number][] = [
    [radius, 0, 0],
    [-radius, 0, 0],
    [0, radius, 0],
    [0, -radius, 0],
    [0, 0, radius],
    [0, 0, -radius],
  ];
  const triangles: [number, number, number][] = [
    [0, 2, 4],
    [2, 1, 4],
    [1, 3, 4],
    [3, 0, 4],
    [2, 0, 5],
    [1, 2, 5],
    [3, 1, 5],
    [0, 3, 5],
  ];
  return {
    positions: new Float64Array(positions.flat()),
    indices: Uint32Array.from(triangles.flat()),
  };
}

function openPatchBuffers(): { positions: Float64Array; indices: Uint32Array } {
  // A single open quad (2 triangles, 4 boundary edges) — not watertight.
  const positions: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  const triangles: [number, number, number][] = [
    [0, 1, 2],
    [0, 2, 3],
  ];
  return {
    positions: new Float64Array(positions.flat()),
    indices: Uint32Array.from(triangles.flat()),
  };
}

const CUBE_HASH = 'sdf-cube-hash';
const OCTA_HASH_SAME_AS_CUBE = CUBE_HASH; // reused deliberately for the eviction test.
const OPEN_HASH = 'sdf-open-hash';

describe('buildSdf + signedClosestPoint (single-worker cache)', () => {
  it('requires buildBvh first — BvhNotCachedError if buildSdf is called without it', async () => {
    const pool = createPool({ size: 1 });
    await expect(pool.run('buildSdf', { contentHash: 'never-built' })).rejects.toMatchObject({
      name: 'BvhNotCachedError',
    });
  });

  it('caches pseudonormals under contentHash; reports correct face/vertex/halfedge counts', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const built = await pool.run('buildSdf', { contentHash: CUBE_HASH });
    expect(built.contentHash).toBe(CUBE_HASH);
    expect(built.faceCount).toBe(12);
    expect(built.vertexCount).toBe(8);
    expect(built.halfedgeCount).toBe(36);
  });

  it('signedClosestPoint requires buildSdf first — SdfNotCachedError if only buildBvh was called', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    await expect(
      pool.run('signedClosestPoint', { contentHash: CUBE_HASH, point: [0.5, 0.5, 3] }),
    ).rejects.toMatchObject({ name: 'SdfNotCachedError' });
  });

  it('signedClosestPoint reports the correct sign and distance for the unit cube', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    await pool.run('buildSdf', { contentHash: CUBE_HASH });

    // Outside: 2 units above the top face's center.
    const outside = await pool.run('signedClosestPoint', { contentHash: CUBE_HASH, point: [0.5, 0.5, 3] });
    expect(outside.distance).toBeCloseTo(2, 12);
    expect(outside.signedDistance).toBeCloseTo(2, 12);

    // Inside: the cube's own center.
    const inside = await pool.run('signedClosestPoint', { contentHash: CUBE_HASH, point: [0.5, 0.5, 0.5] });
    expect(inside.signedDistance).toBeCloseTo(-0.5, 12);
    expect(inside.signedDistance).toBeLessThan(0);
  });

  it('throws NonWatertightMeshError for an open mesh', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = openPatchBuffers();
    await pool.run('buildBvh', { contentHash: OPEN_HASH, positions, indices });
    await expect(pool.run('buildSdf', { contentHash: OPEN_HASH })).rejects.toMatchObject({
      name: 'NonWatertightMeshError',
    });
  });

  it('releaseBvh also evicts the per-worker SDF cache — a rebuild under the SAME contentHash with a DIFFERENT-topology mesh requires a fresh buildSdf call', async () => {
    const pool = createPool({ size: 1 });
    const cube = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions: cube.positions, indices: cube.indices });
    await pool.run('buildSdf', { contentHash: CUBE_HASH });
    // Warm cache confirmed usable.
    await pool.run('signedClosestPoint', { contentHash: CUBE_HASH, point: [0.5, 0.5, 3] });

    await pool.run('releaseBvh', { contentHash: CUBE_HASH });

    const octa = octahedronBuffers(2);
    await pool.run('buildBvh', {
      contentHash: OCTA_HASH_SAME_AS_CUBE,
      positions: octa.positions,
      indices: octa.indices,
    });
    // If jobs/sdf.ts's per-worker cache were NOT evicted on releaseBvh, this
    // would silently succeed using the STALE cube pseudonormals (8
    // vertices/12 faces) against the octahedron's buffers (6 vertices/8
    // faces) — wrong data, no error. With correct eviction, buildSdf must be
    // called again before signedClosestPoint works.
    await expect(
      pool.run('signedClosestPoint', { contentHash: OCTA_HASH_SAME_AS_CUBE, point: [0, 0, 5] }),
    ).rejects.toMatchObject({ name: 'SdfNotCachedError' });

    const rebuilt = await pool.run('buildSdf', { contentHash: OCTA_HASH_SAME_AS_CUBE });
    expect(rebuilt.faceCount).toBe(8);
    expect(rebuilt.vertexCount).toBe(6);

    const outside = await pool.run('signedClosestPoint', {
      contentHash: OCTA_HASH_SAME_AS_CUBE,
      point: [0, 0, 5],
    });
    expect(outside.signedDistance).toBeCloseTo(3, 10); // octahedron radius 2, point at z=5.
  });
});

describe('sampleSdfGrid', () => {
  it('produces the expected grid dims/origin and a sign-transition across the surface, with progress ending at 1', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    await pool.run('buildSdf', { contentHash: CUBE_HASH });

    const progressValues: number[] = [];
    const result = await pool.run(
      'sampleSdfGrid',
      {
        contentHash: CUBE_HASH,
        bboxMin: [-0.5, -0.5, -0.5],
        bboxMax: [1.5, 1.5, 1.5],
        pitchMm: 0.5,
      },
      { onProgress: (fraction) => progressValues.push(fraction) },
    );

    expect(result.dims).toEqual([5, 5, 5]); // extent 2 / pitch 0.5 + 1
    expect(result.origin).toEqual([-0.5, -0.5, -0.5]);
    expect(result.bandMm).toBeNull();
    expect(result.grid.length).toBe(5 * 5 * 5);
    expect(progressValues.length).toBeGreaterThan(1); // one per z-slice (5 slices).
    expect(progressValues[progressValues.length - 1]).toBe(1);

    // Center of the grid (index 2,2,2 -> world (0.5,0.5,0.5), the cube's own
    // center) must be negative (inside); a corner (index 0,0,0 -> world
    // (-0.5,-0.5,-0.5)) must be positive (outside).
    const [nx, ny] = result.dims;
    const centerFlat = 2 * ny * nx + 2 * nx + 2;
    const cornerFlat = 0;
    expect(result.grid[centerFlat]).toBeLessThan(0);
    expect(result.grid[cornerFlat]).toBeGreaterThan(0);
  });

  it('is cancellable BEFORE it starts (pre-flight: signal already aborted when run() is called)', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    await pool.run('buildSdf', { contentHash: CUBE_HASH });

    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'sampleSdfGrid',
        {
          contentHash: CUBE_HASH,
          bboxMin: [-0.5, -0.5, -0.5],
          bboxMax: [1.5, 1.5, 1.5],
          pitchMm: 0.1,
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it('is cancellable GENUINELY MID-GRID (abort triggered from the onProgress hook, after the first z-slice has already completed) — the job must not run to completion', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    await pool.run('buildSdf', { contentHash: CUBE_HASH });

    // extent 2 / pitch 0.1 + 1 = 21 slices along z — comfortably >= 3, so
    // aborting after slice 1's progress event leaves most of the grid
    // (slices 2-20) genuinely unrun, not a fluke of a 1-or-2-slice grid.
    const controller = new AbortController();
    const progressValues: number[] = [];
    let abortedAfterFirstSlice = false;
    await expect(
      pool.run(
        'sampleSdfGrid',
        {
          contentHash: CUBE_HASH,
          bboxMin: [-0.5, -0.5, -0.5],
          bboxMax: [1.5, 1.5, 1.5],
          pitchMm: 0.1,
        },
        {
          signal: controller.signal,
          onProgress: (fraction) => {
            progressValues.push(fraction);
            // The FIRST onProgress call is the job's pre-loop `ctx.progress(0)`
            // (jobs/sdf.ts's sampleSdfGridJob) — not a completed slice yet.
            // The SECOND call (fraction = 1/21) is the first slice's own
            // progress event — abort here, per this task's brief ("after the
            // first slice's progress event").
            if (!abortedAfterFirstSlice && fraction > 0) {
              abortedAfterFirstSlice = true;
              controller.abort();
            }
          },
        },
      ),
    ).rejects.toThrow(JobCancelledError);

    expect(abortedAfterFirstSlice).toBe(true); // sanity: the abort actually fired mid-loop, not skipped.
    // The job must NOT have run to completion: its final progress fraction
    // (1, reported only after the LAST of 21 slices) must never have been
    // observed — a genuine mid-computation cancellation, not merely a
    // pre-flight rejection dressed up with an onProgress hook.
    expect(progressValues).not.toContain(1);
    expect(progressValues.length).toBeLessThan(21);
  });

  it('rejects with SdfGridTooLargeError (the memory guard) for an oversized request, before any large allocation', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    await pool.run('buildSdf', { contentHash: CUBE_HASH });

    await expect(
      pool.run('sampleSdfGrid', {
        contentHash: CUBE_HASH,
        bboxMin: [0, 0, 0],
        bboxMax: [100, 100, 100],
        pitchMm: 0.001,
      }),
    ).rejects.toMatchObject({ name: 'SdfGridTooLargeError' });
  });

  it('bandMm restricts computation: a far corner cell is the +Infinity sentinel', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    await pool.run('buildSdf', { contentHash: CUBE_HASH });

    const result = await pool.run('sampleSdfGrid', {
      contentHash: CUBE_HASH,
      bboxMin: [-3, -3, -3],
      bboxMax: [4, 4, 4],
      pitchMm: 0.5,
      bandMm: 0.3,
    });
    expect(result.bandMm).toBe(0.3);
    // Grid's own last cell (far corner, well outside a 0.3mm band around the
    // unit cube) must be the sentinel.
    expect(result.grid[result.grid.length - 1]).toBe(Number.POSITIVE_INFINITY);
  });
});
