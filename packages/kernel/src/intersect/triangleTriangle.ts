// packages/kernel/src/intersect/triangleTriangle.ts
//
// Robust Float64 triangle–triangle intersection predicate — the geometric
// primitive the whole-mesh self-intersection scan (selfIntersect.ts) runs on
// every candidate face pair the BVH broad phase surfaces. Pure TS, Float64
// throughout, no DOM/Three/WASM (kernel layer rule).
//
// ## Algorithm — Möller 1997, "A Fast Triangle-Triangle Intersection Test"
//
// The two triangles' closures intersect iff:
//   1. (non-coplanar case) Neither triangle lies strictly to one side of the
//      other's supporting plane, AND the two 1-D intervals the triangles cut
//      out of their planes' intersection line L overlap. Concretely: reject
//      early if all three signed distances of triangle A's vertices to B's
//      plane share one (non-zero) sign (A is strictly on one side of B), and
//      symmetrically for B vs A's plane; otherwise project both triangles
//      onto L and test the resulting intervals for overlap.
//   2. (coplanar case) Both triangles share one plane — reduce to a 2-D
//      triangle-overlap test in that plane (any edge–edge crossing, or either
//      triangle's vertex contained in the other).
//
// This is the textbook exact method (the reference `tri_tri_intersect` /
// `coplanar_tri_tri` decomposition), transcribed to Float64 tuples. It is
// exact for well-separated, non-degenerate Float64 inputs (every accept/reject
// is a sign test on an exactly-evaluated polynomial in the coordinates, modulo
// ordinary rounding); the ONLY tolerance is the coplanarity/on-plane snap
// documented as `@errorBound` on `triangleTriangleIntersect`.
//
// ## What "intersect" means here (and why adjacency is NOT excluded here)
//
// This predicate reports intersection of the two CLOSED triangles, boundary
// included: two triangles that merely share an edge or a vertex DO intersect
// by this definition (they touch along the shared feature). That is deliberate
// and correct — excluding topologically-adjacent faces (which meet at a shared
// vertex/edge by construction and are NOT self-intersections) is the SCAN's
// job (selfIntersect.ts excludes any pair sharing ≥1 vertex index), not the
// geometric predicate's. Keeping the predicate a pure closure-intersection
// test keeps it independently testable against closed-form analytic cases.
import type { IndexedMesh } from '../mesh/types.ts';
import { DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4 } from '../intake/degenerate.ts';

/** A point / vector in kernel mm world space (Float64). */
export type Vec3 = readonly [number, number, number];

/** A mutable 3-vector scratch tuple — assignable to the readonly `Vec3`, so
 * caller-owned scratch filled by `readTriangle` can be handed straight to the
 * predicate without an unsafe cast. */
export type MutableVec3 = [number, number, number];

/**
 * Coplanarity / on-plane snap tolerance, in **mm** (the normals are
 * normalized to unit length before the signed-distance computation, so a
 * vertex's signed distance to the other triangle's plane is a true
 * perpendicular distance in mm). A vertex whose |signed distance| is below
 * this is treated as lying exactly ON the plane; a triangle all three of
 * whose vertices are on the plane is handled by the coplanar 2-D path.
 *
 * 1e-9 mm (1 pm) is chosen for mm-scale dental geometry: it is ~4 orders of
 * magnitude above Float64 absolute resolution at ~100 mm coordinate
 * magnitudes (~1e-13 mm) — so it is not tripped by ordinary rounding — while
 * being 6 orders of magnitude below the 1 µm (1e-3 mm) clinical display
 * resolution, so it can never mask a clinically-meaningful gap or overlap.
 */
export const TRIANGLE_INTERSECTION_EPSILON = 1e-9;

/**
 * Thrown when a triangle handed to the predicate is degenerate (zero-area:
 * its edge cross-product norm² is below the kernel's shared
 * `DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4`). A degenerate triangle has no
 * well-defined supporting plane, so an intersection answer would be a silent
 * wrong result — this is surfaced as a typed hard case instead (CLAUDE.md:
 * "never a silent wrong answer"). Callers that scan whole meshes
 * (selfIntersect.ts) detect and skip degenerate triangles up front (counting
 * them) rather than triggering this; it exists so a DIRECT predicate call on
 * bad input fails loudly.
 */
export class DegenerateTriangleError extends Error {
  constructor(which: 'a' | 'b') {
    super(
      `triangleTriangleIntersect: triangle ${which} is degenerate (zero-area); no supporting plane`,
    );
    this.name = 'DegenerateTriangleError';
  }
}

