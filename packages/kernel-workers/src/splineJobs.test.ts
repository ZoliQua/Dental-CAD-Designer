// fitSurfaceSpline / fitSurfaceSplineSpan job tests (Phase 2 Task 5) —
// exercised via a real Node worker_threads WorkerPool, same rationale as
// geodesicJobs.test.ts: job logic is environment-agnostic, so testing it
// through the real Comlink transport also proves payload shapes and
// thrown-error names survive the postMessage boundary. The spline
// ALGORITHM itself (centripetal Catmull-Rom, surface projection,
// `@errorBound`, locality, the great-circle ACCEPTANCE tests) is
// exhaustively covered at the kernel level
// (packages/kernel/src/spline/*.test.ts) — these tests only prove the jobs
// wire @dqcad/kernel's `fitSurfaceSpline`/`fitSurfaceSplineSpan` through a
// real worker correctly, including the per-worker BVH cache contract
// (jobs/spline.ts's module doc).
//
// ## Performance guardrail (this task's guardrails)
//
// "Resample density: expose as points-per-mm... make sure 400-800 samples
// on a real-scan-sized spline stays interactive; measure + report timing on
// the upperjaw fixture." The describe block at the bottom of this file
// measures exactly that: a closed, margin-line-sized (~38mm circumference,
// within the 20-40mm clinical range this task's guardrails cite) control
// polygon on the real, checked-in arch-case-01 upperjaw STL (250,128
// triangles — same fixture geodesicJobs.test.ts's perf test uses) at
// pointsPerMm=15 (within the ~10-20/mm clinical target range,
// surfaceSpline.ts's module doc), which lands in the 400-800 total sample
// guardrail range.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
import { evaluateSurfacePoint, intake, type IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, WorkerPool } from './pool.js';
import { affectedSpanIndices, surfacePointPayloadAt } from './jobs/spline.js';

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
// Small synthetic fixture (icosahedron — 12 vertices / 20 triangles).
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

const ICO_HASH = 'spline-jobs-icosahedron';

function circlePoints(n: number, radius: number, z = 0): Float64Array {
  const flat = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    flat[i * 3] = radius * Math.cos(theta);
    flat[i * 3 + 1] = radius * Math.sin(theta);
    flat[i * 3 + 2] = z;
  }
  return flat;
}

describe('fitSurfaceSpline job', () => {
  it('fits a closed spline, reports progress [0,1], and transfers buffers', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers(5);
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });

    const points = circlePoints(6, 6); // off the r=5 sphere -> snapping pulls onto it
    const progressValues: number[] = [];
    const result = await pool.run(
      'fitSurfaceSpline',
      { contentHash: ICO_HASH, points, closed: true, pointsPerMm: 1 },
      { onProgress: (fraction) => progressValues.push(fraction) },
    );

    expect(progressValues).toEqual([0, 1]);
    expect(result.controlPointTriangleIndices.length).toBe(6);
    expect(result.controlPointBarycentric.length).toBe(18);
    expect(result.spanPointCounts.length).toBe(6); // closed: spanCount === controlPointCount
    expect(Array.from(result.spanPointCounts).reduce((a, b) => a + b, 0)).toBe(result.spanTriangleIndices.length);
    expect(result.spanLengths.length).toBe(6);
    for (const length of result.spanLengths) expect(length).toBeGreaterThan(0);
    expect(typeof result.converged).toBe('boolean');
    expect(Number.isFinite(result.maxAmbientDeviationMm)).toBe(true);
    expect(result.maxAmbientDeviationMm).toBeGreaterThanOrEqual(0);
  });

  it('open spline: spanPointCounts has controlPointCount - 1 entries', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers(5);
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });

    const points = circlePoints(5, 6);
    const result = await pool.run('fitSurfaceSpline', { contentHash: ICO_HASH, points, closed: false, pointsPerMm: 1 });
    expect(result.spanPointCounts.length).toBe(4);
  });

  it('rejects a malformed points array (length not a multiple of 3)', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers();
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });
    await expect(
      pool.run('fitSurfaceSpline', { contentHash: ICO_HASH, points: new Float64Array([0, 0]), closed: false, pointsPerMm: 1 }),
    ).rejects.toThrow(/multiple of 3/);
  });

  it('rejects with BvhNotCachedError when the contentHash was never built on this worker', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('fitSurfaceSpline', { contentHash: 'never-built', points: circlePoints(4, 5), closed: true, pointsPerMm: 1 }),
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
        'fitSurfaceSpline',
        { contentHash: ICO_HASH, points: circlePoints(4, 5), closed: true, pointsPerMm: 1 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it('determinism: two identical calls produce bit-identical results', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers(5);
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });
    const points = circlePoints(6, 6);
    const a = await pool.run('fitSurfaceSpline', { contentHash: ICO_HASH, points, closed: true, pointsPerMm: 2 });
    const b = await pool.run('fitSurfaceSpline', { contentHash: ICO_HASH, points: points.slice(), closed: true, pointsPerMm: 2 });
    expect(Array.from(b.spanTriangleIndices)).toEqual(Array.from(a.spanTriangleIndices));
    expect(Array.from(b.spanBarycentric)).toEqual(Array.from(a.spanBarycentric));
    expect(Array.from(b.spanLengths)).toEqual(Array.from(a.spanLengths));
    expect(b.maxAmbientDeviationMm).toBe(a.maxAmbientDeviationMm);
  });
});

