// packages/kernel/src/curvature/vec.ts
//
// Minimal Float64 Vec3 arithmetic private to curvature/ — mirrors
// bvh/geometry.ts's own file-local sub/dot/cross convention (not a
// project-wide shared vector-math module; kept tiny and duplicated per this
// repo's established precedent — see e.g. jobs/heatmap.ts's own
// `triangleNormalUnnormalized` — rather than introducing a new cross-cutting
// dependency for a handful of 3-line operations).
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

/** Vertex `v`'s position, read out of a flat xyzxyz... `Float64Array` (an
 * `IndexedMesh.positions` buffer) as a `Vec3` triple. */
export function vertexPosition(positions: Float64Array, v: number): Vec3 {
  return [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
}
