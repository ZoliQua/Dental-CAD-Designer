// jobs/blockout.ts — blockoutPreview (Phase 3 Task 10): @dqcad/kernel's
// blockout/ module (display-only undercut blockout PREVIEW, "virtual wax" —
// see that module's doc for the scope boundary: NOT a solid, never fed back
// into another kernel op) as a single worker job, extending the axis tool
// (jobs/axis.ts's `suggestAxisJob`/`axisHeatmapJob`).
//
// ## ROI reuse (same union-region shape as axisHeatmapJob)
//
// Takes the SAME `abutmentMarginLoops` shape jobs/axis.ts's jobs already
// use — `extractMarginRegion` per abutment, then `unionRegions` — so the
// blockout preview covers the exact same combined ROI the live undercut
// heatmap already shows, at the SAME `roiRadiusMm` (must match, same
// caveat as `AxisHeatmapPayload.roiRadiusMm`'s own doc).
//
// ## Per-worker caches (BVH + halfedge) — reused, never rebuilt
//
// `buildBvh` must already be cached for `payload.contentHash` on THIS
// worker (jobs/bvh.ts's `requireCachedBvh`) — this job builds neither the
// BVH nor the halfedge overlay itself if a cached copy already exists. The
// halfedge overlay comes from `jobs/meshCache.ts`'s CONSOLIDATED
// per-worker cache (Phase 4 Task 1 carry-in — this file previously kept its
// own independent `halfedgeCache` copy; see meshCache.ts's module doc).
//
// ## Progress & cancellation
//
// `blockoutPreview` itself is a single synchronous call over an ROI-sized
// (typically a few hundred to a few thousand triangles) region — same
// "single cancellation checkpoint before starting, no mid-call chunking"
// shape as jobs/axis.ts's `axisHeatmapJob` (that file's own doc: a
// single-direction ROI-restricted scan measures in the tens of
// milliseconds on the real arch-case-01 fixture; this job additionally
// samples ONE extra depth ray per SELECTED vertex, roughly the same order
// of magnitude of extra raycasts as the selection scan itself — still well
// under a mid-call-cancellation-worthy budget).
//
// ## `thresholdMm` is a REQUIRED payload field — no clinical default here
//
// CLAUDE.md invariant 7 / this repo's "clinical defaults live in
// clinical-profiles/ only" rule extends to this job layer exactly as it
// does to the kernel: this job does NOT fall back to
// `DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM` if `thresholdMm` is omitted — the
// CALLER (apps/client/src/engine/blockout.ts) must import that constant
// from `@dqcad/clinical-profiles` and pass it explicitly, same as every
// other clinical value in this codebase.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  extractMarginRegion,
  unionRegions,
  blockoutPreview,
  AXIS_DEFAULT_ROI_RADIUS_MM,
  EmptyRegionError,
  type SurfacePoint,
  type UndercutSamplingPolicy,
} from '@dqcad/kernel';
import { requireCachedBvh } from './bvh.ts';
import { requireCachedHalfedge } from './meshCache.ts';
import { JobCancelledError, type JobContext } from './context.ts';
import type { Vec3Payload } from './shared.ts';
import type { MarginSurfacePointPayload } from './margin.ts';

export { EmptyRegionError, AXIS_DEFAULT_ROI_RADIUS_MM };

function toSurfacePoint(sp: MarginSurfacePointPayload): SurfacePoint {
  return { triangleIndex: sp.triangleIndex, barycentric: sp.barycentric as SurfacePoint['barycentric'] };
}

export interface BlockoutPreviewPayload {
  /** contentHash of the mesh to preview blockout on — must already be
   * cached via `buildBvh` (jobs/bvh.ts) on THIS worker. */
  contentHash: string;
  /** Same shape/semantics as `AxisHeatmapPayload.abutmentMarginLoops`
   * (jobs/axis.ts) — the preview covers the UNION of every abutment's ROI. */
  abutmentMarginLoops: readonly (readonly MarginSurfacePointPayload[])[];
  /** The CURRENT candidate axis direction (need not be normalized). */
  direction: Vec3Payload;
  /** REQUIRED — no clinical fallback at this layer, see this file's module
   * doc. Callers pass `@dqcad/clinical-profiles`'s
   * `DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM` explicitly (or a user-adjusted
   * value). */
  thresholdMm: number;
  /** Default `AXIS_DEFAULT_ROI_RADIUS_MM` (@dqcad/kernel) — MUST match the
   * radius used for the `suggestAxis`/`axisHeatmap` call this preview is
   * alongside, or the two will disagree about which triangles are "in
   * view" (same caveat as `AxisHeatmapPayload.roiRadiusMm`). */
  roiRadiusMm?: number;
  sampling?: UndercutSamplingPolicy;
}

export interface BlockoutPreviewJobResult {
  /** Flattened preview-mesh positions (mm, WORLD/case frame Float64 — the
   * client converts to a render-frame Float32 copy, same "kernel gives
   * Float64 world-frame, engine converts" split as every other kernel
   * mesh output — see engine/meshStore.ts's `setLod`). `previewPositions`/
   * `previewIndices` are top-level typed arrays (not nested under a `mesh`
   * object) so `jobs/registry.ts`'s zero-copy transfer applies — same
   * "flatten for wire efficiency" convention as `AxisHeatmapResult`. */
  previewPositions: Float64Array;
  previewIndices: Uint32Array;
  directionUnit: Vec3Payload;
  thresholdMm: number;
  regionTriangleCount: number;
  blockoutTriangleCount: number;
  vertexCount: number;
  maxDisplacementMm: number;
  approxVolumeMm3: number;
}

/**
 * `blockoutPreview`: display-only undercut blockout preview on the mesh
 * cached under `payload.contentHash` (`buildBvh` must have been called for
 * it on THIS worker first — see this file's module doc). An empty union ROI
 * (or a region with no triangle passing the threshold) returns an EMPTY
 * preview (`previewPositions`/`previewIndices` both zero-length) rather
 * than throwing — a live preview toggle has no "search to fail", same
 * "empty result, not an error" precedent as `axisHeatmapJob`.
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if `buildBvh` was never called
 * for `payload.contentHash` on this worker.
 */
export const blockoutPreviewJob = async (
  payload: BlockoutPreviewPayload,
  ctx: JobContext,
): Promise<BlockoutPreviewJobResult> => {
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
      previewPositions: new Float64Array(0),
      previewIndices: new Uint32Array(0),
      directionUnit: payload.direction,
      thresholdMm: payload.thresholdMm,
      regionTriangleCount: 0,
      blockoutTriangleCount: 0,
      vertexCount: 0,
      maxDisplacementMm: 0,
      approxVolumeMm3: 0,
    };
  }

  const result = blockoutPreview(mesh, bvh, union, payload.direction, payload.thresholdMm, {
    sampling: payload.sampling,
  });

  ctx.progress(1);
  return {
    previewPositions: result.mesh.previewMesh.positions,
    previewIndices: result.mesh.previewMesh.indices,
    directionUnit: result.directionUnit,
    thresholdMm: result.thresholdMm,
    regionTriangleCount: result.regionTriangleCount,
    blockoutTriangleCount: result.blockoutTriangleCount,
    vertexCount: result.vertexCount,
    maxDisplacementMm: result.maxDisplacementMm,
    approxVolumeMm3: result.approxVolumeMm3,
  };
};