describe('fitSurfaceSplineSpan job — locality (this task\'s brief, deliverable 3)', () => {
  it('re-fitting one span via the span job reproduces the SAME span the whole-curve job computed', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = icosahedronBuffers(5);
    await pool.run('buildBvh', { contentHash: ICO_HASH, positions, indices });
    const points = circlePoints(6, 6);
    const mesh: IndexedMesh = { positions, indices };

    const whole = await pool.run('fitSurfaceSpline', { contentHash: ICO_HASH, points, closed: true, pointsPerMm: 2 });

    // Reconstruct span 2's role (prev=1, start=2, end=3, next=4) from the
    // SNAPPED (BVH-projected) control-point positions the whole-curve job
    // actually used to build every span's role — NOT the raw pre-snap
    // input `points` (those differ from the on-surface positions by
    // however far each point had to move to land on the sphere, which
    // would silently change the centripetal knot spacing and, in turn, the
    // resampled point COUNT — exactly the kind of subtle mismatch a real
    // Phase 3 caller must avoid: always derive role points from the
    // TRACKED (already-snapped) control-point list, never from the
    // original raw pick points).
    const at = (i: number): readonly [number, number, number] => {
      const idx = ((i % 6) + 6) % 6;
      const sp = surfacePointPayloadAt(whole.controlPointTriangleIndices, whole.controlPointBarycentric, idx);
      return evaluateSurfacePoint(mesh, { triangleIndex: sp.triangleIndex, barycentric: sp.barycentric as [number, number, number] });
    };
    const role: readonly [
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
    ] = [at(1), at(2), at(3), at(4)];
    const startPoint = surfacePointPayloadAt(whole.controlPointTriangleIndices, whole.controlPointBarycentric, 2);
    const endPoint = surfacePointPayloadAt(whole.controlPointTriangleIndices, whole.controlPointBarycentric, 3);

    const span = await pool.run('fitSurfaceSplineSpan', {
      contentHash: ICO_HASH,
      role,
      startPoint,
      endPoint,
      pointsPerMm: 2,
    });

    // Extract span 2's slice from the whole-curve result.
    let offset = 0;
    for (let i = 0; i < 2; i++) offset += whole.spanPointCounts[i]!;
    const count = whole.spanPointCounts[2]!;
    const wholeTriangleIndices = whole.spanTriangleIndices.slice(offset, offset + count);
    const wholeBarycentric = whole.spanBarycentric.slice(offset * 3, (offset + count) * 3);

    expect(Array.from(span.triangleIndices)).toEqual(Array.from(wholeTriangleIndices));
    expect(Array.from(span.barycentric)).toEqual(Array.from(wholeBarycentric));
    expect(span.length).toBe(whole.spanLengths[2]);
    expect(span.converged).toBe(whole.spanConverged[2] === 1);
  });

  it('rejects with BvhNotCachedError when the contentHash was never built', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('fitSurfaceSplineSpan', {
        contentHash: 'never-built',
        role: [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
          [3, 0, 0],
        ],
        startPoint: { triangleIndex: 0, barycentric: [1 / 3, 1 / 3, 1 / 3] },
        endPoint: { triangleIndex: 1, barycentric: [1 / 3, 1 / 3, 1 / 3] },
        pointsPerMm: 1,
      }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });
});

