// packages/kernel/src/margin/marginRidge.analytic.test.ts
//
// Phase 3 Task 4 analytic acceptance suite: `proposeMarginLoop` on
// `shoulderPrepMesh` (a closed, watertight solid of revolution with an
// EXACTLY known concave margin circle — see that fixture's module doc for
// the derivation) — sharp and filleted variants, seed determinism/stability,
// and the degenerate-seed typed-error case.
import { describe, expect, it } from 'vitest';
import { buildHalfedge, computeCurvature, buildBvh, snapToSurface, evaluateSurfacePoint, analyzeMesh } from '@dqcad/kernel';
import {
  proposeMarginLoop,
  NoRidgeFoundError,
  NoClosureError,
  MARGIN_MIN_RIDGE_STRENGTH,
} from './marginRidge.ts';
import { shoulderPrepMesh, type ShoulderPrepMesh } from './marginRidge.test-fixtures.ts';
import { cappedCylinderMesh } from '../curvature/curvature.test-fixtures.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { SurfacePoint } from '../geodesic/types.ts';

/** Builds a seed `SurfacePoint` on the fixture's TAPER wall (above the
 * margin, on the same tooth) at a given height offset from the margin —
 * "seed inside the prep" (this task's brief). Snapped to the actual mesh
 * surface via BVH `closestPoint` (`snapToSurface`), so the exact
 * triangle/barycentric is whatever the real tessellation puts there —
 * deterministic given fixed fixture params. */
function taperSeed(
  mesh: IndexedMesh,
  bvh: ReturnType<typeof buildBvh>,
  fixture: ShoulderPrepMesh,
  topRadiusMm: number,
  totalHeightMm: number,
  heightAboveMarginMm: number,
): SurfacePoint {
  const seedZ = fixture.marginHeightMm + heightAboveMarginMm;
  const seedR =
    fixture.marginRadiusMm + ((topRadiusMm - fixture.marginRadiusMm) * (seedZ - fixture.marginHeightMm)) / (totalHeightMm - fixture.marginHeightMm);
  return snapToSurface(mesh, bvh, [seedR, 0, seedZ]);
}

/** Max (r,z)-plane deviation of every anchor from the fixture's analytic
 * margin circle (radius `marginRadiusMm`, height `marginHeightMm`). */
function maxAnchorDeviationMm(mesh: IndexedMesh, anchors: readonly SurfacePoint[], marginRadiusMm: number, marginHeightMm: number): number {
  let maxDev = 0;
  for (const a of anchors) {
    const p = evaluateSurfacePoint(mesh, a);
    const r = Math.hypot(p[0], p[1]);
    const dev = Math.hypot(r - marginRadiusMm, p[2] - marginHeightMm);
    maxDev = Math.max(maxDev, dev);
  }
  return maxDev;
}

const TOP_RADIUS_MM = 2;
const TOTAL_HEIGHT_MM = 8;

