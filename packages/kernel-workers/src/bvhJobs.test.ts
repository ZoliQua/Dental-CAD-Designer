// bvh job tests (buildBvh / releaseBvh / measurePointToSurface / raycastMesh)
// — exercised via the Node worker_threads path, same rationale as
// intakeMesh.test.ts: the job logic is environment-agnostic, so testing it
// through a real WorkerPool (rather than calling jobs.ts's handlers
// in-process) also proves the Comlink transport (payload shapes, thrown
// error names surviving the postMessage boundary) works end to end.
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

// Same outward-wound unit cube fixture as intakeMesh.test.ts / jobs.ts's own
// manifoldSmoke unitCubeMesh — 8 vertices, 12 triangles, centered at
// (0.5, 0.5, 0.5).
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

const CUBE_HASH = 'test-cube-hash';

describe('buildBvh + measurePointToSurface (single-worker cache)', () => {
  it('caches the mesh under contentHash, then measurePointToSurface finds the exact closest face', async () => {
    // size: 1 — required to guarantee buildBvh and the follow-up
    // measurePointToSurface call land on the SAME worker (see jobs.ts's
    // "Per-worker BVH cache" doc for why this isn't automatic on a
    // multi-worker pool).
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();

    const built = await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    expect(built.contentHash).toBe(CUBE_HASH);
    expect(built.triangleCount).toBe(12);
    expect(built.nodeCount).toBeGreaterThan(0);

    // Point 2 units above the top face's center (top face is z=1,
    // 0<=x,y<=1) — closest surface point is (0.5, 0.5, 1), distance 2.
    const measured = await pool.run('measurePointToSurface', {
      contentHash: CUBE_HASH,
      point: [0.5, 0.5, 3],
    });
    expect(measured.distance).toBeCloseTo(2, 12);
    expect(measured.point[0]).toBeCloseTo(0.5, 12);
    expect(measured.point[1]).toBeCloseTo(0.5, 12);
    expect(measured.point[2]).toBeCloseTo(1, 12);
  });

  it('raycastMesh hits the near face of the cube along -z from above', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const hit = await pool.run('raycastMesh', {
      contentHash: CUBE_HASH,
      origin: [0.5, 0.5, 5],
      direction: [0, 0, -1],
    });
    expect(hit.hit).toBe(true);
    if (!hit.hit) throw new Error('unreachable');
    expect(hit.distance).toBeCloseTo(4, 12); // 5 - 1 (top face at z=1)
    expect(hit.point[2]).toBeCloseTo(1, 12);
  });

  it('raycastMesh reports a miss (not an error) for a ray that clears the mesh entirely', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const hit = await pool.run('raycastMesh', {
      contentHash: CUBE_HASH,
      origin: [10, 10, 10],
      direction: [1, 0, 0],
    });
    expect(hit.hit).toBe(false);
  });

  it('releaseBvh evicts the cache entry; a subsequent measure/raycast call then rejects with BvhNotCachedError', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const releasedFirst = await pool.run('releaseBvh', { contentHash: CUBE_HASH });
    expect(releasedFirst.released).toBe(true);

    const releasedSecond = await pool.run('releaseBvh', { contentHash: CUBE_HASH });
    expect(releasedSecond.released).toBe(false); // already gone — not an error to release again

    await expect(
      pool.run('measurePointToSurface', { contentHash: CUBE_HASH, point: [0, 0, 0] }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
    await expect(
      pool.run('raycastMesh', { contentHash: CUBE_HASH, origin: [0, 0, 5], direction: [0, 0, -1] }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('measurePointToSurface rejects with BvhNotCachedError when buildBvh was never called for that contentHash', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('measurePointToSurface', { contentHash: 'never-built', point: [0, 0, 0] }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('buildBvh reports progress ending at 1 and is cancellable before it starts', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    const progressValues: number[] = [];

    await pool.run(
      'buildBvh',
      { contentHash: CUBE_HASH, positions, indices },
      {
        onProgress: (fraction) => progressValues.push(fraction),
      },
    );
    expect(progressValues.length).toBeGreaterThan(0);
    expect(progressValues[progressValues.length - 1]).toBe(1);

    const controller = new AbortController();
    controller.abort();
    const { positions: p2, indices: i2 } = cubeBuffers();
    await expect(
      pool.run(
        'buildBvh',
        { contentHash: 'other-hash', positions: p2, indices: i2 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });
});

describe('buildBvh cache isolation across workers', () => {
  it('a mesh built via one WorkerPool (one worker) is NOT visible to a different WorkerPool (a different worker)', async () => {
    // Two separate size:1 pools are, by construction, two separate worker
    // processes with two separate module-level `bvhCache` instances — this
    // deterministically demonstrates "per-worker, not global" caching (see
    // jobs.ts's "Per-worker BVH cache" doc) without depending on
    // WorkerPool's internal scheduling/timing.
    const poolA = createPool({ size: 1 });
    const poolB = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();

    await poolA.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    await expect(
      poolB.run('measurePointToSurface', { contentHash: CUBE_HASH, point: [0, 0, 0] }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });
});
