// packages/kernel/src/geodesic/geodesicPath.analytic.test.ts
//
// ACCEPTANCE test (phase acceptance criterion, docs/plans/phase-2-kernel-
// core.md: "geodesic on icosphere vs analytic great-circle length error <
// 0.1%") — see this task's brief: icosphere at a subdivision fine enough
// that TESSELLATION error alone doesn't eat the 0.1% budget, geodesic
// length vs analytic great-circle arc `r*theta` over >= 50 seeded random
// surface-point pairs, error < 0.1% asserted for EACH pair, max REPORTED.
//
// ## Sampling: plain seeded PRNG, not fast-check
//
// Every other `*.test.ts` file in this module DOES use fast-check
// (geodesicPath.test.ts's property suite) for INVARIANT checks (NaN/
// Infinity-freedom, determinism, path-on-surface, length >= Euclidean) —
// those invariants must hold for EVERY input, including fast-check's
// deliberately edge-case-biased samples (near-zero barycentric weights,
// points landing essentially exactly ON a vertex, etc.), and that suite
// already exercises those. THIS file's job is different: it measures
// TYPICAL-case accuracy against a fixed numeric budget (matching this
// project's existing acceptance-test convention — see
// curvature.analytic.test.ts / distanceHeatmap's acceptance describe
// blocks, neither of which uses fast-check either). Using fast-check's
// shrink-biased arbitraries here would measure worst-case-hunting accuracy,
// not typical accuracy — concretely, fast-check's default `fc.double`
// sampling for this file's barycentric-weight generator lands a
// disproportionate fraction of "random" pairs essentially exactly on mesh
// VERTICES (`barycentric` like `[1, 1e-111, 1e-165]`), which measurably (if
// still boundedly — see geodesicPath.test.ts's NaN-freedom property, which
// DOES cover this input shape and passes) pulls the max relative error
// several-fold higher than a uniform distribution over the sphere's surface
// would, without being a more REPRESENTATIVE "random point a clinician
// might place" per this task's brief. A small seeded PRNG (`mulberry32`,
// deterministic, reproducible, no `Math.random`) is used instead — the same
// determinism guarantee, without the edge-case bias.
//
// ## Subdivision derivation (same style as curvature.analytic.test.ts /
// scripts/generate-fixtures.ts's icosphere tolerance derivations — a
// closed-form baseline, then a MEASURED, not just theoretical, margin)
//
// `geodesicPath`'s `@errorBound` (geodesicPath.ts) documents the PURE
// tessellation-error baseline: for one mesh edge subtending angle `theta`
// at the sphere's center, the straight chord underestimates the true arc
// by a relative fraction `theta^2/24` (from `2*sin(theta/2)/theta = 1 -
// theta^2/24 + O(theta^4)`). Icosphere subdivision `s`'s edge angle is
// `acos(1/sqrt(5)) / 2^s` (the base icosahedron's own center-subtended edge
// angle, halved per subdivision — same derivation
// curvature.analytic.test.ts and scripts/generate-fixtures.ts's icosphere
// fixtures use). At `s = 5`: `theta = 1.10715 / 32 = 0.034599` rad, so the
// PURE per-edge tessellation baseline is `theta^2/24 = 4.99e-5` (0.005%) —
// comfortably under budget on its own.
//
// In practice, a geodesic materialize point does not always land exactly on
// one mesh edge's own chord: a long path crosses MANY triangles somewhat
// obliquely, and this method's corridor-seeding heuristic (corridor.ts's
// module doc: an incrementally-unfolded, chain-dependent search, not a
// provably-optimal shortest-path algorithm) is not a perfect algorithm —
// small per-step biases CAN compound over a long chain of hinge-unfolds
// before `geodesicPath`'s widening loop and multi-candidate seeding (see
// its module doc) pull the result back toward the true polyhedral geodesic.
// So the pure `theta^2/24` baseline above is a LOWER bound on the total
// measured error, not the whole story — exactly the situation
// curvature.analytic.test.ts's own doc describes ("measured, not cited").
//
// Measured (reproduce via this file's own test below): over 6 independently
// seeded batches of 50 uniformly-sampled random surface-point pairs each
// (mulberry32 seeds 1, 2, 3, 42, 12345, 99999, plus this file's own
// `PROPERTY_SEED`), on an `icosphereMesh(5, 5)` (20480 triangles), the
// measured max relative error ranged 0.018% - 0.065% across those batches —
// comfortably (>1.5x, up to ~5.5x) under the 0.1% acceptance budget, and
// well above the pure tessellation baseline (confirming the extra
// algorithmic slack described above is real but still small). `s = 5` is
// used below — the same size class (`icosphereMesh(5, subdivision)`) this
// project's other analytic fixtures already use at a comparable resolution
// (Task 3/9's sphere fixtures) — generous, not tuned to this specific seed.
import { describe, expect, it } from 'vitest';
import { buildHalfedge } from '../halfedge/build.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { geodesicPath } from './geodesicPath.ts';
import { evaluateSurfacePoint } from './surfacePoint.ts';
import type { SurfacePoint } from './types.ts';

