// validateMargin job tests (Phase 3 Task 6) — exercised via a real Node
// worker_threads WorkerPool, same rationale as marginJobs.test.ts /
// bvhJobs.test.ts: job logic is environment-agnostic, so testing it through
// the real Comlink transport also proves payload shapes and thrown-error
// names survive the postMessage boundary. The ALGORITHM itself (ambient
// segment-pair self-intersection, BVH on-surface check, discrete-curvature
// smoothness, degenerate anchor-count/length; `@errorBound`, tolerance
// derivations) is exhaustively covered at the kernel level
// (packages/kernel/src/margin/validate.test.ts + test/golden/
// margin-validate.test.ts) — these tests only prove the job wires
// @dqcad/kernel's `validateMarginLine` through a real worker correctly
// (the per-worker BVH cache contract, jobs/margin.ts's module doc) and
// measure the real-mesh runtime this task's brief asks for (<50ms live-
// badge target).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
import { intake, type IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, WorkerPool } from './pool.js';
import type { MarginAnchorPayload, MarginLinePayload } from './jobs/registry.js';

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
// Small synthetic fixture — DUPLICATED (not imported) from
// marginJobs.test.ts's own `shoulderMeshBuffers`, per this repo's
// established "duplicated rather than shared" test-fixture convention (that
// file's own doc has the precedent).
// ---------------------------------------------------------------------------

const GINGIVAL_RADIUS = 4;
const MARGIN_RADIUS = 3.5;
const TOP_RADIUS = 2;
const MARGIN_HEIGHT = 1.5;
const TOTAL_HEIGHT = 8;
const SEGMENTS = 96;
const CORNER_REFINEMENT = 0.05;
const MARGIN_RING_INDEX = 3; // profile = [p0, p1, preP2, p2(margin), postP2, p3]

function shoulderMeshBuffers(): { positions: Float64Array; indices: Uint32Array } {
  const profile: [number, number][] = [
    [GINGIVAL_RADIUS, 0],
    [GINGIVAL_RADIUS, MARGIN_HEIGHT],
    [MARGIN_RADIUS + CORNER_REFINEMENT, MARGIN_HEIGHT],
    [MARGIN_RADIUS, MARGIN_HEIGHT],
  ];
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

/** A `MarginAnchorPayload` at the margin ring's angular index `s` — vertex
 * `ringIndex(MARGIN_RING_INDEX, s)`, anchored on its own fan's FIRST
 * triangle (ring-pair `(MARGIN_RING_INDEX, MARGIN_RING_INDEX+1)`, segment
 * `s`'s first triangle `[a,b,c]` where `a` IS that vertex — see
 * `shoulderMeshBuffers`'s triangle-push loop above), one-hot barycentric. */
function marginRingAnchor(positions: Float64Array, s: number): MarginAnchorPayload {
  const vertexIndex = MARGIN_RING_INDEX * SEGMENTS + (((s % SEGMENTS) + SEGMENTS) % SEGMENTS);
  const triangleIndex = MARGIN_RING_INDEX * SEGMENTS * 2 + (((s % SEGMENTS) + SEGMENTS) % SEGMENTS) * 2;
  return {
    position: [positions[vertexIndex * 3]!, positions[vertexIndex * 3 + 1]!, positions[vertexIndex * 3 + 2]!],
    triangleIndex,
    barycentric: [1, 0, 0],
  };
}

function cleanRingMargin(positions: Float64Array, count: number): MarginLinePayload {
  const step = Math.floor(SEGMENTS / count);
  return { anchors: Array.from({ length: count }, (_, i) => marginRingAnchor(positions, i * step)), closed: true };
}

function figureEightRingMargin(positions: Float64Array, count: number): MarginLinePayload {
  const step = Math.floor(SEGMENTS / count);
  const half = count / 2;
  const order: number[] = [];
  for (let i = 0; i < half; i++) {
    order.push(i);
    order.push(i + half);
  }
  return { anchors: order.map((s) => marginRingAnchor(positions, s * step)), closed: true };
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const upperjawStlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');

function loadUpperjawMesh(): IndexedMesh {
  const bytes = readFileSync(upperjawStlPath);
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

const SHOULDER_HASH = 'validate-margin-jobs-shoulder';

describe('validateMargin job', () => {
  it('a clean ring margin validates with zero findings', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });

    const margin = cleanRingMargin(positions, 16);
    const progressValues: number[] = [];
    const result = await pool.run(
      'validateMargin',
      { contentHash: SHOULDER_HASH, margin },
      { onProgress: (fraction) => progressValues.push(fraction) },
    );

    expect(progressValues).toEqual([0, 1]);
    expect(result.closed).toBe(true);
    expect(result.selfIntersecting).toBe(false);
    expect(result.selfIntersections).toEqual([]);
    expect(result.onSurface).toBe(true);
    expect(result.offSurfacePoints).toEqual([]);
    expect(result.smoothnessWarnings).toEqual([]);
    expect(result.degenerate).toBe(false);
    expect(result.validatedPointCount).toBe(16);
  });

  it('ACCEPTANCE: a figure-eight anchor ordering is rejected — selfIntersecting: true, with locations', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });

    const margin = figureEightRingMargin(positions, 8);
    const result = await pool.run('validateMargin', { contentHash: SHOULDER_HASH, margin });

    expect(result.selfIntersecting).toBe(true);
    expect(result.selfIntersections.length).toBeGreaterThan(0);
  });

  it('an open margin (closed: false) is reported as such', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });

    const margin: MarginLinePayload = { ...cleanRingMargin(positions, 16), closed: false };
    const result = await pool.run('validateMargin', { contentHash: SHOULDER_HASH, margin });
    expect(result.closed).toBe(false);
  });

  it('too few anchors is reported degenerate', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });

    const margin: MarginLinePayload = { anchors: [marginRingAnchor(positions, 0), marginRingAnchor(positions, 10)], closed: true };
    const result = await pool.run('validateMargin', { contentHash: SHOULDER_HASH, margin });
    expect(result.degenerate).toBe(true);
    expect(result.degenerateReasons).toContain('tooFewAnchors');
  });

  it('rejects with BvhNotCachedError when the contentHash was never built on this worker', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('validateMargin', {
        contentHash: 'never-built',
        margin: { anchors: [], closed: true },
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
      pool.run('validateMargin', { contentHash: SHOULDER_HASH, margin: cleanRingMargin(positions, 16) }, { signal: controller.signal }),
    ).rejects.toThrow(JobCancelledError);
  });

  it('determinism: two identical calls produce identical results', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = shoulderMeshBuffers();
    await pool.run('buildBvh', { contentHash: SHOULDER_HASH, positions, indices });
    const margin = figureEightRingMargin(positions, 8);
    const a = await pool.run('validateMargin', { contentHash: SHOULDER_HASH, margin });
    const b = await pool.run('validateMargin', { contentHash: SHOULDER_HASH, margin });
    expect(b).toEqual(a);
  });
});

