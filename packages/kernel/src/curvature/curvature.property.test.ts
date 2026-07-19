// packages/kernel/src/curvature/curvature.property.test.ts
//
// Property-based tests (fast-check) for `computeCurvature` — per this
// task's brief: scale invariance (mesh x2 -> H/2, K/4), rigid-motion
// invariance (rotation+translation, documented tolerance), determinism
// hashes, plus a Gauss-Bonnet global-consistency check (a strong,
// radius-INDEPENDENT correctness signal: `sum(K(v) * mixedArea(v))` over a
// closed mesh must equal `2*pi*eulerCharacteristic`, exactly in the
// continuous limit — this is the standard sanity check for any discrete
// Gaussian-curvature estimator, distinct from — and not subsumed by — the
// per-vertex analytic spot checks in curvature.analytic.test.ts).
//
// Seeded (not fast-check's auto-random seed) for CI reproducibility — same
// convention as halfedge.property.test.ts / bvh.property.test.ts.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildHalfedge, computeEulerCharacteristic, findNonManifoldVertices } from '../halfedge/index.ts';
import { icosphereMesh, octahedronMesh, openGridPatchMesh, torusMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { singleBowtieMesh } from '../repair/repair.test-fixtures.ts';
import { computeCurvature, type CurvatureResult } from './curvature.ts';

const PROPERTY_SEED = 20260712;
const NUM_RUNS = 50;

function hashCurvature(result: CurvatureResult): string {
  const hash = createHash('sha256');
  for (const arr of [result.H, result.K, result.k1, result.k2, result.mixedArea]) {
    hash.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  hash.update(Buffer.from(result.isBoundary.buffer, result.isBoundary.byteOffset, result.isBoundary.byteLength));
  return hash.digest('hex');
}

function scaleMesh(mesh: IndexedMesh, factor: number): IndexedMesh {
  return { positions: mesh.positions.map((x) => x * factor), indices: mesh.indices };
}

function rotateZThenTranslate(mesh: IndexedMesh, angle: number, tx: number, ty: number, tz: number): IndexedMesh {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const positions = new Float64Array(mesh.positions.length);
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const x = mesh.positions[v * 3]!;
    const y = mesh.positions[v * 3 + 1]!;
    const z = mesh.positions[v * 3 + 2]!;
    positions[v * 3] = x * cosA - y * sinA + tx;
    positions[v * 3 + 1] = x * sinA + y * cosA + ty;
    positions[v * 3 + 2] = z + tz;
  }
  return { positions, indices: mesh.indices };
}

describe('computeCurvature — determinism', () => {
  it('repeated runs on the same mesh are bit-identical (hash match)', () => {
    const mesh = icosphereMesh(5, 2);
    const a = computeCurvature(mesh);
    const b = computeCurvature(mesh);
    expect(hashCurvature(a)).toBe(hashCurvature(b));
  });

  it('property: determinism holds across a range of shapes/parameters', () => {
    const shapeArb = fc.oneof(
      fc.record({ kind: fc.constant('icosphere' as const), subdivisions: fc.integer({ min: 0, max: 2 }) }),
      fc.record({
        kind: fc.constant('torus' as const),
        majorSegments: fc.integer({ min: 4, max: 10 }),
        minorSegments: fc.integer({ min: 4, max: 10 }),
      }),
    );
    fc.assert(
      fc.property(shapeArb, (desc) => {
        const mesh =
          desc.kind === 'icosphere' ? icosphereMesh(5, desc.subdivisions) : torusMesh(3, 1, desc.majorSegments, desc.minorSegments);
        const a = computeCurvature(mesh);
        const b = computeCurvature(mesh);
        expect(hashCurvature(a)).toBe(hashCurvature(b));
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('computeCurvature — scale invariance (mesh x factor -> H / factor, K / factor^2)', () => {
  it('property: holds for icospheres and tori at random scale factors', () => {
    const shapeArb = fc.oneof(
      fc.record({ kind: fc.constant('icosphere' as const), subdivisions: fc.integer({ min: 1, max: 2 }) }),
      fc.record({
        kind: fc.constant('torus' as const),
        majorSegments: fc.integer({ min: 6, max: 12 }),
        minorSegments: fc.integer({ min: 6, max: 12 }),
      }),
    );
    const factorArb = fc.double({ min: 0.25, max: 10, noNaN: true }).filter((f) => f > 0.01);
    fc.assert(
      fc.property(shapeArb, factorArb, (desc, factor) => {
        const mesh =
          desc.kind === 'icosphere' ? icosphereMesh(5, desc.subdivisions) : torusMesh(3, 1, desc.majorSegments, desc.minorSegments);
        const base = computeCurvature(mesh);
        const scaled = computeCurvature(scaleMesh(mesh, factor));
        for (let v = 0; v < mesh.positions.length / 3; v++) {
          if (base.isBoundary[v]) continue;
          // Relative tolerance: generous (1e-6) Float64-rounding-scale bound
          // — the scaling relationship H(factor*mesh) = H(mesh)/factor is
          // algebraically EXACT (H has units of inverse length; K, inverse
          // length squared), so any residual here is pure floating-point
          // noise from the two independent computeCurvature calls' summation
          // order, not a real discretization difference (same mesh
          // TOPOLOGY, only positions differ by a uniform scale).
          const expectedH = base.H[v]! / factor;
          const expectedK = base.K[v]! / (factor * factor);
          const scaleH = Math.max(1, Math.abs(expectedH));
          const scaleK = Math.max(1, Math.abs(expectedK));
          expect(Math.abs(scaled.H[v]! - expectedH)).toBeLessThan(1e-6 * scaleH);
          expect(Math.abs(scaled.K[v]! - expectedK)).toBeLessThan(1e-6 * scaleK);
        }
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('computeCurvature — rigid-motion invariance (rotation + translation)', () => {
  // Tolerance derivation: a rigid motion changes nothing about the
  // geometry's INTRINSIC curvature, so in exact arithmetic H/K are
  // unchanged. The only source of difference here is Float64 rounding
  // accumulated through a DIFFERENT sequence of floating-point operations
  // (rotating every position introduces new rounding at each coordinate,
  // then the cotan/mixed-area sums re-accumulate in a numerically different
  // but mathematically equivalent order) — bounded generously at 1e-9
  // absolute, several orders of magnitude above the ~1e-13..1e-14 actually
  // observed for O(1)-magnitude curvature values through a handful of
  // Float64 operations (each contributing ~1e-16 relative rounding).
  const RIGID_MOTION_TOLERANCE = 1e-9;

  it('property: H and K are unchanged (within tolerance) under rotation + translation', () => {
    const shapeArb = fc.oneof(
      fc.record({ kind: fc.constant('icosphere' as const), subdivisions: fc.integer({ min: 1, max: 2 }) }),
      fc.constant({ kind: 'octahedron' as const }),
    );
    const angleArb = fc.double({ min: 0, max: 2 * Math.PI, noNaN: true });
    const translationArb = fc.double({ min: -100, max: 100, noNaN: true });
    fc.assert(
      fc.property(shapeArb, angleArb, translationArb, translationArb, translationArb, (desc, angle, tx, ty, tz) => {
        const mesh = desc.kind === 'icosphere' ? icosphereMesh(5, desc.subdivisions) : octahedronMesh(3);
        const base = computeCurvature(mesh);
        const moved = computeCurvature(rotateZThenTranslate(mesh, angle, tx, ty, tz));
        for (let v = 0; v < mesh.positions.length / 3; v++) {
          if (base.isBoundary[v]) continue;
          expect(Math.abs(moved.H[v]! - base.H[v]!)).toBeLessThan(RIGID_MOTION_TOLERANCE);
          expect(Math.abs(moved.K[v]! - base.K[v]!)).toBeLessThan(RIGID_MOTION_TOLERANCE);
        }
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('computeCurvature — principal curvature ordering and NaN-freedom', () => {
  it('property: k1 >= k2 everywhere, and no NaN/Infinity anywhere (H, K, k1, k2), across closed and boundary-having meshes', () => {
    const shapeArb = fc.oneof(
      fc.record({ kind: fc.constant('icosphere' as const), subdivisions: fc.integer({ min: 0, max: 2 }) }),
      fc.record({
        kind: fc.constant('torus' as const),
        majorSegments: fc.integer({ min: 3, max: 10 }),
        minorSegments: fc.integer({ min: 3, max: 8 }),
      }),
      fc.record({
        kind: fc.constant('openGrid' as const),
        rows: fc.integer({ min: 1, max: 6 }),
        cols: fc.integer({ min: 1, max: 6 }),
      }),
    );
    fc.assert(
      fc.property(shapeArb, (desc) => {
        const mesh =
          desc.kind === 'icosphere'
            ? icosphereMesh(5, desc.subdivisions)
            : desc.kind === 'torus'
              ? torusMesh(3, 1, desc.majorSegments, desc.minorSegments)
              : openGridPatchMesh(desc.rows, desc.cols);
        const result = computeCurvature(mesh);
        for (let v = 0; v < mesh.positions.length / 3; v++) {
          expect(Number.isFinite(result.H[v]!)).toBe(true);
          expect(Number.isFinite(result.K[v]!)).toBe(true);
          expect(Number.isFinite(result.k1[v]!)).toBe(true);
          expect(Number.isFinite(result.k2[v]!)).toBe(true);
          expect(result.k1[v]!).toBeGreaterThanOrEqual(result.k2[v]!);
        }
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it('every boundary-loop vertex of an open patch is flagged and zeroed', () => {
    const mesh = openGridPatchMesh(3, 4);
    const hm = buildHalfedge(mesh);
    const result = computeCurvature(mesh, hm);
    let boundaryCount = 0;
    for (let he = 0; he < hm.halfedgeCount; he++) {
      if (hm.twin[he] !== -1) continue;
      for (const v of [hm.vertex[he]!, hm.vertex[hm.next[he]!]!]) {
        expect(result.isBoundary[v]).toBe(1);
        expect(result.H[v]).toBe(0);
        expect(result.K[v]).toBe(0);
        expect(result.k1[v]).toBe(0);
        expect(result.k2[v]).toBe(0);
        boundaryCount++;
      }
    }
    expect(boundaryCount).toBeGreaterThan(0); // sanity: the patch actually has a boundary
  });

  it('a bowtie vertex is flagged and zeroed (Fix batch: forEachOutgoingHalfedge only walks ONE wing, previously producing a plausible-but-wrong H rather than an error)', () => {
    const mesh = singleBowtieMesh();
    // Sanity: the fixture actually has a bowtie, at vertex 0, per its own doc.
    const bowties = findNonManifoldVertices(mesh);
    expect(bowties).toEqual([{ vertex: 0, fanCount: 2 }]);

    const result = computeCurvature(mesh);

    expect(result.isBoundary[0]).toBe(1);
    expect(result.H[0]).toBe(0);
    expect(result.K[0]).toBe(0);
    expect(result.k1[0]).toBe(0);
    expect(result.k2[0]).toBe(0);

    // Neighbors (each fan's 3 base vertices, forming a closed tetrahedral
    // shell with the apex) are untouched by the bowtie-exclusion policy:
    // they are ordinary interior vertices of their own fan and get real,
    // finite curvature, not flagged.
    for (let v = 1; v < mesh.positions.length / 3; v++) {
      expect(result.isBoundary[v]).toBe(0);
      expect(Number.isFinite(result.H[v]!)).toBe(true);
      expect(Number.isFinite(result.K[v]!)).toBe(true);
      expect(Number.isFinite(result.k1[v]!)).toBe(true);
      expect(Number.isFinite(result.k2[v]!)).toBe(true);
    }

    // Determinism: repeated runs on the same (small, fixed) mesh agree
    // exactly — same convention as the "determinism" describe block above,
    // spot-checked directly here rather than via the shared hash helper so
    // this test stands alone.
    const again = computeCurvature(mesh);
    expect(Array.from(again.H)).toEqual(Array.from(result.H));
    expect(Array.from(again.K)).toEqual(Array.from(result.K));
    expect(Array.from(again.k1)).toEqual(Array.from(result.k1));
    expect(Array.from(again.k2)).toEqual(Array.from(result.k2));
    expect(Array.from(again.isBoundary)).toEqual(Array.from(result.isBoundary));
  });

  it('discriminant clamp actually engages: octahedron r=1 has a NEGATIVE raw H^2-K at every (discrete-umbilic) vertex, yet k1===k2===H with no NaN', () => {
    // octahedronMesh(1): every vertex is surrounded by 4 congruent
    // equilateral-triangle faces (all edges from an axis-aligned octahedron
    // vertex to its neighbors have equal length by symmetry), so H and K
    // are IDENTICAL at all 6 vertices. Measured directly (not asserted as
    // an exact literal, since the discrete formulas' output is a derived
    // quantity, not a designed-in constant): H=1 exactly (mixed-area/cotan
    // geometry happens to normalize to the sphere-like H=1/r here) but
    // K's angle-defect/mixed-area estimate OVERSHOOTS the analytic
    // continuum value at this coarse a tessellation, landing at
    // K~1.8138 > H^2=1 — i.e. the raw discriminant `H^2 - K` is NEGATIVE
    // (~-0.8138), exactly the scenario this file's module doc (curvature.ts,
    // "Principal curvatures kappa1/kappa2") says the clamp exists for: H and
    // K are independent discrete estimators whose errors need not agree
    // sign-wise near an umbilic point, even though the analytic
    // discriminant is always >= 0. Without the `Math.max(0, ...)` clamp at
    // curvature.ts's `discriminant` line, this would try to `Math.sqrt` a
    // negative number and produce NaN for k1/k2 on every vertex of this
    // mesh.
    const mesh = octahedronMesh(1);
    const result = computeCurvature(mesh);
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      expect(result.isBoundary[v]).toBe(0);
      const rawDiscriminant = result.H[v]! * result.H[v]! - result.K[v]!;
      expect(rawDiscriminant).toBeLessThan(0); // confirms this vertex actually exercises the clamp
      expect(Number.isNaN(result.k1[v])).toBe(false);
      expect(Number.isNaN(result.k2[v])).toBe(false);
      expect(result.k1[v]).toBeCloseTo(result.H[v]!, 12); // clamp engaged -> sqrt(0) -> k1 == k2 == H
      expect(result.k2[v]).toBeCloseTo(result.H[v]!, 12);
    }
  });
});

describe('computeCurvature — discrete Gauss-Bonnet (sum(K * mixedArea) = 2*pi*eulerCharacteristic)', () => {
  it('genus-0 closed meshes (icosphere): sum ≈ 4*pi', () => {
    for (const subdivisions of [0, 1, 2, 3]) {
      const mesh = icosphereMesh(5, subdivisions);
      const hm = buildHalfedge(mesh);
      const result = computeCurvature(mesh, hm);
      let total = 0;
      for (let v = 0; v < hm.vertexCount; v++) total += result.K[v]! * result.mixedArea[v]!;
      const euler = computeEulerCharacteristic(hm).eulerCharacteristic;
      expect(euler).toBe(2); // sanity: icosphere is indeed genus 0
      // Convergence to the exact continuum identity is itself
      // O(theta^2)-accurate (same discretization order as the per-vertex
      // estimators) — a coarse tolerance (1%) that just confirms the SIGN
      // and ORDER of magnitude are right is enough here; the tight,
      // per-vertex analytic values are already pinned down in
      // curvature.analytic.test.ts.
      expect(Math.abs(total - 2 * Math.PI * euler)).toBeLessThan(0.01 * 2 * Math.PI * euler);
    }
  });

  it('genus-1 closed mesh (torus): sum ≈ 0', () => {
    const mesh = torusMesh(5, 2, 48, 24);
    const hm = buildHalfedge(mesh);
    const result = computeCurvature(mesh, hm);
    let total = 0;
    for (let v = 0; v < hm.vertexCount; v++) total += result.K[v]! * result.mixedArea[v]!;
    const euler = computeEulerCharacteristic(hm).eulerCharacteristic;
    expect(euler).toBe(0); // sanity: torus is indeed genus 1
    // Absolute tolerance here (the analytic target is exactly 0, so a
    // relative tolerance is undefined) — surface area scale (~4*pi^2*R*r)
    // sets the natural magnitude for a "small" residual; 1e-3 of it is
    // generous against the observed ~1e-13 (see this task's report).
    const analyticSurfaceArea = 4 * Math.PI * Math.PI * 5 * 2;
    expect(Math.abs(total)).toBeLessThan(1e-3 * analyticSurfaceArea);
  });
});