const PROPERTY_SEED = 20260712;
const NUM_PAIRS = 50;
const ACCEPTANCE_BOUND = 1e-3; // 0.1%

/** Small, deterministic PRNG (mulberry32) — see this file's "Sampling" doc
 * for why a plain seeded generator is used instead of fast-check here.
 * Never `Math.random`/`Date.now` — this project's determinism invariant. */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform-area sample of a triangle's barycentric coordinates (standard
 * `(1 - sqrt(r1), sqrt(r1)*(1 - r2), sqrt(r1)*r2)` construction). */
function randomBarycentric(rand: () => number): [number, number, number] {
  const r1 = rand();
  const r2 = rand();
  const sqrtR1 = Math.sqrt(r1);
  const w0 = 1 - sqrtR1;
  const w1 = sqrtR1 * (1 - r2);
  const w2 = sqrtR1 * r2;
  return [w0, w1, w2];
}

function randomSurfacePoint(rand: () => number, faceCount: number): SurfacePoint {
  const triangleIndex = Math.min(faceCount - 1, Math.floor(rand() * faceCount));
  return { triangleIndex, barycentric: randomBarycentric(rand) };
}

function normalize(p: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / len, p[1] / len, p[2] / len];
}

/** Analytic great-circle arc length between `a`/`b`'s RADIAL projections
 * onto the exact sphere of `radius` — see this file's top doc: comparing
 * against the exact sphere (not the slightly-tessellation-dipped mesh
 * surface) is what isolates tessellation error, matching Task 9's
 * distance-heatmap acceptance fixtures' identical convention. */
function greatCircleLength(radius: number, a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const na = normalize(a);
  const nb = normalize(b);
  const cosAngle = Math.min(1, Math.max(-1, na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]));
  return radius * Math.acos(cosAngle);
}

