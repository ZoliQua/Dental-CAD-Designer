// innerSurfaceOffset job tests (Phase 4 Task 3) — exercised via a real Node
// worker_threads WorkerPool, same rationale as offsetJob.test.ts: the
// two-zone offset algorithm itself (zone accuracy, C1 blend, height field,
// `@errorBound`) is exhaustively covered at the kernel level
// (packages/kernel/src/offset/innerSurfaceOffset*.test.ts) — these tests
// prove the job wires @dqcad/kernel's innerSurfaceOffsetRoi through a real
// worker correctly: staged progress, genuine mid-SDF cancellation, typed
// -error propagation across the Comlink boundary, byte-identity with a direct
// kernel call (the job drives the same per-slice/per-slab primitives), and
// the contentHash-keyed cache + BVH-reuse contract.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { innerSurfaceOffsetRoi, type Vec3 } from '@dqcad/kernel';
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

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

function icosahedronBuffers(radius = 1.5): { positions: Float64Array; indices: Uint32Array } {
  const raw: [number, number, number][] = [
    [-1, GOLDEN_RATIO, 0], [1, GOLDEN_RATIO, 0], [-1, -GOLDEN_RATIO, 0], [1, -GOLDEN_RATIO, 0],
    [0, -1, GOLDEN_RATIO], [0, 1, GOLDEN_RATIO], [0, -1, -GOLDEN_RATIO], [0, 1, -GOLDEN_RATIO],
    [GOLDEN_RATIO, 0, -1], [GOLDEN_RATIO, 0, 1], [-GOLDEN_RATIO, 0, -1], [-GOLDEN_RATIO, 0, 1],
  ];
  const positions = new Float64Array(raw.length * 3);
  raw.forEach(([x, y, z], i) => {
    const len = Math.hypot(x, y, z);
    positions[i * 3] = (x / len) * radius;
    positions[i * 3 + 1] = (y / len) * radius;
    positions[i * 3 + 2] = (z / len) * radius;
  });
  const triangles: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2],
    [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5],
    [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { positions, indices: Uint32Array.from(triangles.flat()) };
}

function openPatchBuffers(): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

/** A margin-loop circle (radius r at height z), returned both as a flat
 * Float64Array (job payload) and Vec3[] (direct kernel call) — the SAME
 * points, so the two paths are comparable byte-for-byte. */
function marginLoop(r: number, z: number, n: number): { flat: Float64Array; vecs: Vec3[] } {
  const flat = new Float64Array(n * 3);
  const vecs: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const p: Vec3 = [r * Math.cos(th), r * Math.sin(th), z];
    flat[i * 3] = p[0];
    flat[i * 3 + 1] = p[1];
    flat[i * 3 + 2] = p[2];
    vecs.push(p);
  }
  return { flat, vecs };
}

