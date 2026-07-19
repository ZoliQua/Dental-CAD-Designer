// packages/kernel/src/spline/marginLine.ts
//
// Phase 2 Task 5 / Phase 3 Task 1: converting a `SurfaceSpline` to/from
// shared-types' `MarginLine` shape.
//
// `MarginLine` (packages/shared-types/src/index.ts, schemaVersion 2 —
// Phase 3 Task 1's type evolution):
//
//   interface MarginAnchor {
//     position: Vec3;
//     triangleIndex: number;
//     barycentric: readonly [number, number, number];
//   }
//   interface MarginLine {
//     anchors: readonly MarginAnchor[];
//     closed: boolean;
//     resampledPoints?: readonly Vec3[];
//   }
//
// ## Lossless: `MarginAnchor` IS the `SurfacePoint` currency, plus an exact
// float-precision echo
//
// A `SurfaceSpline`'s control points are `SurfacePoint`s (triangle +
// barycentric — geodesic/types.ts), i.e. ARBITRARY points on the surface,
// exactly like `geodesic/snapPolyline.ts`'s anchors. Phase 2's original
// `MarginLine` (schemaVersion 1) only had `vertexAnchors: readonly
// number[]` — a single NEAREST-vertex index per control point, with no
// representation for "on this triangle, at these barycentric weights" — so
// `toMarginLine`/`fromMarginLine` used to be lossy in one direction (see
// this file's git history / docs/plans/phase-2-kernel-core.md Task 5 for
// the original writeup, and apps/client/src/engine/
// caseDocumentMigration.ts for the schemaVersion 1 -> 2 migration this
// evolution required). `MarginAnchor` carries the EXACT same
// `(triangleIndex, barycentric)` pair `SurfacePoint` does, so this adapter
// is now a straight, lossless field rename/reshape in BOTH directions —
// `toMarginLine` needs no heuristic "nearest vertex" choice, and
// `fromMarginLine` needs no BVH re-projection (and, consequently, no `Bvh`/
// `IndexedMesh` parameter at all — it is now a pure function of
// `MarginLineLike` alone). `position` is carried through as a redundant,
// always-in-sync echo (recomputed via `evaluateSurfacePoint` on the way
// out, never independently trusted on the way back in — see
// `fromMarginLine`'s doc).
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { evaluateSurfacePoint } from '../geodesic/surfacePoint.ts';
import type { SurfacePoint } from '../geodesic/types.ts';

/** The subset of shared-types' `MarginAnchor` this adapter reads/writes —
 * duplicated locally (not imported from `@dqcad/shared-types`), matching
 * `intake/types.ts`'s established "structural twin" convention (that
 * module's `TriangleSoup` is a deliberate structural twin of `@dqcad/io`'s
 * `RawTriangleSoup` for the same reason: the `boundaries/dependencies` lint
 * policy technically ALLOWS `kernel -> shared-types`, but no file in this
 * package actually takes that dependency — `packages/kernel/package.json`
 * has zero workspace `dependencies` today, and this adapter doesn't need to
 * be the first). Structurally identical to `@dqcad/shared-types`'
 * `MarginAnchor` (verified by marginLine.test.ts's exact field-shape test).
 */
export interface MarginAnchorLike {
  readonly position: Vec3;
  readonly triangleIndex: number;
  readonly barycentric: readonly [number, number, number];
}

/** The subset of shared-types' `MarginLine` this adapter reads/writes — see
 * `MarginAnchorLike`'s doc for the "structural twin" convention this
 * follows. Structurally identical to `@dqcad/shared-types`' `MarginLine`
 * (verified by marginLine.test.ts's exact field-shape test), so a
 * `MarginLine` value is always assignable here and vice versa without a
 * cast. */
export interface MarginLineLike {
  readonly anchors: readonly MarginAnchorLike[];
  readonly closed: boolean;
  readonly resampledPoints?: readonly Vec3[];
}

function toSurfacePoint(anchor: MarginAnchorLike): SurfacePoint {
  return { triangleIndex: anchor.triangleIndex, barycentric: anchor.barycentric };
}

/**
 * Converts a `SurfaceSpline`-shaped control-point list (any ordered
 * `SurfacePoint[]` — deliberately not typed against `SurfaceSpline` itself,
 * so a caller can also convert a partially-built or a geodesic-mode control
 * point list with the same function) to `MarginLineLike`. Lossless in both
 * directions (see this module's top doc) — `position` is the evaluated
 * ambient point for each `SurfacePoint`, `triangleIndex`/`barycentric` carry
 * through exactly.
 */
export function toMarginLine(
  mesh: IndexedMesh,
  controlPoints: readonly SurfacePoint[],
  closed: boolean,
  resampledPoints?: readonly Vec3[],
): MarginLineLike {
  const anchors: MarginAnchorLike[] = controlPoints.map((sp) => ({
    position: evaluateSurfacePoint(mesh, sp),
    triangleIndex: sp.triangleIndex,
    barycentric: sp.barycentric,
  }));
  return resampledPoints === undefined ? { anchors, closed } : { anchors, closed, resampledPoints };
}

/**
 * Reconstructs an ordered `SurfacePoint[]` (suitable as `fitSurfaceSpline`'s
 * `points` input after evaluating each to an ambient `Vec3`, or directly as
 * `SurfaceSpline.controlPoints`) from a `MarginLineLike`'s `anchors` —
 * `triangleIndex`/`barycentric` are read straight through (no BVH
 * re-projection needed: see this module's top doc for why this is now
 * lossless and pure). `position` is intentionally IGNORED here (as
 * `vertexAnchors` was under the old scheme) — it is a redundant echo of
 * `evaluateSurfacePoint(mesh, {triangleIndex, barycentric})` against
 * whichever mesh the CALLER already knows is the correct target (this
 * adapter takes no `mesh`/`Bvh` parameter at all, so it has no way to
 * validate or re-derive `position` itself); trusting `triangleIndex`/
 * `barycentric` directly is what "mesh-tied via the restoration's target
 * mesh contentHash context" (shared-types' `MarginAnchor` doc) means in
 * practice — the caller is responsible for passing anchors alongside the
 * SAME mesh content they were produced against.
 *
 * @throws {RangeError} if `marginLine.anchors` is empty.
 */
export function fromMarginLine(marginLine: MarginLineLike): { controlPoints: SurfacePoint[]; closed: boolean } {
  if (marginLine.anchors.length === 0) {
    throw new RangeError('fromMarginLine: marginLine.anchors must have at least 1 entry');
  }
  const controlPoints = marginLine.anchors.map(toSurfacePoint);
  return { controlPoints, closed: marginLine.closed };
}
