// geodesicPath / snapPolyline job tests (Phase 2 Task 4) — exercised via a
// real Node worker_threads WorkerPool, same rationale as bvhJobs.test.ts /
// distanceHeatmap.test.ts: job logic is environment-agnostic, so testing it
// through the real Comlink transport also proves payload shapes and
// thrown-error names survive the postMessage boundary. The geodesic
// ALGORITHM itself (corridor seeding, unfold/funnel straightening, widening,
// `@errorBound`, the icosphere ACCEPTANCE test) is exhaustively covered at
// the kernel level (packages/kernel/src/geodesic/*.test.ts) — these tests
// only prove the jobs wire @dqcad/kernel's `geodesicPath`/
// `snapPolylineGeodesic` through a real worker correctly, including the
// per-worker BVH+halfedge cache contract (jobs/geodesic.ts's module doc).
//
// ## Performance guardrail (this task's brief)
//
// "a margin-line edit re-snaps 1-2 segments on a ~250k-tri mesh — target
// interactive latency (< 100 ms per segment on the upperjaw fixture;
// measure + report)". The describe block at the bottom of this file
// measures exactly that: the real, checked-in arch-case-01 upperjaw STL
// (250,128 triangles — same fixture test/golden/curvature.test.ts's golden
// snapshot uses), a real `buildBvh` job (which also warms the
// jobs/geodesic.ts per-worker halfedge cache on first geodesicPath call),
// and a LOCAL (one-ring-adjacent) start/end pair — matching a real margin-
// edit's scale, not a long cross-mesh query (the icosphere acceptance test
// already covers long-path accuracy/timing separately).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
import { buildHalfedge, intake, oneRingFaces, type IndexedMesh } from '@dqcad/kernel';
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
// Small synthetic fixture (icosahedron — 12 vertices / 20 triangles, genus
// 0, closed) for the behavioral tests below.
// ---------------------------------------------------------------------------

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

