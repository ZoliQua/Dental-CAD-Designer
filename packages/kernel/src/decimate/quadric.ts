// packages/kernel/src/decimate/quadric.ts
//
// Garland-Heckbert quadric error metric (QEM) — the fundamental error
// quadric `Kp = p p^T` for a plane `p = (a, b, c, d)` (unit normal,
// `a*x+b*y+c*z+d = 0`), summed per vertex over its incident triangles'
// supporting planes (Garland & Heckbert, "Surface Simplification Using
// Quadric Error Metrics", SIGGRAPH 1997). No per-triangle area weighting —
// this module follows the original paper's UNWEIGHTED vertex quadric (a
// deliberate simplification per this task's YAGNI guardrail: area-weighted /
// vertex-attribute-preserving quadrics are a well-known refinement this
// render-only LOD tool does not need).
//
// Stored as the 10 independent entries of the symmetric 4x4 matrix
// `Q = [[A, b], [b^T, c]]` (`A`: 3x3 symmetric, `b`: 3x1, `c`: scalar) in
// row-major upper-triangular order:
//   [Axx, Axy, Axz, bx, Ayy, Ayz, by, Azz, bz, c]
// i.e. index 0..9 = qxx, qxy, qxz, qxw, qyy, qyz, qyw, qzz, qzw, qww.

/** Length-10 typed array — see this module's doc for the exact layout. */
export type Quadric = Float64Array;

export function zeroQuadric(): Quadric {
  return new Float64Array(10);
}

/** The fundamental error quadric for the plane `a*x + b*y + c*z + d = 0`.
 * `(a, b, c)` MUST be a unit normal (`a^2+b^2+c^2 === 1`) for `qww` etc. to
 * carry the "sum of squared signed distances" meaning `quadricError` and
 * `decimate.ts`'s `@errorBound` rely on — `triangleQuadric` below (the only
 * production caller) guarantees this. */
export function planeQuadric(a: number, b: number, c: number, d: number): Quadric {
  const q = new Float64Array(10);
  q[0] = a * a;
  q[1] = a * b;
  q[2] = a * c;
  q[3] = a * d;
  q[4] = b * b;
  q[5] = b * c;
  q[6] = b * d;
  q[7] = c * c;
  q[8] = c * d;
  q[9] = d * d;
  return q;
}

/** Minimum squared triangle-normal length accepted before a triangle is
 * treated as degenerate (near-zero area) by `triangleQuadric` — matches this
 * project's other degenerate-triangle epsilon convention in spirit (see
 * `intake/degenerate.ts`'s `DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4`), kept
 * as its own constant here since this module's normal is unit-scaled
 * (squared-length-of-cross-product, not squared-length-of-cross-product /
 * 4 = area^2, so the natural epsilon differs by a constant factor and
 * deserves its own name rather than importing/rescaling that one). */
export const DEGENERATE_NORMAL_LENGTH_SQ_EPSILON = 1e-20;

/** The plane quadric for triangle `(p0, p1, p2)`'s supporting plane:
 * `normal = normalize(cross(p1-p0, p2-p0))`, `d = -(normal . p0)` (so
 * `normal . x + d` is the signed distance from `x` to that plane). Returns a
 * ZERO quadric (no contribution) for a degenerate (near-zero-area) triangle
 * rather than dividing by ~zero — a mesh reaching `decimateMesh` may well
 * carry slivers from earlier pipeline stages (weld/repair), and this module
 * must never NaN/Infinity out on one; a zero-area triangle has no meaningful
 * supporting plane to constrain a collapse position against, so contributing
 * nothing is the correct (not just safe) behavior. */
export function triangleQuadric(
  p0x: number,
  p0y: number,
  p0z: number,
  p1x: number,
  p1y: number,
  p1z: number,
  p2x: number,
  p2y: number,
  p2z: number,
): Quadric {
  const ux = p1x - p0x;
  const uy = p1y - p0y;
  const uz = p1z - p0z;
  const vx = p2x - p0x;
  const vy = p2y - p0y;
  const vz = p2z - p0z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const lenSq = nx * nx + ny * ny + nz * nz;
  if (lenSq < DEGENERATE_NORMAL_LENGTH_SQ_EPSILON) return zeroQuadric();
  const invLen = 1 / Math.sqrt(lenSq);
  const a = nx * invLen;
  const b = ny * invLen;
  const c = nz * invLen;
  const d = -(a * p0x + b * p0y + c * p0z);
  return planeQuadric(a, b, c, d);
}

/** `target += other`, in place (avoids an allocation on the hot "accumulate
 * one triangle's quadric into 3 vertices" / "merge a collapsed vertex's
 * quadric into its survivor" paths). */
