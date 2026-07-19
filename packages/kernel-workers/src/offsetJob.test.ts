// offsetMesh job tests (Phase 2 Task 7) — exercised via a real Node
// worker_threads WorkerPool, same rationale as sdfJobs.test.ts: the offset
// algorithm itself (acceptance radial-error bounds, sign convention, cube
// rounding, roundtrip property, `@errorBound`) is exhaustively covered at
// the kernel level (packages/kernel/src/offset/*.test.ts) — these tests
// prove the job wires @dqcad/kernel's offset/ module through a real worker
// correctly: staged progress, genuine mid-SDF cancellation, typed-error
// propagation across the Comlink boundary, and byte-identity with a direct
// kernel `offsetMesh` call (the job drives the same per-slice/per-slab
// primitives — see jobs/offset.ts's module doc).
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { offsetMesh } from '@dqcad/kernel';
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
// Fixtures: outward-wound icosahedron (12 vertices / 20 triangles, closed,
// watertight — same construction as geodesicJobs.test.ts's) and an open quad
// patch (for the NonWatertightMeshError path).
// ---------------------------------------------------------------------------

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

function icosahedronBuffers(radius = 1.5): { positions: Float64Array; indices: Uint32Array } {
  const raw: [number, number, number][] = [
    [-1, GOLDEN_RATIO, 0],
    [1, GOLDEN_RATIO, 0],
    [-1, -GOLDEN_RATIO, 0],
    [1, -GOLDEN_RATIO, 0],
    [0, -1, GOLDEN_RATIO],
    [0, 1, GOLDEN_RATIO],
    [0, -1, -GOLDEN_RATIO],
    [0, 1, -GOLDEN_RATIO],
    [GOLDEN_RATIO, 0, -1],
    [GOLDEN_RATIO, 0, 1],
    [-GOLDEN_RATIO, 0, -1],
    [-GOLDEN_RATIO, 0, 1],
  ];
  const positions = new Float64Array(raw.length * 3);
  raw.forEach(([x, y, z], i) => {
    const len = Math.hypot(x, y, z);
    positions[i * 3] = (x / len) * radius;
    positions[i * 3 + 1] = (y / len) * radius;
    positions[i * 3 + 2] = (z / len) * radius;
  });
  const triangles: [number, number, number][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  return { positions, indices: Uint32Array.from(triangles.flat()) };
}

function openPatchBuffers(): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

function hashBuffers(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

describe('offsetMesh job', () => {
  it(
    'produces a watertight offset mesh BYTE-IDENTICAL to a direct kernel offsetMesh call, with staged progress ending at 1',
    { timeout: 120_000 },
    async () => {
      const pool = createPool({ size: 1 });
      const { positions, indices } = icosahedronBuffers();
      const distanceMm = 0.15;
      const pitchMm = 0.08;

      const progressValues: number[] = [];
      const jobResult = await pool.run(
        'offsetMesh',
        // Fresh copies: run() transfers the buffers into the worker.
        { positions: positions.slice(), indices: indices.slice(), distanceMm, pitchMm },
        { onProgress: (fraction) => progressValues.push(fraction) },
      );

      expect(jobResult.stats.watertight).toBe(true);
      expect(jobResult.stats.manifoldEdges).toBe(true);
      expect(jobResult.stats.componentCount).toBe(1);
      expect(jobResult.distanceMm).toBe(distanceMm);
      expect(jobResult.pitchMm).toBe(pitchMm);
      expect(jobResult.errorBoundMm).toBeGreaterThan(pitchMm / 2);

      // Staged progress: starts at 0, strictly ordered, ends exactly at 1,
      // with real intermediate values from the SDF slice loop.
      expect(progressValues[0]).toBe(0);
      expect(progressValues[progressValues.length - 1]).toBe(1);
      expect(progressValues.length).toBeGreaterThan(4);
      for (let i = 1; i < progressValues.length; i++) {
        expect(progressValues[i]!).toBeGreaterThanOrEqual(progressValues[i - 1]!);
      }

      // Byte-identity with the kernel path (same primitives, same order —
      // jobs/offset.ts's module doc).
      const direct = await offsetMesh({ positions, indices }, distanceMm, { pitchMm });
      expect(hashBuffers(jobResult.positions, jobResult.indices)).toBe(hashBuffers(direct.mesh.positions, direct.mesh.indices));
      expect(jobResult.stats).toEqual(direct.stats);
      expect(jobResult.errorBoundMm).toBe(direct.errorBoundMm);
    },
  );

  it('is cancellable BEFORE it starts (pre-flight: signal already aborted)', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'offsetMesh',
        { positions, indices, distanceMm: 0.1, pitchMm: 0.05 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it(
    'is cancellable GENUINELY MID-SDF (abort from the onProgress hook during the slice loop) — the job must not run to completion',
    { timeout: 120_000 },
    async () => {
      const pool = createPool({ size: 1 });
      const { positions, indices } = icosahedronBuffers();

      const controller = new AbortController();
      const progressValues: number[] = [];
      let abortedMidSdf = false;
      await expect(
        pool.run(
          'offsetMesh',
          // Fine pitch so the SDF stage has many slices to cancel between.
          { positions, indices, distanceMm: 0.1, pitchMm: 0.02 },
          {
            signal: controller.signal,
            onProgress: (fraction) => {
              progressValues.push(fraction);
              // Abort during the SDF slice band (0.05 -> 0.75) — after at
              // least one real slice, well before the stage completes.
              if (!abortedMidSdf && fraction > 0.05 && fraction < 0.5) {
                abortedMidSdf = true;
                controller.abort();
              }
            },
          },
        ),
      ).rejects.toThrow(JobCancelledError);

      expect(abortedMidSdf).toBe(true);
      expect(progressValues).not.toContain(1);
    },
  );

  it('propagates NonWatertightMeshError for an open mesh', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = openPatchBuffers();
    await expect(
      pool.run('offsetMesh', { positions, indices, distanceMm: 0.1, pitchMm: 0.1 }),
    ).rejects.toMatchObject({ name: 'NonWatertightMeshError' });
  });

  it('rejects invalid pitchMm/distanceMm with a TypeError before any heavy work', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    await expect(
      pool.run('offsetMesh', { positions: positions.slice(), indices: indices.slice(), distanceMm: 0.1, pitchMm: 0 }),
    ).rejects.toMatchObject({ name: 'TypeError' });
    await expect(
      pool.run('offsetMesh', { positions, indices, distanceMm: Number.NaN, pitchMm: 0.1 }),
    ).rejects.toMatchObject({ name: 'TypeError' });
  });

  it('propagates EmptyOffsetResultError when the offset surface vanishes (inward past the inradius)', { timeout: 60_000 }, async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers(1);
    await expect(
      pool.run('offsetMesh', { positions, indices, distanceMm: -1.4, pitchMm: 0.1 }),
    ).rejects.toMatchObject({ name: 'EmptyOffsetResultError' });
  });
});
