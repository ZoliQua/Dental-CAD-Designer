// jobs/geodesic.ts — geodesicPath / snapPolyline (Phase 2 Task 4): shortest
// on-surface path between two arbitrary surface points, and geodesic
// polyline snapping (Phase 3's margin-editing primitive) — see
// @dqcad/kernel's geodesic/geodesicPath.ts for the method, `@errorBound`,
// determinism, and boundary-behavior docs; this file is a thin worker
// wrapper (payload validation, flat-typed-array (de)serialization,
// progress/cancellation), same shape as jobs/section.ts.
//
// ## Per-worker caches (mirrors jobs/bvh.ts's `bvhCache` — see that file's
// module doc for the full "why a per-worker cache, why contentHash" writeup)
//
// Both jobs below take a `contentHash` (NOT the raw mesh buffers) and
// require `buildBvh` to have already been called for that contentHash ON
// THIS WORKER (jobs/bvh.ts's `requireCachedBvh`) — repeated single-segment
// margin-edit payloads stay small (no re-sending a quarter-million-triangle
// mesh on every anchor drag), at the cost of the same "build once on a
// pinned size:1 pool, query many times" contract `measurePointToSurface`/
// `raycastMesh` already establish (see jobs/bvh.ts's doc; apps/client/src/
// engine/workers.ts's `ensureBvhBuilt` is the call-site convention this
// assumes).
//
// A SEPARATE per-worker `halfedgeCache`, also keyed by `contentHash`, holds
// the `HalfedgeMesh` overlay `geodesicPath`/`snapPolylineGeodesic` need
// (`buildHalfedge` is a real, if bounded, O(triangles) cost — rebuilding it
// on every single-segment re-snap call would defeat the whole point of
// "incremental" being fast; this task's guardrail specifically targets
// < 100 ms per re-snapped segment on a ~250k-triangle mesh — see
// geodesicJobs.test.ts's perf test). Built lazily on first use for a given
// contentHash (from the SAME cached `IndexedMesh` `requireCachedBvh`
// already holds), then reused for every subsequent `geodesicPath`/
// `snapPolyline` call on this worker for that mesh.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  buildHalfedge,
  geodesicPath,
  snapPolylineGeodesic,
  type HalfedgeMesh,
  type IndexedMesh,
  type SurfacePoint,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { onBvhRelease, requireCachedBvh } from './bvh.ts';
import type { Vec3Payload } from './shared.ts';

const halfedgeCache = new Map<string, HalfedgeMesh>();

// Evict this cache's overlay whenever the SAME contentHash's BVH is
// released (jobs/bvh.ts's `releaseBvh`) — a released mesh's geodesic jobs
// would fail on `requireCachedBvh` anyway, so a still-cached halfedge
// overlay for it is pure leaked memory (tens of MB at real-scan scale). See
// `onBvhRelease`'s doc for why this is a listener, not a direct import from
// jobs/bvh.ts's side.
onBvhRelease((contentHash) => {
  halfedgeCache.delete(contentHash);
});

function requireCachedHalfedge(contentHash: string, mesh: IndexedMesh): HalfedgeMesh {
  const cached = halfedgeCache.get(contentHash);
  if (cached) return cached;
  const hm = buildHalfedge(mesh);
  halfedgeCache.set(contentHash, hm);
  return hm;
}

/** Worker-safe `SurfacePoint` shape — a plain tuple/record (structured-
 * cloned, no typed array needed for 4 numbers), same convention as
 * jobs/bvh.ts's `Vec3Payload`. */
export interface SurfacePointPayload {
  triangleIndex: number;
  barycentric: Vec3Payload;
}

function toSurfacePoint(sp: SurfacePointPayload): SurfacePoint {
  return { triangleIndex: sp.triangleIndex, barycentric: sp.barycentric as SurfacePoint['barycentric'] };
}

/** Flat, transferable encoding of an ordered `SurfacePoint[]` — one
 * `triangleIndices` entry and 3 `barycentric` entries per point (same
 * "flatten a small struct array into parallel typed arrays" convention as
 * jobs/curvature.ts's per-vertex result fields). */
