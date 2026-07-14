// packages/kernel/src/spline/marginLine.ts
//
// Phase 2 Task 5: converting a `SurfaceSpline` to/from shared-types'
// `MarginLine` shape. See this file's bottom doc ("Proposed shared-types
// evolution") for why this adapter is LOSSY in one direction and NOT a
// substitute for changing `MarginLine` itself — this task's brief is
// explicit that such a change is a Phase 3 decision, not this task's to
// make unilaterally.
//
// `MarginLine` (packages/shared-types/src/index.ts):
//
//   interface MarginLine {
//     vertexAnchors: readonly number[];
//     controlPoints: readonly Vec3[];
//     closed: boolean;
//   }
//
// ## Why this is lossy: `vertexAnchors` assumes control points sit AT mesh
// vertices
//
// A `SurfaceSpline`'s control points are `SurfacePoint`s (triangle +
// barycentric — geodesic/types.ts), i.e. ARBITRARY points on the surface,
// exactly like `geodesic/snapPolyline.ts`'s anchors. A clinician placing a
// margin-line control point clicks (or drags a re-projected handle to)
// wherever the anatomy's true finish line is — that is essentially NEVER
// exactly at a mesh vertex, the same reason `geodesicPath` was built around
// `SurfacePoint` endpoints rather than vertex indices in the first place
// (geodesic/types.ts's `SurfacePoint` doc: "NOT just a vertex index").
// `MarginLine.vertexAnchors` has no representation for "on this triangle,
// at these barycentric weights" — only a single vertex index per anchor.
//
// `toMarginLine` below therefore picks the NEAREST of a control point's
// containing triangle's 3 vertices for `vertexAnchors` — a lossy, coarse
// "which general area of the mesh" hint, explicitly documented as such
// (never assume `vertexAnchors[i]`'s position equals the control point's
// real position; always read `controlPoints[i]` for the exact value, which
// `MarginLine` already stores at full float precision and this adapter
// carries through EXACTLY, no loss). `fromMarginLine` accordingly ignores
// `vertexAnchors` entirely on the way back in (re-projects `controlPoints`
// via BVH — see that function's doc) — round-tripping through
// `vertexAnchors` would silently snap every control point onto the nearest
// vertex, which is exactly the kind of "silent data mutation" CLAUDE.md
// invariant 5 forbids.
//
// ## Proposed shared-types evolution (this task's brief: "propose in the
// report, do NOT change shared-types unilaterally" — NOT implemented here)
//
// A cleaner Phase 3 `MarginLine` would replace `vertexAnchors: readonly
// number[]` with `anchors: readonly SurfacePoint[]` (triangle + barycentric
// — the exact shape this module's `SurfaceSpline.controlPoints` already
// is), keeping `controlPoints: readonly Vec3[]` as the float-precision
// echo (or dropping it in favor of deriving it from `anchors` +
// `evaluateSurfacePoint`, avoiding the two ever disagreeing). This removes
// the lossy nearest-vertex step entirely and matches the convention
// `geodesic/snapPolyline.ts`'s `SnappedPolyline` already established for
// Phase 2. See this task's final report for the full proposal — left as a
// proposal, not applied, per this task's explicit instruction.
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from '../bvh/types.ts';
import { evaluateSurfacePoint, snapToSurface, triangleVertexIndices } from '../geodesic/surfacePoint.ts';
import type { SurfacePoint } from '../geodesic/types.ts';

/** The subset of shared-types' `MarginLine` this adapter reads/writes —
 * duplicated locally (not imported from `@dqcad/shared-types`), matching
 * `intake/types.ts`'s established "structural twin" convention for this
 * exact situation (that module's `TriangleSoup` is a deliberate structural
 * twin of `@dqcad/io`'s `RawTriangleSoup` for the same reason: the
 * `boundaries/dependencies` lint policy technically ALLOWS `kernel ->
 * shared-types`, but no file in this package actually takes that
 * dependency — `packages/kernel/package.json` has zero workspace
 * `dependencies` today, and this adapter doesn't need to be the first).
 * This interface is STRUCTURALLY identical to `@dqcad/shared-types`'
 * `MarginLine` (verified by marginLine.test.ts's exact field-shape test), so
 * a `MarginLine` value is always assignable here and vice versa without a
 * cast. */
export interface MarginLineLike {
  readonly vertexAnchors: readonly number[];
  readonly controlPoints: readonly Vec3[];
  readonly closed: boolean;
}

function nearestVertexOfTriangle(mesh: IndexedMesh, sp: SurfacePoint): number {
  const [ia, ib, ic] = triangleVertexIndices(mesh, sp.triangleIndex);
  const [wa, wb, wc] = sp.barycentric;
  // Nearest vertex = the one with the LARGEST barycentric weight (closest
  // in the standard sense that barycentric weight is 1 exactly AT that
  // vertex and falls off linearly away from it) — a cheap, deterministic,
  // tie-broken-by-first-max choice; ties (e.g. an edge midpoint) keep the
  // lowest-weight-index vertex, matching this project's usual "lowest index
  // wins" determinism convention (e.g. bvh/closestPoint.ts).
  if (wa >= wb && wa >= wc) return ia;
  if (wb >= wc) return ib;
  return ic;
}

/**
 * Converts a `SurfaceSpline`-shaped control-point list (any ordered
 * `SurfacePoint[]` — deliberately not typed against `SurfaceSpline` itself,
 * so a caller can also convert a partially-built or a geodesic-mode control
 * point list with the same function) to `MarginLineLike`. See this module's
 * top doc for the LOSSY `vertexAnchors` caveat — `controlPoints` carries
 * the exact float position, always.
 */
export function toMarginLine(mesh: IndexedMesh, controlPoints: readonly SurfacePoint[], closed: boolean): MarginLineLike {
  const vertexAnchors = controlPoints.map((sp) => nearestVertexOfTriangle(mesh, sp));
  const points = controlPoints.map((sp) => evaluateSurfacePoint(mesh, sp));
  return { vertexAnchors, controlPoints: points, closed };
}

/**
 * Reconstructs an ordered `SurfacePoint[]` (suitable as `fitSurfaceSpline`'s
 * `points` input, or directly as `SurfaceSpline.controlPoints` after a
 * fresh BVH projection) from a `MarginLineLike`'s `controlPoints` — the
 * float-precision field, authoritative per this module's top doc.
 * `vertexAnchors` is intentionally IGNORED (see that doc's "silent data
 * mutation" reasoning) — every point is independently re-projected via BVH
 * `closestPoint`, exactly `geodesic/surfacePoint.ts`'s `snapToSurface`.
 *
 * @throws {RangeError} if `marginLine.controlPoints` is empty.
 */
export function fromMarginLine(mesh: IndexedMesh, bvh: Bvh, marginLine: MarginLineLike): { controlPoints: SurfacePoint[]; closed: boolean } {
  if (marginLine.controlPoints.length === 0) {
    throw new RangeError('fromMarginLine: marginLine.controlPoints must have at least 1 entry');
  }
  const controlPoints = marginLine.controlPoints.map((p) => snapToSurface(mesh, bvh, p));
  return { controlPoints, closed: marginLine.closed };
}
