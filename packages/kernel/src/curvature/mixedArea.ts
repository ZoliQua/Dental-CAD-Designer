// packages/kernel/src/curvature/mixedArea.ts
//
// Meyer-et-al. mixed Voronoi area: the per-vertex "area of influence" the
// mean/Gaussian curvature estimators (curvature.ts) divide by. See Meyer,
// Desbrun, Schröder, Barr, "Discrete Differential-Geometry Operators for
// Triangulated 2-Manifolds" (2003), section 3.3 ("mixed area", their Figure
// 4) and section 3.6 ("Discrete Gaussian curvature").
//
// ## Per-triangle split (`triangleVoronoiAreas`)
//
// For a NON-OBTUSE triangle (a, b, c), the true (circumcenter-based) Voronoi
// region of each vertex INSIDE that triangle has a closed form in terms of
// cotangents — e.g. for vertex `a`:
//
//   area(a) = (1/8) * (|a-b|^2 * cot(angle at c) + |a-c|^2 * cot(angle at b))
//
// (edge (a,b) is opposite vertex c, so it pairs with cot(angle at c); edge
// (a,c) is opposite vertex b, so it pairs with cot(angle at b)) — and the
// symmetric formulas for b, c. These three areas always sum EXACTLY to the
// triangle's true area (a documented identity of the Voronoi construction —
// see mixedArea.test.ts's partition property test, and verify by hand for
// an equilateral triangle: every cotangent is `cot(60deg) = 1/sqrt(3)`,
// every edge length-squared is `s^2`, so each of the 3 areas comes out to
// `s^2 / (4*sqrt(3))` — exactly a third of the triangle's own
// `(sqrt(3)/4)*s^2` area).
//
// For an OBTUSE triangle, the true circumcenter-based Voronoi vertex lies
// OUTSIDE the triangle, so the formula above can (and does) produce a
// NEGATIVE area for the vertex facing the obtuse angle (equivalently: an
// angle's cotangent is negative exactly when that angle is obtuse, which is
// this function's obtuse TEST, not a separate angle computation). Meyer et
// al.'s standard fallback (their Figure 4, "Mixed" case) is used instead:
//
//   - the vertex AT the obtuse angle gets triangleArea / 2
//   - the other two vertices each get triangleArea / 4
//
// This still sums exactly to the triangle's area, and is always
// non-negative — this "T/2, T/4" scheme is THE classic bug source for a
// from-scratch mixed-area implementation (this task's brief) if the
// non-obtuse closed form above is applied uniformly without this branch.
import { cotangentAtVertex } from './cotan.ts';
import { cross, length, sub, vertexPosition } from './vec.ts';
import type { HalfedgeMesh } from '../halfedge/types.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

function distanceSquared(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Splits triangle (a, b, c)'s area into its Meyer-et-al. mixed-Voronoi
 * contribution to each of its 3 vertices — see this file's module doc.
 * Always returns a triple summing to the triangle's true area (within
 * Float64 rounding) and always non-negative per-entry; `[0, 0, 0]` for a
 * degenerate (zero-area) triangle.
 */
export function triangleVoronoiAreas(a: Vec3, b: Vec3, c: Vec3): [number, number, number] {
  const doubleArea = length(cross(sub(b, a), sub(c, a)));
  const triangleArea = doubleArea / 2;
  if (triangleArea === 0) return [0, 0, 0];

  // Interior-angle cotangents at each corner — also exactly the obtuse test
  // (an angle > 90deg has cot < 0), per this file's module doc.
  const cotA = cotangentAtVertex(a, b, c);
  const cotB = cotangentAtVertex(b, a, c);
  const cotC = cotangentAtVertex(c, a, b);

  if (cotA < 0) return [triangleArea / 2, triangleArea / 4, triangleArea / 4];
  if (cotB < 0) return [triangleArea / 4, triangleArea / 2, triangleArea / 4];
  if (cotC < 0) return [triangleArea / 4, triangleArea / 4, triangleArea / 2];

  const areaA = (distanceSquared(a, b) * cotC + distanceSquared(a, c) * cotB) / 8;
  const areaB = (distanceSquared(b, a) * cotC + distanceSquared(b, c) * cotA) / 8;
  const areaC = (distanceSquared(c, a) * cotB + distanceSquared(c, b) * cotA) / 8;
  return [areaA, areaB, areaC];
}

/**
 * Per-vertex mixed Voronoi area over the whole mesh — one pass over every
 * face, accumulating `triangleVoronoiAreas`' 3-way split into each of that
 * face's 3 vertices. Since every triangle's area is partitioned EXACTLY
 * (never double-counted, never dropped) across its own 3 vertices, `sum(
 * computeMixedVoronoiAreas(...))` always equals the mesh's total surface
 * area exactly (mixedArea.test.ts's area-partition property test) —
 * regardless of how many triangles are obtuse.
 */
export function computeMixedVoronoiAreas(hm: HalfedgeMesh, mesh: IndexedMesh): Float64Array {
  const areas = new Float64Array(hm.vertexCount);
  for (let f = 0; f < hm.faceCount; f++) {
    const ia = mesh.indices[f * 3]!;
    const ib = mesh.indices[f * 3 + 1]!;
    const ic = mesh.indices[f * 3 + 2]!;
    const a = vertexPosition(mesh.positions, ia);
    const b = vertexPosition(mesh.positions, ib);
    const c = vertexPosition(mesh.positions, ic);
    const [aa, ab, ac] = triangleVoronoiAreas(a, b, c);
    areas[ia]! += aa;
    areas[ib]! += ab;
    areas[ic]! += ac;
  }
  return areas;
}
