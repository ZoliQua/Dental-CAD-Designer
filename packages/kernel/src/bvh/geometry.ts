// packages/kernel/src/bvh/geometry.ts
//
// Pure, allocation-light Float64 primitives used by both the BVH build
// (per-triangle bounds/centroids) and traversal (closestPoint/raycast):
// exact point-triangle distance and ray-triangle intersection. No BVH
// knowledge here — these operate on three raw vertices at a time, and are
// exactly what closestPoint.ts/raycast.ts fall back to brute force to
// validate against in the property tests (bvh.property.test.ts).

export type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Point-triangle closest point (Ericson, "Real-Time Collision Detection",
// section 5.1.5: "Closest Point on Triangle to Point"). This is the standard
// Voronoi-region-walking algorithm: classify which of the triangle's 7
// Voronoi regions (3 vertices, 3 edges, 1 face) the query point falls into,
// then project accordingly. Chosen over a naive "closest point on each of
// the 3 edges + check if inside the face" approach because it's branch-exact
// (no epsilon comparisons needed for the region tests themselves — every
// comparison is an exact sign test on a dot product) and is the textbook
// reference implementation other engines' unit tests are checked against, so
// it is very unlikely to have a shipped bug.
// ---------------------------------------------------------------------------

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

export interface TriangleClosestPoint {
  point: Vec3;
  /** Barycentric weights (wa, wb, wc) for (a, b, c) respectively — each in
   * [0, 1], summing to 1. */
  barycentric: Vec3;
}

/**
 * Exact closest point on triangle (a, b, c) to point `p`, via Voronoi-region
 * classification (see module doc). Degenerate triangles (zero area) are
 * tolerated: the algorithm degrades gracefully to "closest point on the
 * longest edge / a vertex" — dropDegenerateTriangles (kernel/src/intake)
 * removes true degenerates from any mesh reaching a BVH, but this function
 * itself never assumes non-degeneracy (defense in depth: a caller building a
 * BVH directly over unwelded/raw data must not get NaNs).
 */
export function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): TriangleClosestPoint {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);

  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) {
    // Vertex region A.
    return { point: a, barycentric: [1, 0, 0] };
  }

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) {
    // Vertex region B.
    return { point: b, barycentric: [0, 1, 0] };
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    // Edge region AB.
    const v = d1 / (d1 - d3);
    return { point: addScaled(a, ab, v), barycentric: [1 - v, v, 0] };
  }

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) {
    // Vertex region C.
    return { point: c, barycentric: [0, 0, 1] };
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    // Edge region AC.
    const w = d2 / (d2 - d6);
    return { point: addScaled(a, ac, w), barycentric: [1 - w, 0, w] };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    // Edge region BC.
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { point: addScaled(b, sub(c, b), w), barycentric: [0, 1 - w, w] };
  }

  // Face region: p projects strictly inside the triangle.
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return { point: addScaled(addScaled(a, ab, v), ac, w), barycentric: [1 - v - w, v, w] };
}

