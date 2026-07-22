// jobs/axis.ts — suggestAxis (Phase 3 Task 9): @dqcad/kernel's axis/ module
// (`extractMarginRegion` + `suggestInsertionAxisForRegions`) as a single
// worker job. Always takes a LIST of margin loops (one per abutment) —
// length 1 for crown/inlay/onlay, length > 1 for a bridge (PLAN: one COMMON
// axis over the union of abutment regions + per-abutment undercut report) —
// so this job has exactly one payload shape for both cases, no separate
// "bridge job".
//
// ## Per-worker caches (mirrors jobs/margin.ts's halfedgeCache — same "why a
// per-worker cache, why contentHash" writeup, duplicated per this repo's
// established per-domain-module convention rather than shared)
//
// `buildBvh` must have been called for `payload.contentHash` on THIS worker
// first (jobs/bvh.ts's `requireCachedBvh`) — this job builds neither the BVH
// nor the halfedge overlay itself if a cached copy already exists.
//
// ## Progress & cancellation
//
// `suggestInsertionAxisForRegions`'s underlying `suggestInsertionAxis` call
// reports progress once per DIRECTION (a "batch" — the same terminology
// jobs/undercut.ts's module doc uses for undercutScanBatch's own per-
// direction checkpoint) via its `onProgress` option — wired straight through
// to `ctx.progress` here. Region EXTRACTION (`extractMarginRegion`, a
// Dijkstra ball — fast, see roi.ts's own doc: a whole-mesh triangle scan,
// no raycasting) and the whole search itself are NOT chunked internally
// (unlike jobs/undercut.ts's `runChunkedDirectionScan`, which drives
// `undercutScanRange` chunk-by-chunk for real mid-direction cancellation):
// this task's own measured real-fixture timing (~1.6-1.7s for the full
// default sweep — see this task's report) is well under the sub-2s scale
// where a mid-direction cancellation checkpoint would matter; a single
// `ctx.cancelled()` check before starting (proposeMarginJob's established
// precedent for this shape of job) is sufficient here too.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  buildHalfedge,
  extractMarginRegion,
  unionRegions,
  suggestInsertionAxisForRegions,
  undercutScanIndices,
  AXIS_DEFAULT_ROI_RADIUS_MM,
  AXIS_SEARCH_PRESETS,
  EmptyRegionError,
  DegenerateRegionNormalError,
  type HalfedgeMesh,
  type IndexedMesh,
  type SurfacePoint,
  type UndercutSamplingPolicy,
} from '@dqcad/kernel';
import { onBvhRelease, requireCachedBvh } from './bvh.ts';
import { JobCancelledError, type JobContext } from './context.ts';
import type { Vec3Payload } from './shared.ts';
import type { MarginSurfacePointPayload } from './margin.ts';

export { EmptyRegionError, DegenerateRegionNormalError, AXIS_DEFAULT_ROI_RADIUS_MM, AXIS_SEARCH_PRESETS };

/** `AXIS_SEARCH_PRESETS`' own key type — re-exported so engine code (which
 * may only import `@dqcad/kernel-workers`, never `@dqcad/kernel` directly —
 * CLAUDE.md layer rule) can name `'interactive' | 'precise'` without a
 * direct kernel dependency (Fix batch, Important 7). */
export type AxisSearchPresetName = keyof typeof AXIS_SEARCH_PRESETS;

// Duplicated per-worker halfedge cache — mirrors jobs/margin.ts's own
// `halfedgeCache` (that file's doc explains why this is duplicated per
// domain module rather than shared, and notes the existing 3-file repeat as
// a housekeeping item — this is the same, now-4th, established shape, not a
// new pattern).
const halfedgeCache = new Map<string, HalfedgeMesh>();
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

function toSurfacePoint(sp: MarginSurfacePointPayload): SurfacePoint {
  return { triangleIndex: sp.triangleIndex, barycentric: sp.barycentric as SurfacePoint['barycentric'] };
}

