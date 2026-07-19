// jobs/spline.ts — fitSurfaceSpline / fitSurfaceSplineSpan (Phase 2 Task 5):
// centripetal Catmull-Rom splines constrained to a mesh surface — see
// @dqcad/kernel's spline/surfaceSpline.ts for the method, `@errorBound`,
// locality guarantee, and determinism docs; this file is a thin worker
// wrapper (payload validation, flat-typed-array (de)serialization,
// progress/cancellation), same shape as jobs/geodesic.ts.
//
// ## Two entry points, one shared kernel primitive (mirrors jobs/geodesic.ts's
// geodesicPath/snapPolyline split)
//
// - `fitSurfaceSpline`: the WHOLE-CURVE initial fit — ambient (ordinary
//   pick-point) `points` in, a full `SurfaceSpline` (flattened) out. Phase
//   3's margin-line editor calls this ONCE, on initial placement.
// - `fitSurfaceSplineSpan`: fits/refits/RESAMPLES exactly ONE span, given
//   its 4 Barry-Goldman role points' AMBIENT positions plus its own exact
//   start/end `SurfacePoint`s — this is BOTH this task's brief's "refit"
//   entry point (Phase 3 calls it directly for each of the (up to 4) spans
//   `affectedSpanIndices` (re-exported below, pure integer math, no
//   mesh/BVH needed — see that export's own doc) identifies as touching a
//   moved control point, exactly how jobs/geodesic.ts's module doc
//   describes calling `geodesicPath` directly for the (at most 2) segments
//   touching a moved anchor instead of a whole-polyline re-snap) AND its
//   "resample" entry point (calling it again at a different `pointsPerMm`
//   for the SAME role/endpoints re-resamples that span at the new density —
//   no separate job needed, per @dqcad/kernel's `surfaceSpline.ts` module
//   doc, "Geodesic-snapped mode" section's identical "no new worker-side
//   primitive needed" reasoning). A SEPARATE `resampleSurfaceSpline`-style
//   WHOLE-CURVE job is deliberately NOT added here (YAGNI): a caller that
//   wants every span re-resampled just calls this per-span job once per
//   span it's tracking — the same "caller owns which spans to touch"
//   division of responsibility jobs/geodesic.ts already established.
//
// A role point's "prev"/"next" slot can be an OPEN-curve REFLECTED phantom
// point (kernel's `spanRole` doc) — not itself an on-surface point — so
// `role` here is 4 plain ambient xyz payloads, not `SurfacePointPayload`s;
// only the span's own start/end (`startPoint`/`endPoint`) are guaranteed
// on-surface `SurfacePoint`s, reused directly (kernel's
// `fitSurfaceSplineSpan` doc: "reused directly at points[0]/points[last]").
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  affectedSpanIndices,
  fitSurfaceSpline as kernelFitSurfaceSpline,
  fitSurfaceSplineSpan as kernelFitSurfaceSplineSpan,
  type SurfacePoint,
  type SurfaceSplineSpan,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireCachedBvh } from './bvh.ts';
import type { Vec3Payload } from './shared.ts';

// Re-exported so apps/client/src/engine (kernel-workers-only per the layer
// rule — CLAUDE.md's repository map) can compute WHICH spans a moved
// control point touches without importing `@dqcad/kernel` itself, exactly
// jobs/registry.ts's precedent for re-exporting `KERNEL_VERSION` for the
// same "client needs a pure kernel-level value, not a mesh/BVH job" reason.
export { affectedSpanIndices };

/** Worker-safe `SurfacePoint` shape — same convention as jobs/geodesic.ts's
 * identically-named/-shaped export (duplicated here rather than imported
 * across job-domain files, matching this codebase's existing per-domain-
 * module convention — jobs/registry.ts's module doc: "no circular VALUE
 * imports" between domain modules). */
export interface SurfacePointPayload {
  triangleIndex: number;
  barycentric: Vec3Payload;
}

function toSurfacePoint(sp: SurfacePointPayload): SurfacePoint {
  return { triangleIndex: sp.triangleIndex, barycentric: sp.barycentric as SurfacePoint['barycentric'] };
}

/** Flattens an ordered `SurfacePoint[]` into parallel typed arrays — same
 * convention as jobs/geodesic.ts's `flattenPoints`. */
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

interface FlatSpan {
  triangleIndices: Uint32Array;
  barycentric: Float64Array;
  length: number;
  ambientLength: number;
  iterations: number;
  converged: 0 | 1;
  maxAmbientDeviationMm: number;
}

