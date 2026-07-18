// undercutScan / undercutScanBatch job tests (Phase 2 Task 9) — exercised
// via a real Node worker_threads WorkerPool, same rationale as
// bvhJobs.test.ts / distanceHeatmap.test.ts: job logic is environment-
// agnostic, so testing it through the real Comlink transport also proves
// payload shapes and thrown-error names survive the postMessage boundary.
//
// Includes the "batch timing on the prep-die for ~50 hemisphere directions"
// measurement this task's report cites as the Phase 3 interactivity signal
// (see the last describe block) — both on the small CHECKED-IN
// standin-prep-die.stl fixture (as asked) and, since that fixture is
// deliberately tiny (384 triangles — a "standin", not real-scan scale), on
// a larger IN-MEMORY synthetic icosphere for a more representative number
// (same "perf smoke test never touches disk/LFS" convention as
// distanceHeatmap.test.ts's own performance section).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
import { intake, type IndexedMesh } from '@dqcad/kernel';
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

const CUBE_HASH = 'undercut-cube-hash';

describe('undercutScan job — behavioral tests (unit cube)', () => {
  it('matches the hand-checkable kernel result: d=+Z undercuts exactly the bottom face, depth === 1', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const result = await pool.run('undercutScan', { contentHash: CUBE_HASH, direction: [0, 0, 1] });
    expect(result.triangleCount).toBe(12);
    expect(result.undercutTriangleCount).toBe(2);
    expect(result.maxDepthMm).toBeCloseTo(1, 9);
    let bottomFound = 0;
    for (let t = 0; t < result.triangleCount; t++) {
      if (result.undercut[t] === 1) {
        bottomFound++;
        expect(result.depthMm[t]).toBeCloseTo(1, 9);
      }
    }
    expect(bottomFound).toBe(2);
  });

  it('defaults sampling to centroid, and accepts corners explicitly', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const defaulted = await pool.run('undercutScan', { contentHash: CUBE_HASH, direction: [0, 0, 1] });
    expect(defaulted.sampling).toBe('centroid');
    const corners = await pool.run('undercutScan', { contentHash: CUBE_HASH, direction: [0, 0, 1], sampling: 'corners' });
    expect(corners.sampling).toBe('corners');
    expect(corners.maxDepthMm).toBeCloseTo(defaulted.maxDepthMm, 9); // flat cube face: identical either way
  });

  it('rejects with BvhNotCachedError when the target contentHash was never built on this worker', async () => {
    const pool = createPool({ size: 1 });
    await expect(pool.run('undercutScan', { contentHash: 'never-built', direction: [0, 0, 1] })).rejects.toMatchObject({
      name: 'BvhNotCachedError',
    });
  });

  it('rejects a zero-length direction', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    await expect(pool.run('undercutScan', { contentHash: CUBE_HASH, direction: [0, 0, 0] })).rejects.toThrow(
      /non-zero-length/,
    );
  });

  it('reports per-triangle-batch progress ending at 1 and is cancellable mid-scan', async () => {
    const pool = createPool({ size: 1 });
    // A larger synthetic mesh so there's more than one progress checkpoint
    // (UNDERCUT_PROGRESS_CHUNK_TRIANGLES in jobs/undercut.ts is 2000).
    const mesh = buildIcosphereForTest(5); // 10,242 vertices, 20,480 triangles
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'undercut-icosphere', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );

    const progressValues: number[] = [];
    const result = await pool.run(
      'undercutScan',
      { contentHash: 'undercut-icosphere', direction: [0, 0, 1] },
      { onProgress: (fraction) => progressValues.push(fraction) },
    );
    expect(result.triangleCount).toBe(mesh.indices.length / 3);
    expect(progressValues.length).toBeGreaterThan(1);
    expect(progressValues[progressValues.length - 1]).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run('undercutScan', { contentHash: 'undercut-icosphere', direction: [0, 0, 1] }, { signal: controller.signal }),
    ).rejects.toThrow(JobCancelledError);
  });

  it('determinism: two identical calls produce bit-identical undercut/depthMm', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    const a = await pool.run('undercutScan', { contentHash: CUBE_HASH, direction: [0.3, 0.4, 0.5] });
    const b = await pool.run('undercutScan', { contentHash: CUBE_HASH, direction: [0.3, 0.4, 0.5] });
    expect(Array.from(a.undercut)).toEqual(Array.from(b.undercut));
    expect(Array.from(a.depthMm)).toEqual(Array.from(b.depthMm));
  });
});

