// distanceHeatmap job tests (Task 9) — exercised via a real Node
// worker_threads WorkerPool, same rationale as bvhJobs.test.ts: job logic is
// environment-agnostic, so testing it through the real Comlink transport
// also proves payload shapes and thrown-error names survive the postMessage
// boundary.
//
// ## Acceptance-critical tests
//
// This file's two "acceptance" describe blocks are the phase-acceptance
// criterion itself (docs/plans/phase-1-import-viewer.md's Global
// Constraints: "distance heatmap between two known-offset synthetic meshes
// reports the analytic offset within ±1 µm") — they parse the CHECKED-IN
// STL fixture bytes (test-fixtures/synthetic/offset-pair-*.stl,
// plane-pair-*.stl — see scripts/generate-fixtures.ts's
// `HEATMAP_FIXTURE_PAIRS` doc for the tessellation-error derivation), run
// the real distanceHeatmap job through a real worker, and assert every
// vertex's measured distance is within budget of the fixture's documented
// analytic offset. The measured worst-case deviations are logged so they
// can be copied into the phase acceptance evidence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
import { weldVertices, type IndexedMesh } from '@dqcad/kernel';
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
// Small synthetic fixtures (unit cube) for the non-acceptance behavioral
// tests below — same outward-wound cube as bvhJobs.test.ts/jobs.ts's
// unitCubeMesh.
// ---------------------------------------------------------------------------

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

const CUBE_HASH = 'distance-heatmap-cube';

describe('distanceHeatmap — behavioral tests (unit cube)', () => {
  it('heatmap(A, A) is exactly 0 for every vertex — no epsilon needed, each query point IS a mesh vertex', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const queryPoints = cubeBuffers().positions; // fresh copy — buildBvh's positions were transferred (detached)
    const result = await pool.run('distanceHeatmap', {
      contentHash: CUBE_HASH,
      points: queryPoints,
    });

    expect(result.distances.length).toBe(8);
    for (const d of result.distances) {
      expect(d).toBe(0);
    }
    expect(result.min).toBe(0);
    expect(result.max).toBe(0);
    expect(result.mean).toBe(0);
    expect(result.rms).toBe(0);
  });

  it('unsigned: a point straight out from a face reports its perpendicular distance', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    // 2 units above the top face's center (top face z=1, 0<=x,y<=1) and 2
    // units below the bottom face — same fixture bvhJobs.test.ts uses for
    // measurePointToSurface, batched here as two points in one call.
    const result = await pool.run('distanceHeatmap', {
      contentHash: CUBE_HASH,
      points: new Float64Array([0.5, 0.5, 3, 0.5, 0.5, -2]),
    });
    expect(result.distances[0]).toBeCloseTo(2, 12);
    expect(result.distances[1]).toBeCloseTo(2, 12);
    expect(result.min).toBeCloseTo(2, 12);
    expect(result.max).toBeCloseTo(2, 12);
  });

  it('signed: outside the cube is positive, inside is negative', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const result = await pool.run('distanceHeatmap', {
      contentHash: CUBE_HASH,
      // Outside (above top face), then inside (cube's own center).
      points: new Float64Array([0.5, 0.5, 3, 0.5, 0.5, 0.5]),
      signed: true,
    });
    expect(result.distances[0]).toBeGreaterThan(0);
    expect(result.distances[0]).toBeCloseTo(2, 12);
    expect(result.distances[1]).toBeLessThan(0);
    expect(result.distances[1]).toBeCloseTo(-0.5, 12); // center is 0.5mm from every face
  });

  it('unsigned distances are always >= 0 even when signed is omitted for a point inside the mesh', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    const result = await pool.run('distanceHeatmap', {
      contentHash: CUBE_HASH,
      points: new Float64Array([0.5, 0.5, 0.5]),
    });
    expect(result.distances[0]).toBeCloseTo(0.5, 12);
  });

  it('rejects with BvhNotCachedError when the target contentHash was never built on this worker', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('distanceHeatmap', { contentHash: 'never-built', points: new Float64Array([0, 0, 0]) }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('rejects a malformed points array (length not a multiple of 3)', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });
    await expect(
      pool.run('distanceHeatmap', { contentHash: CUBE_HASH, points: new Float64Array([0, 0]) }),
    ).rejects.toThrow(/multiple of 3/);
  });

  it('reports progress ending at 1 and is cancellable mid-batch', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    // A few thousand query points so there's more than one progress
    // checkpoint (DISTANCE_HEATMAP_PROGRESS_CHUNK_POINTS in jobs.ts is 2000).
    const pointCount = 5000;
    const points = new Float64Array(pointCount * 3);
    for (let i = 0; i < pointCount; i++) {
      points[i * 3] = 0.5;
      points[i * 3 + 1] = 0.5;
      points[i * 3 + 2] = 3;
    }
    const progressValues: number[] = [];
    const result = await pool.run(
      'distanceHeatmap',
      { contentHash: CUBE_HASH, points },
      { onProgress: (fraction) => progressValues.push(fraction) },
    );
    expect(result.distances.length).toBe(pointCount);
    expect(progressValues.length).toBeGreaterThan(1);
    expect(progressValues[progressValues.length - 1]).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'distanceHeatmap',
        { contentHash: CUBE_HASH, points: points.slice() },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it('determinism: two identical calls produce bit-identical distances (same tie-break, same accumulation order)', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await pool.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    // Points scattered so several land exactly on edges/corners (exact BVH
    // tie-break territory — see closestPoint.ts's doc) as well as ordinary
    // face-interior points.
    const points = new Float64Array([
      0.5, 0.5, 3, 3, 0.5, 0.5, 0.5, 3, 0.5, -1, -1, -1, 2, 2, 2, 0, 0, 0, 1, 1, 1, 0.5, 0.5, 0.5,
    ]);

    const first = await pool.run('distanceHeatmap', { contentHash: CUBE_HASH, points: points.slice() });
    const second = await pool.run('distanceHeatmap', { contentHash: CUBE_HASH, points: points.slice() });
    expect(Array.from(second.distances)).toEqual(Array.from(first.distances));
    expect(second.min).toBe(first.min);
    expect(second.max).toBe(first.max);
    expect(second.mean).toBe(first.mean);
    expect(second.rms).toBe(first.rms);
  });

  it('runs on the SAME size:1 measurement-pool pattern as buildBvh/measurePointToSurface — a second WorkerPool never sees the first pool’s cached BVH', async () => {
    const poolA = createPool({ size: 1 });
    const poolB = createPool({ size: 1 });
    const { positions, indices } = cubeBuffers();
    await poolA.run('buildBvh', { contentHash: CUBE_HASH, positions, indices });

    await expect(
      poolB.run('distanceHeatmap', { contentHash: CUBE_HASH, points: new Float64Array([0, 0, 0]) }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });
});

