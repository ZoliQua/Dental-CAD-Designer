// packages/kernel/src/sdf/signedDistance.ts
//
// `signedClosestPoint`: exact closest-point-on-surface query (built on
// bvh/closestPoint.ts, Phase 1) PLUS a sign — negative when the query point
// is inside the mesh, positive when it's outside, exactly 0 on the surface.
// This is Task 6's brief item 1 — see pseudonormals.ts for the angle-weighted
// pseudonormal precompute this builds on and its module doc for the method
// (Bærentzen & Aanæs) and the "requires watertight, consistently-oriented
// input" contract.
//
// ## Sign convention (DOCUMENTED per this task's brief)
//
// `signedDistance < 0` means the query point is INSIDE the mesh; `> 0` means
// OUTSIDE; exactly `0` means ON the surface (`distance === 0`). This is the
// standard SDF convention (e.g. matches Task 7's "offset by 50 µm" reading as
// "grow the surface toward positive signed distance").
import type { IndexedMesh } from '../mesh/types.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { Bvh, ClosestPointResult } from '../bvh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { Pseudonormals } from './pseudonormals.ts';
import { dot, sub } from './vec.ts';

/**
 * Tolerance (in barycentric-weight units — dimensionless, in `[0, 1]`, NOT a
 * mm quantity, so this is scale-invariant across any mesh size) below which
 * a `closestPoint` result's barycentric component is treated as exactly
 * zero when classifying which Voronoi region (face interior / edge / vertex)
 * a closest point falls into (`classifyBarycentricFeature`, below).
 *
 * ## Why this value, and why it's safe
 *
 * `closestPointOnTriangle` (bvh/geometry.ts) returns EXACT zero(s) in its
 * vertex-region and edge-region branches (e.g. `barycentric: [1, 0, 0]` for
 * a vertex-A closest point — literal `0`, not an approximately-small value)
 * — see that function's Voronoi-region-walk implementation. So this epsilon
 * is NOT bridging a genuine "how close counts as on-the-edge" geometric
 * judgment call (unlike, say, `bvh/geometry.ts`'s `BARYCENTRIC_EPSILON`,
 * which relaxes a ray/triangle edge test against real floating-point
 * disagreement between two independently-computed triangles sharing an
 * edge); it exists purely to absorb ordinary Float64 rounding noise
 * upstream of the exact-zero branches (e.g. a barycentric weight computed
 * as `1e-17` instead of literal `0` due to a preceding subtraction's
 * rounding) without misclassifying it as "genuinely in the face interior,
 * just very close to an edge". `1e-9` is many orders of magnitude above
 * Float64's ~1e-16 relative rounding floor and many orders of magnitude
 * below "a real edge-proximity classification would ever need to be that
 * tight" (a face-interior point closer than 1e-9 of a triangle's own extent
 * to an edge is, for every practical dental-CAD purpose, ON that edge).
 */
export const SDF_BARYCENTRIC_EPSILON = 1e-9;

/** Which Voronoi region (face interior / edge / vertex) of its triangle a
 * `closestPoint` result's barycentric coordinates fall into — see
 * `classifyBarycentricFeature`'s doc for the classification rule and
 * `pseudonormalForFeature` for how each variant maps to a `Pseudonormals`
 * lookup. */
export type BarycentricFeature =
  | { readonly kind: 'face' }
  | { readonly kind: 'vertex'; readonly cornerIndex: 0 | 1 | 2 }
  | { readonly kind: 'edge'; readonly oppositeCornerIndex: 0 | 1 | 2 };

/**
 * Classifies a `ClosestPointResult.barycentric` triple into the Voronoi
 * region its closest point falls into:
 *
 * - Two components within `SDF_BARYCENTRIC_EPSILON` of zero (one component
 *   near 1): a VERTEX — `cornerIndex` is the near-1 (dominant) component.
 * - Exactly one component within epsilon of zero: an EDGE — the point lies
 *   on the edge OPPOSITE the near-zero corner (`oppositeCornerIndex`) —
 *   i.e. the edge joining the OTHER two corners. Triangle-local halfedge
 *   `k = (oppositeCornerIndex + 1) % 3` is that edge, in the SAME
 *   `he = triangleIndex * 3 + k` indexing `Pseudonormals.edgeNormals` uses
 *   (halfedge/types.ts's "Layout": halfedge `f*3+k` runs from corner `k` to
 *   corner `(k+1)%3` — corner `(oppositeCornerIndex+2)%3` to corner
 *   `oppositeCornerIndex`... concretely: corner 0 near-zero -> edge BC ->
 *   local halfedge 1 (B->C); corner 1 near-zero -> edge CA -> local halfedge
 *   2 (C->A); corner 2 near-zero -> edge AB -> local halfedge 0 (A->B) —
 *   each is `(oppositeCornerIndex + 1) % 3`).
 * - No component near zero: the FACE interior.
 *
 * (Three components near zero simultaneously cannot happen for a
 * non-degenerate triangle — they always sum to 1 — and would collapse to
 * the vertex branch above regardless, since `>= 2` near-zero is the vertex
 * test.)
 */