function flattenSpan(span: SurfaceSplineSpan): FlatSpan {
  const { triangleIndices, barycentric } = flattenPoints(span.points);
  return {
    triangleIndices,
    barycentric,
    length: span.length,
    ambientLength: span.ambientLength,
    iterations: span.iterations,
    converged: span.converged ? 1 : 0,
    maxAmbientDeviationMm: span.maxAmbientDeviationMm,
  };
}

// ---------------------------------------------------------------------------
// fitSurfaceSpline — whole-curve initial fit.
// ---------------------------------------------------------------------------

export interface FitSurfaceSplinePayload {
  contentHash: string;
  /** Flat xyz Float64 mm ambient (pre-projection) control points, one per
   * control point — same "small, user-placed handful of points" convention
   * as jobs/geodesic.ts's `SnapPolylinePayload.points`. */
  points: Float64Array;
  closed: boolean;
  /** See @dqcad/kernel's spline/surfaceSpline.ts module doc, "Density"
   * section, for the clinical points-per-mm guidance. */
  pointsPerMm: number;
  maxIterations?: number;
  relativeTolerance?: number;
}

export interface FitSurfaceSplineResult {
  /** One BVH-projected `SurfacePoint` per input control point, flattened —
   * same convention as jobs/geodesic.ts's `SnapPolylineResult.anchor*`. */
  controlPointTriangleIndices: Uint32Array;
  controlPointBarycentric: Float64Array;
  /** `spans.length` entries — see jobs/geodesic.ts's `segmentPointCounts`
   * convention for the identical "counts array + concatenated flat arrays"
   * split-back scheme. */
  spanPointCounts: Uint32Array;
  spanTriangleIndices: Uint32Array;
  spanBarycentric: Float64Array;
  /** Per-span diagnostics — same order/length as `spanPointCounts`. See
   * @dqcad/kernel's `SurfaceSplineSpan` doc for each field's meaning
   * (`maxAmbientDeviationMm` in particular is NOT an off-surface distance —
   * see that doc's `@errorBound` section for why). */
  spanLengths: Float64Array;
  spanAmbientLengths: Float64Array;
  spanIterations: Uint32Array;
  spanConverged: Uint8Array;
  spanMaxAmbientDeviationMm: Float64Array;
  /** `SurfaceSpline.converged`/`maxAmbientDeviationMm` aggregates. */
  converged: boolean;
  maxAmbientDeviationMm: number;
}

export const fitSurfaceSpline = async (payload: FitSurfaceSplinePayload, ctx: JobContext): Promise<FitSurfaceSplineResult> => {
  if (!(payload.points instanceof Float64Array)) {
    throw new TypeError('fitSurfaceSpline: points must be a Float64Array (kernel Float64 rule)');
  }
  if (payload.points.length % 3 !== 0) {
    throw new RangeError('fitSurfaceSpline: points.length must be a multiple of 3');
  }
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const pointCount = payload.points.length / 3;
  const points: Vec3[] = new Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    points[i] = [payload.points[i * 3]!, payload.points[i * 3 + 1]!, payload.points[i * 3 + 2]!];
  }

  const spline = kernelFitSurfaceSpline(mesh, bvh, points, payload.closed, payload.pointsPerMm, {
    maxIterations: payload.maxIterations,
    relativeTolerance: payload.relativeTolerance,
  });

  const { triangleIndices: controlPointTriangleIndices, barycentric: controlPointBarycentric } = flattenPoints(spline.controlPoints);

  const spanPointCounts = new Uint32Array(spline.spans.length);
  const spanLengths = new Float64Array(spline.spans.length);
  const spanAmbientLengths = new Float64Array(spline.spans.length);
  const spanIterations = new Uint32Array(spline.spans.length);
  const spanConverged = new Uint8Array(spline.spans.length);
  const spanMaxAmbientDeviationMm = new Float64Array(spline.spans.length);
  let totalSpanPoints = 0;
  for (const span of spline.spans) totalSpanPoints += span.points.length;
  const spanTriangleIndices = new Uint32Array(totalSpanPoints);
  const spanBarycentric = new Float64Array(totalSpanPoints * 3);

  let offset = 0;
  for (let i = 0; i < spline.spans.length; i++) {
    const flat = flattenSpan(spline.spans[i]!);
    spanPointCounts[i] = flat.triangleIndices.length;
    spanLengths[i] = flat.length;
    spanAmbientLengths[i] = flat.ambientLength;
    spanIterations[i] = flat.iterations;
    spanConverged[i] = flat.converged;
    spanMaxAmbientDeviationMm[i] = flat.maxAmbientDeviationMm;
    spanTriangleIndices.set(flat.triangleIndices, offset);
    spanBarycentric.set(flat.barycentric, offset * 3);
    offset += flat.triangleIndices.length;
  }

  ctx.progress(1);
  return {
    controlPointTriangleIndices,
    controlPointBarycentric,
    spanPointCounts,
    spanTriangleIndices,
    spanBarycentric,
    spanLengths,
    spanAmbientLengths,
    spanIterations,
    spanConverged,
    spanMaxAmbientDeviationMm,
    converged: spline.converged,
    maxAmbientDeviationMm: spline.maxAmbientDeviationMm,
  };
};