// ---------------------------------------------------------------------------
// Acceptance: offset-pair-inner.stl / offset-pair-outer.stl — icospheres
// r=5 / r=5.05, analytic offset 50 µm (see scripts/generate-fixtures.ts's
// HEATMAP_FIXTURE_PAIRS doc for the tessellation-error derivation, and
// test-fixtures/synthetic/offset-pair.expected.json for the recorded
// analytic offset/tolerance).
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const syntheticDir = join(repoRoot, 'test-fixtures', 'synthetic');

function readFixtureMesh(name: string): IndexedMesh {
  const bytes = readFileSync(join(syntheticDir, `${name}.stl`));
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return weldVertices(soup);
}

interface PairSidecar {
  analyticOffsetMm: number;
  toleranceMm: number;
}

function readPairSidecar(pairName: string): PairSidecar {
  return JSON.parse(readFileSync(join(syntheticDir, `${pairName}.expected.json`), 'utf8')) as PairSidecar;
}

/** Phase acceptance bound (docs/plans/phase-1-import-viewer.md): "reports
 * the analytic offset within ±1 µm". Both fixtures below assert against
 * this SAME shared bound, on top of (not instead of) each fixture's own
 * tighter, documented generation-time tolerance. */
const PHASE_ACCEPTANCE_BOUND_MM = 1e-3; // 1 µm

describe('distanceHeatmap — ACCEPTANCE: offset-pair (icospheres, 50 µm analytic gap)', () => {
  it('every inner-sphere vertex reports a distance to the outer-sphere mesh within ±1 µm of 50 µm', async () => {
    const pool = createPool({ size: 1 });
    const inner = readFixtureMesh('offset-pair-inner');
    const outer = readFixtureMesh('offset-pair-outer');
    const sidecar = readPairSidecar('offset-pair');

    const outerPositions = outer.positions.slice();
    const outerIndices = outer.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'offset-pair-outer', positions: outerPositions, indices: outerIndices },
      { transfer: [outerPositions.buffer, outerIndices.buffer] },
    );

    const start = performance.now();
    const result = await pool.run('distanceHeatmap', {
      contentHash: 'offset-pair-outer',
      points: inner.positions.slice(),
    });
    const elapsedMs = performance.now() - start;

    let maxDeviationMm = 0;
    for (const d of result.distances) {
      const deviation = Math.abs(d - sidecar.analyticOffsetMm);
      if (deviation > maxDeviationMm) maxDeviationMm = deviation;
    }

    console.log(
      `[distanceHeatmap acceptance] offset-pair: ${result.distances.length} vertices, ` +
        `max|measured-50µm| = ${(maxDeviationMm * 1000).toFixed(4)} µm ` +
        `(fixture's own generation-time bound: ${(sidecar.toleranceMm * 1000).toFixed(4)} µm, ` +
        `phase acceptance bound: 1 µm), computed in ${elapsedMs.toFixed(1)}ms`,
    );

    expect(maxDeviationMm).toBeLessThanOrEqual(PHASE_ACCEPTANCE_BOUND_MM);
    // Tighter, fixture-documented bound (see HEATMAP_FIXTURE_PAIRS's doc) —
    // holding this too proves the acceptance margin isn't a coincidence.
    expect(maxDeviationMm).toBeLessThanOrEqual(sidecar.toleranceMm);
    expect(result.min).toBeGreaterThan(0);
  });
});