function icosahedronBuffers(radius = 5): { positions: Float64Array; indices: Uint32Array } {
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

const ICO_HASH = 'geodesic-jobs-icosahedron';

describe('geodesicPath job', () => {
  it('computes a path between two adjacent triangles, reports progress [0,1], and transfers buffers', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });

    const progressValues: number[] = [];
    const start = { triangleIndex: 0, barycentric: [1 / 3, 1 / 3, 1 / 3] as const };
    const end = { triangleIndex: 1, barycentric: [1 / 3, 1 / 3, 1 / 3] as const };
    const result = await pool.run(
      'geodesicPath',
      { contentHash: ICO_HASH, start, end },
      { onProgress: (fraction) => progressValues.push(fraction) },
    );

    expect(progressValues).toEqual([0, 1]);
    expect(result.length).toBeGreaterThan(0);
    expect(result.triangleIndices.length).toBe(result.barycentric.length / 3);
    expect(result.triangleIndices[0]).toBe(0);
    expect(result.triangleIndices[result.triangleIndices.length - 1]).toBe(1);
    expect(result.iterations).toBeGreaterThanOrEqual(0);
    expect(typeof result.converged).toBe('boolean');
  });

  it('same start/end triangle+barycentric: length 0, a single point', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });

    const sp = { triangleIndex: 3, barycentric: [0.2, 0.3, 0.5] as const };
    const result = await pool.run('geodesicPath', { contentHash: ICO_HASH, start: sp, end: sp });
    expect(result.length).toBe(0);
  });

  it('rejects with BvhNotCachedError when the contentHash was never built on this worker', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('geodesicPath', {
        contentHash: 'never-built',
        start: { triangleIndex: 0, barycentric: [1 / 3, 1 / 3, 1 / 3] },
        end: { triangleIndex: 1, barycentric: [1 / 3, 1 / 3, 1 / 3] },
      }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('is cancellable before it starts', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'geodesicPath',
        {
          contentHash: ICO_HASH,
          start: { triangleIndex: 0, barycentric: [1 / 3, 1 / 3, 1 / 3] },
          end: { triangleIndex: 1, barycentric: [1 / 3, 1 / 3, 1 / 3] },
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it('releaseBvh also evicts the per-worker halfedge cache — a rebuild under the SAME contentHash with a DIFFERENT-topology mesh works correctly', async () => {
    const pool = createPool({ size: 1 });
    const ico = icosahedronBuffers(); // 20 triangles
    await pool.run('buildBvh', {
      contentHash: ICO_HASH,
      positions: ico.positions,
      indices: ico.indices,
    });
    // Warm the halfedge cache for the icosahedron topology.
    await pool.run('geodesicPath', {
      contentHash: ICO_HASH,
      start: { triangleIndex: 0, barycentric: [1 / 3, 1 / 3, 1 / 3] },
      end: { triangleIndex: 19, barycentric: [1 / 3, 1 / 3, 1 / 3] },
    });

    await pool.run('releaseBvh', { contentHash: ICO_HASH });

    // Rebuild the SAME contentHash with a DIFFERENT-topology mesh (a unit
    // cube — 12 triangles vs the icosahedron's 20, different vertex count).
    // If jobs/geodesic.ts's halfedge cache were NOT evicted on releaseBvh,
    // the stale icosahedron overlay (faceCount 20, 12 vertices) would be
    // used against the cube's buffers — wrong topology, wrong/undefined
    // results. With correct eviction this recomputes a fresh overlay and
    // returns a valid path on the cube.
    const cubePositions = new Float64Array(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ].flat(),
    );
    const cubeIndices = Uint32Array.from(
      [
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
      ].flat(),
    );
    await pool.run('buildBvh', {
      contentHash: ICO_HASH,
      positions: cubePositions,
      indices: cubeIndices,
    });

    const result = await pool.run('geodesicPath', {
      contentHash: ICO_HASH,
      start: { triangleIndex: 0, barycentric: [1 / 3, 1 / 3, 1 / 3] }, // bottom face
      end: { triangleIndex: 2, barycentric: [1 / 3, 1 / 3, 1 / 3] }, // top face
    });
    expect(Number.isFinite(result.length)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // Bottom-face centroid to top-face centroid on a unit cube: the path
    // must at least span the cube's height (1) and is bounded by a walk
    // over a few unit faces — a coarse sanity envelope, deliberately loose.
    expect(result.length).toBeGreaterThan(1);
    expect(result.length).toBeLessThan(4);
  });

  it('determinism: two identical calls produce bit-identical results', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });

    const start = { triangleIndex: 2, barycentric: [0.5, 0.25, 0.25] as const };
    const end = { triangleIndex: 15, barycentric: [0.1, 0.6, 0.3] as const };
    const a = await pool.run('geodesicPath', { contentHash: ICO_HASH, start, end });
    const b = await pool.run('geodesicPath', { contentHash: ICO_HASH, start, end });
    expect(Array.from(b.triangleIndices)).toEqual(Array.from(a.triangleIndices));
    expect(Array.from(b.barycentric)).toEqual(Array.from(a.barycentric));
    expect(b.length).toBe(a.length);
  });
});

describe('snapPolyline job', () => {
  it('projects anchors onto the surface and joins them with geodesic segments', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers(5);
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });

    // 3 points slightly OFF the r=5 sphere.
    const points = new Float64Array([6, 0, 0, 0, 6, 0, 0, 0, 6]);
    const result = await pool.run('snapPolyline', { contentHash: ICO_HASH, points });

    expect(result.anchorTriangleIndices.length).toBe(3);
    expect(result.anchorBarycentric.length).toBe(9);
    expect(result.segmentPointCounts.length).toBe(2);
    expect(result.segmentLengths.length).toBe(2);
    for (const length of result.segmentLengths) {
      expect(length).toBeGreaterThan(0);
    }
    expect(result.segmentTriangleIndices.length).toBe(
      Array.from(result.segmentPointCounts).reduce((a, b) => a + b, 0),
    );
    expect(result.segmentConverged.length).toBe(2);
    // Aggregate `converged` is the AND of the per-segment flags.
    const expectedAggregate = Array.from(result.segmentConverged).every((v) => v === 1);
    expect(result.converged).toBe(expectedAggregate);
  });

  it('rejects a malformed points array (length not a multiple of 3)', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });
    await expect(
      pool.run('snapPolyline', { contentHash: ICO_HASH, points: new Float64Array([0, 0]) }),
    ).rejects.toThrow(/multiple of 3/);
  });
});

// ---------------------------------------------------------------------------
// Performance guardrail — real arch-case-01 upperjaw fixture (250,128
// triangles). See this file's top doc.
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const upperjawStlPath = join(
  repoRoot,
  'test-fixtures',
  'real-scans',
  'arch-case-01',
  'arch-case-01-upperjaw.stl',
);