function flattenPoints(points: readonly SurfacePoint[]): { triangleIndices: Uint32Array; barycentric: Float64Array } {
  const triangleIndices = new Uint32Array(points.length);
  const barycentric = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    triangleIndices[i] = p.triangleIndex;
    barycentric[i * 3] = p.barycentric[0];
    barycentric[i * 3 + 1] = p.barycentric[1];
    barycentric[i * 3 + 2] = p.barycentric[2];
  }
  return { triangleIndices, barycentric };
}

export interface GeodesicPathPayload {
  contentHash: string;
  start: SurfacePointPayload;
  end: SurfacePointPayload;
  /** See `GeodesicOptions` (@dqcad/kernel) — both optional, kernel defaults
   * apply when omitted. */
  maxIterations?: number;
  relativeTolerance?: number;
}

export interface GeodesicPathResult {
  /** Ordered path points, flattened — see `flattenPoints`'s doc. Split back
   * into `SurfacePoint`s via `triangleIndices[i]`/`barycentric[i*3..i*3+2]`. */
  triangleIndices: Uint32Array;
  barycentric: Float64Array;
  /** Total path length, mm. */
  length: number;
  /** Corridor-widening passes actually applied — see
   * `GeodesicPathResult.iterations` (@dqcad/kernel) for the convergence
   * criterion this counts against. */
  iterations: number;
  /** Whether straightening genuinely converged before any iteration cap —
   * see `GeodesicPathResult.converged` (@dqcad/kernel) for the exact
   * semantics (`false` means the result is only best-so-far, truncated by
   * `maxIterations`, not a verified local optimum). */
  converged: boolean;
}

/**
 * `geodesicPath`: shortest on-surface path between two arbitrary
 * `SurfacePoint`s (triangle + barycentric) on the mesh cached under
 * `payload.contentHash` (`buildBvh` must have been called for it on THIS
 * worker first — see this file's module doc). ONE synchronous, non-
 * yielding kernel call (same cancellation/progress granularity as
 * jobs/section.ts's `sectionMesh` / jobs/repair.ts's repair jobs — nothing
 * to check cancellation BETWEEN internally at this phase's scale, a single
 * checkpoint before starting is this project's established pattern for
 * this shape of job).
 */
export const geodesicPathJob = async (payload: GeodesicPathPayload, ctx: JobContext): Promise<GeodesicPathResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh } = requireCachedBvh(payload.contentHash);
  const hm = requireCachedHalfedge(payload.contentHash, mesh);
  const start = toSurfacePoint(payload.start);
  const end = toSurfacePoint(payload.end);
  const result = geodesicPath(mesh, hm, start, end, {
    maxIterations: payload.maxIterations,
    relativeTolerance: payload.relativeTolerance,
  });

  ctx.progress(1);
  const { triangleIndices, barycentric } = flattenPoints(result.points);
  return { triangleIndices, barycentric, length: result.length, iterations: result.iterations, converged: result.converged };
};

export interface SnapPolylinePayload {
  contentHash: string;
  /** Flat xyz Float64 mm world-space anchor points (one per anchor,
   * `length === anchorCount * 3`) — the mesh's OWN master buffers are never
   * transferred here (unlike `buildBvh`'s `positions`); this is a small,
   * user-placed handful of points, same convention as jobs/bvh.ts's
   * `measurePointToSurface`. */
  points: Float64Array;
  maxIterations?: number;
  relativeTolerance?: number;
}

export interface SnapPolylineResult {
  /** One entry per anchor (`points.length / 3` entries), the BVH-projected
   * `SurfacePoint`. */
  anchorTriangleIndices: Uint32Array;
  anchorBarycentric: Float64Array;
  /** `anchorCount - 1` segments, each an ordered `SurfacePoint[]`
   * concatenated together — split back using `segmentPointCounts` (point
   * count per segment, same convention as jobs/section.ts's
   * `polylineCounts`). */
  segmentTriangleIndices: Uint32Array;
  segmentBarycentric: Float64Array;
  segmentPointCounts: Uint32Array;
  /** Per-segment total length (mm) and widening-iteration count — same
   * order/length as `segmentPointCounts`. */
  segmentLengths: Float64Array;
  segmentIterations: Uint32Array;
  /** Per-segment `GeodesicPathResult.converged` (@dqcad/kernel), 0/1 encoded
   * (no boolean typed array) — same order/length as `segmentPointCounts`.
   * See `converged` below for the whole-polyline aggregate. */
  segmentConverged: Uint8Array;
  /** `SnappedPolyline.converged` (@dqcad/kernel) — AND of every
   * `segmentConverged` entry (`true` vacuously for 0 segments). */
  converged: boolean;
}