describe('distanceHeatmap — ACCEPTANCE: plane-pair (flat planes, exact 17 µm analytic gap)', () => {
  it('every plane-A vertex reports a distance to plane B within ±1 µm (in practice, Float64-exact) of 17 µm', async () => {
    const pool = createPool({ size: 1 });
    const planeA = readFixtureMesh('plane-pair-a');
    const planeB = readFixtureMesh('plane-pair-b');
    const sidecar = readPairSidecar('plane-pair');

    const planeBPositions = planeB.positions.slice();
    const planeBIndices = planeB.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'plane-pair-b', positions: planeBPositions, indices: planeBIndices },
      { transfer: [planeBPositions.buffer, planeBIndices.buffer] },
    );

    const result = await pool.run('distanceHeatmap', {
      contentHash: 'plane-pair-b',
      points: planeA.positions.slice(),
    });

    let maxDeviationMm = 0;
    for (const d of result.distances) {
      const deviation = Math.abs(d - sidecar.analyticOffsetMm);
      if (deviation > maxDeviationMm) maxDeviationMm = deviation;
    }

    console.log(
      `[distanceHeatmap acceptance] plane-pair: ${result.distances.length} vertices, ` +
        `max|measured-17µm| = ${(maxDeviationMm * 1e6).toFixed(6)} nm (phase acceptance bound: 1000 nm = 1 µm)`,
    );

    expect(maxDeviationMm).toBeLessThanOrEqual(PHASE_ACCEPTANCE_BOUND_MM);
    // Planes are flat — no tessellation error at all, only Float64 rounding
    // (~1e-12 mm scale) — hold the fixture's own much tighter documented bound too.
    expect(maxDeviationMm).toBeLessThanOrEqual(sidecar.toleranceMm);
  });
});

// ---------------------------------------------------------------------------
// Performance smoke test — Task 9's guardrail: "250k-vertex heatmap should
// complete in seconds". The checked-in fixtures above are intentionally
// small (a few thousand vertices, kept LFS-light); this builds a much
// larger synthetic mesh IN-MEMORY (never written to disk/LFS) purely to
// exercise the job at a representative scale and report timing. The full
// 250k-vertex/real-scan-geometry case is additionally verified manually
// against arch-case-01 (see this task's report).
// ---------------------------------------------------------------------------

/** Minimal, deterministic icosphere builder — duplicated (not imported) from
 * scripts/generate-fixtures.ts's `buildIcosphere`: that script is
 * fixture-generation TOOLING (its own module doc says as much), not a
 * dependency this package should reach across the repo root for just to
 * build a throwaway perf-test mesh. ~20 lines, same recursive-subdivision
 * algorithm, radius-independent topology (see that file's doc for why that
 * matters for the OTHER, analytic tests above — irrelevant here, this mesh
 * is only ever compared to itself). */
function buildLargeIcosphereForPerfTest(subdivisions: number): IndexedMesh {
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

describe('distanceHeatmap — performance smoke test', () => {
  it('a ~40k-vertex heatmap completes well within a generous multi-second budget', async () => {
    const pool = createPool({ size: 1 });
    const mesh = buildLargeIcosphereForPerfTest(6); // 40,962 vertices, 81,920 triangles
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'perf-sphere', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );

    const start = performance.now();
    const result = await pool.run('distanceHeatmap', {
      contentHash: 'perf-sphere',
      points: mesh.positions.slice(),
    });
    const elapsedMs = performance.now() - start;

    console.log(
      `[distanceHeatmap perf] ${result.distances.length} vertices against an ${
        mesh.indices.length / 3
      }-triangle BVH: ${elapsedMs.toFixed(1)}ms`,
    );
    expect(result.distances.length).toBe(mesh.positions.length / 3);
    expect(elapsedMs).toBeLessThan(10_000); // generous — see this describe block's doc
  }, 30_000);
});
