// proposeMargin job tests (Phase 3 Task 4) — exercised via a real Node
// worker_threads WorkerPool, same rationale as bvhJobs.test.ts /
// distanceHeatmap.test.ts: job logic is environment-agnostic, so testing it
// through the real Comlink transport also proves payload shapes and thrown-
// error names survive the postMessage boundary. The ALGORITHM itself
// (bounded region, bidirectional crest walk, closure, simplification,
// confidence, `@errorBound`, the analytic acceptance tests) is exhaustively
// covered at the kernel level (packages/kernel/src/margin/*.test.ts) — these
// tests only prove the job wires @dqcad/kernel's `proposeMarginLoop` through
// a real worker correctly, including the per-worker BVH+halfedge+curvature
// cache contract (jobs/margin.ts's module doc), and measure the real-mesh
// runtime this task's brief asks for (< 5s in-worker on the 250k-tri
// upperjaw fixture).
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
// Small synthetic fixture: a sharp concave shoulder, solid of revolution —
// a MINIMAL, locally-duplicated version of packages/kernel/src/margin/
// marginRidge.test-fixtures.ts's `shoulderPrepMesh` (that file is TEST-ONLY
// kernel-internal code, not importable across the package boundary — see
// this repo's established "duplicated rather than shared... N lines of
// fixture data, not shared logic" convention, e.g. undercutJobs.test.ts's
// own `CUBE_CORNERS`/`CUBE_TRIANGLES`). Same profile shape (bottom cap ->
// vertical collar -> flat shelf -> CONCAVE corner at the margin -> taper ->
// top cap) — see that file's module doc for the turning-direction proof
// this concave-corner construction relies on.
// ---------------------------------------------------------------------------

const GINGIVAL_RADIUS = 4;
const MARGIN_RADIUS = 3.5;
const TOP_RADIUS = 2;
const MARGIN_HEIGHT = 1.5;
const TOTAL_HEIGHT = 8;
const SEGMENTS = 96;
const CORNER_REFINEMENT = 0.05; // see marginRidge.test-fixtures.ts's doc for why this is needed

function shoulderMeshBuffers(): { positions: Float64Array; indices: Uint32Array } {
  const profile: [number, number][] = [
    [GINGIVAL_RADIUS, 0],
    [GINGIVAL_RADIUS, MARGIN_HEIGHT],
    [MARGIN_RADIUS + CORNER_REFINEMENT, MARGIN_HEIGHT], // just before the corner (along the shelf)
    [MARGIN_RADIUS, MARGIN_HEIGHT], // the margin itself
  ];
  // Taper direction (from the margin to the top rim), used to place the
  // post-corner refinement ring at CORNER_REFINEMENT mm along it.
  const dr = TOP_RADIUS - MARGIN_RADIUS;
  const dz = TOTAL_HEIGHT - MARGIN_HEIGHT;
  const taperLen = Math.hypot(dr, dz);
  profile.push([MARGIN_RADIUS + (dr / taperLen) * CORNER_REFINEMENT, MARGIN_HEIGHT + (dz / taperLen) * CORNER_REFINEMENT]);
  profile.push([TOP_RADIUS, TOTAL_HEIGHT]);

  const positions: [number, number, number][] = [];
  const ringIndex = (ring: number, seg: number): number => ring * SEGMENTS + seg;
  for (const [radius, z] of profile) {
    for (let s = 0; s < SEGMENTS; s++) {
      const theta = (2 * Math.PI * s) / SEGMENTS;
      positions.push([radius * Math.cos(theta), radius * Math.sin(theta), z]);
    }
  }
  const bottomCenterIndex = positions.length;
  positions.push([0, 0, profile[0]![1]]);
  const topCenterIndex = positions.length;
  positions.push([0, 0, profile[profile.length - 1]![1]]);

  const triangles: [number, number, number][] = [];
  for (let r = 0; r < profile.length - 1; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const sNext = (s + 1) % SEGMENTS;
      const a = ringIndex(r, s);
      const b = ringIndex(r, sNext);
      const c = ringIndex(r + 1, sNext);
      const d = ringIndex(r + 1, s);
      triangles.push([a, b, c]);
      triangles.push([a, c, d]);
    }
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    triangles.push([bottomCenterIndex, ringIndex(0, sNext), ringIndex(0, s)]);
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    triangles.push([topCenterIndex, ringIndex(profile.length - 1, s), ringIndex(profile.length - 1, sNext)]);
  }

  // Signed-volume self-correcting winding (same convention as
  // undercut.test-fixtures.ts's `ensureOutwardWinding`).
  let signedVolume6 = 0;
  for (const [ia, ib, ic] of triangles) {
    const a = positions[ia]!;
    const b = positions[ib]!;
    const c = positions[ic]!;
    signedVolume6 += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  const orientedTriangles = signedVolume6 >= 0 ? triangles : triangles.map(([a, b, c]) => [a, c, b] as [number, number, number]);

  const flatPositions = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => flatPositions.set(p, i * 3));
  const indices = new Uint32Array(orientedTriangles.length * 3);
  orientedTriangles.forEach((t, i) => indices.set(t, i * 3));
  return { positions: flatPositions, indices };
}