function sub(p: Vec3, q: Vec3): [number, number, number] {
  return [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
}
function cross(u: Vec3, v: Vec3): [number, number, number] {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
function dot(u: Vec3, v: Vec3): number {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}

/** Snap a signed distance to exactly 0 when within the on-plane tolerance. */
function snap(d: number): number {
  return Math.abs(d) < TRIANGLE_INTERSECTION_EPSILON ? 0 : d;
}

type Interval = readonly [number, number];

/**
 * The line-segment (projected onto the intersection-line axis) that triangle
 * (proj0, proj1, proj2) — with signed plane-distances d0,d1,d2 — cuts out of
 * the intersection line, OR the sentinel `'coplanar'` when the triangle lies
 * in the other triangle's plane (all distances 0). Faithful transcription of
 * Möller's COMPUTE_INTERVALS macro: it interpolates the two crossing points
 * along the two edges that straddle the plane, dispatching on which single
 * vertex is the "odd one out" (on its own side of the plane).
 */
function computeInterval(
  p0: number,
  p1: number,
  p2: number,
  d0: number,
  d1: number,
  d2: number,
): Interval | 'coplanar' {
  const d0d1 = d0 * d1;
  const d0d2 = d0 * d2;
  // isect(vv0, vv1, vv2, dd0, dd1, dd2): crossing points of edges (vv0->vv1)
  // and (vv0->vv2), where vv0 is the odd-one-out vertex.
  const isect = (
    vv0: number,
    vv1: number,
    vv2: number,
    dd0: number,
    dd1: number,
    dd2: number,
  ): Interval => {
    const a = vv0 + (vv1 - vv0) * (dd0 / (dd0 - dd1));
    const b = vv0 + (vv2 - vv0) * (dd0 / (dd0 - dd2));
    return a <= b ? [a, b] : [b, a];
  };
  if (d0d1 > 0) {
    // d0, d1 same side ⇒ d2 is the odd one out.
    return isect(p2, p0, p1, d2, d0, d1);
  }
  if (d0d2 > 0) {
    // d0, d2 same side ⇒ d1 is the odd one out.
    return isect(p1, p0, p2, d1, d0, d2);
  }
  if (d1 * d2 > 0 || d0 !== 0) {
    // d1, d2 same side (⇒ d0 odd), or d0 is off-plane and the only nonzero.
    return isect(p0, p1, p2, d0, d1, d2);
  }
  if (d1 !== 0) {
    return isect(p1, p0, p2, d1, d0, d2);
  }
  if (d2 !== 0) {
    return isect(p2, p0, p1, d2, d0, d1);
  }
  // All three distances are 0 ⇒ the triangle is coplanar with the other.
  return 'coplanar';
}

function intervalsOverlap(a: Interval, b: Interval): boolean {
  // Closed intervals overlap iff neither lies strictly beyond the other.
  return !(a[1] < b[0] || b[1] < a[0]);
}

// ---------------------------------------------------------------------------
// Coplanar case: 2-D triangle-overlap test in the shared plane (Möller's
// `coplanar_tri_tri`). Project away the axis of the largest normal component
// (keeps the projection non-degenerate), then: (a) if any edge of A crosses
// any edge of B, they overlap; (b) else if one triangle is entirely inside the
// other, they overlap; (c) else disjoint.
// ---------------------------------------------------------------------------

/** Sign of the 2-D cross product (edge x·y minus y·x) — orientation test. */
function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Do closed 2-D segments (a0,a1) and (b0,b1) intersect? Includes collinear
 * overlap (the shared-edge/touching case) — the predicate reports closed-set
 * intersection. */
function segmentsIntersect2d(
  a0: readonly [number, number],
  a1: readonly [number, number],
  b0: readonly [number, number],
  b1: readonly [number, number],
): boolean {
  const d1 = orient2d(b0[0], b0[1], b1[0], b1[1], a0[0], a0[1]);
  const d2 = orient2d(b0[0], b0[1], b1[0], b1[1], a1[0], a1[1]);
  const d3 = orient2d(a0[0], a0[1], a1[0], a1[1], b0[0], b0[1]);
  const d4 = orient2d(a0[0], a0[1], a1[0], a1[1], b1[0], b1[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  const onSeg = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean =>
    Math.min(px, qx) <= rx &&
    rx <= Math.max(px, qx) &&
    Math.min(py, qy) <= ry &&
    ry <= Math.max(py, qy);
  if (d1 === 0 && onSeg(b0[0], b0[1], b1[0], b1[1], a0[0], a0[1])) return true;
  if (d2 === 0 && onSeg(b0[0], b0[1], b1[0], b1[1], a1[0], a1[1])) return true;
  if (d3 === 0 && onSeg(a0[0], a0[1], a1[0], a1[1], b0[0], b0[1])) return true;
  if (d4 === 0 && onSeg(a0[0], a0[1], a1[0], a1[1], b1[0], b1[1])) return true;
  return false;
}

/** Is point p inside (or on) the 2-D triangle (t0,t1,t2)? Robust to either
 * winding (uses the sign of the triangle's own area). */
function pointInTriangle2d(
  p: readonly [number, number],
  t0: readonly [number, number],
  t1: readonly [number, number],
  t2: readonly [number, number],
): boolean {
  const s0 = orient2d(t0[0], t0[1], t1[0], t1[1], p[0], p[1]);
  const s1 = orient2d(t1[0], t1[1], t2[0], t2[1], p[0], p[1]);
  const s2 = orient2d(t2[0], t2[1], t0[0], t0[1], p[0], p[1]);
  const hasNeg = s0 < 0 || s1 < 0 || s2 < 0;
  const hasPos = s0 > 0 || s1 > 0 || s2 > 0;
  // Inside (or on an edge) iff not straddling both strict signs.
  return !(hasNeg && hasPos);
}

function coplanarIntersect(
  n: Vec3,
  a0: Vec3,
  a1: Vec3,
  a2: Vec3,
  b0: Vec3,
  b1: Vec3,
  b2: Vec3,
): boolean {
  // Drop the axis of the largest |normal| component to project onto the 2-D
  // plane where the triangles are non-degenerate.
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  let i0: number;
  let i1: number;
  if (ax >= ay && ax >= az) {
    i0 = 1;
    i1 = 2;
  } else if (ay >= az) {
    i0 = 0;
    i1 = 2;
  } else {
    i0 = 0;
    i1 = 1;
  }
  const p = (v: Vec3): [number, number] => [v[i0]!, v[i1]!];
  const A: readonly [number, number][] = [p(a0), p(a1), p(a2)];
  const B: readonly [number, number][] = [p(b0), p(b1), p(b2)];
  // (a) any edge–edge crossing.
  for (let i = 0; i < 3; i++) {
    const ai0 = A[i]!;
    const ai1 = A[(i + 1) % 3]!;
    for (let j = 0; j < 3; j++) {
      if (segmentsIntersect2d(ai0, ai1, B[j]!, B[(j + 1) % 3]!)) return true;
    }
  }
  // (b) full containment either way (no edge crossing ⇒ one inside the other,
  // or disjoint). Testing a single vertex of each suffices given no crossings.
  if (pointInTriangle2d(A[0]!, B[0]!, B[1]!, B[2]!)) return true;
  if (pointInTriangle2d(B[0]!, A[0]!, A[1]!, A[2]!)) return true;
  return false;
}

/**
 * Returns whether the two CLOSED triangles (a0,a1,a2) and (b0,b1,b2) intersect
 * geometrically (share ≥1 point), handling the coplanar case. Boundary touches
 * (shared edge/vertex, edge-on-face contact) count as intersection — excluding
 * topologically-adjacent pairs is the caller's responsibility (see the module
 * doc / selfIntersect.ts).
 *
 * @errorBound Exact for non-degenerate, non-coplanar Float64 inputs (every
 * accept/reject is an exactly-evaluated sign test, modulo ordinary Float64
 * rounding). Near-coplanar and on-plane configurations are resolved with a
 * single snap tolerance of `TRIANGLE_INTERSECTION_EPSILON` = 1e-9 mm: a vertex
 * within 1 pm of the other triangle's plane is treated as lying on it. Two
 * triangles separated by, or overlapping by, less than this are indistinguish-
 * able from touching — 6 orders of magnitude below the 1 µm clinical
 * resolution, so clinically irrelevant. Exact single-point/edge touches sit
 * precisely ON the decision boundary: the interval-overlap comparison is a
 * strict Float64 test, so an exact tangency can resolve either way within
 * ordinary rounding (verified by differential testing against an independent
 * exact-arithmetic reference: every disagreement was an exact single-point
 * touch, zero genuine positive-overlap misses) — and a tangency is not an
 * interpenetration, so either resolution is correct for this gate's purpose.
 * Degenerate (zero-area) input throws `DegenerateTriangleError` rather than
 * guessing.
 */
export function triangleTriangleIntersect(
  a0: Vec3,
  a1: Vec3,
  a2: Vec3,
  b0: Vec3,
  b1: Vec3,
  b2: Vec3,
): boolean {
  // Degeneracy of BOTH triangles is checked UP FRONT, before any early-reject,
  // so the answer is symmetric under argument swap: if either triangle is
  // zero-area the predicate always throws (never returns for one ordering and
  // throws for the other). Triangle A is checked first, so a degenerate A
  // throws 'a'.
  const ae1 = sub(a1, a0);
  const ae2 = sub(a2, a0);
  const n1raw = cross(ae1, ae2);
  const n1sq = n1raw[0] * n1raw[0] + n1raw[1] * n1raw[1] + n1raw[2] * n1raw[2];
  if (n1sq < DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4) throw new DegenerateTriangleError('a');

  const be1 = sub(b1, b0);
  const be2 = sub(b2, b0);
  const n2raw = cross(be1, be2);
  const n2sq = n2raw[0] * n2raw[0] + n2raw[1] * n2raw[1] + n2raw[2] * n2raw[2];
  if (n2sq < DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4) throw new DegenerateTriangleError('b');

  // Plane of triangle B: unit normal n2, so signed distances are true mm.
  const n2len = Math.sqrt(n2sq);
  const n2: Vec3 = [n2raw[0] / n2len, n2raw[1] / n2len, n2raw[2] / n2len];
  const d2 = -dot(n2, b0);

  // Signed distances of A's vertices to B's plane; early reject if all one side.
  const dva0 = snap(dot(n2, a0) + d2);
  const dva1 = snap(dot(n2, a1) + d2);
  const dva2 = snap(dot(n2, a2) + d2);
  if (dva0 * dva1 > 0 && dva0 * dva2 > 0) return false;

  // Plane of triangle A.
  const n1len = Math.sqrt(n1sq);
  const n1: Vec3 = [n1raw[0] / n1len, n1raw[1] / n1len, n1raw[2] / n1len];
  const d1 = -dot(n1, a0);

  const dvb0 = snap(dot(n1, b0) + d1);
  const dvb1 = snap(dot(n1, b1) + d1);
  const dvb2 = snap(dot(n1, b2) + d1);
  if (dvb0 * dvb1 > 0 && dvb0 * dvb2 > 0) return false;

  // Direction of the intersection line L = n1 × n2; project onto its largest
  // component axis (a proxy for the true parameter along L — Möller's trick;
  // the projection is monotone along L so interval overlap is preserved).
  const ld = cross(n1, n2);
  const la0 = Math.abs(ld[0]);
  const la1 = Math.abs(ld[1]);
  const la2 = Math.abs(ld[2]);
  let axis = 0;
  if (la1 > la0 && la1 >= la2) axis = 1;
  else if (la2 > la0 && la2 > la1) axis = 2;

  const intervalA = computeInterval(a0[axis]!, a1[axis]!, a2[axis]!, dva0, dva1, dva2);
  if (intervalA === 'coplanar') {
    return coplanarIntersect(n1, a0, a1, a2, b0, b1, b2);
  }
  const intervalB = computeInterval(b0[axis]!, b1[axis]!, b2[axis]!, dvb0, dvb1, dvb2);
  if (intervalB === 'coplanar') {
    return coplanarIntersect(n1, a0, a1, a2, b0, b1, b2);
  }
  return intervalsOverlap(intervalA, intervalB);
}

/**
 * Reads triangle `t`'s three vertices out of an `IndexedMesh` into a caller-
 * supplied 3-tuple of mutable 3-vectors (reused across calls to keep the
 * self-intersection scan allocation-free). `out[k]` is filled with vertex k's
 * (x,y,z). Returns `out` typed as three `Vec3` for direct predicate use (a
 * `MutableVec3` IS a `Vec3` — no cast).
 */
export function readTriangle(
  mesh: IndexedMesh,
  t: number,
  out: readonly [MutableVec3, MutableVec3, MutableVec3],
): readonly [Vec3, Vec3, Vec3] {
  const base = t * 3;
  const { indices, positions } = mesh;
  for (let k = 0; k < 3; k++) {
    const vi = indices[base + k]! * 3;
    const dst = out[k]!;
    dst[0] = positions[vi]!;
    dst[1] = positions[vi + 1]!;
    dst[2] = positions[vi + 2]!;
  }
  return out;
}