export function classifyBarycentricFeature(barycentric: Vec3): BarycentricFeature {
  const nearZero: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(barycentric[i]!) <= SDF_BARYCENTRIC_EPSILON) nearZero.push(i);
  }
  if (nearZero.length >= 2) {
    let dominant: 0 | 1 | 2 = 0;
    for (let i = 1; i < 3; i++) {
      if (barycentric[i]! > barycentric[dominant]!) dominant = i as 0 | 1 | 2;
    }
    return { kind: 'vertex', cornerIndex: dominant };
  }
  if (nearZero.length === 1) {
    return { kind: 'edge', oppositeCornerIndex: nearZero[0] as 0 | 1 | 2 };
  }
  return { kind: 'face' };
}

/** Looks up the `Pseudonormals` array entry matching `feature` for
 * `triangleIndex` — see `classifyBarycentricFeature`'s doc for the
 * face/edge/vertex indexing convention each branch relies on. */
function pseudonormalForFeature(
  mesh: IndexedMesh,
  pseudonormals: Pseudonormals,
  triangleIndex: number,
  feature: BarycentricFeature,
): Vec3 {
  if (feature.kind === 'face') {
    const n = pseudonormals.faceNormals;
    return [n[triangleIndex * 3]!, n[triangleIndex * 3 + 1]!, n[triangleIndex * 3 + 2]!];
  }
  if (feature.kind === 'vertex') {
    const vertexIndex = mesh.indices[triangleIndex * 3 + feature.cornerIndex]!;
    const n = pseudonormals.vertexNormals;
    return [n[vertexIndex * 3]!, n[vertexIndex * 3 + 1]!, n[vertexIndex * 3 + 2]!];
  }
  const localHalfedge = (feature.oppositeCornerIndex + 1) % 3;
  const he = triangleIndex * 3 + localHalfedge;
  const n = pseudonormals.edgeNormals;
  return [n[he * 3]!, n[he * 3 + 1]!, n[he * 3 + 2]!];
}

/** Result of a `signedClosestPoint` query — extends `ClosestPointResult`
 * (bvh/types.ts) with the signed value. */
export interface SignedClosestPointResult extends ClosestPointResult {
  /** `distance`, signed per this module's convention: negative inside the
   * mesh, positive outside, `0` exactly on the surface (`=== distance` in
   * sign only when `distance === 0`, since `0` has no sign). */
  signedDistance: number;
}

/**
 * Exact closest point on `mesh`'s surface to `point` (via `closestPoint`,
 * bvh/closestPoint.ts — Float64, deterministic tie-break), PLUS its SIGN
 * (this module's top-of-file doc: negative inside, positive outside), via
 * `pseudonormals`' angle-weighted pseudonormal for whichever Voronoi region
 * (face/edge/vertex) the closest point falls into
 * (`classifyBarycentricFeature`).
 *
 * `pseudonormals` MUST have been built (`computePseudonormals`,
 * pseudonormals.ts) from THIS SAME `mesh` — like `bvh` itself, this function
 * does not re-validate that beyond `closestPoint`'s own triangle-count check
 * against `bvh` (a `Pseudonormals`/`Bvh` pair built from different meshes
 * with the same triangle count would silently produce nonsense, exactly the
 * same caveat `closestPoint`'s own doc states for a stale `Bvh`).
 *
 * @errorBound Distance itself is exact (inherits `closestPoint`'s bound: no
 * approximation, ordinary Float64 rounding only). The SIGN is exact
 * (not merely "usually right near edges/vertices") for a closed,
 * consistently-oriented mesh, by construction of the angle-weighted
 * pseudonormal method (Bærentzen & Aanæs 2005) — see pseudonormals.ts's
 * module doc. The one tie-break with no "true" answer: `distance > 0` and
 * `dot(point - closestPoint, pseudonormal) === 0` EXACTLY (the query point
 * lies precisely on the pseudonormal's own tangent plane through the
 * closest point — a measure-zero configuration for generic input) is
 * classified OUTSIDE (`sign = +1`), a fixed, deterministic, arbitrary but
 * documented choice (mirrors bvh/closestPoint.ts's exact-tie handling
 * philosophy: pick a fixed rule rather than leaving it to iteration order).
 */
export function signedClosestPoint(
  mesh: IndexedMesh,
  bvh: Bvh,
  pseudonormals: Pseudonormals,
  point: Vec3,
): SignedClosestPointResult {
  const base = closestPoint(mesh, bvh, point);
  if (base.distance === 0) {
    return { ...base, signedDistance: 0 };
  }
  const feature = classifyBarycentricFeature(base.barycentric);
  const normal = pseudonormalForFeature(mesh, pseudonormals, base.triangleIndex, feature);
  const toQuery = sub(point, base.point);
  const sign = dot(toQuery, normal) < 0 ? -1 : 1;
  return { ...base, signedDistance: sign * base.distance };
}
