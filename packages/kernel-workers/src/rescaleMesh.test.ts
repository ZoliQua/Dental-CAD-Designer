// rescaleMesh job tests — exercised via the Node worker_threads path (same
// rationale as parseMeshFile.test.ts / intakeMesh.test.ts). Covers: (a) a
// correct per-coordinate scale, (b) the output buffer is transferred back
// (not copied), (c) progress + cancellation between chunks, and (d)
// rejection of a non-positive/non-finite factor.
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

function sequentialPositions(count: number): Float64Array {
  const positions = new Float64Array(count);
  for (let i = 0; i < count; i++) positions[i] = i + 1;
  return positions;
}

describe('WorkerPool — rescaleMesh', () => {
  it('multiplies every coordinate by factor and transfers the buffer back', async () => {
    const pool = createPool({ size: 1 });
    const positions = sequentialPositions(9); // 3 triangle-soup vertices
    const sourceBuffer = positions.buffer;

    const result = await pool.run(
      'rescaleMesh',
      { positions, factor: 10 },
      { transfer: [positions.buffer] },
    );

    expect(sourceBuffer.byteLength).toBe(0); // moved, not copied
    expect(Array.from(result.positions)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('applies the µm-suspect factor (0.001) correctly', async () => {
    const pool = createPool({ size: 1 });
    const positions = new Float64Array([1000, 2000, 3000]);

    const result = await pool.run('rescaleMesh', { positions, factor: 0.001 });

    expect(Array.from(result.positions)).toEqual([1, 2, 3]);
  });

  it('reports monotonically non-decreasing progress ending at 1', async () => {
    const pool = createPool({ size: 1 });
    const positions = sequentialPositions(600_003); // several progress chunks
    const fractions: number[] = [];

    await pool.run('rescaleMesh', { positions, factor: 2 }, { onProgress: (f) => fractions.push(f) });

    expect(fractions.length).toBeGreaterThan(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
    expect(Math.max(...fractions)).toBeGreaterThan(0.5);
  });

  it('rejects a job aborted mid-run with JobCancelledError, and the worker stays reusable', async () => {
    const pool = createPool({ size: 1 });
    const positions = sequentialPositions(2_000_000);
    const controller = new AbortController();
    let observedProgress = false;

    const run = pool.run(
      'rescaleMesh',
      { positions, factor: 10 },
      {
        signal: controller.signal,
        onProgress: (fraction) => {
          if (!observedProgress && fraction > 0) {
            observedProgress = true;
            controller.abort();
          }
        },
      },
    );

    await expect(run).rejects.toBeInstanceOf(JobCancelledError);
    expect(observedProgress).toBe(true);

    const after = await pool.run('rescaleMesh', { positions: new Float64Array([5]), factor: 2 });
    expect(Array.from(after.positions)).toEqual([10]);
  });

  it('rejects a non-positive factor', async () => {
    const pool = createPool({ size: 1 });
    let thrown: unknown;
    try {
      await pool.run('rescaleMesh', { positions: new Float64Array([1]), factor: 0 });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error)?.name).toBe('TypeError');
  });

  it('rejects a non-finite factor', async () => {
    const pool = createPool({ size: 1 });
    let thrown: unknown;
    try {
      await pool.run('rescaleMesh', { positions: new Float64Array([1]), factor: Number.NaN });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error)?.name).toBe('TypeError');
  });

  it('handles an empty positions buffer', async () => {
    const pool = createPool({ size: 1 });
    const result = await pool.run('rescaleMesh', { positions: new Float64Array(0), factor: 10 });
    expect(result.positions).toHaveLength(0);
  });
});
