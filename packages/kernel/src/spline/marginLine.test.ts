// packages/kernel/src/spline/marginLine.test.ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { evaluateSurfacePoint } from '../geodesic/surfacePoint.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { fitSurfaceSpline } from './surfaceSpline.ts';
import { fromMarginLine, toMarginLine, type MarginLineLike } from './marginLine.ts';

// Structural-compatibility check against the REAL shared-types `MarginLine`
// — this module's top doc claims `MarginLineLike` is a structural twin;
// this is what actually verifies it (a compile-time-only check: if the two
// shapes ever drift apart, `expectTypeOf` fails typecheck here, not at some
// unrelated call site). Only a TYPE import — no runtime dependency on
// `@dqcad/shared-types` (see marginLine.ts's doc for why kernel doesn't
// take that as a real package dependency).
import type { MarginLine } from '@dqcad/shared-types';

describe('MarginLineLike — structural compatibility with @dqcad/shared-types MarginLine', () => {
  it('a MarginLine value is assignable to MarginLineLike and vice versa (compile-time)', () => {
    expectTypeOf<MarginLine>().toMatchTypeOf<MarginLineLike>();
    expectTypeOf<MarginLineLike>().toMatchTypeOf<MarginLine>();
  });
});

describe('toMarginLine', () => {
  it('carries controlPoints through at exact float precision and closed flag unchanged', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const points: Vec3[] = [
      [5, 0, 0],
      [0, 5, 0],
      [-5, 0, 0],
    ];
    const spline = fitSurfaceSpline(mesh, bvh, points, true, 2);
    const marginLine = toMarginLine(mesh, spline.controlPoints, spline.closed);

    expect(marginLine.closed).toBe(true);
    expect(marginLine.controlPoints.length).toBe(spline.controlPoints.length);
    expect(marginLine.vertexAnchors.length).toBe(spline.controlPoints.length);
    for (let i = 0; i < spline.controlPoints.length; i++) {
      const expected = evaluateSurfacePoint(mesh, spline.controlPoints[i]!);
      expect(marginLine.controlPoints[i]).toEqual(expected);
      expect(Number.isInteger(marginLine.vertexAnchors[i])).toBe(true);
      expect(marginLine.vertexAnchors[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('vertexAnchors picks the nearest of the containing triangle\'s 3 vertices (documented lossy heuristic)', () => {
    const mesh = icosphereMesh(5, 2);
    const bvh = buildBvh(mesh);
    // A control point placed EXACTLY at a mesh vertex should report THAT
    // vertex as its nearest — the least ambiguous case to directly verify.
    const vertexPosition: Vec3 = [mesh.positions[0]!, mesh.positions[1]!, mesh.positions[2]!];
    const spline = fitSurfaceSpline(
      mesh,
      bvh,
      [vertexPosition, [0, 0, 5], [0, -5, 0]],
      true,
      2,
    );
    const marginLine = toMarginLine(mesh, spline.controlPoints, spline.closed);
    expect(marginLine.vertexAnchors[0]).toBe(0);
  });
});

describe('fromMarginLine', () => {
  it('round-trips control points onto the surface (re-projected, ignoring vertexAnchors)', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const points: Vec3[] = [
      [5, 0, 0],
      [0, 5, 0],
      [-5, 0, 0],
      [0, -5, 0],
    ];
    const spline = fitSurfaceSpline(mesh, bvh, points, true, 2);
    const marginLine = toMarginLine(mesh, spline.controlPoints, spline.closed);

    // Corrupt vertexAnchors to prove it's ignored on the way back in (per
    // this module's "silent data mutation" doc) — if fromMarginLine used
    // it, this would produce wildly different (wrong) positions.
    const corrupted: MarginLineLike = { ...marginLine, vertexAnchors: marginLine.vertexAnchors.map(() => 0) };

    const reconstructed = fromMarginLine(mesh, bvh, corrupted);
    expect(reconstructed.closed).toBe(true);
    expect(reconstructed.controlPoints.length).toBe(marginLine.controlPoints.length);
    for (let i = 0; i < reconstructed.controlPoints.length; i++) {
      const p = evaluateSurfacePoint(mesh, reconstructed.controlPoints[i]!);
      const expected = marginLine.controlPoints[i]!;
      expect(p[0]).toBeCloseTo(expected[0], 9);
      expect(p[1]).toBeCloseTo(expected[1], 9);
      expect(p[2]).toBeCloseTo(expected[2], 9);
    }
  });

  it('throws RangeError for an empty controlPoints array', () => {
    const mesh = icosphereMesh(5, 2);
    const bvh = buildBvh(mesh);
    expect(() => fromMarginLine(mesh, bvh, { vertexAnchors: [], controlPoints: [], closed: false })).toThrow(RangeError);
  });

  it('fitSurfaceSpline accepts fromMarginLine\'s output directly (round-trip through the full spline API)', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const points: Vec3[] = [
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
    ];
    const original = fitSurfaceSpline(mesh, bvh, points, false, 2);
    const marginLine = toMarginLine(mesh, original.controlPoints, original.closed);
    const reconstructed = fromMarginLine(mesh, bvh, marginLine);
    const refitted = fitSurfaceSpline(mesh, bvh, reconstructed.controlPoints.map((sp) => evaluateSurfacePoint(mesh, sp)), reconstructed.closed, 2);
    expect(refitted.spans.length).toBe(original.spans.length);
    expect(refitted.converged).toBe(true);
  });
});