function hashBuffers(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

async function buildBvhFor(pool: WorkerPool, contentHash: string, positions: Float64Array, indices: Uint32Array) {
  await pool.run('buildBvh', { contentHash, positions, indices });
}

const GAPS = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const ROI = { min: [-1.7, -1.7, -1.7] as Vec3, max: [1.7, 1.7, 1.7] as Vec3 };

describe('innerSurfaceOffset job', () => {
  it(
    'produces a patch BYTE-IDENTICAL to a direct kernel innerSurfaceOffsetRoi call, with staged progress ending at 1',
    { timeout: 120_000 },
    async () => {
      const pool = createPool({ size: 1 });
      const { positions, indices } = icosahedronBuffers();
      const { flat, vecs } = marginLoop(1.0, 0.4, 128);
      const contentHash = 'inner-surface-byte-identity';
      await buildBvhFor(pool, contentHash, positions.slice(), indices.slice());

      const progress: number[] = [];
      const jobResult = await pool.run(
        'innerSurfaceOffset',
        { contentHash, ...GAPS, pitchMm: 0.1, marginLoop: flat.slice(), roiBboxMm: ROI },
        { onProgress: (f) => progress.push(f) },
      );

      expect(progress[0]).toBe(0);
      expect(progress[progress.length - 1]).toBe(1);
      expect(progress.length).toBeGreaterThan(4);
      for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
      expect(jobResult.errorBoundMm).toBeGreaterThan(0.1 / 2);
      expect(jobResult.flatZoneErrorBoundMm).toBeGreaterThanOrEqual(0.1 / 2);

      const direct = await innerSurfaceOffsetRoi(
        { positions, indices },
        { ...GAPS, pitchMm: 0.1, marginLoop: vecs, roiBboxMm: ROI },
      );
      expect(hashBuffers(jobResult.positions, jobResult.indices)).toBe(
        hashBuffers(direct.mesh.positions, direct.mesh.indices),
      );
      expect(jobResult.stats).toEqual(direct.stats);
      expect(jobResult.errorBoundMm).toBe(direct.errorBoundMm);
      expect(jobResult.flatZoneErrorBoundMm).toBe(direct.flatZoneErrorBoundMm);
    },
  );

  it('cache hit: an identical second call returns a byte-identical clone without re-running the pipeline', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    const { flat } = marginLoop(1.0, 0.4, 96);
    const contentHash = 'inner-surface-cache';
    await buildBvhFor(pool, contentHash, positions, indices);
    const payload = { contentHash, ...GAPS, pitchMm: 0.12, marginLoop: flat, roiBboxMm: ROI } as const;

    const first = await pool.run('innerSurfaceOffset', { ...payload, marginLoop: flat.slice() });
    const progress: number[] = [];
    const second = await pool.run(
      'innerSurfaceOffset',
      { ...payload, marginLoop: flat.slice() },
      { onProgress: (f) => progress.push(f) },
    );
    expect(progress).toEqual([0, 1]); // cache hit: straight to 1
    expect(second.positions.buffer).not.toBe(first.positions.buffer);
    expect(hashBuffers(second.positions, second.indices)).toBe(hashBuffers(first.positions, first.indices));
  });

  it('rejects a contentHash with no cached BVH on this worker', async () => {
    const pool = createPool({ size: 1 });
    const { flat } = marginLoop(1.0, 0.4, 32);
    await expect(
      pool.run('innerSurfaceOffset', { contentHash: 'never-built', ...GAPS, pitchMm: 0.1, marginLoop: flat, roiBboxMm: ROI }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('propagates NonWatertightMeshError for an open target', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = openPatchBuffers();
    const { flat } = marginLoop(0.3, 0.1, 24);
    const contentHash = 'inner-surface-open';
    await buildBvhFor(pool, contentHash, positions, indices);
    await expect(
      pool.run('innerSurfaceOffset', {
        contentHash, ...GAPS, pitchMm: 0.1, marginLoop: flat,
        roiBboxMm: { min: [0, 0, 0], max: [1, 1, 0.5] },
      }),
    ).rejects.toMatchObject({ name: 'NonWatertightMeshError' });
  });

  it('rejects invalid pitch / too-narrow blend before any heavy work', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    const { flat } = marginLoop(1.0, 0.4, 32);
    const contentHash = 'inner-surface-invalid';
    await buildBvhFor(pool, contentHash, positions, indices);
    await expect(
      pool.run('innerSurfaceOffset', { contentHash, ...GAPS, pitchMm: 0, marginLoop: flat.slice(), roiBboxMm: ROI }),
    ).rejects.toMatchObject({ name: 'TypeError' });
    await expect(
      pool.run('innerSurfaceOffset', { contentHash, ...GAPS, pitchMm: 1e-5, marginLoop: flat.slice(), roiBboxMm: ROI }),
    ).rejects.toMatchObject({ name: 'PitchTooSmallError' });
    await expect(
      pool.run('innerSurfaceOffset', {
        contentHash, ...GAPS, blendWidthMm: 0.01, pitchMm: 0.1, marginLoop: flat.slice(), roiBboxMm: ROI,
      }),
    ).rejects.toMatchObject({ name: 'BlendWidthTooNarrowError' });
  });

  it(
    'is cancellable GENUINELY MID-SDF (abort from onProgress during the slice loop)',
    { timeout: 120_000 },
    async () => {
      const pool = createPool({ size: 1 });
      const { positions, indices } = icosahedronBuffers();
      const { flat } = marginLoop(1.0, 0.4, 128);
      const contentHash = 'inner-surface-mid-cancel';
      await buildBvhFor(pool, contentHash, positions, indices);

      const controller = new AbortController();
      const progress: number[] = [];
      let abortedMidSdf = false;
      await expect(
        pool.run(
          'innerSurfaceOffset',
          { contentHash, ...GAPS, pitchMm: 0.03, marginLoop: flat, roiBboxMm: ROI },
          {
            signal: controller.signal,
            onProgress: (f) => {
              progress.push(f);
              if (!abortedMidSdf && f > 0.05 && f < 0.5) {
                abortedMidSdf = true;
                controller.abort();
              }
            },
          },
        ),
      ).rejects.toThrow(JobCancelledError);
      expect(abortedMidSdf).toBe(true);
      expect(progress).not.toContain(1);
    },
  );
});
