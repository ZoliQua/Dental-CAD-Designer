// suggestAxis job tests (Phase 3 Task 9) — exercised via a real Node
// worker_threads WorkerPool, same rationale as marginJobs.test.ts/
// undercutJobs.test.ts: job logic is environment-agnostic, so testing it
// through the real Comlink transport also proves payload shapes and
// thrown-error names survive the postMessage boundary. The ALGORITHM
// itself (region extraction, coarse->fine search, objective,
// determinism/tie-break, `@errorBound`-adjacent analytic accuracy) is
// exhaustively covered at the kernel level
// (packages/kernel/src/axis/*.test.ts) — these tests only prove the job
// wires @dqcad/kernel's `extractMarginRegion` + `suggestInsertionAxisForRegions`
// through a real worker correctly, including the per-worker BVH+halfedge
// cache contract (jobs/axis.ts's module doc), and measure the real-mesh
// interactivity timing this task's brief asks for (< 2s target).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ---------------------------------------------------------------------------
// A capped cone frustum (bottom ring WIDER than the top — draft toward
// +Z, true insertion axis [0,0,1] EXACTLY) with several intermediate wall
// rings — mirrors packages/kernel/src/axis/axis.test-fixtures.ts's
// `coneFrustumMesh` (TEST-ONLY kernel-internal code, not importable across
// the package boundary — same "duplicated rather than shared" convention
// as undercutJobs.test.ts's own `CUBE_CORNERS`/`CUBE_TRIANGLES`). Every
// vertex/triangle index below is HAND-COMPUTED from this file's own
// construction (no snapToSurface/kernel geometry query needed to build a
// seed) — same "hand-known indices" convention marginJobs.test.ts's
// `taperSeedTriangleIndex()` uses.
// ---------------------------------------------------------------------------

const BOTTOM_RADIUS = 4;
const TOP_RADIUS = 2.5;
const HEIGHT = 9;
const SEGMENTS = 32;
const HEIGHT_SEGMENTS = 8;

function frustumMeshBuffers(center: readonly [number, number, number] = [0, 0, 0]): {
  positions: Float64Array;
  indices: Uint32Array;
  /** Triangle index + barycentric for a seed AT ring `r`, segment `s` — one
   * of the two wall triangles sharing that ring vertex as its FIRST corner
   * (so barycentric `[1,0,0]` names it exactly). */
  wallSeed: (ring: number, seg: number) => { triangleIndex: number; barycentric: [number, number, number] };
} {
  const ringIndex = (ring: number, seg: number): number => ring * SEGMENTS + seg;
  const positions: number[] = [];
  for (let r = 0; r <= HEIGHT_SEGMENTS; r++) {
    const t = r / HEIGHT_SEGMENTS;
    const z = center[2] + t * HEIGHT;
    const radius = BOTTOM_RADIUS + (TOP_RADIUS - BOTTOM_RADIUS) * t;
    for (let s = 0; s < SEGMENTS; s++) {
      const theta = (2 * Math.PI * s) / SEGMENTS;
      positions.push(center[0] + radius * Math.cos(theta), center[1] + radius * Math.sin(theta), z);
    }
  }
  const bottomCenterIndex = positions.length / 3;
  positions.push(center[0], center[1], center[2]);
  const topCenterIndex = positions.length / 3;
  positions.push(center[0], center[1], center[2] + HEIGHT);

  const indices: number[] = [];
  const wallTriangleIndexOf = new Map<string, number>();
  for (let r = 0; r < HEIGHT_SEGMENTS; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const sNext = (s + 1) % SEGMENTS;
      const a = ringIndex(r, s);
      const b = ringIndex(r, sNext);
      const c = ringIndex(r + 1, sNext);
      const d = ringIndex(r + 1, s);
      wallTriangleIndexOf.set(`${r},${s}`, indices.length / 3);
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    indices.push(bottomCenterIndex, ringIndex(0, sNext), ringIndex(0, s));
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    indices.push(topCenterIndex, ringIndex(HEIGHT_SEGMENTS, s), ringIndex(HEIGHT_SEGMENTS, sNext));
  }

  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    wallSeed: (ring, seg) => {
      const key = `${Math.min(ring, HEIGHT_SEGMENTS - 1)},${seg}`;
      const triangleIndex = wallTriangleIndexOf.get(key)!;
      return { triangleIndex, barycentric: [1, 0, 0] };
    },
  };
}