describe('validateMargin job — performance guardrail (real upperjaw fixture)', () => {
  it('validation of the golden 261-anchor real margin proposal completes fast, in-worker', async () => {
    const mesh = loadUpperjawMesh();
    const pool = createPool({ size: 1 });
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run('buildBvh', { contentHash: 'upperjaw-validate-margin-perf', positions, indices }, { transfer: [positions.buffer, indices.buffer] });

    // SAME fixed seed as marginJobs.test.ts's own perf test / kernel-ops
    // golden's `proposeMargin` entry — "the golden tooth-11 proposal".
    const proposal = await pool.run('proposeMargin', {
      contentHash: 'upperjaw-validate-margin-perf',
      seed: { triangleIndex: 152488, barycentric: [0, 0, 1] },
    });
    expect(proposal.closed).toBe(true);

    // The job payload's `position` field IS what gets validated (kernel
    // validate.ts's module doc: ambient position, never re-derived from
    // triangleIndex/barycentric) — a real caller (marginEditor.ts) always
    // has the true evaluated ambient position on hand already (it's what
    // gets rendered); here, evaluate it directly from the ALREADY-LOADED
    // mesh (this test has `mesh` in hand, no extra worker round trip
    // needed).
    function evaluateAmbient(triangleIndex: number, bary: readonly [number, number, number]): [number, number, number] {
      const ia = mesh.indices[triangleIndex * 3]!;
      const ib = mesh.indices[triangleIndex * 3 + 1]!;
      const ic = mesh.indices[triangleIndex * 3 + 2]!;
      const [bx, by, bz] = bary;
      return [
        mesh.positions[ia * 3]! * bx + mesh.positions[ib * 3]! * by + mesh.positions[ic * 3]! * bz,
        mesh.positions[ia * 3 + 1]! * bx + mesh.positions[ib * 3 + 1]! * by + mesh.positions[ic * 3 + 1]! * bz,
        mesh.positions[ia * 3 + 2]! * bx + mesh.positions[ib * 3 + 2]! * by + mesh.positions[ic * 3 + 2]! * bz,
      ];
    }
    const margin: MarginLinePayload = {
      anchors: Array.from({ length: proposal.triangleIndices.length }, (_, i) => {
        const triangleIndex = proposal.triangleIndices[i]!;
        const barycentric: [number, number, number] = [proposal.barycentric[i * 3]!, proposal.barycentric[i * 3 + 1]!, proposal.barycentric[i * 3 + 2]!];
        return { position: evaluateAmbient(triangleIndex, barycentric), triangleIndex, barycentric };
      }),
      closed: proposal.closed,
    };

    const start = performance.now();
    const result = await pool.run('validateMargin', { contentHash: 'upperjaw-validate-margin-perf', margin });
    const elapsedMs = performance.now() - start;
    console.log(`[validateMargin perf] real 261-anchor upperjaw margin, in-worker: ${elapsedMs.toFixed(3)}ms (target: <50ms).`);

    expect(result.closed).toBe(true);
    expect(result.selfIntersecting).toBe(false);
    expect(result.onSurface).toBe(true);
    expect(result.smoothnessWarnings).toEqual([]);
    expect(result.degenerate).toBe(false);
    expect(elapsedMs).toBeLessThan(500); // generous CI headroom over the <50ms live-badge target
  }, 30_000);
});
