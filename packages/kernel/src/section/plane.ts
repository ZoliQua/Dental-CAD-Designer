// packages/kernel/src/section/plane.ts
//
// Shared plane math for this module: a `Plane` (a point + normal, both
// Float64 mm/unitless-direction) plus an orthonormal basis derived from it
// (`PlaneBasis`) used by both the polyline extraction (polyline.ts) and the
// manifold-3d cap computation (../boolean/manifold.ts's `sectionCap`) — one
// canonical, deterministic construction so both code paths agree on exactly
// where "the plane" is and which direction its local (e1, e2) axes point.
import type { Vec3 } from '../bvh/geometry.ts';

/** A plane in kernel world coordinates (Float64 mm). `normal` need not be
 * unit length — every consumer normalizes it via `normalizePlane` below —
 * but MUST be non-degenerate (see `DegeneratePlaneError`). The "positive"
 * side of the plane is the side `normal` points toward. */
export interface Plane {
  point: Vec3;
  normal: Vec3;
}

/** A plane resolved to a canonical orthonormal basis: `normal` (unit length,
 * same direction as the input `Plane.normal`), `e1`/`e2` (unit, mutually
 * orthogonal, both orthogonal to `normal`, spanning the plane), and `d` —
 * the plane's signed offset from the origin along `normal`
 * (`d = normal . point`), so a point `p` lies on the plane iff
 * `normal . p === d`. Any point ON the plane can be reconstructed from its
 * local 2D coordinates `(u, v)` (see `projectToPlaneXY`) as
 * `p = u*e1 + v*e2 + d*normal` — this identity is what both `polyline.ts`'s
 * SVG-projection helper and `../boolean/manifold.ts`'s `sectionCap` rely on
 * to move between world 3D and plane-local 2D. */
export interface PlaneBasis {
  point: Vec3;
  normal: Vec3;
  e1: Vec3;
  e2: Vec3;
  d: number;
}

/** Thrown by `normalizePlane` when `plane.normal` is too close to the zero
 * vector to determine a direction — e.g. an all-zero normal, or one so tiny
 * it's indistinguishable from floating-point noise. Not a mesh-input
 * problem (contrast `NonManifoldInputError`), so it's its own named error
 * rather than reusing that class. */
export class DegeneratePlaneError extends Error {
  constructor(message = 'Plane normal is degenerate (zero or near-zero length)') {
    super(message);
    this.name = 'DegeneratePlaneError';
  }
}

/** Below this length, a normal is treated as degenerate — see
 * `DegeneratePlaneError`. Deliberately far smaller than any plausible mesh
 * coordinate scale (mm) or intentional normal component, so it only ever
 * rejects genuinely-zero/near-zero input, never a legitimate unit or
 * scaled-but-valid normal. */
const MIN_NORMAL_LENGTH = 1e-12;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * Resolves a `Plane` into a canonical `PlaneBasis`. Deterministic given the
 * exact same `plane` input (no randomness, no dependence on iteration
 * order): `e1` is built by crossing `normal` with whichever WORLD axis
 * `normal` is LEAST aligned with (the standard "arbitrary perpendicular"
 * construction — picking the least-aligned axis avoids the near-parallel
 * case where a cross product would be near-zero/numerically unstable), then
 * `e2 = normal x e1` completes the right-handed orthonormal frame.
 *
 * @throws {DegeneratePlaneError} if `plane.normal`'s length is below
 * `MIN_NORMAL_LENGTH`.
 */
export function normalizePlane(plane: Plane): PlaneBasis {
  const rawLength = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]);
  if (!Number.isFinite(rawLength) || rawLength < MIN_NORMAL_LENGTH) {
    throw new DegeneratePlaneError();
  }
  const normal = normalize(plane.normal);

  // Least-aligned world axis (deterministic tie-break: X, then Y, then Z,
  // by strict `<` comparison order below) — see doc comment above.
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  let axis: Vec3;
  if (ax <= ay && ax <= az) {
    axis = [1, 0, 0];
  } else if (ay <= az) {
    axis = [0, 1, 0];
  } else {
    axis = [0, 0, 1];
  }

  const e1 = normalize(cross(axis, normal));
  const e2 = cross(normal, e1); // already unit: normal and e1 are orthonormal

  return {
    point: plane.point,
    normal,
    e1,
    e2,
    d: dot(normal, plane.point),
  };
}

/** Signed distance from `p` to the plane (mm), positive on the side
 * `basis.normal` points toward. Zero exactly when `p` lies on the plane. */
export function signedDistance(basis: PlaneBasis, p: Vec3): number {
  return p[0] * basis.normal[0] + p[1] * basis.normal[1] + p[2] * basis.normal[2] - basis.d;
}

/**
 * Projects ANY point `p` onto its local `(u, v) = (e1 . p, e2 . p)`
 * coordinate in `basis`'s frame — the exact inverse of the reconstruction
 * identity in `PlaneBasis`'s doc (`p = u*e1 + v*e2 + d*normal`), since
 * `{e1, e2, normal}` is an orthonormal basis of R^3: for any `p`,
 * `p = (e1.p)*e1 + (e2.p)*e2 + (normal.p)*normal` exactly, and
 * `normal.p === d` whenever `p` lies on the plane. Deliberately does NOT
 * subtract `basis.point` first — doing so would make the result depend on
 * which particular on-plane point `normalizePlane` happened to be given,
 * breaking the identity above (two different `point` choices for the same
 * geometric plane share the same `d`, but differ from each other by a
 * vector IN the plane, i.e. with a generally nonzero `e1`/`e2` component).
 * Does NOT verify `p` is actually on the plane (every call site here only
 * ever passes points this module itself computed to be on it, up to
 * floating point) — off-plane points are still projected consistently
 * (used by `../boolean/manifold.ts`'s `sectionCap` to build the rotation
 * that maps `basis.normal` to the manifold-3d slice's Z axis).
 */
export function projectToPlaneXY(basis: PlaneBasis, p: Vec3): readonly [number, number] {
  return [
    p[0] * basis.e1[0] + p[1] * basis.e1[1] + p[2] * basis.e1[2],
    p[0] * basis.e2[0] + p[1] * basis.e2[1] + p[2] * basis.e2[2],
  ];
}