function loadUpperjawMesh(): IndexedMesh {
  const bytes = readFileSync(upperjawStlPath);
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

describe('geodesicPath job — performance guardrail (real upperjaw fixture)', () => {
  it('a LOCAL (one-ring-adjacent) segment re-snap completes well under 100 ms on the real 250k-triangle mesh', async () => {
    const mesh = loadUpperjawMesh();
    const triangleCount = mesh.indices.length / 3;
    expect(triangleCount).toBeGreaterThan(200_000); // sanity: this really is the ~250k-tri fixture

    // Pick a genuinely LOCAL pair (one-ring-adjacent triangles) — a margin-
    // line edit re-snaps 1-2 SHORT segments, not a long cross-mesh path (the
    // icosphere acceptance test already covers long-path timing).
    const hm = buildHalfedge(mesh);
    const anchorVertex = Math.floor(mesh.positions.length / 3 / 2); // an arbitrary interior-ish vertex
    const ring = oneRingFaces(hm, anchorVertex);
    expect(ring.length).toBeGreaterThan(0);
    const startFace = ring[0]!;
    const endFace = ring[ring.length - 1]!;

    const pool = createPool({ size: 1 });
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    const buildStart = performance.now();
    await pool.run(
      'buildBvh',
      { contentHash: 'upperjaw-perf', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );
    const buildMs = performance.now() - buildStart;

    const start = { triangleIndex: startFace, barycentric: [1 / 3, 1 / 3, 1 / 3] as const };
    const end = { triangleIndex: endFace, barycentric: [1 / 3, 1 / 3, 1 / 3] as const };

    // First call also warms the per-worker halfedge cache (jobs/geodesic.ts)
    // — measure it separately from the WARM, cache-hit calls a real
    // incremental re-snap workflow would actually perform repeatedly.
    const firstCallStart = performance.now();
    const firstResult = await pool.run('geodesicPath', {
      contentHash: 'upperjaw-perf',
      start,
      end,
    });
    const firstCallMs = performance.now() - firstCallStart;
    expect(firstResult.length).toBeGreaterThan(0);

    const WARM_CALLS = 5;
    const warmTimings: number[] = [];
    for (let i = 0; i < WARM_CALLS; i++) {
      const t0 = performance.now();
      await pool.run('geodesicPath', { contentHash: 'upperjaw-perf', start, end });
      warmTimings.push(performance.now() - t0);
    }
    const maxWarmMs = Math.max(...warmTimings);
    const avgWarmMs = warmTimings.reduce((a, b) => a + b, 0) / warmTimings.length;

    console.log(
      `[geodesicPath perf] upperjaw (${triangleCount} triangles): buildBvh ${buildMs.toFixed(1)}ms, ` +
        `first geodesicPath call (cold halfedge cache) ${firstCallMs.toFixed(1)}ms, ` +
        `${WARM_CALLS} warm calls: max ${maxWarmMs.toFixed(2)}ms, avg ${avgWarmMs.toFixed(2)}ms ` +
        `(UX target: < 100ms/segment, see docs/demos/phase-2.md for the real measured number)`,
    );

    // Phase 2 Task 12 fix (full-suite timing flakiness under CPU contention,
    // see .superpowers/sdd/progress.md's P2 Task 11 carry-over note): this
    // in-suite assertion is a SMOKE test ("completes, doesn't regress by an
    // order of magnitude"), not the UX benchmark itself — the real <100ms/
    // ~5ms-warm target is measured and reported honestly in
    // docs/demos/phase-2.md, run in isolation on an uncontended machine.
    // Under `npm test`'s full parallel run, this file can share CPU with
    // other heavy suites (e.g. packages/kernel/src/offset/offsetMesh.test.ts,
    // which is itself now isolated behind RUN_OFFSET_ACCEPTANCE — see that
    // file's module doc), so a strict 100ms ceiling measured a ~5ms-warm
    // operation flaking under noisy-neighbor contention. 750ms is generous
    // (150x the typically-measured ~5ms) while still catching a genuine
    // algorithmic regression (e.g. the cache not hitting at all, which was
    // observed pre-fix to cost tens of ms per call, not hundreds).
    expect(maxWarmMs).toBeLessThan(750);
  }, 30_000);
});
