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

/** Epsilon (in barycentric-weight units) within which a `SurfacePoint` is
 * treated as "vertex-exact" by `vertexIndexIfExact` — see that function's
 * doc and corridor.ts's "one-ring seed extension" module doc. Tight enough
 * to only catch points that are genuinely AT a vertex (either bit-exact —
 * `funnel.ts`'s `surfacePointAtVertex` always emits `[1,0,0]`-style
 * barycentrics, and BVH `closestPoint` projections that land on/very near a
 * vertex are effectively exact too — or fast-check's shrink-biased
 * near-vertex samples, e.g. `[1, 1e-111, 1e-165]`), never a typical
 * randomly-sampled interior point (a uniform sample landing within `1e-9`
 * of a vertex by chance is vanishingly unlikely). */
export const VERTEX_EXACT_BARYCENTRIC_EPSILON = 1e-9;

// ## Derivation vs. `MESH_WELD_EPSILON_MM` — deliberately NOT the same scale
//
// This is a BARYCENTRIC-WEIGHT epsilon (dimensionless, a ratio), unlike
// `../intake/weld.ts`'s `MESH_WELD_EPSILON_MM` (1e-6 mm, an absolute
// distance) — the two are not directly comparable, but it's worth deriving
// the spatial (mm) bound this barycentric epsilon actually implies, so the
// gap between the two is a stated design choice rather than an unexamined
// coincidence of two different-looking small numbers.
//
// For `sp` with `w0 = 1 - epsilon` (the "vertex-exact at vertex A" case),
// `evaluateSurfacePoint`'s position is `A + w1*(B-A) + w2*(C-A)` with
// `w1 + w2 = epsilon`, so the spatial deviation from `A` is bounded by
// `epsilon * max(|B-A|, |C-A|)` — i.e. `epsilon` scaled by the LONGEST edge
// incident to the vertex being tested. At real-scan/die mesh scale (edge
// lengths from the ~20 µm marching-cubes pitch floor up to a few mm for a
// coarse arch scan — see offset/marchingCubes.ts's pitch floor and
// intake/weld.ts's own doc), `epsilon = 1e-9` bounds the spatial deviation
// to roughly `1e-9 * (0.02 to a few) mm ≈ 2e-11 to 1e-8 mm` — several orders
// tighter than `MESH_WELD_EPSILON_MM`'s 1e-6 mm. That gap is INTENTIONAL:
// this check exists to recognize points that are the SAME point as a mesh
// vertex up to floating-point noise (funnel.ts's `surfacePointAtVertex`
// always emits an exact `[1,0,0]`-style barycentric; a BVH `closestPoint`
// projection landing ON a vertex is exact up to Float64 rounding only) — it
// must NOT fire for a genuinely distinct nearby point that a weld pass would
// still consider mergeable, since firing incorrectly biases the corridor
// seed (this function's own doc, "vertex-exact endpoints"). A barycentric
// epsilon at weld-distance scale would be too loose for that purpose.
//
// The known LIMIT this leaves undocumented-until-now: because the spatial
// bound scales with edge length, an edge far longer than this kernel's
// working volume (this project's clinical scans are bounded to a few
// hundred mm at most — PLAN.md's working-volume assumption) could in
// principle push the spatial deviation above `MESH_WELD_EPSILON_MM` while
// still satisfying `epsilon = 1e-9` in barycentric terms — i.e. a
// "vertex-exact" classification that a weld pass would NOT agree is the same
// point. This does not arise at any mesh scale this kernel actually
// processes (dental restorations, dies, or full arches), so `epsilon` is not
// tied to `MESH_WELD_EPSILON_MM`/edge length dynamically — but it is a real,
// stated deficit of a fixed dimensionless threshold rather than a scale-
// aware one, not a silent assumption.

/**
 * Returns the global mesh vertex index `sp` sits (at least effectively)
 * exactly AT — one barycentric weight within `epsilon` of 1 — or `null` if
 * `sp` is a genuine interior/edge point. Used by corridor.ts's one-ring
 * seed extension (seeding/terminating the corridor search from every
 * triangle incident to the vertex, not just `sp.triangleIndex`) and
 * geodesicPath.ts's exact endpoint placement in the unfolded 2D frame — see
 * geodesicPath.ts's `@errorBound` "vertex-exact endpoints" section for why
 * this matters (a single arbitrarily-chosen containing triangle otherwise
 * biases the corridor seed, measurably, for legitimate vertex-anchored
 * surface points).
 */
export function vertexIndexIfExact(mesh: IndexedMesh, sp: SurfacePoint, epsilon: number = VERTEX_EXACT_BARYCENTRIC_EPSILON): number | null {
  const [w0, w1, w2] = sp.barycentric;
  const threshold = 1 - epsilon;
  if (w0 >= threshold) return triangleVertexIndices(mesh, sp.triangleIndex)[0];
  if (w1 >= threshold) return triangleVertexIndices(mesh, sp.triangleIndex)[1];
  if (w2 >= threshold) return triangleVertexIndices(mesh, sp.triangleIndex)[2];
  return null;
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
