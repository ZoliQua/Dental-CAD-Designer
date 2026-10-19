// jobs/neighbourRegion.ts — the proximal NEIGHBOUR CAPTURE job (Phase 9 Task
// 3, ADR-022 Decision 3): @dqcad/kernel's `extractNeighbourRegion` on the
// case's arch scan, which is BVH-cache-resident on this worker (jobs/bvh.ts's
// `requireCachedBvh` — the caller runs `buildBvh` first with the same
// `affinityKey`). See the kernel op's module doc for the window rules, the
// closure and `@errorBound`.
//
// The op is a fast synchronous Float64 pass, so progress is coarse (0 → 1)
// with one cancellation checkpoint up front; neither affects any computed
// value (byte-identical to a direct kernel call — extractNeighbourRegionJob.
// test.ts).
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import { extractNeighbourRegion, type NeighbourRegionOptions, type Vec3 } from '@dqcad/kernel';
import { requireCachedBvh } from './bvh.ts';
import { JobCancelledError, type JobContext } from './context.ts';

export interface ExtractNeighbourRegionPayload {
  /** Content hash of the arch scan (its BVH must be cached on this worker). */
  contentHash: string;
  /** The user's pick on the neighbour tooth (mm, world). */
  seed: Vec3;
  /** The restoration's margin loop, flat xyz (centroid + reach). */
  marginLoop: Float64Array;
  insertionAxis: Vec3;
  /** Kernel ALGORITHM overrides (defaults applied by the kernel op). */
  options?: NeighbourRegionOptions;
}

export interface ExtractNeighbourRegionResult {
  /** Closed solid; the first `capturedTriangleCount` triangles are the
   * verbatim scan surface. */
  positions: Float64Array;
  indices: Uint32Array;
  capturedTriangleCount: number;
  sourceTriangleIndices: Uint32Array;
  seedOnSurface: Vec3;
  approachDirection: Vec3;
  separatingPlanePoint: Vec3;
  capturedAreaMm2: number;
  windowBoundaryBandMm: number;
  foldTrianglesDropped: number;
  approach: 'proximal' | 'occlusal';
  radiusMm: number;
  minFacingCos: number;
  cervicalOffsetMm: number;
  closureDepthMm: number;
}

/**
 * `extractNeighbourRegion` worker job.
 *
 * @throws {TypeError} a malformed margin loop (before any work).
 * @throws {BvhNotCachedError} (jobs/bvh.ts) no BVH cached for `contentHash`.
 * @throws {JobCancelledError} if cancelled.
 * @throws propagates the kernel's typed errors (`NeighbourSeedTooCloseError`,
 * `NeighbourRegionEmptyError`, `NeighbourRegionInvalidError`).
 */
export const extractNeighbourRegionJob = async (
  payload: ExtractNeighbourRegionPayload,
  ctx: JobContext,
): Promise<ExtractNeighbourRegionResult> => {
  if (!(payload.marginLoop instanceof Float64Array) || payload.marginLoop.length % 3 !== 0) {
    throw new TypeError('extractNeighbourRegion: marginLoop must be a Float64Array of xyz triples');
  }
  ctx.progress(0);
  if (await ctx.cancelled()) throw new JobCancelledError();
  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const loop: Vec3[] = [];
  for (let i = 0; i < payload.marginLoop.length; i += 3) {
    loop.push([payload.marginLoop[i]!, payload.marginLoop[i + 1]!, payload.marginLoop[i + 2]!]);
  }
  const r = extractNeighbourRegion(
    mesh,
    bvh,
    payload.seed,
    loop,
    payload.insertionAxis,
    payload.options ?? {},
  );
  ctx.progress(1);
  return {
    positions: r.mesh.positions,
    indices: r.mesh.indices,
    capturedTriangleCount: r.capturedTriangleCount,
    sourceTriangleIndices: r.sourceTriangleIndices,
    seedOnSurface: r.seedOnSurface,
    approachDirection: r.approachDirection,
    separatingPlanePoint: r.separatingPlane.point,
    capturedAreaMm2: r.capturedAreaMm2,
    windowBoundaryBandMm: r.windowBoundaryBandMm,
    foldTrianglesDropped: r.foldTrianglesDropped,
    approach: r.approach,
    radiusMm: r.radiusMm,
    minFacingCos: r.minFacingCos,
    cervicalOffsetMm: r.cervicalOffsetMm,
    closureDepthMm: r.closureDepthMm,
  };
};
