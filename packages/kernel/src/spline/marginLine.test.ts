// packages/kernel/src/spline/marginLine.test.ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { evaluateSurfacePoint } from '../geodesic/surfacePoint.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { fitSurfaceSpline } from './surfaceSpline.ts';
import { fromMarginLine, toMarginLine, MarginAnchorMismatchError, type MarginLineLike } from './marginLine.ts';

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
  it('carries position, triangleIndex, and barycentric through LOSSLESSLY (Phase 3 Task 1: no more nearest-vertex heuristic)', () => {
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
    expect(marginLine.anchors.length).toBe(spline.controlPoints.length);
    for (let i = 0; i < spline.controlPoints.length; i++) {
      const sp = spline.controlPoints[i]!;
      const anchor = marginLine.anchors[i]!;
      const expected = evaluateSurfacePoint(mesh, sp);
      expect(anchor.position).toEqual(expected);
      // Exact round-trip, not a heuristic approximation — the whole point
      // of this task's type evolution.
      expect(anchor.triangleIndex).toBe(sp.triangleIndex);
      expect(anchor.barycentric).toEqual(sp.barycentric);
    }
  });

  it('resampledPoints is carried through only when provided (optional field)', () => {
    const mesh = icosphereMesh(5, 2);
    const bvh = buildBvh(mesh);
    const spline = fitSurfaceSpline(mesh, bvh, [[5, 0, 0], [0, 5, 0], [0, 0, 5]], true, 2);

    const withoutResample = toMarginLine(mesh, spline.controlPoints, spline.closed);
    expect(withoutResample.resampledPoints).toBeUndefined();

    const resampled: readonly Vec3[] = [[1, 2, 3], [4, 5, 6]];
    const withResample = toMarginLine(mesh, spline.controlPoints, spline.closed, resampled);
    expect(withResample.resampledPoints).toEqual(resampled);
  });
});