describe('geodesicPath — ACCEPTANCE: icosphere geodesic length vs analytic great-circle arc', () => {
  it(`>= ${NUM_PAIRS} seeded random surface-point pairs, each within ${(ACCEPTANCE_BOUND * 100).toFixed(2)}%`, () => {
    const radius = 5;
    const subdivisions = 5; // see this file's top doc for the derivation
    const mesh = icosphereMesh(radius, subdivisions);
    const hm = buildHalfedge(mesh);
    const faceCount = mesh.indices.length / 3;
    const rand = mulberry32(PROPERTY_SEED);

    let maxRelError = 0;
    let maxIterationsSeen = 0;
    let pairsChecked = 0;
    const start = performance.now();
    for (let i = 0; i < NUM_PAIRS; i++) {
      const a = randomSurfacePoint(rand, faceCount);
      const b = randomSurfacePoint(rand, faceCount);
      const result = geodesicPath(mesh, hm, a, b);
      const analytic = greatCircleLength(radius, evaluateSurfacePoint(mesh, a), evaluateSurfacePoint(mesh, b));
      const relError = analytic > 1e-9 ? Math.abs(result.length - analytic) / analytic : 0;
      if (relError > maxRelError) maxRelError = relError;
      if (result.iterations > maxIterationsSeen) maxIterationsSeen = result.iterations;
      pairsChecked++;
      expect(relError).toBeLessThan(ACCEPTANCE_BOUND);
    }
    const elapsedMs = performance.now() - start;

    expect(pairsChecked).toBe(NUM_PAIRS); // sanity: the loop actually ran NUM_PAIRS pairs
    console.log(
      `[geodesicPath acceptance] icosphere r=${radius} subdiv=${subdivisions} (${faceCount} triangles): ` +
        `${NUM_PAIRS} pairs, measured max relative error = ${(maxRelError * 100).toFixed(4)}% ` +
        `(phase acceptance bound: ${(ACCEPTANCE_BOUND * 100).toFixed(2)}%), max widening iterations used = ` +
        `${maxIterationsSeen}, total ${elapsedMs.toFixed(1)}ms (${(elapsedMs / NUM_PAIRS).toFixed(2)}ms/pair)`,
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-seed robustness sweep (this task's fix-batch, minor (a)): a
// LIGHTWEIGHT, COMMITTED version of the dev-time cross-seed sweep this
// file's top doc already cites ("mulberry32 seeds 1, 2, 3, 42, 12345,
// 99999 ... measured max relative error ranged 0.018% - 0.065%"). That
// sweep was previously only a manual/dev-time check, not asserted in CI —
// this `describe.each` makes it a real regression test, asserting the SAME
// per-pair 0.1% acceptance budget as the primary test above, for every one
// of the 6 report seeds. Pair count is reduced from 50 to
// `SWEEP_PAIRS_PER_SEED` (documented below) purely for CI runtime — the
// primary test above already covers 50 pairs at `PROPERTY_SEED`; this sweep
// exists to catch a regression that happens to dodge that ONE seed, not to
// re-establish the accuracy bound from scratch.
const SWEEP_SEEDS = [1, 2, 3, 42, 12345, 99999];
const SWEEP_PAIRS_PER_SEED = 15; // reduced from NUM_PAIRS (50) — see doc above; 6 seeds x 15 pairs = 90 total geodesicPath calls, comparable total cost to the primary test's 50

describe('geodesicPath — multi-seed robustness sweep (icosphere, reduced pair count per seed)', () => {
  const radius = 5;
  const subdivisions = 5; // same fixture as the primary acceptance test above
  const mesh = icosphereMesh(radius, subdivisions);
  const hm = buildHalfedge(mesh);
  const faceCount = mesh.indices.length / 3;

  it.each(SWEEP_SEEDS)(`seed %i: ${SWEEP_PAIRS_PER_SEED} pairs, each within the acceptance budget`, (seed) => {
    const rand = mulberry32(seed);
    let maxRelError = 0;
    for (let i = 0; i < SWEEP_PAIRS_PER_SEED; i++) {
      const a = randomSurfacePoint(rand, faceCount);
      const b = randomSurfacePoint(rand, faceCount);
      const result = geodesicPath(mesh, hm, a, b);
      const analytic = greatCircleLength(radius, evaluateSurfacePoint(mesh, a), evaluateSurfacePoint(mesh, b));
      const relError = analytic > 1e-9 ? Math.abs(result.length - analytic) / analytic : 0;
      if (relError > maxRelError) maxRelError = relError;
      expect(relError).toBeLessThan(ACCEPTANCE_BOUND);
    }
    console.log(
      `[geodesicPath sweep] seed=${seed}: ${SWEEP_PAIRS_PER_SEED} pairs, measured max relative error = ` +
        `${(maxRelError * 100).toFixed(4)}% (budget: ${(ACCEPTANCE_BOUND * 100).toFixed(2)}%)`,
    );
  });
});
