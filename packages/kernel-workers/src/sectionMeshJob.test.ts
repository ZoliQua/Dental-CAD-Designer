// sectionMesh job tests (Task 10; Phase 3 Task 1 housekeeping: contentHash
// instead of raw buffers) — worker round-trip wiring (transferables,
// progress, flat polyline encoding, optional cap) for the cross-section
// job. The extraction ALGORITHM itself (edge-plane intersection, on-plane
// epsilon policy, the acceptance-critical sphere radius tests) is
// exhaustively covered at the kernel level
// (packages/kernel/src/section/polyline.test.ts) — these tests only prove
// the job wires the real @dqcad/kernel functions through a real worker
// correctly.
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

/** Open box: cubeMesh with its top face (z=1) omitted — not watertight. */
function openBoxMesh(): { positions: Float64Array; indices: Uint32Array } {
  const cube = cubeMesh();
  const withoutTop = CUBE_TRIANGLES.slice(2); // drop the two top-face triangles
  return { positions: cube.positions, indices: Uint32Array.from(withoutTop.flat()) };
}

async function buildBvhFor(
  pool: WorkerPool,
  contentHash: string,
  positions: Float64Array,
  indices: Uint32Array,
): Promise<void> {
  await pool.run('buildBvh', { contentHash, positions, indices });
}

describe('WorkerPool — sectionMesh', () => {
  it('extracts a 4-point closed square outline through a unit cube', async () => {
    const pool = createPool({ size: 1 });
    const cube = cubeMesh();
    const contentHash = 'cube-section';
    await buildBvhFor(pool, contentHash, cube.positions, cube.indices);

    const fractions: number[] = [];
    const result = await pool.run(
      'sectionMesh',
      { contentHash, point: [0, 0, 0.5], normal: [0, 0, 1] },
      { onProgress: (f) => fractions.push(f) },
    );

    expect(fractions[0]).toBe(0);
    expect(fractions.at(-1)).toBe(1);

    expect(result.polylineCounts.length).toBe(1);
    expect(result.polylineClosed.length).toBe(1);
    expect(result.polylineClosed[0]).toBe(1);
    // 8, not 4: each of the cube's 4 side faces is a quad split into 2
    // triangles by a diagonal, and (same effect verified directly in
    // packages/kernel/src/section/polyline.test.ts's torus test) the
    // crossing threads through that diagonal, contributing an extra node
    // per face beyond the shared vertical-edge crossing points — 4 face
    // diagonal points + 4 shared vertical-edge points = 8.
    const pointCount = result.polylineCounts[0]!;
    expect(pointCount).toBe(8);
    expect(result.pointsFlat.length).toBe(pointCount * 3);
    expect(result.points2dFlat.length).toBe(pointCount * 2);
    for (let i = 0; i < pointCount; i++) {
      expect(result.pointsFlat[i * 3 + 2]).toBeCloseTo(0.5, 12); // every point on the cutting plane
    }
    expect(result.capPositions).toBeNull();
    expect(result.capIndices).toBeNull();
  });

  it('computeCap: true returns a filled cap mesh for a watertight input', async () => {
    const pool = createPool({ size: 1 });
    const cube = cubeMesh();
    const contentHash = 'cube-section-cap';
    await buildBvhFor(pool, contentHash, cube.positions, cube.indices);

    const result = await pool.run('sectionMesh', {
      contentHash,
      point: [0, 0, 0.5],
      normal: [0, 0, 1],
      computeCap: true,
    });

    expect(result.capPositions).not.toBeNull();
    expect(result.capIndices).not.toBeNull();
    expect(result.capIndices!.length % 3).toBe(0);
    expect(result.capIndices!.length).toBeGreaterThan(0);
  });

  it('computeCap: true on a non-watertight mesh omits the cap without failing the job', async () => {
    const pool = createPool({ size: 1 });
    const open = openBoxMesh();
    const contentHash = 'open-box-section-cap';
    await buildBvhFor(pool, contentHash, open.positions, open.indices);

    const result = await pool.run('sectionMesh', {
      contentHash,
      point: [0, 0, 0.5],
      normal: [0, 0, 1],
      computeCap: true,
    });

    // The outline is still valid even though the cap was omitted.
    expect(result.polylineCounts.length).toBeGreaterThan(0);
    expect(result.capPositions).toBeNull();
    expect(result.capIndices).toBeNull();
  });

  it('a plane missing the mesh entirely returns zero polylines, no crash', async () => {
    const pool = createPool({ size: 1 });
    const cube = cubeMesh();
    const contentHash = 'cube-section-miss';
    await buildBvhFor(pool, contentHash, cube.positions, cube.indices);

    const result = await pool.run('sectionMesh', { contentHash, point: [0, 0, 100], normal: [0, 0, 1] });

    expect(result.polylineCounts.length).toBe(0);
    expect(result.pointsFlat.length).toBe(0);
    expect(result.points2dFlat.length).toBe(0);
  });

  it('rejects a contentHash with no cached BVH on this worker', async () => {
    const pool = createPool({ size: 1 });
    // Comlink reconstructs a thrown error as a plain Error with the
    // original name/message preserved (not the exact built-in subclass) —
    // same caveat as JobCancelledError elsewhere in this package (see
    // jobs/context.ts's and jobs/bvh.ts's doc comments) — so this asserts by
    // `.name` rather than `instanceof`.
    await expect(
      pool.run('sectionMesh', { contentHash: 'never-built', point: [0, 0, 0], normal: [0, 0, 1] }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('two consecutive section queries for the SAME contentHash both succeed without re-sending buffers', async () => {
    const pool = createPool({ size: 1 });
    const cube = cubeMesh();
    const contentHash = 'cube-section-repeat';
    await buildBvhFor(pool, contentHash, cube.positions, cube.indices);

    const first = await pool.run('sectionMesh', { contentHash, point: [0, 0, 0.25], normal: [0, 0, 1] });
    const second = await pool.run('sectionMesh', { contentHash, point: [0, 0, 0.75], normal: [0, 0, 1] });

    expect(first.polylineCounts.length).toBe(1);
    expect(second.polylineCounts.length).toBe(1);
  });
});
