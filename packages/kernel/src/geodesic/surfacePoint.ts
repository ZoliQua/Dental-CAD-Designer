// packages/kernel/src/geodesic/surfacePoint.ts
//
// Conversions between `SurfacePoint` (triangle + barycentric) and the actual
// Float64 3D position it names, plus the BVH-projection helper
// (`snapToSurface`) that turns an arbitrary 3D point into a `SurfacePoint` —
// `snapPolylineGeodesic`'s "anchors projected to surface via BVH first"
// step (this task's brief, deliverable 2).
import type { ClosestPointResult } from '../bvh/types.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { Bvh } from '../bvh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { SurfacePoint } from './types.ts';

/** The 3 global vertex indices of `mesh`'s triangle `triangleIndex`, in
 * winding order (matches `mesh.indices[triangleIndex*3 + 0..2]`). */
export function triangleVertexIndices(mesh: IndexedMesh, triangleIndex: number): [number, number, number] {
  const base = triangleIndex * 3;
  return [mesh.indices[base]!, mesh.indices[base + 1]!, mesh.indices[base + 2]!];
}

function vertexPosition3(mesh: IndexedMesh, v: number): Vec3 {
  const p = mesh.positions;
  return [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
}

/** Evaluates a `SurfacePoint`'s actual Float64 3D position: the barycentric
 * combination of its triangle's 3 vertex positions. */
export function evaluateSurfacePoint(mesh: IndexedMesh, sp: SurfacePoint): Vec3 {
  const [ia, ib, ic] = triangleVertexIndices(mesh, sp.triangleIndex);
  const [wa, wb, wc] = sp.barycentric;
  const a = vertexPosition3(mesh, ia);
  const b = vertexPosition3(mesh, ib);
  const c = vertexPosition3(mesh, ic);
  return [a[0] * wa + b[0] * wb + c[0] * wc, a[1] * wa + b[1] * wb + c[1] * wc, a[2] * wa + b[2] * wb + c[2] * wc];
}

/** Direct conversion from a BVH `closestPoint` result — the SAME
 * `triangleIndex`/`barycentric` shape (see this module's top doc), so a
 * projection is already a valid `SurfacePoint` with zero extra work. */
export function surfacePointFromClosestPoint(cp: ClosestPointResult): SurfacePoint {
  return { triangleIndex: cp.triangleIndex, barycentric: cp.barycentric };
}

/** Projects an arbitrary 3D point onto `mesh`'s surface via `bvh`
 * (`closestPoint`) and returns it as a `SurfacePoint`. This is the "anchors
 * projected to surface via BVH first" step of `snapPolylineGeodesic` (this
 * task's brief) — also usable standalone by `geodesicPath` callers that
 * start from a raw pick point rather than an existing `SurfacePoint`. */
export function snapToSurface(mesh: IndexedMesh, bvh: Bvh, point: Vec3): SurfacePoint {
  return surfacePointFromClosestPoint(closestPoint(mesh, bvh, point));
}

/** Squared Euclidean distance between two `SurfacePoint`s' evaluated 3D
 * positions — used by `geodesicPath`'s same-point fast path and by tests. */
export function surfacePointDistanceSquared(mesh: IndexedMesh, a: SurfacePoint, b: SurfacePoint): number {
  const pa = evaluateSurfacePoint(mesh, a);
  const pb = evaluateSurfacePoint(mesh, b);
  const dx = pa[0] - pb[0];
  const dy = pa[1] - pb[1];
  const dz = pa[2] - pb[2];
  return dx * dx + dy * dy + dz * dz;
}