/**
 * `snapPolyline`: projects `payload.points` onto the mesh cached under
 * `payload.contentHash` (BVH required, same as `geodesicPath` above) and
 * joins consecutive anchors with `geodesicPath` segments
 * (`snapPolylineGeodesic`, @dqcad/kernel) — the FULL (re)snap of a whole
 * polyline. Phase 3's margin-line editor calls THIS once for an initial
 * placement, and calls the `geodesicPath` job above directly for the (at
 * most 2) segments touching a single MOVED anchor afterward — see
 * @dqcad/kernel's `snapPolyline.ts` module doc for the documented locality
 * contract this incremental workflow relies on (also proven by
 * packages/kernel/src/geodesic/snapPolyline.test.ts's locality test) and
 * this task's brief for why a separate `resnapPolylineAnchor` job is YAGNI
 * (Phase 3 building it from the two jobs above needs no new worker-side
 * primitive).
 */
export const snapPolyline = async (payload: SnapPolylinePayload, ctx: JobContext): Promise<SnapPolylineResult> => {
  if (!(payload.points instanceof Float64Array)) {
    throw new TypeError('snapPolyline: points must be a Float64Array (kernel Float64 rule)');
  }
  if (payload.points.length % 3 !== 0) {
    throw new RangeError('snapPolyline: points.length must be a multiple of 3');
  }
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const hm = requireCachedHalfedge(payload.contentHash, mesh);
  const anchorCount = payload.points.length / 3;
  const points: [number, number, number][] = new Array(anchorCount);
  for (let i = 0; i < anchorCount; i++) {
    points[i] = [payload.points[i * 3]!, payload.points[i * 3 + 1]!, payload.points[i * 3 + 2]!];
  }

  const polyline = snapPolylineGeodesic(mesh, hm, bvh, points, {
    maxIterations: payload.maxIterations,
    relativeTolerance: payload.relativeTolerance,
  });

  const { triangleIndices: anchorTriangleIndices, barycentric: anchorBarycentric } = flattenPoints(polyline.anchors);

  const segmentPointCounts = new Uint32Array(polyline.segments.length);
  const segmentLengths = new Float64Array(polyline.segments.length);
  const segmentIterations = new Uint32Array(polyline.segments.length);
  const segmentConverged = new Uint8Array(polyline.segments.length);
  let totalSegmentPoints = 0;
  for (let i = 0; i < polyline.segments.length; i++) {
    totalSegmentPoints += polyline.segments[i]!.points.length;
  }
  const segmentTriangleIndices = new Uint32Array(totalSegmentPoints);
  const segmentBarycentric = new Float64Array(totalSegmentPoints * 3);
  let offset = 0;
  for (let i = 0; i < polyline.segments.length; i++) {
    const segment = polyline.segments[i]!;
    segmentPointCounts[i] = segment.points.length;
    segmentLengths[i] = segment.length;
    segmentIterations[i] = segment.iterations;
    segmentConverged[i] = segment.converged ? 1 : 0;
    const flat = flattenPoints(segment.points);
    segmentTriangleIndices.set(flat.triangleIndices, offset);
    segmentBarycentric.set(flat.barycentric, offset * 3);
    offset += segment.points.length;
  }

  ctx.progress(1);
  return {
    anchorTriangleIndices,
    anchorBarycentric,
    segmentTriangleIndices,
    segmentBarycentric,
    segmentPointCounts,
    segmentLengths,
    segmentIterations,
    segmentConverged,
    converged: polyline.converged,
  };
};
