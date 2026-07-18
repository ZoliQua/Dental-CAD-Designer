// packages/kernel/src/sdf/vec.ts
//
// Minimal Float64 Vec3 arithmetic private to sdf/ — mirrors curvature/vec.ts's
// / bvh/geometry.ts's own file-local sub/dot/cross convention (not a
// project-wide shared vector-math module; this repo deliberately duplicates
// this handful of 3-line operations per-module rather than introducing a new
// cross-cutting dependency — see curvature/vec.ts's own doc for the same
// rationale).
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
 * the zero vector — the same "undefined direction, never divide by zero"
 * convention curvature/normals.ts's `computeVertexNormals` uses, needed here
 * for the same reason: a degenerate (zero-area) triangle's face normal, or a
 * vertex/edge whose incident normals happen to cancel exactly, must not
 * produce `NaN` and propagate it into a sign decision. Intake's
 * `dropDegenerateTriangles` removes true degenerates from any mesh that went
 * through kernel intake, so this is defense in depth, not an expected path.
 */
export function normalizeOrZero(a: Vec3): Vec3 {
  const len = length(a);
  return len === 0 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}

/** Interior angle at vertex `p` within triangle (p, q, r) — `atan2(|cross|,
 * dot)`, the same numerically-stable form curvature/curvature.ts's
 * `triangleAngleAt` builds on (robust near 0 and pi, unlike
 * `acos(dot/(|u|*|v|))`); duplicated here rather than imported since it's
 * file-local (not exported) in curvature.ts — see this file's top-of-file
 * doc for why small vec helpers are duplicated per-module in this repo. */
export function triangleAngleAt(p: Vec3, q: Vec3, r: Vec3): number {
  const u = sub(q, p);
  const v = sub(r, p);
  const crossLen = length(cross(u, v));
  return Math.atan2(crossLen, dot(u, v));
}