export interface SuggestAxisPayload {
  /** contentHash of the mesh to search — must already be cached via
   * `buildBvh` (jobs/bvh.ts) on THIS worker. */
  contentHash: string;
  /** One entry per abutment's margin loop — length 1 for crown/inlay/onlay,
   * length > 1 for a bridge. Each loop should be dense enough that
   * consecutive points are closer together than `roiRadiusMm` (a
   * restoration's confirmed `MarginLine.resampledPoints`, converted to
   * on-mesh SurfacePoints client-side via `snapToSurface`/its own anchors —
   * this job has no opinion on which; it only needs a triangle+barycentric
   * per point, same currency `MarginSurfacePointPayload` already uses for
   * `proposeMargin`/`validateMargin`). */
  abutmentMarginLoops: readonly (readonly MarginSurfacePointPayload[])[];
  /** Default `AXIS_DEFAULT_ROI_RADIUS_MM` (@dqcad/kernel). */
  roiRadiusMm?: number;
  coarseCount?: number;
  refineCount?: number;
  refineCapAngleRad?: number;
  sampling?: UndercutSamplingPolicy;
}

export interface SuggestAxisCandidatePayload {
  direction: Vec3Payload;
  scoreMm3: number;
  undercutAreaMm2: number;
  maxDepthMm: number;
  undercutTriangleCount: number;
}

export interface SuggestAxisResult {
  best: SuggestAxisCandidatePayload;
  /** Every evaluated candidate, sorted ascending by `scoreMm3` — same order
   * guarantee as @dqcad/kernel's `SuggestInsertionAxisResult.ranked`. */
  ranked: readonly SuggestAxisCandidatePayload[];
  poleUsed: Vec3Payload;
  coarseCount: number;
  refineCount: number;
  /** One entry per INPUT abutment loop (same order as
   * `payload.abutmentMarginLoops`) — that abutment's own undercut stats
   * evaluated AT `best.direction` (@dqcad/kernel's `suggestInsertionAxisForRegions`
   * "per-abutment report", not an independent per-abutment optimization). */
  perAbutment: readonly SuggestAxisCandidatePayload[];
  /** ROI triangle count per abutment (same order) — informational (UI
   * coverage/perf display), not used by the search itself. */
  regionTriangleCounts: readonly number[];
}

function toCandidatePayload(c: { direction: readonly [number, number, number]; scoreMm3: number; undercutAreaMm2: number; maxDepthMm: number; undercutTriangleCount: number }): SuggestAxisCandidatePayload {
  return {
    direction: c.direction,
    scoreMm3: c.scoreMm3,
    undercutAreaMm2: c.undercutAreaMm2,
    maxDepthMm: c.maxDepthMm,
    undercutTriangleCount: c.undercutTriangleCount,
  };
}

/**
 * `suggestAxis`: insertion-axis auto-suggestion on the mesh cached under
 * `payload.contentHash` (`buildBvh` must have been called for it on THIS
 * worker first — see this file's module doc).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if `buildBvh` was never called
 * for `payload.contentHash` on this worker.
 * @throws {EmptyRegionError} (@dqcad/kernel) if `payload.abutmentMarginLoops`
 * is empty, or every extracted ROI is empty (e.g. a margin loop with zero
 * points, or a `roiRadiusMm` too small to reach any mesh vertex).
 * @throws {DegenerateRegionNormalError} (@dqcad/kernel) if the union ROI's
 * area-weighted outward normals sum to a negligible vector (no well-defined
 * hemisphere pole) — a genuinely degenerate/symmetric region.
 */
export const suggestAxisJob = async (payload: SuggestAxisPayload, ctx: JobContext): Promise<SuggestAxisResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const hm = requireCachedHalfedge(payload.contentHash, mesh);
  const roiRadiusMm = payload.roiRadiusMm ?? AXIS_DEFAULT_ROI_RADIUS_MM;

  const regions = payload.abutmentMarginLoops.map((loop) =>
    extractMarginRegion(mesh, hm, loop.map(toSurfacePoint), roiRadiusMm),
  );

  const { common, perRegion } = suggestInsertionAxisForRegions(mesh, bvh, regions, {
    coarseCount: payload.coarseCount,
    refineCount: payload.refineCount,
    refineCapAngleRad: payload.refineCapAngleRad,
    sampling: payload.sampling,
    onProgress: (done, total) => ctx.progress(total > 0 ? done / total : 1),
  });

  ctx.progress(1);
  return {
    best: toCandidatePayload(common.best),
    ranked: common.ranked.map(toCandidatePayload),
    poleUsed: common.poleUsed,
    coarseCount: common.coarseCount,
    refineCount: common.refineCount,
    perAbutment: perRegion.map(toCandidatePayload),
    regionTriangleCounts: regions.map((r) => r.triangleIndices.length),
  };
};