describe('undercutScanBatch job — multi-direction consistency, progress, cancellation', () => {
  it('every direction slice matches an equivalent single-direction undercutScan call', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const directions: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 1],
    ];
    const batch = await pool.run('undercutScanBatch', { contentHash: CUBE_HASH, directions });
    expect(batch.directionCount).toBe(directions.length);
    expect(batch.triangleCount).toBe(12);

    for (let i = 0; i < directions.length; i++) {
      const single = await pool.run('undercutScan', { contentHash: CUBE_HASH, direction: directions[i]! });
      const sliceStart = i * batch.triangleCount;
      const undercutSlice = Array.from(batch.undercut.slice(sliceStart, sliceStart + batch.triangleCount));
      const depthSlice = Array.from(batch.depthMm.slice(sliceStart, sliceStart + batch.triangleCount));
      expect(undercutSlice).toEqual(Array.from(single.undercut));
      expect(depthSlice).toEqual(Array.from(single.depthMm));
      expect(batch.undercutTriangleCounts[i]).toBe(single.undercutTriangleCount);
      expect(batch.maxDepthMmPerDirection[i]).toBeCloseTo(single.maxDepthMm, 9);
      expect(Array.from(batch.directionUnits.slice(i * 3, i * 3 + 3))).toEqual(single.directionUnit);
    }
  });

  it('an empty directions array returns immediately with zero-length arrays (progress still reaches 1)', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    const progressValues: number[] = [];
    const batch = await pool.run(
      'undercutScanBatch',
      { contentHash: CUBE_HASH, directions: [] },
      { onProgress: (f) => progressValues.push(f) },
    );
    expect(batch.directionCount).toBe(0);
    expect(batch.undercut.length).toBe(0);
    expect(progressValues[progressValues.length - 1]).toBe(1);
  });

  it('rejects with BvhNotCachedError when the target contentHash was never built on this worker', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('undercutScanBatch', { contentHash: 'never-built', directions: [[0, 0, 1]] }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('reports progress across BOTH directions and per-triangle-batches within a direction, ending at 1; cancellable mid-batch', async () => {
    const pool = createPool({ size: 1 });
    const mesh = buildIcosphereForTest(4); // 2562 vertices, 5120 triangles — >1 chunk per direction
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'undercut-batch-icosphere', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );

    const directions: ReadonlyArray<readonly [number, number, number]> = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const progressValues: number[] = [];
    const batch = await pool.run(
      'undercutScanBatch',
      { contentHash: 'undercut-batch-icosphere', directions },
      { onProgress: (f) => progressValues.push(f) },
    );
    expect(batch.directionCount).toBe(3);
    // Monotonically non-decreasing, reaching exactly 1 at the end, with more
    // than one checkpoint per direction (3 directions -> > 3 checkpoints).
    expect(progressValues.length).toBeGreaterThan(directions.length);
    expect(progressValues[progressValues.length - 1]).toBe(1);
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]!).toBeGreaterThanOrEqual(progressValues[i - 1]!);
    }

    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'undercutScanBatch',
        { contentHash: 'undercut-batch-icosphere', directions },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });
});

// ---------------------------------------------------------------------------
// Minimal, deterministic icosphere builder — duplicated (not imported) from
// scripts/generate-fixtures.ts's `buildIcosphere`, same precedent as
// distanceHeatmap.test.ts's own `buildLargeIcosphereForPerfTest` (that
// file's doc: "TOOLING, not a dependency this package should reach across
// the repo root for just to build a throwaway test mesh").
// ---------------------------------------------------------------------------
function buildIcosphereForTest(subdivisions: number): IndexedMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: Array<[number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  function normalize(v: [number, number, number]): [number, number, number] {
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  }
  const vertices: Array<[number, number, number]> = raw.map(normalize);
  let faces: Array<[number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; s++) {
    const midpointCache = new Map<string, number>();
    function midpoint(i: number, j: number): number {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;
      const a = vertices[i]!;
      const b = vertices[j]!;
      const idx = vertices.length;
      vertices.push(normalize([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]));
      midpointCache.set(key, idx);
      return idx;
    }
    const nextFaces: Array<[number, number, number]> = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nextFaces;
  }
  const positions = new Float64Array(vertices.length * 3);
  vertices.forEach((v, i) => {
    positions[i * 3] = v[0] * 5;
    positions[i * 3 + 1] = v[1] * 5;
    positions[i * 3 + 2] = v[2] * 5;
  });
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach(([a, b, c], i) => {
    indices[i * 3] = a;
    indices[i * 3 + 1] = b;
    indices[i * 3 + 2] = c;
  });
  return { positions, indices };
}