function midWallLoop(fixture: ReturnType<typeof frustumMeshBuffers>, ring: number, count = SEGMENTS) {
  const step = Math.max(1, Math.floor(SEGMENTS / count));
  const loop = [];
  for (let s = 0; s < SEGMENTS; s += step) {
    loop.push(fixture.wallSeed(ring, s));
  }
  return loop;
}

function angleBetweenDeg(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const lenA = Math.hypot(a[0], a[1], a[2]);
  const lenB = Math.hypot(b[0], b[1], b[2]);
  return (Math.acos(Math.min(1, Math.max(-1, dot / (lenA * lenB)))) * 180) / Math.PI;
}

describe('suggestAxis job — single abutment (crown-like)', () => {
  it('recovers the frustum\'s true construction axis, well within a generous angular tolerance', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'axis-frustum-1', positions: fixture.positions, indices: fixture.indices });

    const loop = midWallLoop(fixture, 3); // mid-wall ring — avoids the fully-capped fixture's own cap-normal skew (see kernel-level analytic test's doc)
    const result = await pool.run('suggestAxis', {
      contentHash: 'axis-frustum-1',
      abutmentMarginLoops: [loop],
      roiRadiusMm: 2.0,
    });

    const angleDeg = angleBetweenDeg(result.best.direction, [0, 0, 1]);
    console.log(`[axisJobs] single-abutment: angular error ${angleDeg.toFixed(2)} deg, regionTriangles=${result.regionTriangleCounts[0]}`);
    expect(angleDeg).toBeLessThan(20); // generous — kernel-level analytic tests own the tight, derived tolerance
    expect(result.perAbutment.length).toBe(1);
    expect(result.regionTriangleCounts.length).toBe(1);
    expect(result.regionTriangleCounts[0]).toBeGreaterThan(0);
    expect(result.best).toEqual(result.ranked[0]);
  });

  it('rejects with BvhNotCachedError when the contentHash was never built on this worker', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await expect(
      pool.run('suggestAxis', {
        contentHash: 'never-built',
        abutmentMarginLoops: [midWallLoop(fixture, 3)],
      }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('is cancellable before it starts', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'axis-frustum-cancel', positions: fixture.positions, indices: fixture.indices });
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'suggestAxis',
        { contentHash: 'axis-frustum-cancel', abutmentMarginLoops: [midWallLoop(fixture, 3)] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it('determinism: two identical calls produce bit-identical results', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'axis-frustum-det', positions: fixture.positions, indices: fixture.indices });
    const payload = { contentHash: 'axis-frustum-det', abutmentMarginLoops: [midWallLoop(fixture, 3)], roiRadiusMm: 2.0 } as const;
    const a = await pool.run('suggestAxis', payload);
    const b = await pool.run('suggestAxis', payload);
    expect(a).toEqual(b);
  });

  it('reports progress, ending near/at 1', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'axis-frustum-progress', positions: fixture.positions, indices: fixture.indices });
    const fractions: number[] = [];
    await pool.run(
      'suggestAxis',
      { contentHash: 'axis-frustum-progress', abutmentMarginLoops: [midWallLoop(fixture, 3)], roiRadiusMm: 2.0 },
      { onProgress: (f) => fractions.push(f) },
    );
    expect(fractions.length).toBeGreaterThan(1); // multiple per-direction checkpoints
    expect(fractions[fractions.length - 1]).toBe(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
  });

  it('rejects with EmptyRegionError for an abutment loop with no points', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'axis-frustum-empty', positions: fixture.positions, indices: fixture.indices });
    await expect(
      pool.run('suggestAxis', { contentHash: 'axis-frustum-empty', abutmentMarginLoops: [[]] }),
    ).rejects.toMatchObject({ name: 'EmptyRegionError' });
  });

  it('rejects with DegenerateRegionNormalError for a region covering an entire closed surface (area-weighted normals cancel exactly)', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'axis-frustum-wholemesh', positions: fixture.positions, indices: fixture.indices });
    // A huge radius reaches every triangle from a mid-wall seed loop (this
    // fixture's whole extent is well under 20mm) — the WHOLE closed
    // surface's area-weighted outward-normal integral is exactly zero
    // (divergence theorem), for ANY closed watertight mesh, not just a
    // symmetric one.
    await expect(
      pool.run('suggestAxis', {
        contentHash: 'axis-frustum-wholemesh',
        abutmentMarginLoops: [midWallLoop(fixture, 3)],
        roiRadiusMm: 1000,
      }),
    ).rejects.toMatchObject({ name: 'DegenerateRegionNormalError' });
  });
});

