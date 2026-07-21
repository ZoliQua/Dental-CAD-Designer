// packages/kernel/src/blockout/vec.ts
//
// Minimal Float64 Vec3 arithmetic private to blockout/ — mirrors
// undercut/vec.ts's / axis/vec.ts's own file-local sub/cross/length
// convention (not a project-wide shared vector-math module; this repo
// deliberately duplicates this handful of 3-line operations per-module
// rather than introducing a new cross-cutting dependency — see
// undercut/vec.ts's own doc for the same rationale).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
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

/** Triangle area, mm^2 — half the cross-product magnitude. */
export function triangleAreaMm2(a: Vec3, b: Vec3, c: Vec3): number {
  return 0.5 * length(cross(sub(b, a), sub(c, a)));
}