export function addQuadricInPlace(target: Quadric, other: Quadric): void {
  for (let i = 0; i < 10; i++) target[i]! += other[i]!;
}

export function addQuadric(a: Quadric, b: Quadric): Quadric {
  const out = new Float64Array(10);
  for (let i = 0; i < 10; i++) out[i] = a[i]! + b[i]!;
  return out;
}

/**
 * `v^T A v + 2 b^T v + c` — the QEM cost of placing a (possibly merged)
 * vertex at `(x, y, z)` under quadric `q`. For a `q` built purely from
 * `triangleQuadric` sums, this is exactly the sum, over every plane folded
 * into `q`, of the SQUARED signed distance from `(x, y, z)` to that plane —
 * always `>= 0` up to floating-point rounding (never asserted here, a hot
 * per-candidate-edge function; `decimate.ts` clamps negative rounding noise
 * to 0 at its call sites).
 */
export function quadricError(q: Quadric, x: number, y: number, z: number): number {
  const qxx = q[0]!;
  const qxy = q[1]!;
  const qxz = q[2]!;
  const qxw = q[3]!;
  const qyy = q[4]!;
  const qyz = q[5]!;
  const qyw = q[6]!;
  const qzz = q[7]!;
  const qzw = q[8]!;
  const qww = q[9]!;
  return (
    qxx * x * x +
    2 * qxy * x * y +
    2 * qxz * x * z +
    2 * qxw * x +
    qyy * y * y +
    2 * qyz * y * z +
    2 * qyw * y +
    qzz * z * z +
    2 * qzw * z +
    qww
  );
}

/** Determinant-magnitude threshold, RELATIVE to the matrix's own scale (see
 * `solveOptimalPosition`'s doc for why relative, not absolute), below which
 * the 3x3 system `A v = -b` is treated as singular. `1e-9` cubed-scale is
 * conservative (favors falling back to the sampled-candidate chain over
 * trusting an ill-conditioned solve, which could otherwise place a collapse
 * position arbitrarily far away). */
export const QUADRIC_SOLVE_SINGULARITY_EPSILON = 1e-9;

/**
 * Solves for the QEM-OPTIMAL collapse position: minimizes
 * `quadricError(q, x, y, z)` over all `(x, y, z)` by solving the 3x3 linear
 * system `A v = -b` (`A`/`b` extracted from `q` — see this module's top
 * layout doc) via Cramer's rule (`A` is only ever 3x3 here — full Gaussian
 * elimination would be strictly more general and no more correct for this
 * fixed size). Returns `null` if `A` is singular (or too ill-conditioned to
 * trust) — a degenerate local quadric (e.g. every accumulated plane through
 * the edge is parallel, or the two incident triangles are coplanar with no
 * other constraint) has no unique minimizer; `decimate.ts`'s
 * `optimalCollapsePosition` documents the fallback chain for that case.
 */
export function solveOptimalPosition(q: Quadric): readonly [number, number, number] | null {
  const a11 = q[0]!;
  const a12 = q[1]!;
  const a13 = q[2]!;
  const a22 = q[4]!;
  const a23 = q[5]!;
  const a33 = q[7]!;
  // A v = -b, i.e. rhs = -b.
  const rx = -q[3]!;
  const ry = -q[6]!;
  const rz = -q[8]!;

  const c00 = a22 * a33 - a23 * a23;
  const c01 = a12 * a33 - a23 * a13;
  const c02 = a12 * a23 - a22 * a13;
  const det = a11 * c00 - a12 * c01 + a13 * c02;

  // Scale reference for a RELATIVE singularity test — matrix entries scale
  // with the accumulated number/magnitude of incident unit-normal planes
  // (each contributing `<= 1` to a diagonal entry), so an ABSOLUTE epsilon
  // would misclassify a well-conditioned but heavily-accumulated quadric
  // (many incident triangles) as singular.
  const scale = Math.abs(a11) + Math.abs(a22) + Math.abs(a33) + 1;
  if (Math.abs(det) < QUADRIC_SOLVE_SINGULARITY_EPSILON * scale * scale * scale) {
    return null;
  }

  const detX = rx * c00 - a12 * (ry * a33 - a23 * rz) + a13 * (ry * a23 - a22 * rz);
  const detY = a11 * (ry * a33 - a23 * rz) - rx * c01 + a13 * (a12 * rz - ry * a13);
  const detZ = a11 * (a22 * rz - ry * a23) - a12 * (a12 * rz - ry * a13) + rx * c02;

  const x = detX / det;
  const y = detY / det;
  const z = detZ / det;
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return null;
  return [x, y, z];
}
