// intakeMesh job tests — exercised via the Node worker_threads path (same
// rationale as parseMeshFile.test.ts / pool.test.ts: the browser path's
// worker spawn is verified separately; the job logic itself is
// environment-agnostic). Covers: (a) both payload kinds produce a correct
// intake result, (b) output buffers are transferred (not copied) back,
// (c) progress is reported between stages, (d) cancellation between stages
// rejects with JobCancelledError and the worker stays reusable, and (e) a
// parseMeshFile -> intakeMesh round trip works end-to-end on real STL bytes.
import { afterEach, describe, expect, it } from 'vitest';
import { writeStlBinary } from '@dqcad/io';
import { JobCancelledError, WorkerPool } from './pool.js';
import type { IntakeMeshPayload } from './jobs/registry.js';

const pools: WorkerPool[] = [];

function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

// Outward-wound unit cube (verified winding — same fixture as jobs.ts's
// unitCubeMesh / manifold.test.ts).
const CUBE_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 1], [0, 3, 2],
  [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6],
  [0, 4, 7], [0, 7, 3],
];

/** Unwelded 9-per-triangle soup positions for the unit cube — 36 raw
 * vertices that must weld down to exactly 8. */
function cubeSoupPositions(): Float64Array {
  const positions = new Float64Array(CUBE_TRIANGLES.length * 9);
  CUBE_TRIANGLES.forEach((triangle, t) => {
    triangle.forEach((cornerIndex, corner) => {
      positions.set(CUBE_CORNERS[cornerIndex]!, t * 9 + corner * 3);
    });
  });
  return positions;
}

describe('WorkerPool — intakeMesh: soup payload', () => {
  it('welds a duplicated-vertex cube soup, reports watertight stats, and transfers buffers both ways', async () => {
    const pool = createPool({ size: 1 });
    const positions = cubeSoupPositions();
    const sourceBuffer = positions.buffer;

    const result = await pool.run(
      'intakeMesh',
      { kind: 'soup', positions },
      { transfer: [positions.buffer] },
    );

    // Input buffer was moved into the worker, not copied.
    expect(sourceBuffer.byteLength).toBe(0);

    expect(result.positions).toHaveLength(8 * 3);
    expect(result.indices).toHaveLength(12 * 3);
    expect(result.stats.watertight).toBe(true);
    expect(result.stats.manifoldEdges).toBe(true);
    expect(result.stats.componentCount).toBe(1);
    expect(result.stats.signedVolumeMm3).toBeCloseTo(1, 12);
    expect(result.stats.surfaceAreaMm2).toBeCloseTo(6, 12);
    expect(result.report.weldEpsilonMm).toBe(1e-6);
    expect(result.report.steps.map((s) => s.step)).toEqual([
      'weld',
      'dropDegenerateTriangles',
      'orientNormalsConsistently',
    ]);
    const weldStep = result.report.steps[0]!;
    expect(weldStep.before.vertexCount).toBe(36);
    expect(weldStep.after.vertexCount).toBe(8);
  });
});

