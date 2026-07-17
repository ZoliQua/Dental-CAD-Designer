// packages/kernel/src/geodesic/types.ts
//
// Shared types for the geodesic module (Phase 2 Task 4). See geodesicPath.ts's
// module doc for the full method description and @errorBound.

import type { Vec3 } from '../bvh/geometry.ts';

/**
 * An arbitrary point ON a mesh's surface, addressed by triangle + barycentric
 * coordinates — NOT just a vertex index (this task's brief: "endpoints are
 * arbitrary surface points... not just vertices"). Same shape as
 * `bvh/types.ts`'s `ClosestPointResult`'s `triangleIndex`/`barycentric`
 * fields (see `surfacePoint.ts`'s `surfacePointFromClosestPoint` for the
 * direct conversion), so a BVH `closestPoint` projection is already a valid
 * `SurfacePoint`.
 */
export interface SurfacePoint {
  readonly triangleIndex: number;
  /** Barycentric weights (w0, w1, w2) for `mesh.indices[triangleIndex*3 + 0..2]`
   * respectively — sums to 1, each component in [0, 1]. */
  readonly barycentric: Vec3;
}

/** Result of `geodesicPath` — see that function's doc for the method and
 * `@errorBound`. */
export interface GeodesicPathResult {
  /** Ordered surface points tracing the path: `points[0]` is exactly the
   * input `start` (same object shape, not just "close to"), `points[last]`
   * is exactly `end`; every point strictly between them is either a mesh
   * vertex (a "bend" the taut path turns at) or a point on a mesh edge
   * (where the straight-in-the-unfolded-plane path crosses a triangle
   * boundary) — see geodesicPath.ts's module doc. Every point lies exactly
   * on the input mesh's surface (see the "path-on-surface" property test). */
  points: SurfacePoint[];
  /** Total path length (mm): the sum of the Euclidean lengths of the
   * straight 3D segments between consecutive `points` entries. */
  length: number;
  /** Number of corridor-widening refinement passes actually performed
   * (0 if the very first corridor+funnel pass was already locally taut) —
   * surfaced for diagnostics/determinism tests, not required by production
   * callers. See geodesicPath.ts's "Iterative straightening" doc for the
   * convergence criterion this counts against. */
  iterations: number;
}

/** Options shared by `geodesicPath`/`snapPolylineGeodesic` — see
 * geodesicPath.ts's module doc for what each bounds. */
export interface GeodesicOptions {
  /** Max corridor-widening iterations before giving up and returning the
   * best path found so far (hang-guard for degenerate inputs, e.g.
   * near-antipodal points on a closed surface with many equally-short
   * candidate geodesics). Default: `GEODESIC_MAX_ITERATIONS`. */
  maxIterations?: number;
  /** Relative total-length improvement below which widening stops (treated
   * as converged). Default: `GEODESIC_REL_TOL`. */
  relativeTolerance?: number;
}
