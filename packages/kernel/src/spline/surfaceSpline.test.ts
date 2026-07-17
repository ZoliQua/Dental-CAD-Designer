// packages/kernel/src/spline/surfaceSpline.test.ts
//
// Phase 2 Task 5, deliverables 2, 3 & 5 (surface-constrained tests): see
// surfaceSpline.ts's module doc for the iterative re-projection algorithm
// and @errorBound.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { Bvh } from '../bvh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { MESH_WELD_EPSILON_MM } from '../intake/weld.ts';
import { evaluateSurfacePoint } from '../geodesic/surfacePoint.ts';
import { icosphereMesh, openGridPatchMesh } from '../halfedge/halfedge.test-fixtures.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import {
  fitSurfaceSpline,
  refitSurfaceSplineControlPoint,
  resampleSurfaceSpline,
  type SurfaceSpline,
} from './surfaceSpline.ts';

/** Re-queries `closestPoint` on every point this `spline` returns (control
 * points + every span's resampled points) and returns the max distance —
 * this is the literal "the final curve lies on-surface" check (this task's
 * brief, deliverable 2), independent of `maxAmbientDeviationMm`'s internal
 * bookkeeping (see surfaceSpline.ts's `@errorBound` doc for why those are
 * two different quantities). */
function maxReturnedPointOffSurfaceDistance(mesh: IndexedMesh, bvh: Bvh, spline: SurfaceSpline): number {
  let max = 0;
  for (const cp of spline.controlPoints) {
    const p = evaluateSurfacePoint(mesh, cp);
    max = Math.max(max, closestPoint(mesh, bvh, p).distance);
  }
  for (const span of spline.spans) {
    for (const sp of span.points) {
      const p = evaluateSurfacePoint(mesh, sp);
      max = Math.max(max, closestPoint(mesh, bvh, p).distance);
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// @errorBound: every returned point is on-surface within floating-point
// noise (this task's brief, deliverable 2: "assert <= weld-epsilon x
// documented factor" — see surfaceSpline.ts's module doc, item 1, for why
// this is the TIGHT, honest bound to assert directly — factor = 1, not just
// "small"). `maxAmbientDeviationMm` (item 2 of that same doc) is a
// DIFFERENT, deliberately non-tiny diagnostic — checked separately below,
// not against the weld-epsilon bound.
// ---------------------------------------------------------------------------

describe('fitSurfaceSpline — @errorBound: max off-surface distance of RETURNED points', () => {
  it('open spline on an icosphere: every returned point is on-surface within weld-epsilon', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const points: Vec3[] = [
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
      [-5, 0, 0],
    ];
    const spline = fitSurfaceSpline(mesh, bvh, points, false, 3);
    expect(spline.spans.length).toBe(3);
    expect(maxReturnedPointOffSurfaceDistance(mesh, bvh, spline)).toBeLessThanOrEqual(MESH_WELD_EPSILON_MM);
    // The AMBIENT deviation (how far the pre-projection smooth curve
    // strayed before being pulled onto the surface) is a separate,
    // legitimately non-tiny diagnostic — just sanity-checked here (finite,
    // non-negative), not bounded by weld-epsilon.
    expect(Number.isFinite(spline.maxAmbientDeviationMm)).toBe(true);
    expect(spline.maxAmbientDeviationMm).toBeGreaterThanOrEqual(0);
  });

  it('closed spline on an icosphere: every returned point is on-surface within weld-epsilon', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const points: Vec3[] = [
      [5, 0, 0],
      [0, 5, 0],
      [-5, 0, 0],
      [0, -5, 0],
    ];
    const spline = fitSurfaceSpline(mesh, bvh, points, true, 3);
    expect(spline.spans.length).toBe(4);
    expect(spline.converged).toBe(true);
    expect(maxReturnedPointOffSurfaceDistance(mesh, bvh, spline)).toBeLessThanOrEqual(MESH_WELD_EPSILON_MM);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE: closed margin-line-like spline on a real icosphere, control
// points on a great circle -> radius deviation asserted (this task's brief,
// deliverable 5, surface-constrained version — combines catmullRom.test.ts's
// pure ambient-space circle test with icosphere TESSELLATION error, the same
// two independently-bounded error sources geodesicPath.ts's @errorBound doc
// separates for its own great-circle acceptance test).
// ---------------------------------------------------------------------------

describe('fitSurfaceSpline — ACCEPTANCE: closed spline through a great circle on an icosphere', () => {
  it('N=24 points on the equator of an icosphere: max radius deviation is small (measured + documented bound)', () => {
    const radius = 5;
    const subdivisions = 4; // matches this project's other analytic-fixture size class
    const mesh = icosphereMesh(radius, subdivisions);
    const bvh = buildBvh(mesh);
    const n = 24;
    const points: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const theta = (2 * Math.PI * i) / n;
      points.push([radius * Math.cos(theta), radius * Math.sin(theta), 0]);
    }
    const spline = fitSurfaceSpline(mesh, bvh, points, true, 4);
    expect(spline.converged).toBe(true);

    let maxRadialDeviation = 0;
    for (const span of spline.spans) {
      for (const sp of span.points) {
        const p = evaluateSurfacePoint(mesh, sp);
        const r = Math.hypot(p[0], p[1], p[2]);
        maxRadialDeviation = Math.max(maxRadialDeviation, Math.abs(r - radius));
      }
    }
    // Two independently-bounded sources compound here (surfaceSpline.ts's
    // module doc + catmullRom.test.ts's circle-test doc): (a) the pure
    // ambient Catmull-Rom's own deviation from the exact circle (measured
    // ~0.0005mm at this density in catmullRom.test.ts), and (b) icosphere
    // TESSELLATION error (the mesh itself doesn't sit exactly on the
    // analytic sphere — same chord-vs-arc reasoning geodesicPath.ts's
    // @errorBound documents; at subdivision 4 the icosphere's own vertices
    // deviate from the true sphere by a comparable small fraction of a mm
    // at r=5). MEASURED (reproduce via this test) below; BOUND set with
    // margin above it.
    // MEASURED (reproduce via this test): 0.00568mm. BOUND below is set at
    // ~2x that measured value (comfortable margin against fixture/seed
    // changes, still far tighter than a loose sanity ceiling), matching
    // this project's "measured, not just theoretical" convention.
    console.log(`[surfaceSpline circle acceptance] N=${n} r=${radius}mm icosphere subdiv=${subdivisions}: max radius deviation = ${maxRadialDeviation.toFixed(5)}mm`);
    expect(maxRadialDeviation).toBeLessThan(0.012);
  });
});

// ---------------------------------------------------------------------------
// Locality (this task's brief, deliverable 3) — mirrors
// geodesic/snapPolyline.test.ts's `resnapPolylineAnchor` locality test
// exactly (same `===`-identity assertion style).
// ---------------------------------------------------------------------------

describe('refitSurfaceSplineControlPoint — locality', () => {
  it('open spline: moving an interior control point recomputes only its touching spans; every other span is the SAME object reference', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const points: Vec3[] = [
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
      [-5, 0, 0],
      [0, -5, 0],
      [0, 0, -5],
    ];
    const original = fitSurfaceSpline(mesh, bvh, points, false, 2);
    expect(original.spans.length).toBe(5);

    const moved = refitSurfaceSplineControlPoint(mesh, bvh, original, 2, [3, 3, 3]);

    expect(moved.controlPoints.length).toBe(original.controlPoints.length);
    expect(moved.spans.length).toBe(original.spans.length);
    expect(moved.controlPoints[2]).not.toBe(original.controlPoints[2]);
    // Every OTHER control point is untouched (same reference).
    for (const i of [0, 1, 3, 4, 5]) {
      expect(moved.controlPoints[i]).toBe(original.controlPoints[i]);
    }
    // Control point 2's role touches spans {0,1,2,3} (window [k-2,k+1] clipped
    // to [0,4] — see catmullRom.ts's affectedSpanIndices doc); span 4 is
    // untouched.
    expect(moved.spans[0]).not.toBe(original.spans[0]);
    expect(moved.spans[1]).not.toBe(original.spans[1]);
    expect(moved.spans[2]).not.toBe(original.spans[2]);
    expect(moved.spans[3]).not.toBe(original.spans[3]);
    expect(moved.spans[4]).toBe(original.spans[4]);
  });

  it('closed spline: moving one control point recomputes only its touching (wrapped) spans; every other span is the SAME object reference', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const n = 8;
    const points: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const theta = (2 * Math.PI * i) / n;
      points.push([5 * Math.cos(theta), 5 * Math.sin(theta), 0]);
    }
    const original = fitSurfaceSpline(mesh, bvh, points, true, 2);
    expect(original.spans.length).toBe(n);

    const moved = refitSurfaceSplineControlPoint(mesh, bvh, original, 0, [0, 0, 5]);

    // Control point 0's window {n-2,n-1,0,1} = {6,7,0,1} — see
    // catmullRom.test.ts's directed wrap-indexing table for this exact
    // shape (n=6 there; same formula, different n here).
    const touched = new Set([6, 7, 0, 1]);
    for (let i = 0; i < n; i++) {
      if (touched.has(i)) {
        expect(moved.spans[i]).not.toBe(original.spans[i]);
      } else {
        expect(moved.spans[i]).toBe(original.spans[i]);
      }
    }
  });

  it('does not mutate the input spline', () => {
    const mesh = openGridPatchMesh(4, 4);
    const bvh = buildBvh(mesh);
    const points: Vec3[] = [
      [0.5, 0.5, 0],
      [2, 1, 0],
      [3.5, 2.5, 0],
    ];
    const original = fitSurfaceSpline(mesh, bvh, points, false, 2);
    const controlPointsSnapshot = [...original.controlPoints];
    const spansSnapshot = [...original.spans];

    refitSurfaceSplineControlPoint(mesh, bvh, original, 1, [2, 3, 0]);

    expect(original.controlPoints).toEqual(controlPointsSnapshot);
    expect(original.spans).toEqual(spansSnapshot);
  });

  it('throws RangeError for an out-of-range index', () => {
    const mesh = openGridPatchMesh(3, 3);
    const bvh = buildBvh(mesh);
    const spline = fitSurfaceSpline(
      mesh,
      bvh,
      [
        [0.5, 0.5, 0],
        [2, 2, 0],
      ],
      false,
      2,
    );
    expect(() => refitSurfaceSplineControlPoint(mesh, bvh, spline, -1, [1, 1, 0])).toThrow(RangeError);
    expect(() => refitSurfaceSplineControlPoint(mesh, bvh, spline, 2, [1, 1, 0])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// resampleSurfaceSpline — global density change, reuses existing control
// points (no re-snap).
// ---------------------------------------------------------------------------

describe('resampleSurfaceSpline', () => {
  it('reuses the same controlPoints (identical SurfacePoint objects) and recomputes every span at the new density', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const points: Vec3[] = [
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
    ];
    const original = fitSurfaceSpline(mesh, bvh, points, false, 1);
    const resampled = resampleSurfaceSpline(mesh, bvh, original, 8);

    expect(resampled.pointsPerMm).toBe(8);
    for (let i = 0; i < original.controlPoints.length; i++) {
      expect(resampled.controlPoints[i]).toBe(original.controlPoints[i]);
    }
    // Higher density -> at least as many points per span.
    for (let i = 0; i < original.spans.length; i++) {
      expect(resampled.spans[i]!.points.length).toBeGreaterThanOrEqual(original.spans[i]!.points.length);
    }
  });

  it('throws RangeError for a non-positive density', () => {
    const mesh = openGridPatchMesh(3, 3);
    const bvh = buildBvh(mesh);
    const spline = fitSurfaceSpline(
      mesh,
      bvh,
      [
        [0.5, 0.5, 0],
        [2, 2, 0],
      ],
      false,
      2,
    );
    expect(() => resampleSurfaceSpline(mesh, bvh, spline, 0)).toThrow(RangeError);
    expect(() => resampleSurfaceSpline(mesh, bvh, spline, -1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

describe('fitSurfaceSpline — determinism', () => {
  it('two identical calls produce bit-identical results', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const points: Vec3[] = [
      [5, 0, 0],
      [0, 5, 0],
      [-5, 0, 0],
    ];
    const a = fitSurfaceSpline(mesh, bvh, points, true, 3);
    const b = fitSurfaceSpline(mesh, bvh, points, true, 3);
    expect(b.spans.length).toBe(a.spans.length);
    for (let i = 0; i < a.spans.length; i++) {
      expect(b.spans[i]!.points).toEqual(a.spans[i]!.points);
      expect(b.spans[i]!.length).toBe(a.spans[i]!.length);
    }
    expect(b.maxAmbientDeviationMm).toBe(a.maxAmbientDeviationMm);
  });
});

// ---------------------------------------------------------------------------
// Property: NaN-free + on-surface for a spread of random-ish control point
// picks against a fixed mesh (fast-check, seeded).
// ---------------------------------------------------------------------------

describe('fitSurfaceSpline — property: NaN-free and on-surface', () => {
  it('random control point sets on an icosphere never produce NaN/Infinity and stay on-surface', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 7 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.boolean(),
        (count, seedOffset, closed) => {
          const points: Vec3[] = [];
          for (let i = 0; i < count; i++) {
            const theta = (2 * Math.PI * i) / count + seedOffset * 0.013;
            const phi = ((i * 37 + seedOffset) % 180) * (Math.PI / 180) - Math.PI / 2;
            points.push([5 * Math.cos(phi) * Math.cos(theta), 5 * Math.cos(phi) * Math.sin(theta), 5 * Math.sin(phi)]);
          }
          const spline = fitSurfaceSpline(mesh, bvh, points, closed, 2);
          for (const span of spline.spans) {
            for (const sp of span.points) {
              const p = evaluateSurfacePoint(mesh, sp);
              expect(Number.isFinite(p[0])).toBe(true);
              expect(Number.isFinite(p[1])).toBe(true);
              expect(Number.isFinite(p[2])).toBe(true);
              expect(closestPoint(mesh, bvh, p).distance).toBeLessThanOrEqual(MESH_WELD_EPSILON_MM);
            }
            expect(Number.isFinite(span.length)).toBe(true);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