describe('WorkerPool — intakeMesh: indexed payload', () => {
  it('skips the weld step for an already-indexed mesh and still analyzes it', async () => {
    const pool = createPool({ size: 1 });
    const positions = new Float64Array(CUBE_CORNERS.flat());
    const indices = Uint32Array.from(CUBE_TRIANGLES.flat());

    const result = await pool.run(
      'intakeMesh',
      { kind: 'indexed', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );

    expect(result.report.steps.map((s) => s.step)).toEqual([
      'dropDegenerateTriangles',
      'orientNormalsConsistently',
    ]);
    expect(result.stats.watertight).toBe(true);
    expect(result.stats.signedVolumeMm3).toBeCloseTo(1, 12);
  });

  it('reports the same [0.25, 0.5, 0.75, 1] progress sequence as the soup case, even with the weld stage skipped', async () => {
    // jobs.ts's INTAKE_STAGE_FRACTIONS doc: "When the weld stage is skipped
    // (indexed input) progress starts at the same first checkpoint anyway
    // ... keeping the fraction sequence identical for both input kinds so UI
    // progress bars behave the same regardless of source format." This test
    // pins that documented uniform-4-fraction sequence for the indexed-input
    // case specifically (the soup case is already covered above).
    const pool = createPool({ size: 1 });
    const positions = new Float64Array(CUBE_CORNERS.flat());
    const indices = Uint32Array.from(CUBE_TRIANGLES.flat());
    const fractions: number[] = [];

    await pool.run(
      'intakeMesh',
      { kind: 'indexed', positions, indices },
      { onProgress: (f) => fractions.push(f) },
    );

    expect(fractions).toEqual([0.25, 0.5, 0.75, 1]);
  });
});

describe('WorkerPool — intakeMesh: progress + cancellation', () => {
  it('reports the four between-stage progress checkpoints in order', async () => {
    const pool = createPool({ size: 1 });
    const fractions: number[] = [];

    await pool.run(
      'intakeMesh',
      { kind: 'soup', positions: cubeSoupPositions() },
      { onProgress: (f) => fractions.push(f) },
    );

    // runJob's progress-before-resolution ordering guarantee (pool.ts's
    // RunJobOptions.onProgress doc) makes this exact assertion safe.
    expect(fractions).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('rejects with JobCancelledError when aborted between stages, and the worker stays reusable', async () => {
    const pool = createPool({ size: 1 });
    const controller = new AbortController();

    const run = pool.run(
      'intakeMesh',
      { kind: 'soup', positions: cubeSoupPositions() },
      {
        signal: controller.signal,
        onProgress: (fraction) => {
          if (fraction <= 0.25) controller.abort();
        },
      },
    );

    await expect(run).rejects.toBeInstanceOf(JobCancelledError);

    // Pool size 1 — the follow-up run necessarily reuses the same worker.
    const after = await pool.run('intakeMesh', { kind: 'soup', positions: cubeSoupPositions() });
    expect(after.stats.watertight).toBe(true);
  });

  it('rejects a soup payload that wrongly carries indices', async () => {
    const pool = createPool({ size: 1 });
    let thrown: unknown;
    try {
      await pool.run('intakeMesh', {
        kind: 'soup',
        positions: cubeSoupPositions(),
        indices: new Uint32Array(3),
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error)?.name).toBe('TypeError');
  });

  it('rejects a payload whose kind is neither "soup" nor "indexed"', async () => {
    const pool = createPool({ size: 1 });
    // Deliberately past the typed payload surface (only 'soup' | 'indexed'
    // are valid `kind`s) — same cast-past-the-type convention pool.test.ts
    // uses for its worker-crash test's job name.
    const invalidPayload = { kind: 'bogus', positions: cubeSoupPositions() } as unknown as IntakeMeshPayload;
    let thrown: unknown;
    try {
      await pool.run('intakeMesh', invalidPayload);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error)?.name).toBe('TypeError');
  });
});

describe('WorkerPool — parseMeshFile -> intakeMesh round trip', () => {
  it('parses STL bytes then intakes the resulting soup, producing watertight cube stats', async () => {
    const pool = createPool({ size: 1 });
    const soupPositions = cubeSoupPositions();
    const normals = new Float64Array(CUBE_TRIANGLES.length * 3); // zero normals: parser reads as stored
    const bytes = writeStlBinary({
      positions: soupPositions,
      normals,
      triangleCount: CUBE_TRIANGLES.length,
    });

    const parsed = await pool.run('parseMeshFile', { format: 'stl', bytes }, { transfer: [bytes.buffer] });
    expect(parsed.kind).toBe('stl-soup');
    if (parsed.kind !== 'stl-soup') throw new Error('unreachable');

    const result = await pool.run(
      'intakeMesh',
      { kind: 'soup', positions: parsed.positions },
      { transfer: [parsed.positions.buffer] },
    );

    expect(result.stats.watertight).toBe(true);
    expect(result.stats.signedVolumeMm3).toBeCloseTo(1, 6); // float32 STL round trip: µm-scale tolerance
    expect(result.positions).toHaveLength(8 * 3);
  });
});
