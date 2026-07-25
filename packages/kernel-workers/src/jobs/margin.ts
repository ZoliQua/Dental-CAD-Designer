// jobs/margin.ts — proposeMargin (Phase 3 Task 4): @dqcad/kernel's margin/
// module (`proposeMarginLoop` — curvature-ridge (k2) bidirectional crest
// walk + curvature-adaptive anchor simplification; see that module's
// marginRidge.ts for the method, `@errorBound`, and determinism notes) as a
// single worker job.
//
// ## Per-worker caches (mirrors jobs/bvh.ts's `bvhCache` — see that file's
// module doc for the full "why a per-worker cache, why contentHash" writeup)
//
// `buildBvh` must have been called for `payload.contentHash` on THIS worker
// first (jobs/bvh.ts's `requireCachedBvh`) — this job builds neither the
// BVH nor the halfedge overlay nor curvature itself if a cached copy already
// exists; each is a real, non-trivial per-call cost (curvature especially —
// O(vertices + edges)) that a repeated `proposeMargin` call against the SAME
// mesh (e.g. re-proposing after the user nudges the seed) would otherwise
// pay again for no reason. Both caches come from `jobs/meshCache.ts`'s
// CONSOLIDATED per-worker cache (Phase 4 Task 1 carry-in) — this file
// previously kept its OWN independent `halfedgeCache`/`curvatureCache`
// copies (a shape repeated across up to 4 files — see meshCache.ts's module
// doc for the full housekeeping writeup and why consolidating them now is
// safe/output-preserving).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  proposeMarginLoop,
  validateMarginLine,
  MARGIN_SEARCH_RADIUS_MM,
  NoRidgeFoundError,
  NoClosureError,
  type SurfacePoint,
  type MarginLineLike,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireCachedBvh } from './bvh.ts';
import { requireCachedHalfedge, requireCachedCurvature } from './meshCache.ts';
import type { Vec3Payload } from './shared.ts';

export { NoRidgeFoundError, NoClosureError };

/** Worker-safe `SurfacePoint` shape — mirrors jobs/geodesic.ts's own
 * `SurfacePointPayload` (a separate, structurally-identical type per this
 * repo's established per-domain-module convention, not imported across
 * domain files — see jobs/registry.ts's re-export of BOTH under distinct
 * names, `SurfacePointPayload` and `SplineSurfacePointPayload`, for the
 * existing precedent this follows). */
export interface MarginSurfacePointPayload {
  triangleIndex: number;
  barycentric: Vec3Payload;
}

function toSurfacePoint(sp: MarginSurfacePointPayload): SurfacePoint {
  return { triangleIndex: sp.triangleIndex, barycentric: sp.barycentric as SurfacePoint['barycentric'] };
}

export interface ProposeMarginPayload {
  contentHash: string;
  seed: MarginSurfacePointPayload;
  /** See `ProposeMarginLoopOptions` (@dqcad/kernel) — all optional, kernel
   * defaults apply when omitted. */
  searchRadiusMm?: number;
  walkRadiusMm?: number;
  minRidgeStrength?: number;
  closureToleranceMm?: number;
  lookaheadSteps?: number;
  maxStepsPerDirection?: number;
  anchorAngleBudgetRad?: number;
  anchorMaxSpacingMm?: number;
  /** See `ProposeMarginLoopOptions.targetAnchorCount` (@dqcad/kernel) —
   * approximate, curvature-adaptive anchor-count target (Phase 3
   * editor-enhancement task 1). `undefined`: kernel default (current
   * behavior, byte-identical). */
  targetAnchorCount?: number;
}

export interface ProposeMarginResult {
  /** Ordered, closed-loop anchors, flattened — one `triangleIndices` entry
   * and 3 `barycentric` entries per anchor (same convention as
   * jobs/geodesic.ts's `flattenPoints`). Split back via
   * `triangleIndices[i]`/`barycentric[i*3..i*3+2]`. */
  triangleIndices: Uint32Array;
  barycentric: Float64Array;
  closed: true;
  /** Per-segment confidence, `triangleIndices.length` entries, same order
   * (`segmentConfidence[i]` covers anchor `i` -> anchor `(i+1) %
   * anchorCount`) — see `ProposeMarginLoopResult.segmentConfidence`
   * (@dqcad/kernel). */
  segmentConfidence: Float64Array;
  walkVertexCount: number;
  closureDeviationMm: number;
  searchRadiusMm: number;
}