describe('proposeMarginLoop — analytic shoulderPrepMesh (sharp corner)', () => {
  it('tracks the EXACT analytic margin circle: every anchor within floating-point-noise tolerance', () => {
    const fixture = shoulderPrepMesh();
    const stats = analyzeMesh(fixture.mesh);
    expect(stats.watertight).toBe(true); // sanity: a real solid, not a broken fixture

    const hm = buildHalfedge(fixture.mesh);
    const curv = computeCurvature(fixture.mesh, hm);
    const bvh = buildBvh(fixture.mesh);
    const seed = taperSeed(fixture.mesh, bvh, fixture, TOP_RADIUS_MM, TOTAL_HEIGHT_MM, 1.0);

    const result = proposeMarginLoop(fixture.mesh, hm, curv, seed);
    expect(result.closed).toBe(true);
    expect(result.anchors.length).toBeGreaterThanOrEqual(3);
    // Default fixture: 128 circumferential segments — every P2-ring vertex
    // is EXACT (module doc's "exact ring" note), so the walk should visit
    // the WHOLE ring exactly once (no vertex skipped or duplicated).
    expect(result.walkVertexCount).toBe(128);
    expect(result.closureDeviationMm).toBeLessThanOrEqual(1e-6);

    // Derived tolerance: the sharp corner's ring vertices are EXACT points
    // on the analytic circle (module doc) — the only error source is
    // Float64 `cos`/`sin` rounding (~1e-15 relative to the mesh's coordinate
    // magnitude, a few mm here) — 1e-9 mm is a documented, comfortably loose
    // multiple of that (same style as surfaceSpline.test.ts's `@errorBound`
    // suite, "assert <= weld-epsilon x documented factor").
    const derivedToleranceMm = 1e-9;
    const measuredMaxDeviationMm = maxAnchorDeviationMm(fixture.mesh, result.anchors, fixture.marginRadiusMm, fixture.marginHeightMm);
    console.log(`[margin analytic] sharp-corner max anchor deviation: ${measuredMaxDeviationMm.toExponential(3)}mm (tolerance ${derivedToleranceMm}mm)`);
    expect(measuredMaxDeviationMm).toBeLessThanOrEqual(derivedToleranceMm);

    // Every segment should report high confidence (the whole ring is
    // uniformly strong, real ridge — no weak segments on this fixture).
    for (const c of result.segmentConfidence) {
      expect(c).toBeGreaterThan(0.9);
    }
  });

  it('reports a plausible anchor count and a closed, non-degenerate loop', () => {
    const fixture = shoulderPrepMesh();
    const hm = buildHalfedge(fixture.mesh);
    const curv = computeCurvature(fixture.mesh, hm);
    const bvh = buildBvh(fixture.mesh);
    const seed = taperSeed(fixture.mesh, bvh, fixture, TOP_RADIUS_MM, TOTAL_HEIGHT_MM, 1.0);
    const result = proposeMarginLoop(fixture.mesh, hm, curv, seed);
    // Analytic circumference: 2*pi*marginRadiusMm.
    const analyticCircumference = 2 * Math.PI * fixture.marginRadiusMm;
    let perimeter = 0;
    for (let i = 0; i < result.anchors.length; i++) {
      const a = evaluateSurfacePoint(fixture.mesh, result.anchors[i]!);
      const b = evaluateSurfacePoint(fixture.mesh, result.anchors[(i + 1) % result.anchors.length]!);
      perimeter += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
    // A polygon inscribed in a circle always has perimeter <= the circle's
    // own circumference — assert that plus a loose lower bound (not
    // degenerately small).
    expect(perimeter).toBeLessThanOrEqual(analyticCircumference * 1.001);
    expect(perimeter).toBeGreaterThan(analyticCircumference * 0.9);
  });
});

describe('proposeMarginLoop — analytic shoulderPrepMesh (filleted margin)', () => {
  it.each([0.15, 0.3])('tracks the filleted crest within the fillet-radius-derived tolerance (filletRadiusMm=%d)', (filletRadiusMm) => {
    const fixture = shoulderPrepMesh({ filletRadiusMm });
    const stats = analyzeMesh(fixture.mesh);
    expect(stats.watertight).toBe(true);

    const hm = buildHalfedge(fixture.mesh);
    const curv = computeCurvature(fixture.mesh, hm);
    const bvh = buildBvh(fixture.mesh);
    const seed = taperSeed(fixture.mesh, bvh, fixture, TOP_RADIUS_MM, TOTAL_HEIGHT_MM, 1.0);

    const result = proposeMarginLoop(fixture.mesh, hm, curv, seed);
    expect(result.closed).toBe(true);

    // Derived tolerance (tightened, fix batch T4 review): the fillet blend's
    // two tangent points each sit `r / tan(theta/2)` from the nominal sharp
    // corner P2 along P2's own two straight edges — the standard
    // tangent-circle-at-a-vertex identity, where `theta` is the angle
    // between those two edges as seen FROM the corner (`theta = acos(
    // normalize(P1-P2) . normalize(P3-P2))`). At this fixture's default
    // gingival/margin/top radii and heights, `theta ~= 103deg`, so
    // `r / tan(theta/2) ~= r / tan(51.5deg) ~= 0.7975*r` (~0.8r) — TIGHTER
    // than the `filletRadiusMm` (1.0r) bound this test previously stated.
    // The blended arc lies within the triangle those two tangent points and
    // P2 form (marginRidge.test-fixtures.ts's `filletCorner` doc), so no
    // point on the blended crest is ever farther from P2 than that. The
    // ASSERTED tolerance below is deliberately kept LOOSER than this tight
    // ~0.8r bound (1.1r, unchanged) as a safety margin absorbing the
    // discrete-curvature estimator's own resolution-dependent behavior at a
    // small-radius feature (curvature.ts's `@errorBound`) — the MEASURED
    // numbers logged below (0.1026mm/0.2051mm at filletRadiusMm 0.15/0.3)
    // are comfortably under even the tight 0.8r bound (0.12mm/0.24mm), not
    // just the 1.1r safety tolerance.
    const derivedToleranceMm = filletRadiusMm * 1.1;
    const measuredMaxDeviationMm = maxAnchorDeviationMm(fixture.mesh, result.anchors, fixture.marginRadiusMm, fixture.marginHeightMm);
    console.log(
      `[margin analytic] filletRadiusMm=${filletRadiusMm} max anchor deviation: ${measuredMaxDeviationMm.toFixed(4)}mm (tolerance ${derivedToleranceMm.toFixed(4)}mm)`,
    );
    expect(measuredMaxDeviationMm).toBeLessThanOrEqual(derivedToleranceMm);
  });
});

describe('proposeMarginLoop — determinism and seed stability', () => {
  it('same seed -> bit-identical anchors (hash-stable)', () => {
    const fixture = shoulderPrepMesh();
    const hm = buildHalfedge(fixture.mesh);
    const curv = computeCurvature(fixture.mesh, hm);
    const bvh = buildBvh(fixture.mesh);
    const seed = taperSeed(fixture.mesh, bvh, fixture, TOP_RADIUS_MM, TOTAL_HEIGHT_MM, 1.0);

    const a = proposeMarginLoop(fixture.mesh, hm, curv, seed);
    const b = proposeMarginLoop(fixture.mesh, hm, curv, seed);
    expect(JSON.stringify(b.anchors)).toBe(JSON.stringify(a.anchors));
    expect(b.segmentConfidence).toEqual(a.segmentConfidence);
    expect(b.closureDeviationMm).toBe(a.closureDeviationMm);
  });

  it('nearby seeds (different heights above the SAME margin) converge to the SAME loop within tolerance', () => {
    const fixture = shoulderPrepMesh();
    const hm = buildHalfedge(fixture.mesh);
    const curv = computeCurvature(fixture.mesh, hm);
    const bvh = buildBvh(fixture.mesh);

    const seedNear = taperSeed(fixture.mesh, bvh, fixture, TOP_RADIUS_MM, TOTAL_HEIGHT_MM, 0.6);
    const seedFar = taperSeed(fixture.mesh, bvh, fixture, TOP_RADIUS_MM, TOTAL_HEIGHT_MM, 2.0);
    // Sanity: genuinely different ambient seed points (may still land on the
    // same triangle strip's segment — the mesh's own tessellation is coarser
    // than the 1.4mm height gap between them — so compare ambient position,
    // not necessarily `triangleIndex`).
    expect(evaluateSurfacePoint(fixture.mesh, seedNear)).not.toEqual(evaluateSurfacePoint(fixture.mesh, seedFar));

    const resultNear = proposeMarginLoop(fixture.mesh, hm, curv, seedNear);
    const resultFar = proposeMarginLoop(fixture.mesh, hm, curv, seedFar);
    // Both must land on the SAME analytic ring (a shared, mesh-independent
    // ground truth) — the ring being EXACT (module doc) means "same loop"
    // is directly verifiable via the same tight analytic tolerance, not
    // just "similar anchor count".
    const derivedToleranceMm = 1e-9;
    expect(maxAnchorDeviationMm(fixture.mesh, resultNear.anchors, fixture.marginRadiusMm, fixture.marginHeightMm)).toBeLessThanOrEqual(
      derivedToleranceMm,
    );
    expect(maxAnchorDeviationMm(fixture.mesh, resultFar.anchors, fixture.marginRadiusMm, fixture.marginHeightMm)).toBeLessThanOrEqual(
      derivedToleranceMm,
    );
    expect(resultNear.walkVertexCount).toBe(resultFar.walkVertexCount);
  });
});

describe('proposeMarginLoop — degenerate seed (typed errors)', () => {
  it('throws NoRidgeFoundError for a seed on a large, featureless flat/curved region far from any ridge', () => {
    // A large-radius capped cylinder tube (curvature.test-fixtures.ts) has
    // NO concave feature anywhere (k1 = 1/radius, k2 = 0 analytically) — a
    // seed on its tube, far from the (also convex) end caps, has no ridge
    // within any reasonable searchRadiusMm.
    const mesh = cappedCylinderMesh(50, 40, 64, 20);
    const hm = buildHalfedge(mesh);
    const curv = computeCurvature(mesh, hm);
    const bvh = buildBvh(mesh);
    const seed = snapToSurface(mesh, bvh, [50, 0, 0]); // tube, well away from either cap

    expect(() => proposeMarginLoop(mesh, hm, curv, seed)).toThrow(NoRidgeFoundError);
  });

  it('NoRidgeFoundError reports the searchRadiusMm/minRidgeStrength actually used', () => {
    const mesh = cappedCylinderMesh(50, 40, 64, 20);
    const hm = buildHalfedge(mesh);
    const curv = computeCurvature(mesh, hm);
    const bvh = buildBvh(mesh);
    const seed = snapToSurface(mesh, bvh, [50, 0, 0]);

    try {
      proposeMarginLoop(mesh, hm, curv, seed, { searchRadiusMm: 5 });
      expect.unreachable('expected NoRidgeFoundError');
    } catch (e) {
      expect(e).toBeInstanceOf(NoRidgeFoundError);
      expect((e as Error).message).toContain('5mm');
      expect((e as Error).message).toContain(String(MARGIN_MIN_RIDGE_STRENGTH));
    }
  });

  it('NoClosureError is a distinct typed error from NoRidgeFoundError (both importable, never confused)', () => {
    expect(NoClosureError).not.toBe(NoRidgeFoundError);
    const e1 = new NoRidgeFoundError(10, 3);
    const e2 = new NoClosureError(1, 0.15, 10);
    expect(e1.name).toBe('NoRidgeFoundError');
    expect(e2.name).toBe('NoClosureError');
    expect(e1).toBeInstanceOf(Error);
    expect(e2).toBeInstanceOf(Error);
  });
});
