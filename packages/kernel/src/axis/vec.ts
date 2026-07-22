// packages/kernel/src/axis/vec.ts
//
// Minimal Float64 Vec3 arithmetic + per-triangle helpers private to axis/ —
// mirrors undercut/vec.ts's / curvature/vec.ts's own file-local
// sub/dot/cross/normalizeOrZero convention (see undercut/vec.ts's own doc
// for the "duplicated rather than shared" rationale this repo follows for
// this handful of 3-line operations, per module, rather than a new
// cross-cutting shared vector-math dependency).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
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
 * convention as undercut/vec.ts's `normalizeOrZero`. */
export function normalizeOrZero(a: Vec3): Vec3 {
  const len = length(a);
  return len === 0 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}

export function triangleVertexPositions(mesh: IndexedMesh, triangleIndex: number): [Vec3, Vec3, Vec3] {
  const i0 = mesh.indices[triangleIndex * 3]!;
  const i1 = mesh.indices[triangleIndex * 3 + 1]!;
  const i2 = mesh.indices[triangleIndex * 3 + 2]!;
  const p = mesh.positions;
  return [
    [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!],
    [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!],
    [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!],
  ];
}

/** Unit outward face normal (CCW-from-outside cross product, matching
 * `IndexedMesh`'s winding convention — see mesh/types.ts, same convention
 * undercut/undercutScan.ts's own `triangleUnitNormal` uses). `[0,0,0]` for a
 * degenerate zero-area triangle (defense-in-depth only). */
export function triangleUnitNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalizeOrZero(cross(sub(b, a), sub(c, a)));
}

/** Triangle area, mm^2 — half the cross-product magnitude. */
export function triangleAreaMm2(a: Vec3, b: Vec3, c: Vec3): number {
  return 0.5 * length(cross(sub(b, a), sub(c, a)));
}