/**
 * `proposeMargin`: curvature-ridge margin-loop auto-proposal on the mesh
 * cached under `payload.contentHash` (`buildBvh` must have been called for
 * it on THIS worker first — see this file's module doc). ONE synchronous,
 * non-yielding kernel call (same cancellation/progress granularity as
 * jobs/geodesic.ts's `geodesicPathJob` — a single checkpoint before starting
 * is this project's established pattern for this shape of job; the real
 * 250k-tri upperjaw fixture's own measured runtime — see this task's
 * report — is well under the sub-second scale that would ever need a
 * mid-call cancellation checkpoint).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if `buildBvh` was never called
 * for `payload.contentHash` on this worker.
 * @throws {NoRidgeFoundError} (@dqcad/kernel) if no ridge locus exists
 * within the bounded search region around `payload.seed`.
 * @throws {NoClosureError} (@dqcad/kernel) if a ridge is found but the walk
 * never closes into a loop.
 */
export const proposeMarginJob = async (payload: ProposeMarginPayload, ctx: JobContext): Promise<ProposeMarginResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh } = requireCachedBvh(payload.contentHash);
  const hm = requireCachedHalfedge(payload.contentHash, mesh);
  const curvature = requireCachedCurvature(payload.contentHash, mesh, hm);
  const seed = toSurfacePoint(payload.seed);

  const result = proposeMarginLoop(mesh, hm, curvature, seed, {
    searchRadiusMm: payload.searchRadiusMm,
    walkRadiusMm: payload.walkRadiusMm,
    minRidgeStrength: payload.minRidgeStrength,
    closureToleranceMm: payload.closureToleranceMm,
    lookaheadSteps: payload.lookaheadSteps,
    maxStepsPerDirection: payload.maxStepsPerDirection,
    anchorAngleBudgetRad: payload.anchorAngleBudgetRad,
    anchorMaxSpacingMm: payload.anchorMaxSpacingMm,
    targetAnchorCount: payload.targetAnchorCount,
  });

  ctx.progress(1);
  const triangleIndices = new Uint32Array(result.anchors.length);
  const barycentric = new Float64Array(result.anchors.length * 3);
  for (let i = 0; i < result.anchors.length; i++) {
    const a = result.anchors[i]!;
    triangleIndices[i] = a.triangleIndex;
    barycentric[i * 3] = a.barycentric[0];
    barycentric[i * 3 + 1] = a.barycentric[1];
    barycentric[i * 3 + 2] = a.barycentric[2];
  }
  return {
    triangleIndices,
    barycentric,
    closed: result.closed,
    segmentConfidence: Float64Array.from(result.segmentConfidence),
    walkVertexCount: result.walkVertexCount,
    closureDeviationMm: result.closureDeviationMm,
    searchRadiusMm: result.searchRadiusMm,
  };
};

/** Re-exported so callers (and tests) can reference the default without a
 * direct `@dqcad/kernel` import in engine code — mirrors kernel-workers'
 * own top-level `index.ts` re-export precedent (e.g. `DEFAULT_MAX_BOUNDARY_EDGES`). */
export { MARGIN_SEARCH_RADIUS_MM };

// ---------------------------------------------------------------------------
// validateMargin (Phase 3 Task 6) — @dqcad/kernel's `validateMarginLine`
// (margin/validate.ts — ambient segment-pair self-intersection, BVH
// on-surface check, discrete-curvature smoothness outliers, degenerate
// anchor-count/length; see that module's doc for the method, tolerances,
// and their measured derivations) as a single worker job.
//
// ## Progress/cancellation (this task's brief: "progress optional for the
// small input, cancellation pre-flight OK — document")
//
// Same shape as `proposeMarginJob` above: ONE synchronous, non-yielding
// kernel call, a single cancellation checkpoint BEFORE starting (no
// mid-call checkpoint). Justified even more strongly here than for
// `proposeMargin`: this task's report measures `validateMarginLine` at
// ~6-9ms on the real 261-anchor arch-case-01 golden margin (well under the
// live-badge <50ms target this task's brief sets) — there is no realistic
// input size for a margin LINE (as opposed to a full mesh) where a
// mid-call progress/cancellation checkpoint would ever matter; a single
// pre-flight `ctx.cancelled()` check is this project's established minimum
// for ANY job (mirrors every other job in this file/package), not a
// special exception for this one.
//
// `buildBvh` must already be cached for `payload.contentHash` on THIS
// worker (jobs/bvh.ts's `requireCachedBvh`) — same per-worker-cache
// contract every other margin-domain job in this file relies on.
// `validateMarginLine` needs no halfedge/curvature (unlike `proposeMargin`
// above) — it operates purely on the mesh + BVH + the margin's own
// (ambient) points, so this job does not touch `halfedgeCache`/
// `curvatureCache` at all.