/** A `SurfacePoint` on the taper wall, `heightAboveMargin` above the margin
 * ring, at azimuth 0 — matches marginRidge.analytic.test.ts's `taperSeed`
 * convention. Triangle index/barycentric found by hand (fixed ring
 * indexing, azimuth 0 always lands on segment 0's fan — verified against
 * this fixture's own construction above, not snapped via a BVH query, so
 * this file has zero @dqcad/kernel dependency for fixture GENERATION). */
function taperSeedTriangleIndex(): number {
  // Ring 3 (index MARGIN_HEIGHT+CORNER_REFINEMENT-along-taper) to ring 4
  // (TOP_RADIUS/TOTAL_HEIGHT) quad strip, segment 0's FIRST triangle — see
  // the triangle-push loop above: `r=3` writes segments 0..SEGMENTS-1 for
  // ring pair (3,4), each contributing 2 triangles; ring pairs (0,1) and
  // (1,2) and (2,3) come first (3 * SEGMENTS * 2 triangles).
  return 3 * SEGMENTS * 2;
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const upperjawStlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');

function loadUpperjawMesh(): IndexedMesh {
  const bytes = readFileSync(upperjawStlPath);
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

const SHOULDER_HASH = 'margin-jobs-shoulder';

describe('proposeMargin job', () => {
  it('proposes a closed loop on the synthetic shoulder fixture, tracking the analytic margin', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });

    const seed = { triangleIndex: taperSeedTriangleIndex(), barycentric: [1 / 3, 1 / 3, 1 / 3] as const };
    const progressValues: number[] = [];
    const result = await pool.run(
      'proposeMargin',
      { contentHash: SHOULDER_HASH, seed },
      { onProgress: (fraction) => progressValues.push(fraction) },
    );

    expect(progressValues).toEqual([0, 1]);
    expect(result.closed).toBe(true);
    expect(result.triangleIndices.length).toBeGreaterThanOrEqual(3);
    expect(result.barycentric.length).toBe(result.triangleIndices.length * 3);
    expect(result.segmentConfidence.length).toBe(result.triangleIndices.length);
    for (const c of result.segmentConfidence) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(result.walkVertexCount).toBe(SEGMENTS); // the exact margin ring
    expect(result.closureDeviationMm).toBeLessThanOrEqual(1e-6);
  });

  it('rejects with BvhNotCachedError when the contentHash was never built on this worker', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('proposeMargin', {
        contentHash: 'never-built',
        seed: { triangleIndex: 0, barycentric: [1 / 3, 1 / 3, 1 / 3] },
      }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('is cancellable before it starts', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'proposeMargin',
        { contentHash: SHOULDER_HASH, seed: { triangleIndex: taperSeedTriangleIndex(), barycentric: [1 / 3, 1 / 3, 1 / 3] } },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it('degenerate seed (far from any ridge, tight searchRadiusMm) rejects with NoRidgeFoundError', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });
    // Top-cap fan triangle — flat, no ridge nearby AT THIS TIGHT RADIUS (this
    // whole synthetic fixture is small enough — ~4mm across — that the
    // DEFAULT 10mm searchRadiusMm reaches even the top cap from the margin;
    // a small override isolates a genuinely far seed, same role
    // marginRidge.analytic.test.ts's degenerate-seed test gets "for free"
    // from its own larger capped-cylinder fixture).
    const topCapTriangleIndex = SEGMENTS * 2 * 4 + SEGMENTS; // first top-cap fan triangle
    await expect(
      pool.run('proposeMargin', {
        contentHash: SHOULDER_HASH,
        seed: { triangleIndex: topCapTriangleIndex, barycentric: [1 / 3, 1 / 3, 1 / 3] },
        searchRadiusMm: 1,
      }),
    ).rejects.toMatchObject({ name: 'NoRidgeFoundError' });
  });

  it('targetAnchorCount: threads through to a smaller, ~target-sized anchor set (Phase 3 editor-enhancement task 1)', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });
    const seed = { triangleIndex: taperSeedTriangleIndex(), barycentric: [1 / 3, 1 / 3, 1 / 3] as const };

    const withoutTarget = await pool.run('proposeMargin', { contentHash: SHOULDER_HASH, seed });
    const withTarget = await pool.run('proposeMargin', { contentHash: SHOULDER_HASH, seed, targetAnchorCount: 10 });

    expect(withTarget.closed).toBe(true);
    expect(withTarget.walkVertexCount).toBe(withoutTarget.walkVertexCount); // walked loop unaffected
    expect(withTarget.triangleIndices.length).toBeLessThan(withoutTarget.triangleIndices.length);
    expect(Math.abs(withTarget.triangleIndices.length - 10)).toBeLessThanOrEqual(6);
  });

  it('determinism: two identical calls produce bit-identical results', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });
    const seed = { triangleIndex: taperSeedTriangleIndex(), barycentric: [1 / 3, 1 / 3, 1 / 3] as const };
    const a = await pool.run('proposeMargin', { contentHash: SHOULDER_HASH, seed });
    const b = await pool.run('proposeMargin', { contentHash: SHOULDER_HASH, seed });
    expect(Array.from(b.triangleIndices)).toEqual(Array.from(a.triangleIndices));
    expect(Array.from(b.barycentric)).toEqual(Array.from(a.barycentric));
    expect(Array.from(b.segmentConfidence)).toEqual(Array.from(a.segmentConfidence));
  });
});