// ---------------------------------------------------------------------------
// axisHeatmap — a SINGLE-direction, ROI-restricted undercut scan, for the
// UI's LIVE undercut µm-depth heatmap while the user manually drags the
// axis gizmo/sliders (this task's brief). Deliberately NOT the full
// coarse->fine `suggestAxis` search above — a manual adjustment needs "how
// bad is UNDERCUT AT THIS EXACT DIRECTION, right now", not a re-optimization.
// Reuses the exact same ROI-restriction primitive (`undercutScanIndices`)
// `suggestInsertionAxis` itself is built on (see that kernel module's
// "Why the ROI restricts the SCAN's triangle set" doc for the measured
// 45s-whole-mesh-vs-ROI motivation) — a single direction against the same
// ~13700-triangle real-fixture ROI measures in the tens of milliseconds
// (this task's report — comfortably under the brief's <200ms per-adjustment
// target), not the ~1s+ a whole-mesh single-direction scan would cost.
// ---------------------------------------------------------------------------

export interface AxisHeatmapPayload {
  contentHash: string;
  /** Same shape as `SuggestAxisPayload.abutmentMarginLoops` — the heatmap
   * covers the UNION of every abutment's ROI (a bridge's live preview shows
   * every abutment's undercut at once, per this task's brief: "per-abutment
   * readout for bridges"). */
  abutmentMarginLoops: readonly (readonly MarginSurfacePointPayload[])[];
  /** The CURRENT candidate axis direction (need not be normalized). */
  direction: Vec3Payload;
  /** Default `AXIS_DEFAULT_ROI_RADIUS_MM` (@dqcad/kernel) — MUST match the
   * radius used for the `suggestAxis` call this heatmap is previewing
   * around, or the two will disagree about which triangles are "in view". */
  roiRadiusMm?: number;
  sampling?: UndercutSamplingPolicy;
}

export interface AxisHeatmapAbutmentStats {
  undercutTriangleCount: number;
  maxDepthMm: number;
  regionTriangleCount: number;
}

export interface AxisHeatmapResult {
  /** The union-ROI's triangle indices (sorted ascending, de-duplicated) —
   * ALIGNED 1:1 with `undercut`/`depthMm` below. The UI maps this directly
   * into per-vertex colors on the target mesh's render copy (documented
   * mapping — see apps/client/src/engine/axis.ts). */
  triangleIndices: Uint32Array;
  undercut: Uint8Array;
  depthMm: Float64Array;
  // NO `undercutAreaMm2` field here (Task-11-review Critical 1): unlike
  // `suggestAxisJob`'s candidate stats (which DO compute a real per-triangle-
  // area sum — @dqcad/kernel's `suggestInsertionAxis.ts`), this live single-
  // direction preview never computes area at all — it would need the same
  // per-triangle geometry the UI doesn't need for a color-only preview (see
  // the comment at this field's old call site in `axisHeatmapJob` below).
  // Previously this interface DID carry an `undercutAreaMm2` field, always
  // hardcoded to `0` — a real-metric-named field that could never hold a
  // real measurement. `apps/client/src/ui/AxisPanel.tsx` renders an
  // "Undercut area" column fed by `perAbutment` readouts, and a fabricated
  // `0` there reads as "confirmed zero undercut area", which is actively
  // wrong (not merely absent) for a clinician deciding on an insertion
  // axis. Omitting the field entirely (rather than keeping a
  // permanently-`0` one) makes the absence a TYPE ERROR at any call site
  // that tries to read it, instead of a silent wrong number — the honest
  // choice CLAUDE.md's "a wrong quantitative clinical readout is worse than
  // none" rule calls for. `apps/client/src/engine/axis.ts`'s
  // `refreshHeatmap` now preserves the last real (suggest-time)
  // `undercutAreaMm2` per abutment across a heatmap-only recompute instead
  // of clobbering it — see that method's own doc.
  maxDepthMm: number;
  undercutTriangleCount: number;
  /** One entry per INPUT abutment loop (same order as
   * `payload.abutmentMarginLoops`) — this task's brief: "per-abutment
   * readout for bridges", now for the LIVE manual-adjust heatmap too, not
   * just `suggestAxis`'s own result. */
  perAbutment: readonly AxisHeatmapAbutmentStats[];
}