/** Worker-safe `MarginAnchor` shape (mirrors `MarginSurfacePointPayload`'s
 * own "separate, structurally-identical payload type per domain module"
 * convention — jobs/registry.ts's re-export doc has the precedent this
 * follows). Structurally identical to `@dqcad/shared-types`'
 * `MarginAnchor` / `@dqcad/kernel`'s `MarginAnchorLike`. */
export interface MarginAnchorPayload {
  position: Vec3Payload;
  triangleIndex: number;
  barycentric: Vec3Payload;
}

/** Worker-safe `MarginLine` shape — mirrors `MarginAnchorPayload`'s doc. */
export interface MarginLinePayload {
  anchors: readonly MarginAnchorPayload[];
  closed: boolean;
  resampledPoints?: readonly Vec3Payload[];
}

function toMarginLineLike(margin: MarginLinePayload): MarginLineLike {
  return {
    anchors: margin.anchors.map((a) => ({ position: a.position, triangleIndex: a.triangleIndex, barycentric: a.barycentric })),
    closed: margin.closed,
    ...(margin.resampledPoints !== undefined ? { resampledPoints: margin.resampledPoints } : {}),
  };
}

export interface ValidateMarginPayload {
  contentHash: string;
  margin: MarginLinePayload;
  /** See `ValidateMarginLineOptions` (@dqcad/kernel) — optional, kernel
   * defaults apply when omitted. */
  selfIntersectionToleranceMm?: number;
  smoothnessCurvatureThresholdMmInv?: number;
  /** See `ValidateMarginLineOptions.selfIntersectionLengthScaleFactor`
   * (@dqcad/kernel, Task-11-final-review Important 8) — optional, kernel
   * default applies when omitted. */
  selfIntersectionLengthScaleFactor?: number;
}

/** Plain, small-count result (unlike `ProposeMarginResult`'s flattened
 * typed arrays) — a validation report's finding lists are 0-length for
 * clean input and small (a handful of entries) even for deliberately bad
 * input (this task's own figure-eight/zigzag acceptance fixtures never
 * exceed a few dozen), so there is no payload-size motivation for typed-
 * array flattening here — plain objects keep this job's code (and its
 * callers') simple. Field shape mirrors `@dqcad/kernel`'s
 * `MarginValidationReport` exactly (verified structurally by this file's
 * own job test). */
export interface ValidateMarginResult {
  closed: boolean;
  selfIntersecting: boolean;
  selfIntersections: readonly {
    segmentIndexA: number;
    segmentIndexB: number;
    pointMm: Vec3Payload;
    distanceMm: number;
  }[];
  onSurface: boolean;
  maxSurfaceDeviationMm: number;
  offSurfacePoints: readonly { index: number; pointMm: Vec3Payload; distanceMm: number }[];
  smoothnessWarnings: readonly { index: number; pointMm: Vec3Payload; curvatureMmInv: number }[];
  degenerate: boolean;
  degenerateReasons: readonly ('tooFewAnchors' | 'zeroLength')[];
  validatedPointCount: number;
}

/**
 * `validateMargin`: deterministic margin-line validation on the mesh cached
 * under `payload.contentHash` (`buildBvh` must have been called for it on
 * THIS worker first — see this file's module doc). NEVER throws for a
 * validation finding (per @dqcad/kernel's `validateMarginLine` contract —
 * "REPORTS, not gates") — only a genuine job-infrastructure failure
 * (`BvhNotCachedError`, `JobCancelledError`) throws.
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if `buildBvh` was never called
 * for `payload.contentHash` on this worker.
 */
export const validateMarginJob = async (payload: ValidateMarginPayload, ctx: JobContext): Promise<ValidateMarginResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const margin = toMarginLineLike(payload.margin);
  const report = validateMarginLine(mesh, bvh, margin, {
    selfIntersectionToleranceMm: payload.selfIntersectionToleranceMm,
    smoothnessCurvatureThresholdMmInv: payload.smoothnessCurvatureThresholdMmInv,
    selfIntersectionLengthScaleFactor: payload.selfIntersectionLengthScaleFactor,
  });

  ctx.progress(1);
  return {
    closed: report.closed,
    selfIntersecting: report.selfIntersecting,
    selfIntersections: report.selfIntersections,
    onSurface: report.onSurface,
    maxSurfaceDeviationMm: report.maxSurfaceDeviationMm,
    offSurfacePoints: report.offSurfacePoints,
    smoothnessWarnings: report.smoothnessWarnings,
    degenerate: report.degenerate,
    degenerateReasons: report.degenerateReasons,
    validatedPointCount: report.validatedPointCount,
  };
};