export function distanceSquared(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

// ---------------------------------------------------------------------------
// Ray-triangle intersection (Möller-Trumbore, "Fast, Minimum Storage
// Ray-Triangle Intersection", 1997).
//
// ## Epsilon policy (documented per this task's brief)
//
// - `RAY_PARALLEL_EPSILON`: if the ray direction lies in the triangle's
//   plane (determinant ~0), the algorithm's barycentric solve would divide
//   by ~0 — rays within this tolerance of parallel are treated as a miss.
//   1e-12 is scaled for Float64 mm-magnitude geometry: the determinant here
//   has units of length^3 (a scalar triple product on ~1-100mm-scale edge
//   vectors and a unit ray direction), so 1e-12 is comfortably above Float64
//   rounding noise (~1e-16 relative) for any triangle above ~1e-4 mm in
//   size, while still rejecting genuinely near-parallel rays rather than
//   reporting a numerically unstable hit far outside the triangle.
// - `BARYCENTRIC_EPSILON`: the edge tests (u >= 0, v >= 0, u + v <= 1) are
//   relaxed by this tolerance (u >= -eps, etc.) — a ray that lands exactly
//   on an edge shared by two triangles must be reported as a hit by BOTH
//   adjacent triangles, not neither (a strict `>= 0` test can flip either
//   way per triangle due to floating-point rounding in the two triangles'
//   independent computations, opening a "crack" a ray can slip through on a
//   watertight mesh). This is the same goal as Woop et al.'s "Watertight
//   Ray/Triangle Intersection" (2013), achieved here by a simple symmetric
//   epsilon rather than their fixed-precision re-formulation — at Float64
//   (vs. their Float32 target), plain Möller-Trumbore with a small symmetric
//   edge tolerance does not exhibit the precision pathologies their paper is
//   solving for, so the extra machinery isn't needed. When both triangles at
//   a shared edge register a hit at (numerically) the same `t`, `raycast`'s
//   BVH-level nearest-hit selection deterministically keeps the
//   lower-triangle-index one (see raycast.ts).
// - Hits behind the ray origin (`t < 0`) are rejected; `t === 0` (origin
//   exactly on the surface) is accepted — there is no "self-intersection"
//   bias applied, since every caller here casts a single ray from outside
//   the mesh (camera picking) rather than recursively bouncing rays off the
//   same surface, so no positive `tMin` fudge is needed.
// ---------------------------------------------------------------------------

export const RAY_PARALLEL_EPSILON = 1e-12;
export const BARYCENTRIC_EPSILON = 1e-12;

export interface RayTriangleHit {
  /** Ray parameter `t` (distance, since `direction` must be a unit vector). */
  t: number;
  barycentric: Vec3;
}

/**
 * Möller-Trumbore ray-triangle intersection. `direction` MUST be a unit
 * vector (callers own normalization — raycast.ts's `raycast` normalizes
 * once per query rather than once per triangle test). Returns `null` for a
 * miss (parallel, behind the ray origin, or outside the triangle beyond
 * `BARYCENTRIC_EPSILON`).
 */
export function rayTriangleIntersect(
  origin: Vec3,
  direction: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): RayTriangleHit | null {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const pvec: Vec3 = [
    direction[1] * e2[2] - direction[2] * e2[1],
    direction[2] * e2[0] - direction[0] * e2[2],
    direction[0] * e2[1] - direction[1] * e2[0],
  ];
  const det = dot(e1, pvec);
  if (Math.abs(det) < RAY_PARALLEL_EPSILON) {
    return null;
  }
  const invDet = 1 / det;

  const tvec = sub(origin, a);
  const u = dot(tvec, pvec) * invDet;
  if (u < -BARYCENTRIC_EPSILON || u > 1 + BARYCENTRIC_EPSILON) {
    return null;
  }

  const qvec: Vec3 = [
    tvec[1] * e1[2] - tvec[2] * e1[1],
    tvec[2] * e1[0] - tvec[0] * e1[2],
    tvec[0] * e1[1] - tvec[1] * e1[0],
  ];
  const v = dot(direction, qvec) * invDet;
  if (v < -BARYCENTRIC_EPSILON || u + v > 1 + BARYCENTRIC_EPSILON) {
    return null;
  }

  const t = dot(e2, qvec) * invDet;
  if (t < 0) {
    return null;
  }
  const w = 1 - u - v;
  return { t, barycentric: [w, u, v] };
}

// ---------------------------------------------------------------------------
// Ray-AABB slab test (Kay & Kajiya), using IEEE754 divide-by-zero's signed
// infinities (1/0 = +Inf, -1/0 = -Inf) for an axis-aligned ray component —
// EXCEPT for the one case that trick doesn't cover: `direction[axis] === 0`
// AND `origin[axis]` sits EXACTLY on `boundsMin[axis]` or `boundsMax[axis]`.
// There, `(boundsMin[axis] - origin[axis]) * invDirection[axis]` is
// `0 * Infinity`, which is `NaN` in IEEE754 (not the intended +-Infinity) —
// every subsequent comparison against a NaN is false, which silently
// disables that axis's pruning instead of correctly resolving it. This is a
// known sharp edge of the naive slab-test formula (not a Kay/Kajiya
// oversight — their original formulation assumes this exact coincidence
// doesn't arise; a triangle-heavy mesh with an axis-aligned bbox edge and a
// ray aimed exactly along that edge from exactly on the boundary makes it
// arise routinely enough to need handling — caught here by
// bvh.property.test.ts's brute-force comparison). Handled explicitly below
// by branching on `direction[axis] === 0` first, per-axis, before ever
// computing with `invDirection`.
// ---------------------------------------------------------------------------

/** Returns the entry `t` (>= `tMinIn`) if the ray hits the AABB before
 * `tMaxIn`, else `null`. `invDirection` is `1 / direction` per axis
 * (precomputed once per ray by the caller — raycast.ts); `direction` itself
 * is also required (not derivable back from `invDirection` when it's an
 * infinity) to detect the exact-zero case documented above. */
export function rayAabbEntry(
  origin: Vec3,
  direction: Vec3,
  invDirection: Vec3,
  boundsMin: Vec3,
  boundsMax: Vec3,
  tMinIn: number,
  tMaxIn: number,
): number | null {
  let tMin = tMinIn;
  let tMax = tMaxIn;
  for (let axis = 0; axis < 3; axis++) {
    const o = origin[axis]!;
    const d = direction[axis]!;
    if (d === 0) {
      // Ray is parallel to this axis: it stays at `o` forever, so this axis
      // either fully admits the ray (o within the slab — no constraint on
      // t) or rules it out for every t.
      if (o < boundsMin[axis]! || o > boundsMax[axis]!) return null;
      continue;
    }
    const invD = invDirection[axis]!;
    let t1 = (boundsMin[axis]! - o) * invD;
    let t2 = (boundsMax[axis]! - o) * invD;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  return tMin;
}

/** Squared distance from a point to an AABB (0 if the point is inside/on the
 * box) — used by closestPoint.ts's branch-and-bound pruning. */
export function pointAabbDistanceSquared(p: Vec3, boundsMin: Vec3, boundsMax: Vec3): number {
  let sum = 0;
  for (let axis = 0; axis < 3; axis++) {
    const v = p[axis]!;
    const lo = boundsMin[axis]!;
    const hi = boundsMax[axis]!;
    const d = v < lo ? lo - v : v > hi ? v - hi : 0;
    sum += d * d;
  }
  return sum;
}