describe('affectedSpanIndices — re-exported for kernel-workers-only callers (layer rule)', () => {
  it('matches the kernel-level directed example (closed, n=6, control point 0)', () => {
    expect(affectedSpanIndices(6, true, 0)).toEqual([0, 1, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Performance guardrail — real arch-case-01 upperjaw fixture (250,128
// triangles), a margin-line-sized closed loop, 400-800 total samples. See
// this file's top doc.
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const upperjawStlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');

function loadUpperjawMesh(): IndexedMesh {
  const bytes = readFileSync(upperjawStlPath);
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

describe('fitSurfaceSpline job — performance guardrail (real upperjaw fixture, 400-800 samples)', () => {
  it('a ~38mm-circumference closed control loop at 15 points/mm (clinical density) stays interactive', async () => {
    const mesh = loadUpperjawMesh();
    const triangleCount = mesh.indices.length / 3;
    expect(triangleCount).toBeGreaterThan(200_000); // sanity: this really is the ~250k-tri fixture

    // An arbitrary interior-ish mesh vertex as the loop's center — margin
    // lines are local, not global, so this deliberately does NOT need to
    // trace an actual anatomical margin (that's Phase 3's UI concern); it
    // only needs to be a realistically-sized, real-mesh-anchored loop for
    // TIMING purposes (same "local, not long-path" rationale
    // geodesicJobs.test.ts's perf test documents for its own fixture pick).
    const anchorVertex = Math.floor(mesh.positions.length / 3 / 2);
    const center: [number, number, number] = [
      mesh.positions[anchorVertex * 3]!,
      mesh.positions[anchorVertex * 3 + 1]!,
      mesh.positions[anchorVertex * 3 + 2]!,
    ];

    const CONTROL_POINT_COUNT = 16;
    const RADIUS_MM = 6; // circumference ~= 2*pi*6 = 37.7mm, within the 20-40mm clinical range
    const POINTS_PER_MM = 15; // within the ~10-20/mm clinical target density
    const points = new Float64Array(CONTROL_POINT_COUNT * 3);
    for (let i = 0; i < CONTROL_POINT_COUNT; i++) {
      const theta = (2 * Math.PI * i) / CONTROL_POINT_COUNT;
      // An arbitrary plane through `center` (not derived from a surface
      // normal — BVH projection pulls every point onto the real surface
      // regardless, so this is a fine, deterministic way to seed a local
      // loop without needing curvature/normal machinery here).
      points[i * 3] = center[0] + RADIUS_MM * Math.cos(theta);
      points[i * 3 + 1] = center[1] + RADIUS_MM * Math.sin(theta);
      points[i * 3 + 2] = center[2];
    }

    const pool = createPool({ size: 1 });
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    const buildStart = performance.now();
    await pool.run(
      'buildBvh',
      { contentHash: 'upperjaw-spline-perf', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );
    const buildMs = performance.now() - buildStart;

    const fitStart = performance.now();
    const result = await pool.run('fitSurfaceSpline', {
      contentHash: 'upperjaw-spline-perf',
      points,
      closed: true,
      pointsPerMm: POINTS_PER_MM,
    });
    const fitMs = performance.now() - fitStart;

    const totalSamples = Array.from(result.spanPointCounts).reduce((a, b) => a + b, 0);

    console.log(
      `[fitSurfaceSpline perf] upperjaw (${triangleCount} triangles): buildBvh ${buildMs.toFixed(1)}ms, ` +
        `fitSurfaceSpline (${CONTROL_POINT_COUNT} control points, ${POINTS_PER_MM} pts/mm, ${totalSamples} total samples) ` +
        `${fitMs.toFixed(1)}ms (guardrail: 400-800 samples stays interactive)`,
    );

    expect(totalSamples).toBeGreaterThanOrEqual(400);
    expect(totalSamples).toBeLessThanOrEqual(800);
    // "Interactive" for an initial full-curve fit (not the sub-100ms
    // PER-SEGMENT re-snap budget geodesicJobs.test.ts's perf test targets,
    // which is this module's `fitSurfaceSplineSpan` job's job) — a generous
    // guardrail well above typical measured latency, still tight enough to
    // catch a real regression.
    expect(fitMs).toBeLessThan(2000);
  }, 30_000);
});
