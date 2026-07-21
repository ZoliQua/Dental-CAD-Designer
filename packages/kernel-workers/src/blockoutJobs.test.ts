// blockoutPreview job tests (Phase 3 Task 10) — exercised via a real Node
// worker_threads WorkerPool, same rationale as axisJobs.test.ts: job logic
// is environment-agnostic, so testing it through the real Comlink transport
// also proves payload shapes and thrown-error names survive the
// postMessage boundary. The ALGORITHM itself (triangle selection, per-
// vertex horizon displacement, winding reversal, `@errorBound`) is
// exhaustively covered at the kernel level
// (packages/kernel/src/blockout/*.test.ts) — these tests only prove the job
// wires @dqcad/kernel's `extractMarginRegion` + `blockoutPreview` through a
// real worker correctly, including the per-worker BVH+halfedge cache
// contract (jobs/blockout.ts's module doc).
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
// Same capped cone frustum fixture as axisJobs.test.ts (duplicated per this
// repo's established "TEST-ONLY kernel-internal fixture code is not
// importable across the package boundary" convention — see that file's own
// doc).
// ---------------------------------------------------------------------------

const BOTTOM_RADIUS = 4;
const TOP_RADIUS = 2.5;
const HEIGHT = 9;
const SEGMENTS = 32;
const HEIGHT_SEGMENTS = 8;

function frustumMeshBuffers(): {
  positions: Float64Array;
  indices: Uint32Array;
  wallSeed: (ring: number, seg: number) => { triangleIndex: number; barycentric: [number, number, number] };
} {
  const ringIndex = (ring: number, seg: number): number => ring * SEGMENTS + seg;
  const positions: number[] = [];
  for (let r = 0; r <= HEIGHT_SEGMENTS; r++) {
    const t = r / HEIGHT_SEGMENTS;
    const z = t * HEIGHT;
    const radius = BOTTOM_RADIUS + (TOP_RADIUS - BOTTOM_RADIUS) * t;
    for (let s = 0; s < SEGMENTS; s++) {
      const theta = (2 * Math.PI * s) / SEGMENTS;
      positions.push(radius * Math.cos(theta), radius * Math.sin(theta), z);
    }
  }
  const bottomCenterIndex = positions.length / 3;
  positions.push(0, 0, 0);
  const topCenterIndex = positions.length / 3;
  positions.push(0, 0, HEIGHT);

  const indices: number[] = [];
  const wallTriangleIndexOf = new Map<string, number>();
  for (let r = 0; r < HEIGHT_SEGMENTS; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const sNext = (s + 1) % SEGMENTS;
      const a = ringIndex(r, s);
      const b = ringIndex(r, sNext);
      const c = ringIndex(r + 1, sNext);
      const d = ringIndex(r + 1, s);
      wallTriangleIndexOf.set(`${r},${s}`, indices.length / 3);
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    indices.push(bottomCenterIndex, ringIndex(0, sNext), ringIndex(0, s));
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    indices.push(topCenterIndex, ringIndex(HEIGHT_SEGMENTS, s), ringIndex(HEIGHT_SEGMENTS, sNext));
  }

  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    wallSeed: (ring, seg) => {
      const key = `${Math.min(ring, HEIGHT_SEGMENTS - 1)},${seg}`;
      const triangleIndex = wallTriangleIndexOf.get(key)!;
      return { triangleIndex, barycentric: [1, 0, 0] };
    },
  };
}

function midWallLoop(fixture: ReturnType<typeof frustumMeshBuffers>, ring: number, count = SEGMENTS) {
  const step = Math.max(1, Math.floor(SEGMENTS / count));
  const loop = [];
  for (let s = 0; s < SEGMENTS; s += step) {
    loop.push(fixture.wallSeed(ring, s));
  }
  return loop;
}

const TILT_RAD = (30 * Math.PI) / 180;
const TILTED_AXIS: readonly [number, number, number] = [Math.sin(TILT_RAD), 0, Math.cos(TILT_RAD)];

