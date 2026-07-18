// repairRemoveComponents / repairSplitNonManifoldEdges / repairFillSmallHoles
// job tests — worker round-trip wiring (transferables, progress,
// before/after MeshStats) for Task 8's repair jobs. The repair ALGORITHMS
// themselves (ear-clipping, Laplacian relax, non-manifold-edge splitting,
// component compaction) are exhaustively covered at the kernel level
// (packages/kernel/src/repair/*.test.ts) — these tests only prove the jobs
// wire real @dqcad/kernel repair functions through a real worker correctly.
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];

function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

// Outward-wound unit cube — same fixture as intakeMesh.test.ts / jobs/misc.ts's
// unitCubeMesh.
const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const CUBE_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 1], [0, 3, 2],
  [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6],
  [0, 4, 7], [0, 7, 3],
];

function cubeMesh(): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: new Float64Array(CUBE_CORNERS.flat()),
    indices: Uint32Array.from(CUBE_TRIANGLES.flat()),
  };
}

describe('WorkerPool — repairRemoveComponents', () => {
  it('drops a small stray component, transfers buffers, and reports before/after stats', async () => {
    const pool = createPool({ size: 1 });
    const cube = cubeMesh();
    // Append a 1-triangle "speck" far from the cube — its own component.
    const positions = new Float64Array(cube.positions.length + 9);
    positions.set(cube.positions, 0);
    positions.set([100, 100, 100, 101, 100, 100, 100, 101, 100], cube.positions.length);
    const indices = new Uint32Array(cube.indices.length + 3);
    indices.set(cube.indices, 0);
    indices.set([8, 9, 10], cube.indices.length);
    const sourceBuffer = positions.buffer;

    const fractions: number[] = [];
    const result = await pool.run(
      'repairRemoveComponents',
      { positions, indices, selector: { mode: 'minTriangles', minTriangles: 2 } },
      { transfer: [positions.buffer, indices.buffer], onProgress: (f) => fractions.push(f) },
    );

    expect(sourceBuffer.byteLength).toBe(0); // moved, not copied
    expect(fractions).toEqual([0, 1]);
    expect(result.statsBefore.componentCount).toBe(2);
    expect(result.statsAfter.componentCount).toBe(1);
    expect(result.statsAfter.watertight).toBe(true);
    expect(result.report.removedComponentIds).toEqual([1]);
    expect(result.positions).toHaveLength(8 * 3);
  });
});

describe('WorkerPool — repairSplitNonManifoldEdges', () => {
  it('resolves a doubled triangle, transfers buffers, and reports before/after stats', async () => {
    const pool = createPool({ size: 1 });
    const cube = cubeMesh();
    const indices = new Uint32Array(cube.indices.length + 3);
    indices.set(cube.indices, 0);
    indices.set(cube.indices.subarray(0, 3), cube.indices.length); // duplicate triangle 0
    const positions = cube.positions;
    const sourceBuffer = positions.buffer;

    const fractions: number[] = [];
    const result = await pool.run(
      'repairSplitNonManifoldEdges',
      { positions, indices },
      { transfer: [positions.buffer, indices.buffer], onProgress: (f) => fractions.push(f) },
    );

    expect(sourceBuffer.byteLength).toBe(0);
    expect(fractions).toEqual([0, 1]);
    expect(result.statsBefore.manifoldEdges).toBe(false);
    expect(result.statsAfter.manifoldEdges).toBe(true);
    expect(result.report.duplicatedVertexCount).toBe(3);
  });
});

describe('WorkerPool — repairSplitNonManifoldVertices', () => {
  it('resolves a bowtie vertex (2 fans sharing only the apex), transfers buffers, and reports before/after stats', async () => {
    const pool = createPool({ size: 1 });
    // Two closed tetrahedron-like fans sharing ONLY apex vertex 0 — same
    // construction as packages/kernel/src/repair/repair.test-fixtures.ts's
    // `singleBowtieMesh` (duplicated here, not imported, per this file's own
    // "worker wiring only, not the algorithm" scope — the algorithm itself
    // is covered at the kernel level, packages/kernel/src/repair/
    // splitNonManifoldVertices.test.ts).
    function apexFan(positions: number[], apex: number, base: ReadonlyArray<readonly [number, number, number]>): number[] {
      const baseIndex = positions.length / 3;
      for (const p of base) positions.push(p[0], p[1], p[2]);
      const [b0, b1, b2] = [baseIndex, baseIndex + 1, baseIndex + 2];
      return [apex, b0, b1, apex, b2, b0, apex, b1, b2, b0, b2, b1];
    }
    const positionsList: number[] = [0, 0, 0];
    const indicesList: number[] = [
      ...apexFan(positionsList, 0, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]),
      ...apexFan(positionsList, 0, [[-1, 0, 0], [0, -1, 0], [0, 0, -1]]),
    ];
    const positions = Float64Array.from(positionsList);
    const indices = Uint32Array.from(indicesList);
    const sourceBuffer = positions.buffer;

    const fractions: number[] = [];
    const result = await pool.run(
      'repairSplitNonManifoldVertices',
      { positions, indices },
      { transfer: [positions.buffer, indices.buffer], onProgress: (f) => fractions.push(f) },
    );

    expect(sourceBuffer.byteLength).toBe(0); // moved, not copied
    expect(fractions).toEqual([0, 1]);
    expect(result.report.nonManifoldVertexCountBefore).toBe(1);
    expect(result.report.duplicatedVertexCount).toBe(1);
    expect(result.report.nonManifoldVertexCountAfter).toBe(0);
    expect(result.positions).toHaveLength(8 * 3);
  });
});

describe('WorkerPool — repairFillSmallHoles', () => {
  it('fills a single-triangle hole, transfers buffers, and reports before/after stats', async () => {
    const pool = createPool({ size: 1 });
    const cube = cubeMesh();
    // Drop triangle 0 ([0, 2, 1]) — its 3 edges are each shared with exactly
    // one other cube triangle, so removing it leaves one clean 3-edge
    // boundary loop over vertices {0, 1, 2}.
    const indices = Uint32Array.from(cube.indices.subarray(3));
    const positions = cube.positions;
    const sourceBuffer = positions.buffer;

    const fractions: number[] = [];
    const result = await pool.run(
      'repairFillSmallHoles',
      { positions, indices },
      { transfer: [positions.buffer, indices.buffer], onProgress: (f) => fractions.push(f) },
    );

    expect(sourceBuffer.byteLength).toBe(0);
    expect(fractions).toEqual([0, 1]);
    expect(result.statsBefore.watertight).toBe(false);
    expect(result.statsAfter.watertight).toBe(true);
    expect(result.report.loopsFilled).toBe(1);
    expect(result.report.loopsSkipped).toHaveLength(0);
  });

  it('honors a custom maxBoundaryEdges option, refusing an otherwise-fillable hole', async () => {
    const pool = createPool({ size: 1 });
    const cube = cubeMesh();
    const indices = Uint32Array.from(cube.indices.subarray(3));
    const positions = cube.positions;

    const result = await pool.run('repairFillSmallHoles', {
      positions,
      indices,
      options: { maxBoundaryEdges: 2 },
    });

    expect(result.statsAfter.watertight).toBe(false);
    expect(result.report.loopsFilled).toBe(0);
    expect(result.report.loopsSkipped).toHaveLength(1);
    expect(result.report.loopsSkipped[0]!.reason).toBe('tooManyEdges');
  });
});