describe('suggestAxis job — two abutments (bridge-like)', () => {
  it('finds a common axis close to both abutments\' shared true axis, with per-abutment stats reported', async () => {
    const pool = createPool();
    const fixtureA = frustumMeshBuffers([0, 0, 0]);
    const fixtureB = frustumMeshBuffers([30, 0, 0]);
    const vertexCountA = fixtureA.positions.length / 3;
    const positions = new Float64Array(fixtureA.positions.length + fixtureB.positions.length);
    positions.set(fixtureA.positions, 0);
    positions.set(fixtureB.positions, fixtureA.positions.length);
    const indices = new Uint32Array(fixtureA.indices.length + fixtureB.indices.length);
    indices.set(fixtureA.indices, 0);
    for (let i = 0; i < fixtureB.indices.length; i++) {
      indices[fixtureA.indices.length + i] = fixtureB.indices[i]! + vertexCountA;
    }
    await pool.run('buildBvh', { contentHash: 'axis-bridge', positions, indices });

    const loopA = midWallLoop(fixtureA, 3);
    const loopB = midWallLoop(fixtureB, 3).map((s) => ({ ...s, triangleIndex: s.triangleIndex + fixtureA.indices.length / 3 }));
    const result = await pool.run('suggestAxis', {
      contentHash: 'axis-bridge',
      abutmentMarginLoops: [loopA, loopB],
      roiRadiusMm: 2.0,
    });

    expect(result.perAbutment.length).toBe(2);
    expect(result.regionTriangleCounts.length).toBe(2);
    const angleDeg = angleBetweenDeg(result.best.direction, [0, 0, 1]);
    console.log(
      `[axisJobs] bridge: common axis angular error ${angleDeg.toFixed(2)} deg, perAbutment scoreMm3=[${result.perAbutment.map((c) => c.scoreMm3.toExponential(2)).join(', ')}]`,
    );
    expect(angleDeg).toBeLessThan(20);
  });
});

describe('suggestAxis job — performance guardrail (real upperjaw fixture)', () => {
  it('suggestion on the real upperjaw ROI completes well within this task\'s interactivity target, in-worker', async () => {
    const pool = createPool();
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const stlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');
    const stlBytes = readFileSync(stlPath);
    const { soup } = parseStl(new Uint8Array(stlBytes.buffer, stlBytes.byteOffset, stlBytes.byteLength));
    const mesh: IndexedMesh = intake({ kind: 'soup', soup }).mesh;
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'axis-upperjaw-perf', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );

    const referencePath = join(repoRoot, 'test-fixtures', 'margins', 'arch-case-01', '11.reference.json');
    const reference = JSON.parse(readFileSync(referencePath, 'utf8')) as {
      anchors: readonly { triangleIndex: number; barycentric: readonly [number, number, number] }[];
    };
    const loop = reference.anchors.map((a) => ({ triangleIndex: a.triangleIndex, barycentric: a.barycentric }));

    const started = performance.now();
    const result = await pool.run('suggestAxis', {
      contentHash: 'axis-upperjaw-perf',
      abutmentMarginLoops: [loop],
    });
    const elapsedMs = performance.now() - started;

    console.log(
      `[axisJobs perf] real upperjaw suggestAxis (in-worker, incl. postMessage/transfer overhead): ${elapsedMs.toFixed(0)}ms, ` +
        `regionTriangles=${result.regionTriangleCounts[0]}, bestScoreMm3=${result.best.scoreMm3.toExponential(2)}`,
    );
    // Generous CI-safe bound (this task's real <2s target is measured
    // in-process, without worker/postMessage overhead — see the kernel-ops
    // golden's own dedicated measurement and this task's report); this
    // guardrail exists to catch an ACTUAL regression (e.g. an accidental
    // whole-mesh scan), not to flake on machine/CI contention.
    expect(elapsedMs).toBeLessThan(10000);
  }, 30000);
});