// ---------------------------------------------------------------------------
// fitSurfaceSplineSpan — single-span fit/refit/resample (locality — this
// task's brief, deliverable 3 — and "resample" — see this file's top doc).
// ---------------------------------------------------------------------------

export interface FitSurfaceSplineSpanPayload {
  contentHash: string;
  /** Ambient (pre-projection) xyz of the span's 4 Barry-Goldman role points
   * `[prev, start, end, next]` — see @dqcad/kernel's `spanRole` doc for
   * open-curve reflection / closed-curve wrap. The CALLER computes this
   * (Phase 3 tracks its own control-point list) since an open-curve
   * boundary's reflected phantom point is not itself an on-surface point —
   * see this file's top doc. */
  role: readonly [Vec3Payload, Vec3Payload, Vec3Payload, Vec3Payload];
  /** The span's own start/end control points as EXACT `SurfacePoint`s
   * (reused directly at `points[0]`/`points[last]` of the result — see
   * @dqcad/kernel's `SurfaceSplineSpan.points` doc). Must evaluate to the
   * same ambient positions as `role[1]`/`role[2]` respectively — not
   * independently re-validated here (mirrors jobs/geodesic.ts's
   * `geodesicPathJob`, which likewise trusts caller-supplied
   * `SurfacePoint`s without re-deriving them from raw pick points). */
  startPoint: SurfacePointPayload;
  endPoint: SurfacePointPayload;
  pointsPerMm: number;
  maxIterations?: number;
  relativeTolerance?: number;
}

export interface FitSurfaceSplineSpanResult {
  triangleIndices: Uint32Array;
  barycentric: Float64Array;
  length: number;
  ambientLength: number;
  iterations: number;
  converged: boolean;
  maxAmbientDeviationMm: number;
}

export const fitSurfaceSplineSpan = async (
  payload: FitSurfaceSplineSpanPayload,
  ctx: JobContext,
): Promise<FitSurfaceSplineSpanResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const role = payload.role.map((p) => p as Vec3) as [Vec3, Vec3, Vec3, Vec3];
  const startPoint = toSurfacePoint(payload.startPoint);
  const endPoint = toSurfacePoint(payload.endPoint);

  const span = kernelFitSurfaceSplineSpan(mesh, bvh, role, startPoint, endPoint, payload.pointsPerMm, {
    maxIterations: payload.maxIterations,
    relativeTolerance: payload.relativeTolerance,
  });

  ctx.progress(1);
  const { triangleIndices, barycentric } = flattenPoints(span.points);
  return {
    triangleIndices,
    barycentric,
    length: span.length,
    ambientLength: span.ambientLength,
    iterations: span.iterations,
    converged: span.converged,
    maxAmbientDeviationMm: span.maxAmbientDeviationMm,
  };
};

// Re-exported for symmetry with jobs/geodesic.ts's `SurfacePointPayload`
// usage pattern — a caller building a `FitSurfaceSplineSpanPayload.startPoint`/
// `.endPoint` from a PRIOR `fitSurfaceSpline` job's flattened
// `controlPointTriangleIndices`/`controlPointBarycentric` output does so with
// this exact shape.
export function surfacePointPayloadAt(triangleIndices: Uint32Array, barycentric: Float64Array, index: number): SurfacePointPayload {
  return {
    triangleIndex: triangleIndices[index]!,
    barycentric: [barycentric[index * 3]!, barycentric[index * 3 + 1]!, barycentric[index * 3 + 2]!],
  };
}
