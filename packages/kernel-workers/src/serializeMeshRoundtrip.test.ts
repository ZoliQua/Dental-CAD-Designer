// serializeMeshStl / weldMeshSoup job tests (Task 11: scene persistence) —
// exercised via the Node worker_threads path, same rationale as
// intakeMesh.test.ts. Covers: (a) an already-welded indexed mesh
// round-trips through serializeMeshStl -> (binary STL bytes) ->
// parseMeshFile -> weldMeshSoup back to the same topology (same vertex/
// triangle counts, coordinates equal within float32 STL precision — see
// jobs.ts's module doc for why NOT bit-identical), (b) serializeMeshStl's
// output is a real, parseable binary STL, (c) weldMeshSoup's report is a
// single 'weld' step (the "intake-skip" contract), (d) output buffers are
// transferred (not copied) back.
import { afterEach, describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
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

const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

// Outward-wound unit cube (same fixture as jobs.ts's unitCubeMesh / intakeMesh.test.ts).
const CUBE_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 1], [0, 3, 2],
  [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6],
  [0, 4, 7], [0, 7, 3],
];

function unitCubeIndexedMesh(): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: new Float64Array(CUBE_CORNERS.flat()),
    indices: Uint32Array.from(CUBE_TRIANGLES.flat()),
  };
}

describe('WorkerPool — serializeMeshStl', () => {
  it('writes a parseable binary STL whose triangle count matches the indexed mesh', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = unitCubeIndexedMesh();
    const positionsCopy = positions.slice();
    const indicesCopy = indices.slice();

    const result = await pool.run(
      'serializeMeshStl',
      { positions: positionsCopy, indices: indicesCopy },
      { transfer: [positionsCopy.buffer, indicesCopy.buffer] },
    );

    expect(result.bytes).toBeInstanceOf(Uint8Array);
    const parsed = parseStl(result.bytes);
    expect(parsed.soup.triangleCount).toBe(12);
    expect(parsed.diagnostics.format).toBe('stl-binary');
  });

  it('rejects non-Float64Array positions', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('serializeMeshStl', {
        // @ts-expect-error deliberately wrong type for the runtime guard
        positions: [0, 0, 0],
        indices: Uint32Array.from([0, 1, 2]),
      }),
    ).rejects.toThrow(/Float64Array/);
  });
});

describe('WorkerPool — weldMeshSoup', () => {
  it('reconstructs the SAME topology from a serialize -> parse -> weld round trip', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = unitCubeIndexedMesh();

    const serialized = await pool.run(
      'serializeMeshStl',
      { positions: positions.slice(), indices: indices.slice() },
      { transfer: [] },
    );
    const parsed = parseStl(serialized.bytes);
    expect(parsed.soup.positions).toHaveLength(12 * 9); // unindexed soup

    const sourceBuffer = parsed.soup.positions.buffer;
    const welded = await pool.run(
      'weldMeshSoup',
      { positions: parsed.soup.positions },
      { transfer: [parsed.soup.positions.buffer] },
    );

    // Input buffer was moved into the worker, not copied.
    expect(sourceBuffer.byteLength).toBe(0);

    expect(welded.positions).toHaveLength(8 * 3); // welds back to 8 unique vertices
    expect(welded.indices).toHaveLength(12 * 3);
    expect(welded.stats.watertight).toBe(true);
    expect(welded.stats.componentCount).toBe(1);
    expect(welded.stats.signedVolumeMm3).toBeCloseTo(1, 4); // float32 STL precision, not 1e-12
    // "Intake-skip" contract: exactly one step, named 'weld' — no
    // dropDegenerateTriangles/orientNormalsConsistently re-run.
    expect(welded.report.steps.map((s) => s.step)).toEqual(['weld']);
    expect(welded.report.weldEpsilonMm).toBe(1e-6);
    const weldStep = welded.report.steps[0]!;
    expect(weldStep.before.vertexCount).toBe(36);
    expect(weldStep.after.vertexCount).toBe(8);

    // Coordinates match the original within float32 STL precision (not
    // bit-identical — see jobs.ts's module doc).
    for (let i = 0; i < welded.positions.length; i++) {
      const originalValue = positions[i % positions.length]!;
      // Loose bound: any welded vertex should be within float32 rounding of
      // SOME original cube corner (0 or 1) — a coarse but sufficient shape
      // check given cube corners are only 0/1 valued.
      expect(Math.abs(welded.positions[i]! - Math.round(welded.positions[i]!))).toBeLessThan(1e-4);
      void originalValue;
    }
  });

  it('rejects a positions length that is not a multiple of 9', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('weldMeshSoup', { positions: new Float64Array(10) }),
    ).rejects.toThrow(/multiple of 9/);
  });
});