describe('fromMarginLine', () => {
  it('reconstructs the EXACT SAME SurfacePoints from anchors — no mesh/Bvh parameter needed, pure and lossless', () => {
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

    const reconstructed = fromMarginLine(marginLine);
    expect(reconstructed.closed).toBe(true);
    expect(reconstructed.controlPoints.length).toBe(spline.controlPoints.length);
    for (let i = 0; i < reconstructed.controlPoints.length; i++) {
      expect(reconstructed.controlPoints[i]!.triangleIndex).toBe(spline.controlPoints[i]!.triangleIndex);
      expect(reconstructed.controlPoints[i]!.barycentric).toEqual(spline.controlPoints[i]!.barycentric);
    }
  });

  it('ignores `position` on the way back in (triangleIndex/barycentric are authoritative)', () => {
    const mesh = icosphereMesh(5, 2);
    const bvh = buildBvh(mesh);
    const spline = fitSurfaceSpline(mesh, bvh, [[5, 0, 0], [0, 5, 0], [0, -5, 0]], true, 2);
    const marginLine = toMarginLine(mesh, spline.controlPoints, spline.closed);

    // Corrupt `position` to prove it's ignored on the way back in — if
    // fromMarginLine trusted it, this would silently produce a DIFFERENT
    // SurfacePoint than the one anchors' triangleIndex/barycentric encode.
    const corrupted: MarginLineLike = {
      ...marginLine,
      anchors: marginLine.anchors.map((a) => ({ ...a, position: [999, 999, 999] })),
    };

    const reconstructed = fromMarginLine(corrupted);
    for (let i = 0; i < reconstructed.controlPoints.length; i++) {
      expect(reconstructed.controlPoints[i]!.triangleIndex).toBe(spline.controlPoints[i]!.triangleIndex);
      expect(reconstructed.controlPoints[i]!.barycentric).toEqual(spline.controlPoints[i]!.barycentric);
    }
  });

  it('throws RangeError for an empty anchors array', () => {
    expect(() => fromMarginLine({ anchors: [], closed: false })).toThrow(RangeError);
  });

  describe('fix batch (Task-11-final-review Important 9): optional `mesh` validation', () => {
    it('with no `mesh` argument, an out-of-range triangleIndex is NOT caught (unchanged pre-fix behavior)', () => {
      const mesh = icosphereMesh(5, 2);
      const bvh = buildBvh(mesh);
      const spline = fitSurfaceSpline(mesh, bvh, [[5, 0, 0], [0, 5, 0], [0, -5, 0]], true, 2);
      const marginLine = toMarginLine(mesh, spline.controlPoints, spline.closed);
      const corrupted: MarginLineLike = {
        ...marginLine,
        anchors: marginLine.anchors.map((a, i) => (i === 0 ? { ...a, triangleIndex: 999_999 } : a)),
      };
      // No throw — this is the documented, still-supported "no mesh in hand"
      // pure path; the caller gets back whatever the (bogus) triangleIndex
      // says, same as before this fix batch.
      const reconstructed = fromMarginLine(corrupted);
      expect(reconstructed.controlPoints[0]!.triangleIndex).toBe(999_999);
    });

    it('with `mesh` supplied, an out-of-range triangleIndex throws MarginAnchorMismatchError(outOfRange) instead of silently reconstructing a NaN point', () => {
      const mesh = icosphereMesh(5, 2);
      const bvh = buildBvh(mesh);
      const spline = fitSurfaceSpline(mesh, bvh, [[5, 0, 0], [0, 5, 0], [0, -5, 0]], true, 2);
      const marginLine = toMarginLine(mesh, spline.controlPoints, spline.closed);
      const corrupted: MarginLineLike = {
        ...marginLine,
        anchors: marginLine.anchors.map((a, i) => (i === 1 ? { ...a, triangleIndex: 999_999 } : a)),
      };
      let caught: unknown;
      try {
        fromMarginLine(corrupted, mesh);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MarginAnchorMismatchError);
      expect((caught as MarginAnchorMismatchError).kind).toBe('outOfRange');
      expect((caught as MarginAnchorMismatchError).index).toBe(1);

      // Confirms the bug this closes: WITHOUT the bounds check, evaluating
      // an out-of-range triangleIndex silently yields NaN rather than
      // throwing — `mesh` present now catches it before that ever happens.
      const rawEval = evaluateSurfacePoint(mesh, { triangleIndex: 999_999, barycentric: [1, 0, 0] });
      expect(rawEval.some((c) => Number.isNaN(c))).toBe(true);
    });

    it('with `mesh` supplied, a corrupted barycentric (valid triangleIndex, wrong position) throws MarginAnchorMismatchError(positionMismatch)', () => {
      const mesh = icosphereMesh(5, 2);
      const bvh = buildBvh(mesh);
      const spline = fitSurfaceSpline(mesh, bvh, [[5, 0, 0], [0, 5, 0], [0, -5, 0]], true, 2);
      const marginLine = toMarginLine(mesh, spline.controlPoints, spline.closed);
      // Same triangleIndex (valid), but barycentric weights shifted to a
      // DIFFERENT point on the same triangle — position echo is left
      // exactly as `toMarginLine` produced it, i.e. now stale/wrong.
      const corrupted: MarginLineLike = {
        ...marginLine,
        anchors: marginLine.anchors.map((a, i) => (i === 2 ? { ...a, barycentric: [0.1, 0.1, 0.8] } : a)),
      };
      let caught: unknown;
      try {
        fromMarginLine(corrupted, mesh);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MarginAnchorMismatchError);
      expect((caught as MarginAnchorMismatchError).kind).toBe('positionMismatch');
      expect((caught as MarginAnchorMismatchError).index).toBe(2);
    });

    it('with `mesh` supplied, a genuinely clean MarginLine (produced by toMarginLine) validates without throwing', () => {
      const mesh = icosphereMesh(5, 3);
      const bvh = buildBvh(mesh);
      const spline = fitSurfaceSpline(mesh, bvh, [[5, 0, 0], [0, 5, 0], [-5, 0, 0], [0, -5, 0]], true, 2);
      const marginLine = toMarginLine(mesh, spline.controlPoints, spline.closed);
      expect(() => fromMarginLine(marginLine, mesh)).not.toThrow();
    });
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
    const reconstructed = fromMarginLine(marginLine);
    const refitted = fitSurfaceSpline(
      mesh,
      bvh,
      reconstructed.controlPoints.map((sp) => evaluateSurfacePoint(mesh, sp)),
      reconstructed.closed,
      2,
    );
    expect(refitted.spans.length).toBe(original.spans.length);
    expect(refitted.converged).toBe(true);
  });
});
