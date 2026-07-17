// packages/kernel/src/geodesic/snapPolyline.ts
//
// `snapPolylineGeodesic` (this task's brief, deliverable 2): a polyline of
// arbitrary 3D anchor points, projected onto `mesh`'s surface (via `bvh`),
// with consecutive anchors joined by an exact `geodesicPath` segment. This
// is Phase 3's margin-editing primitive: a clinician drags a handful of
// anchor points near the prep margin, and this produces the actual on-
// surface polyline connecting them.
//
// ## Incremental re-snap API (this task's brief: "shaped for INCREMENTAL
// re-snapping of a single moved anchor — document + test locality")
//
// `resnapPolylineAnchor` moves exactly ONE anchor and recomputes ONLY the
// (up to 2) segments that touch it — `segments[index-1]` (anchor[index-1]
// to the moved anchor) and `segments[index]` (the moved anchor to
// anchor[index+1]) — every other anchor and every other segment is carried
// over UNCHANGED (same array reference — see `resnapPolylineAnchor`'s doc
// and snapPolyline.test.ts's locality test, which asserts `===` identity on
// the untouched segments, not just equal content). This matches the
// project's "meshes immutable" convention (docs/plans/phase-2-kernel-core.md
// Global Constraints) extended to this result shape: neither function
// mutates its input `SnappedPolyline`, each returns a new one.
//
// A margin-line edit typically moves ONE anchor at a time (drag one
// handle); this API is deliberately NOT "re-snap the whole polyline from
// scratch" — see this module's perf test (kernel-workers/geodesicJobs.test.ts)
// for the measured per-segment latency on the real ~250k-triangle upperjaw
// fixture against this task's guardrail (< 100 ms per re-snapped segment).
import type { Bvh } from '../bvh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { HalfedgeMesh } from '../halfedge/types.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { geodesicPath } from './geodesicPath.ts';
import { snapToSurface } from './surfacePoint.ts';
import type { GeodesicOptions, GeodesicPathResult, SurfacePoint } from './types.ts';

export interface SnappedPolyline {
  /** One `SurfacePoint` per input 3D point, in the same order, each
   * projected onto `mesh`'s surface via `bvh` (`snapToSurface`). */
  anchors: SurfacePoint[];
  /** `anchors.length - 1` entries: `segments[i]` is the geodesic path from
   * `anchors[i]` to `anchors[i + 1]`. Empty if fewer than 2 anchors. */
  segments: GeodesicPathResult[];
}

/**
 * Projects every point in `points` onto `mesh`'s surface (via `bvh`) and
 * joins consecutive anchors with an exact `geodesicPath` segment. See this
 * module's doc for the incremental re-snap counterpart
 * (`resnapPolylineAnchor`).
 *
 * @throws {RangeError} if `points` has fewer than 1 entry.
 */
export function snapPolylineGeodesic(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  bvh: Bvh,
  points: readonly Vec3[],
  options: GeodesicOptions = {},
): SnappedPolyline {
  if (points.length < 1) {
    throw new RangeError('snapPolylineGeodesic: points must have at least 1 entry');
  }
  const anchors = points.map((p) => snapToSurface(mesh, bvh, p));
  const segments: GeodesicPathResult[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    segments.push(geodesicPath(mesh, hm, anchors[i]!, anchors[i + 1]!, options));
  }
  return { anchors, segments };
}

/**
 * Moves `polyline.anchors[index]` to `newPoint` (re-projected onto `mesh`'s
 * surface via `bvh`) and recomputes ONLY the (up to 2) segments touching it
 * — see this module's top doc for the locality guarantee. `polyline` itself
 * is never mutated.
 *
 * @throws {RangeError} if `index` is out of range for `polyline.anchors`.
 */
export function resnapPolylineAnchor(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  bvh: Bvh,
  polyline: SnappedPolyline,
  index: number,
  newPoint: Vec3,
  options: GeodesicOptions = {},
): SnappedPolyline {
  if (index < 0 || index >= polyline.anchors.length || !Number.isInteger(index)) {
    throw new RangeError(
      `resnapPolylineAnchor: index ${index} out of range for a polyline with ${polyline.anchors.length} anchors`,
    );
  }

  const anchors = polyline.anchors.slice();
  anchors[index] = snapToSurface(mesh, bvh, newPoint);

  const segments = polyline.segments.slice();
  if (index > 0) {
    segments[index - 1] = geodesicPath(mesh, hm, anchors[index - 1]!, anchors[index]!, options);
  }
  if (index < anchors.length - 1) {
    segments[index] = geodesicPath(mesh, hm, anchors[index]!, anchors[index + 1]!, options);
  }

  return { anchors, segments };
}
