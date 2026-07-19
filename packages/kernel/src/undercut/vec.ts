// packages/kernel/src/undercut/vec.ts
//
// Minimal Float64 Vec3 arithmetic private to undercut/ — mirrors
// curvature/vec.ts's / sdf/vec.ts's / bvh/geometry.ts's own file-local
// sub/dot/cross convention (not a project-wide shared vector-math module;
// this repo deliberately duplicates this handful of 3-line operations
// per-module rather than introducing a new cross-cutting dependency — see
// curvature/vec.ts's own doc for the same rationale).
import type { Vec3 } from '../bvh/geometry.ts';

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Normalizes `a`, or returns `[0, 0, 0]` unchanged if `a` is (numerically)
 * the zero vector — same "undefined direction, never divide by zero"
 * convention as sdf/vec.ts's `normalizeOrZero` (needed here for the same
 * reason: a degenerate zero-area triangle's face normal must not produce
 * `NaN` and propagate it into the undercut sign test). */
export function normalizeOrZero(a: Vec3): Vec3 {
  const len = length(a);
  return len === 0 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}