/**
 * `axisHeatmap`: one direction's undercut/depth over the union ROI, on the
 * mesh cached under `payload.contentHash` (`buildBvh` must have been called
 * for it on THIS worker first — see this file's module doc). ONE
 * synchronous, non-yielding kernel call (same shape/precedent as
 * `proposeMarginJob`/`validateMarginJob`/`suggestAxisJob` above — a single
 * cancellation checkpoint before starting; this task's report measures this
 * well under the 200ms per-adjustment budget, no mid-call checkpoint
 * needed).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if `buildBvh` was never called
 * for `payload.contentHash` on this worker.
 * @throws {EmptyRegionError} (@dqcad/kernel) — NOT actually thrown by this
 * job (unlike `suggestAxisJob`): an empty union ROI here just returns an
 * empty result (nothing to color), since a live-preview heatmap has no
 * search to fail — see this function's body.
 */
export const axisHeatmapJob = async (payload: AxisHeatmapPayload, ctx: JobContext): Promise<AxisHeatmapResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const hm = requireCachedHalfedge(payload.contentHash, mesh);
  const roiRadiusMm = payload.roiRadiusMm ?? AXIS_DEFAULT_ROI_RADIUS_MM;

  const regions = payload.abutmentMarginLoops.map((loop) =>
    extractMarginRegion(mesh, hm, loop.map(toSurfacePoint), roiRadiusMm),
  );
  const union = unionRegions(regions);

  if (union.triangleIndices.length === 0) {
    ctx.progress(1);
    return {
      triangleIndices: new Uint32Array(0),
      undercut: new Uint8Array(0),
      depthMm: new Float64Array(0),
      maxDepthMm: 0,
      undercutTriangleCount: 0,
      perAbutment: regions.map(() => ({ undercutTriangleCount: 0, maxDepthMm: 0, regionTriangleCount: 0 })),
    };
  }

  const scan = undercutScanIndices(mesh, bvh, payload.direction, union.triangleIndices, { sampling: payload.sampling });
  // Per-abutment breakdown: one additional (cheap — region-sized, not
  // union-sized) `undercutScanIndices` call per abutment, same "small
  // per-region call, not a re-run of the whole scan" precedent as
  // `suggestInsertionAxisForRegions`'s own `perRegion` computation
  // (@dqcad/kernel). For a single-abutment restoration (the common case)
  // this is one extra call over an IDENTICAL region to `union` — still
  // cheap (region-sized, not mesh-sized) and keeps this job's code uniform
  // rather than special-casing length===1.
  const perAbutment: AxisHeatmapAbutmentStats[] = regions.map((region) => {
    const regionScan = undercutScanIndices(mesh, bvh, payload.direction, region.triangleIndices, { sampling: payload.sampling });
    return {
      undercutTriangleCount: regionScan.undercutTriangleCount,
      maxDepthMm: regionScan.maxDepthMm,
      regionTriangleCount: region.triangleIndices.length,
    };
  });

  ctx.progress(1);
  return {
    triangleIndices: union.triangleIndices,
    undercut: scan.undercut,
    depthMm: scan.depthMm,
    // No `undercutAreaMm2` here — see `AxisHeatmapResult`'s own doc above
    // for why this job never computes one (it's only meaningful together
    // with per-triangle geometry a color-only preview doesn't need);
    // undercutTriangleCount/maxDepthMm are still useful as a cheap numeric
    // readout alongside the color map.
    maxDepthMm: scan.maxDepthMm,
    undercutTriangleCount: scan.undercutTriangleCount,
    perAbutment,
  };
};