/** Fibonacci-lattice hemisphere sample (`+Z` hemisphere) — TEST-ONLY
 * direction generator for the batch-timing measurement below, deliberately
 * NOT exported from @dqcad/kernel or this package (Phase 3's actual
 * hemisphere-sampling strategy for insertion-axis optimization is out of
 * THIS task's scope — YAGNI per this task's guardrail: "no axis
 * OPTIMIZATION"). Standard deterministic equal-area lattice (no
 * Math.random), good enough to exercise `undercutScanBatch` at a
 * representative direction COUNT for the timing signal this task's report
 * asks for. */
function fibonacciHemisphereDirections(count: number): Array<readonly [number, number, number]> {
  const directions: Array<readonly [number, number, number]> = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    // Map i in [0, count) to z in [0, 1) (upper hemisphere only).
    const z = (i + 0.5) / count;
    const radius = Math.sqrt(1 - z * z);
    const theta = goldenAngle * i;
    directions.push([radius * Math.cos(theta), radius * Math.sin(theta), z]);
  }
  return directions;
}

// ---------------------------------------------------------------------------
// Batch timing on ~50 hemisphere directions — the Phase 3 interactivity
// signal this task's report cites.
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readStandinPrepDie(): IndexedMesh {
  const bytes = readFileSync(join(repoRoot, 'test-fixtures', 'standin-scans', 'standin-prep-die.stl'));
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

describe('undercutScanBatch job — batch timing (Phase 3 interactivity signal)', () => {
  it('~50 hemisphere directions against standin-prep-die.stl (checked-in fixture, 384 triangles)', async () => {
    const pool = createPool({ size: 1 });
    const mesh = readStandinPrepDie();
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'standin-prep-die', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );

    const directions = fibonacciHemisphereDirections(50);
    const start = performance.now();
    const batch = await pool.run('undercutScanBatch', { contentHash: 'standin-prep-die', directions });
    const elapsedMs = performance.now() - start;

    console.log(
      `[undercutScanBatch timing] standin-prep-die.stl: ${mesh.indices.length / 3} triangles x ${directions.length} ` +
        `hemisphere directions = ${elapsedMs.toFixed(2)}ms total (${(elapsedMs / directions.length).toFixed(3)}ms/direction)`,
    );
    expect(batch.directionCount).toBe(50);
    expect(elapsedMs).toBeLessThan(10_000); // generous — this fixture is tiny (384 tris); see the larger synthetic case below
  }, 30_000);

  it('~50 hemisphere directions against a ~20k-triangle synthetic icosphere (more representative of a real prep scan)', async () => {
    const pool = createPool({ size: 1 });
    const mesh = buildIcosphereForTest(5); // 10,242 vertices, 20,480 triangles
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'perf-icosphere-batch', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );

    const directions = fibonacciHemisphereDirections(50);
    const start = performance.now();
    const batch = await pool.run('undercutScanBatch', { contentHash: 'perf-icosphere-batch', directions });
    const elapsedMs = performance.now() - start;

    let totalUndercutTriangles = 0;
    for (const c of batch.undercutTriangleCounts) totalUndercutTriangles += c;

    console.log(
      `[undercutScanBatch timing] synthetic icosphere: ${mesh.indices.length / 3} triangles x ${directions.length} ` +
        `hemisphere directions = ${elapsedMs.toFixed(2)}ms total (${(elapsedMs / directions.length).toFixed(3)}ms/direction), ` +
        `mean undercut fraction ${(totalUndercutTriangles / (batch.triangleCount * directions.length)).toFixed(4)}`,
    );
    expect(batch.directionCount).toBe(50);
    expect(elapsedMs).toBeLessThan(30_000); // generous — see this task's report for the measured figure
  }, 60_000);

  it('determinism: hashing the flattened batch result is bit-identical across two identical runs', async () => {
    const pool = createPool({ size: 1 });
    const mesh = readStandinPrepDie();
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'standin-prep-die-det', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );
    const directions = fibonacciHemisphereDirections(10);
    const a = await pool.run('undercutScanBatch', { contentHash: 'standin-prep-die-det', directions });
    const b = await pool.run('undercutScanBatch', { contentHash: 'standin-prep-die-det', directions });
    const hashOf = (r: typeof a): string => {
      const hash = createHash('sha256');
      hash.update(Buffer.from(r.undercut.buffer, r.undercut.byteOffset, r.undercut.byteLength));
      hash.update(Buffer.from(r.depthMm.buffer, r.depthMm.byteOffset, r.depthMm.byteLength));
      return hash.digest('hex');
    };
    expect(hashOf(a)).toBe(hashOf(b));
  });
});