describe('blockoutPreview job — single abutment', () => {
  it('a tilted axis (beyond the frustum\'s zero-undercut cone) produces a non-empty preview, self-consistent with zero residual undercut', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'blockout-frustum-1', positions: fixture.positions, indices: fixture.indices });
    const loop = midWallLoop(fixture, 3);

    const result = await pool.run('blockoutPreview', {
      contentHash: 'blockout-frustum-1',
      abutmentMarginLoops: [loop],
      direction: TILTED_AXIS,
      thresholdMm: 0,
      roiRadiusMm: 2.0,
    });

    expect(result.blockoutTriangleCount).toBeGreaterThan(0);
    expect(result.previewIndices.length).toBe(result.blockoutTriangleCount * 3);
    expect(result.previewPositions.length).toBe(result.vertexCount * 3);
    expect(result.maxDisplacementMm).toBeGreaterThan(0);
    expect(result.approxVolumeMm3).toBeGreaterThan(0);

    // Self-consistency, exercised through the real worker: build a fresh
    // BVH from the returned preview mesh and re-scan — see this task's
    // kernel-level analytic test for the full derivation/measured numbers;
    // this is a smoke re-assertion that the job's own wiring preserves it.
    await pool.run('buildBvh', {
      contentHash: 'blockout-frustum-1-preview',
      positions: result.previewPositions,
      indices: result.previewIndices,
    });
    const rescan = await pool.run('undercutScan', {
      contentHash: 'blockout-frustum-1-preview',
      direction: result.directionUnit,
    });
    console.log(
      `[blockoutJobs] frustum tilt=30deg: selected=${result.blockoutTriangleCount} tris, ` +
        `maxDisplacement=${result.maxDisplacementMm.toFixed(4)}mm -> rescan undercutTriangleCount=${rescan.undercutTriangleCount}, maxDepthMm=${rescan.maxDepthMm}`,
    );
    expect(rescan.undercutTriangleCount).toBe(0);
  });

  it('the true construction axis (no undercut beyond the zero-undercut cone) produces a small or empty preview', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'blockout-frustum-true-axis', positions: fixture.positions, indices: fixture.indices });
    const loop = midWallLoop(fixture, 3);

    const result = await pool.run('blockoutPreview', {
      contentHash: 'blockout-frustum-true-axis',
      abutmentMarginLoops: [loop],
      direction: [0, 0, 1],
      thresholdMm: 0,
      roiRadiusMm: 2.0,
    });
    expect(result.blockoutTriangleCount).toBe(0);
    expect(result.previewPositions.length).toBe(0);
    expect(result.previewIndices.length).toBe(0);
  });

  it('a threshold above every region depth -> empty preview', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'blockout-frustum-threshold', positions: fixture.positions, indices: fixture.indices });
    const loop = midWallLoop(fixture, 3);

    const result = await pool.run('blockoutPreview', {
      contentHash: 'blockout-frustum-threshold',
      abutmentMarginLoops: [loop],
      direction: TILTED_AXIS,
      thresholdMm: 1000,
      roiRadiusMm: 2.0,
    });
    expect(result.blockoutTriangleCount).toBe(0);
  });

  it('rejects with BvhNotCachedError when the contentHash was never built on this worker', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await expect(
      pool.run('blockoutPreview', {
        contentHash: 'never-built',
        abutmentMarginLoops: [midWallLoop(fixture, 3)],
        direction: TILTED_AXIS,
        thresholdMm: 0,
      }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('is cancellable before it starts', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'blockout-frustum-cancel', positions: fixture.positions, indices: fixture.indices });
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'blockoutPreview',
        { contentHash: 'blockout-frustum-cancel', abutmentMarginLoops: [midWallLoop(fixture, 3)], direction: TILTED_AXIS, thresholdMm: 0 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it('determinism: two identical calls produce bit-identical results', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'blockout-frustum-det', positions: fixture.positions, indices: fixture.indices });
    const payload = {
      contentHash: 'blockout-frustum-det',
      abutmentMarginLoops: [midWallLoop(fixture, 3)],
      direction: TILTED_AXIS,
      thresholdMm: 0,
      roiRadiusMm: 2.0,
    } as const;
    const a = await pool.run('blockoutPreview', payload);
    const b = await pool.run('blockoutPreview', payload);
    expect(a).toEqual(b);
  });

  it('reports progress, ending at 1', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'blockout-frustum-progress', positions: fixture.positions, indices: fixture.indices });
    const fractions: number[] = [];
    await pool.run(
      'blockoutPreview',
      { contentHash: 'blockout-frustum-progress', abutmentMarginLoops: [midWallLoop(fixture, 3)], direction: TILTED_AXIS, thresholdMm: 0, roiRadiusMm: 2.0 },
      { onProgress: (f) => fractions.push(f) },
    );
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  it('returns an empty result (no throw) for an abutment loop with no points', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'blockout-frustum-empty', positions: fixture.positions, indices: fixture.indices });
    const result = await pool.run('blockoutPreview', {
      contentHash: 'blockout-frustum-empty',
      abutmentMarginLoops: [[]],
      direction: TILTED_AXIS,
      thresholdMm: 0,
    });
    expect(result.blockoutTriangleCount).toBe(0);
    expect(result.previewPositions.length).toBe(0);
    expect(result.previewIndices.length).toBe(0);
  });
});
