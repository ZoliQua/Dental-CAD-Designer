// extractNeighbourRegion job tests (Phase 9 Task 3) — via a real Node
// worker_threads WorkerPool. The window rules, closure and `@errorBound` are
// covered at the kernel level (neighbour/extractNeighbourRegion.test.ts, on
// the closed-form box arch); these tests prove the JOB wires the kernel op
// through a real worker: byte-identity with a direct kernel call against the
// BVH-cached arch mesh, typed-error propagation, and cancellation.
import { afterEach, describe, expect, it } from 'vitest';
import { buildBvh, extractNeighbourRegion, type Vec3 } from '@dqcad/kernel';
import { boxArch } from '@dqcad/kernel/neighbour-fixtures';
import { WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];
function createPool(): WorkerPool {
  const pool = new WorkerPool({ size: 1 });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

const AXIS: Vec3 = [0, 0, 1];
const SEED: Vec3 = [7, 0, 4];

async function cachedArch(pool: WorkerPool): Promise<ReturnType<typeof boxArch>> {
  const arch = boxArch();
  await pool.run('buildBvh', {
    contentHash: 'arch',
    positions: arch.mesh.positions.slice(),
    indices: arch.mesh.indices.slice(),
  });
  return arch;
}

describe('extractNeighbourRegion job', () => {
  it('is byte-identical to the direct kernel call on the BVH-cached arch', async () => {
    const pool = createPool();
    const arch = await cachedArch(pool);
    const progress: number[] = [];
    const result = await pool.run(
      'extractNeighbourRegion',
      {
        contentHash: 'arch',
        seed: SEED,
        marginLoop: new Float64Array(arch.marginLoop.flat()),
        insertionAxis: AXIS,
      },
      { onProgress: (f) => progress.push(f) },
    );
    const direct = extractNeighbourRegion(
      arch.mesh,
      buildBvh(arch.mesh),
      SEED,
      arch.marginLoop,
      AXIS,
    );
    expect(Array.from(result.positions)).toEqual(Array.from(direct.mesh.positions));
    expect(Array.from(result.indices)).toEqual(Array.from(direct.mesh.indices));
    expect(Array.from(result.sourceTriangleIndices)).toEqual(
      Array.from(direct.sourceTriangleIndices),
    );
    expect(result.capturedTriangleCount).toBe(512);
    expect(result.approachDirection).toEqual([1, 0, 0]);
    expect(result.windowBoundaryBandMm).toBe(direct.windowBoundaryBandMm);
    expect(result.capturedAreaMm2).toBe(direct.capturedAreaMm2);
    expect(result.foldTrianglesDropped).toBe(0);
    expect(result.radiusMm).toBe(direct.radiusMm);
    expect(progress.at(-1)).toBe(1);
  });

  it('passes window options through', async () => {
    const pool = createPool();
    const arch = await cachedArch(pool);
    const result = await pool.run('extractNeighbourRegion', {
      contentHash: 'arch',
      seed: SEED,
      marginLoop: new Float64Array(arch.marginLoop.flat()),
      insertionAxis: AXIS,
      options: { cervicalOffsetMm: 1 },
    });
    expect(result.capturedTriangleCount).toBe(16 * 12 * 2);
    expect(result.cervicalOffsetMm).toBe(1);
  });

  it('propagates the typed kernel error for a pick on the restoration', async () => {
    const pool = createPool();
    const arch = await cachedArch(pool);
    await expect(
      pool.run('extractNeighbourRegion', {
        contentHash: 'arch',
        seed: [2, 0, 4],
        marginLoop: new Float64Array(arch.marginLoop.flat()),
        insertionAxis: AXIS,
      }),
    ).rejects.toMatchObject({ name: 'NeighbourSeedTooCloseError' });
  });

  it('rejects a malformed margin loop before any work', async () => {
    const pool = createPool();
    await cachedArch(pool);
    await expect(
      pool.run('extractNeighbourRegion', {
        contentHash: 'arch',
        seed: SEED,
        marginLoop: new Float64Array([1, 2]),
        insertionAxis: AXIS,
      }),
    ).rejects.toThrow(/xyz triples/);
  });
});