describe('proposeMargin job — performance guardrail (real upperjaw fixture)', () => {
  it('proposal on the real 250k-tri upperjaw completes well under 5s in-worker', async () => {
    const mesh = loadUpperjawMesh();
    const triangleCount = mesh.indices.length / 3;
    expect(triangleCount).toBeGreaterThan(200_000); // sanity: this really is the ~250k-tri fixture

    const pool = createPool({ size: 1 });
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run('buildBvh', { contentHash: 'upperjaw-margin-perf', positions, indices }, { transfer: [positions.buffer, indices.buffer] });

    // Fixed seed AT one of the real anterior shoulder-prep margin ridge
    // vertices (this task's report: the "tooth 11" real-case identification
    // — one of the two central-incisor-position margins) — the SAME seed
    // the kernel-ops golden pins (test-fixtures/golden/kernel-ops.json's
    // "proposeMargin" entry).
    const start = performance.now();
    // First call also warms the per-worker halfedge+curvature caches
    // (jobs/margin.ts's module doc).
    const result = await pool.run('proposeMargin', {
      contentHash: 'upperjaw-margin-perf',
      seed: { triangleIndex: 152488, barycentric: [0, 0, 1] },
    });
    const elapsedMs = performance.now() - start;

    console.log(
      `[proposeMargin perf] upperjaw (${triangleCount} triangles): first call (cold caches) ${elapsedMs.toFixed(1)}ms, ` +
        `anchors=${result.triangleIndices.length}, walkVertexCount=${result.walkVertexCount}, ` +
        `closureDeviationMm=${result.closureDeviationMm.toFixed(4)} (target: < 5000ms).`,
    );
    expect(result.closed).toBe(true);
    expect(elapsedMs).toBeLessThan(5000);

    // Confidence-spread assertion (fix batch, T4 review): on this real,
    // noisy fixture `segmentConfidence` was MEASURED to spread across
    // roughly 0.10-0.98 (weak, background-adjacent segments alongside
    // strong, unambiguous ridge segments) — a real, healthy spread, not a
    // saturated "everything reads as ~1.0" degenerate result. Assert a
    // band straddling the midpoint (min comfortably below it, max
    // comfortably above), loose enough not to flake on ordinary golden/
    // fixture-noise drift, tight enough to catch a future regression that
    // collapses the whole confidence range (e.g. a normalization bug that
    // saturates every segment to ~1.0 or ~0.5).
    const confidenceValues = Array.from(result.segmentConfidence);
    const confidenceMin = Math.min(...confidenceValues);
    const confidenceMax = Math.max(...confidenceValues);
    console.log(`[proposeMargin perf] segmentConfidence spread: min=${confidenceMin.toFixed(3)}, max=${confidenceMax.toFixed(3)} (measured band: ~0.10-0.98).`);
    expect(confidenceMin).toBeLessThan(0.7);
    expect(confidenceMax).toBeGreaterThan(0.7);
  }, 30_000);

  // Guardrail (this task's brief): "the bounded region must prevent the walk
  // from jumping to a NEIGHBORING tooth's margin (they're close!)" — seeded
  // on two ADJACENT real anterior shoulder preps (the "tooth21"/"tooth22"-
  // position candidates this task's report identifies — measured as
  // genuinely close, real inter-tooth gaps down to ~0.27mm on this same
  // fixture), the two proposals must be DISTINCT loops (no shared anchors,
  // different hashes), never one bleeding into the other.
  //
  // TODO (fix batch, T4 review): the pair exercised here (21/22, gap
  // ~2.4mm) is NOT the TIGHTEST real ambient gap on this fixture — that's
  // ~0.27mm, between the golden ("21") cluster and a separate, small
  // (~400-vertex) near-midline cluster (scripts/diagnose-margin-gap.ts's
  // own cluster survey) — but that tightest-GAP pair is not the pair this
  // test actually needs: the genuinely non-closing central-incisor
  // candidate (this task's report; verified directly by
  // scripts/diagnose-margin-gap.ts) is a THIRD, separate ~820-vertex
  // cluster whose own ridge has an interrupted stretch mid-loop (a real
  // scan-coverage hole, not a proximity-to-another-tooth issue) — it
  // cannot be used here regardless of which OTHER cluster it might be
  // paired against. T6 (validation) should revisit once that candidate's
  // own closure is resolved (more real fixtures, Task 8) and consider
  // whether a genuinely tighter-gap adjacent pair is also worth adding
  // alongside this one.
  it('two ADJACENT real preps propose DISTINCT loops (no shared anchors, hash-different)', async () => {
    const mesh = loadUpperjawMesh();
    const pool = createPool({ size: 1 });
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run('buildBvh', { contentHash: 'upperjaw-margin-adjacency', positions, indices }, { transfer: [positions.buffer, indices.buffer] });

    // "tooth21" (x~6.35) and "tooth22" (x~13.96) — adjacent central/lateral
    // incisor margins, both known (this task's report) to close cleanly
    // with default parameters.
    const seedTooth21 = { triangleIndex: 152488, barycentric: [0, 0, 1] as const };
    const seedTooth22Ambient = [10.596149444580078, -16.416439056396484, 10.833629608154297] as const;
    const cp = await pool.run('measurePointToSurface', { contentHash: 'upperjaw-margin-adjacency', point: seedTooth22Ambient });
    const seedTooth22 = { triangleIndex: cp.triangleIndex, barycentric: cp.barycentric };

    const result21 = await pool.run('proposeMargin', { contentHash: 'upperjaw-margin-adjacency', seed: seedTooth21 });
    const result22 = await pool.run('proposeMargin', { contentHash: 'upperjaw-margin-adjacency', seed: seedTooth22 });

    expect(result21.closed).toBe(true);
    expect(result22.closed).toBe(true);

    const key = (triangleIndex: number, barycentric: readonly number[]): string => `${triangleIndex}:${barycentric.join(',')}`;
    const set21 = new Set<string>();
    for (let i = 0; i < result21.triangleIndices.length; i++) {
      set21.add(key(result21.triangleIndices[i]!, Array.from(result21.barycentric.slice(i * 3, i * 3 + 3))));
    }
    let sharedCount = 0;
    for (let i = 0; i < result22.triangleIndices.length; i++) {
      if (set21.has(key(result22.triangleIndices[i]!, Array.from(result22.barycentric.slice(i * 3, i * 3 + 3))))) sharedCount++;
    }
    console.log(
      `[proposeMargin adjacency] tooth21 anchors=${result21.triangleIndices.length}, tooth22 anchors=${result22.triangleIndices.length}, shared=${sharedCount}`,
    );
    expect(sharedCount).toBe(0);
    expect(Array.from(result21.triangleIndices)).not.toEqual(Array.from(result22.triangleIndices));
  }, 30_000);
});