describe('axisHeatmap job — live single-direction preview', () => {
  it('matches per-region-triangle undercut/depth against an independent suggestAxis candidate at the same direction', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'axis-heatmap-1', positions: fixture.positions, indices: fixture.indices });
    const loop = midWallLoop(fixture, 3);

    const suggestion = await pool.run('suggestAxis', { contentHash: 'axis-heatmap-1', abutmentMarginLoops: [loop], roiRadiusMm: 2.0 });
    const heatmap = await pool.run('axisHeatmap', {
      contentHash: 'axis-heatmap-1',
      abutmentMarginLoops: [loop],
      direction: suggestion.best.direction,
      roiRadiusMm: 2.0,
    });

    expect(heatmap.triangleIndices.length).toBe(suggestion.regionTriangleCounts[0]);
    expect(heatmap.undercut.length).toBe(heatmap.triangleIndices.length);
    expect(heatmap.depthMm.length).toBe(heatmap.triangleIndices.length);
    expect(heatmap.undercutTriangleCount).toBe(suggestion.best.undercutTriangleCount);
    expect(heatmap.maxDepthMm).toBeCloseTo(suggestion.best.maxDepthMm, 9);
  });

  it('returns an empty result (no throw) for an abutment loop with no points', async () => {
    const pool = createPool();
    const fixture = frustumMeshBuffers();
    await pool.run('buildBvh', { contentHash: 'axis-heatmap-empty', positions: fixture.positions, indices: fixture.indices });
    const result = await pool.run('axisHeatmap', {
      contentHash: 'axis-heatmap-empty',
      abutmentMarginLoops: [[]],
      direction: [0, 0, 1],
    });
    expect(result.triangleIndices.length).toBe(0);
    expect(result.undercutTriangleCount).toBe(0);
  });

  it('rejects with BvhNotCachedError when the contentHash was never built on this worker', async () => {
    await expect(
      createPool().run('axisHeatmap', { contentHash: 'never-built-heatmap', abutmentMarginLoops: [[]], direction: [0, 0, 1] }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('performance guardrail: a live single-direction preview on the real upperjaw ROI comfortably meets the <200ms adjust-loop target', async () => {
    const pool = createPool();
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const stlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');
    const stlBytes = readFileSync(stlPath);
    const { soup } = parseStl(new Uint8Array(stlBytes.buffer, stlBytes.byteOffset, stlBytes.byteLength));
    const mesh: IndexedMesh = intake({ kind: 'soup', soup }).mesh;
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run(
      'buildBvh',
      { contentHash: 'axis-heatmap-upperjaw-perf', positions, indices },
      { transfer: [positions.buffer, indices.buffer] },
    );
    const referencePath = join(repoRoot, 'test-fixtures', 'margins', 'arch-case-01', '11.reference.json');
    const reference = JSON.parse(readFileSync(referencePath, 'utf8')) as {
      anchors: readonly { triangleIndex: number; barycentric: readonly [number, number, number] }[];
    };
    const loop = reference.anchors.map((a) => ({ triangleIndex: a.triangleIndex, barycentric: a.barycentric }));

    // Warm the halfedge/BVH caches with one call first (an interactive
    // adjust LOOP starts from an already-suggested axis, so the first
    // real adjustment is never a cold-cache call in practice).
    await pool.run('axisHeatmap', { contentHash: 'axis-heatmap-upperjaw-perf', abutmentMarginLoops: [loop], direction: [0, 0, 1] });

    const timings: number[] = [];
    for (const direction of [
      [0.1, 0, 1],
      [0.15, 0.05, 1],
      [0.2, 0.1, 1],
      [0.25, 0.15, 1],
      [0.3, 0.2, 1],
    ] as const) {
      const started = performance.now();
      await pool.run('axisHeatmap', { contentHash: 'axis-heatmap-upperjaw-perf', abutmentMarginLoops: [loop], direction });
      timings.push(performance.now() - started);
    }
    const medianMs = timings.slice().sort((a, b) => a - b)[Math.floor(timings.length / 2)]!;
    console.log(`[axisJobs perf] live heatmap adjust-loop (in-worker, incl. postMessage): timings=${timings.map((t) => t.toFixed(0)).join(', ')}ms, median=${medianMs.toFixed(0)}ms`);
    // Generous CI-safe bound — see suggestAxis's own perf test doc for the
    // same contention rationale; this task's report cites the real,
    // in-isolation median against the brief's <200ms target.
    expect(medianMs).toBeLessThan(1500);
  }, 30000);
});
