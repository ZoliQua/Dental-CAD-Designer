// packages/kernel/src/intersect/triangleTriangle.test.ts
//
// ANALYTIC (closed-form) tests for the Möller tri-tri predicate — every case
// has a hand-verifiable geometric answer, no fixtures. Covers: genuine
// crossing → intersect; well-separated → not; shared edge/vertex → touch
// (intersect, boundary included — adjacency exclusion is the scan's job, see
// selfIntersect.test.ts); coplanar overlap vs coplanar disjoint; and the
// degenerate (zero-area) triangle typed hard case.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  triangleTriangleIntersect,
  DegenerateTriangleError,
  type Vec3,
} from './triangleTriangle.ts';

describe('triangleTriangleIntersect — non-coplanar cases', () => {
  it('reports two triangles whose interiors genuinely pass through each other', () => {
    // Triangle A in the z=0 plane; triangle B standing vertically (x=0.25
    // plane) with vertices below and above z=0, so it pierces A's interior.
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [2, 0, 0];
    const a2: Vec3 = [0, 2, 0];
    const b0: Vec3 = [0.25, 0.25, -1];
    const b1: Vec3 = [0.25, 0.25, 1];
    const b2: Vec3 = [1.25, 0.25, 0];
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(true);
  });

  it('does NOT report two well-separated parallel triangles', () => {
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [1, 0, 0];
    const a2: Vec3 = [0, 1, 0];
    const b0: Vec3 = [0, 0, 5];
    const b1: Vec3 = [1, 0, 5];
    const b2: Vec3 = [0, 1, 5];
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(false);
  });

  it('does NOT report a triangle that dips toward but stops short of the other plane', () => {
    // B straddles nothing: both its off-plane vertices are ABOVE z=0.
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [2, 0, 0];
    const a2: Vec3 = [0, 2, 0];
    const b0: Vec3 = [0.25, 0.25, 0.001];
    const b1: Vec3 = [0.25, 0.25, 1];
    const b2: Vec3 = [1.25, 0.25, 0.5];
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(false);
  });

  it('does NOT report a triangle that crosses the plane but MISSES the other triangle (interval disjoint)', () => {
    // B pierces z=0 far away in +x, outside triangle A (which lives near origin).
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [1, 0, 0];
    const a2: Vec3 = [0, 1, 0];
    const b0: Vec3 = [5, 0.25, -1];
    const b1: Vec3 = [5, 0.25, 1];
    const b2: Vec3 = [6, 0.25, 0];
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(false);
  });
});

describe('triangleTriangleIntersect — shared feature (boundary touch)', () => {
  it('reports two non-coplanar triangles sharing an edge as touching (intersect)', () => {
    // A in z=0, B folded up along the shared edge (a0,a1).
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [1, 0, 0];
    const a2: Vec3 = [0, 1, 0];
    const b0: Vec3 = [0, 0, 0];
    const b1: Vec3 = [1, 0, 0];
    const b2: Vec3 = [0, 0, 1];
    // Boundary contact along the shared edge — the predicate reports the
    // touch; the SCAN excludes such adjacent pairs (selfIntersect.test.ts).
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(true);
  });

  it('reports two triangles sharing a single vertex as touching (intersect)', () => {
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [1, 0, 0];
    const a2: Vec3 = [0, 1, 0];
    const b0: Vec3 = [0, 0, 0];
    const b1: Vec3 = [-1, 0, 1];
    const b2: Vec3 = [0, -1, 1];
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(true);
  });
});

describe('triangleTriangleIntersect — coplanar cases', () => {
  it('reports two coplanar OVERLAPPING triangles (interiors overlap)', () => {
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [2, 0, 0];
    const a2: Vec3 = [0, 2, 0];
    // Shifted so their interiors overlap around (0.5, 0.5).
    const b0: Vec3 = [0.5, 0.5, 0];
    const b1: Vec3 = [2.5, 0.5, 0];
    const b2: Vec3 = [0.5, 2.5, 0];
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(true);
  });

  it('reports one coplanar triangle fully CONTAINED in the other', () => {
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [10, 0, 0];
    const a2: Vec3 = [0, 10, 0];
    const b0: Vec3 = [1, 1, 0];
    const b1: Vec3 = [2, 1, 0];
    const b2: Vec3 = [1, 2, 0];
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(true);
  });

  it('does NOT report two coplanar DISJOINT triangles', () => {
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [1, 0, 0];
    const a2: Vec3 = [0, 1, 0];
    const b0: Vec3 = [5, 5, 0];
    const b1: Vec3 = [6, 5, 0];
    const b2: Vec3 = [5, 6, 0];
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(false);
  });

  it('handles coplanar triangles in a NON-axis-aligned plane (projection axis choice)', () => {
    // Both triangles in the plane x + y + z = 0.
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [1, -1, 0];
    const a2: Vec3 = [1, 0, -1];
    const b0: Vec3 = [0.4, -0.2, -0.2];
    const b1: Vec3 = [1.4, -1.2, -0.2];
    const b2: Vec3 = [1.4, -0.2, -1.2];
    expect(triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toBe(true);
  });
});

describe('triangleTriangleIntersect — degenerate input (typed hard case)', () => {
  it('throws DegenerateTriangleError when triangle A is zero-area (collinear)', () => {
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [1, 0, 0];
    const a2: Vec3 = [2, 0, 0]; // collinear ⇒ zero area
    const b0: Vec3 = [0, 0, -1];
    const b1: Vec3 = [0, 0, 1];
    const b2: Vec3 = [1, 0, 0];
    expect(() => triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toThrow(
      DegenerateTriangleError,
    );
  });

  it('throws DegenerateTriangleError when triangle B is zero-area (identifies b)', () => {
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [1, 0, 0];
    const a2: Vec3 = [0, 1, 0];
    const b0: Vec3 = [0, 0, 0];
    const b1: Vec3 = [0, 0, 0];
    const b2: Vec3 = [0, 0, 0]; // a point ⇒ zero area
    expect(() => triangleTriangleIntersect(a0, a1, a2, b0, b1, b2)).toThrow(/triangle b/);
  });
});

describe('triangleTriangleIntersect — symmetry (property)', () => {
  it('is symmetric in its arguments for random non-degenerate triangle pairs', () => {
    const coord = (): fc.Arbitrary<number> => fc.integer({ min: -4, max: 4 });
    const vertex = (): fc.Arbitrary<Vec3> =>
      fc.tuple(coord(), coord(), coord()) as fc.Arbitrary<Vec3>;
    fc.assert(
      fc.property(
        vertex(),
        vertex(),
        vertex(),
        vertex(),
        vertex(),
        vertex(),
        (a0, a1, a2, b0, b1, b2) => {
          // Skip pairs where either triangle is degenerate (predicate throws).
          let forward: boolean;
          try {
            forward = triangleTriangleIntersect(a0, a1, a2, b0, b1, b2);
          } catch (e) {
            if (e instanceof DegenerateTriangleError) return true;
            throw e;
          }
          const backward = triangleTriangleIntersect(b0, b1, b2, a0, a1, a2);
          expect(backward).toBe(forward);
          return true;
        },
      ),
      { numRuns: 400 },
    );
  });
});
