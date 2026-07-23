// jobs/innerSurface.ts — the crown INNER-SURFACE stage (Phase 4 Tasks 3+4):
// @dqcad/kernel's `buildInnerSurface` — the two-zone cement-gap offset + SOLID
// undercut blockout (draft-close along the insertion axis) + skirt-to-margin,
// producing the finished intaglio whose boundary loop == the margin polyline.
// See @dqcad/kernel's innerSurfaceSolid.ts for the formulation, the draft-close
// correctness proof, the skirt construction, and `@errorBound`.
//
// ## Progress, cancellation & byte-identity
//
// The job calls `buildInnerSurface` directly, passing progress/cancellation
// HOOKS (`onProgress`/`checkCancel`) that the kernel op invokes across its
// field-grid loop and phase boundaries. Those hooks affect NO computed value,
// so the job's result is BYTE-IDENTICAL to a direct `buildInnerSurface` call
// (pinned by innerSurfaceJob.test.ts) — the same "hooks don't change the math"
// contract, without re-driving the primitives here. `checkCancel` throws
// `JobCancelledError` to cancel cooperatively between field slices.
//
// Progress budget (from the kernel op): 0 start, 0.05 after ROI, field-grid
// slices 0.05->0.80, 0.90 after the blockout marching cubes, 1 after the skirt
// + orient. A cache HIT skips straight to 1.
//
// ## Per-worker result cache
//
// Takes a `contentHash` (NOT raw buffers) and requires `buildBvh` to have run
// for it on THIS worker (jobs/bvh.ts's `requireCachedBvh`) — reusing only the
// cached MESH (the kernel op builds its own axis-frame BVH internally, so the
// world-frame cached BVH is not reused here; documented). Keyed by
// `contentHash` then a `paramKey` (gaps/spacer/blend/pitch/axis + margin loop).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  buildInnerSurface,
  blendZoneLipschitz,
  MIN_PITCH_MM,
  PitchTooSmallError,
  BlendWidthTooNarrowError,
  type InnerSurfaceGapParams,
  type MeshStats,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { onBvhRelease, requireCachedBvh } from './bvh.ts';

export interface InnerSurfacePayload {
  contentHash: string;
  pitchMm: number;
  marginalGapMm: number;
  cementGapMm: number;
  spacerStartMm: number;
  blendWidthMm: number;
  /** The dense on-surface margin loop, flat xyz (transferable) — rebuilt into
   * Vec3[] inside the job. */
  marginLoop: Float64Array;
  /** Insertion axis (crown draw direction) — the blockout draft-closes along it. */
  insertionAxis: Vec3;
}

export interface InnerSurfaceResult {
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  /** Worst-case (blend-zone) offset error bound, mm — see @dqcad/kernel's
   * innerSurfaceSolid.ts `@errorBound`. */
  errorBoundMm: number;
  /** Tighter flat-zone (marginal/cement) bound, mm. */
  flatZoneErrorBoundMm: number;
  /** Triangle counts (blocked offset patch / margin skirt). */
  patchTriangleCount: number;
  skirtTriangleCount: number;
  marginVertexCount: number;
  marginalGapMm: number;
  cementGapMm: number;
  spacerStartMm: number;
  blendWidthMm: number;
  pitchMm: number;
}

const innerSurfaceCache = new Map<string, Map<string, InnerSurfaceResult>>();

function paramKey(p: InnerSurfacePayload): string {
  return JSON.stringify({
    pitchMm: p.pitchMm,
    marginalGapMm: p.marginalGapMm,
    cementGapMm: p.cementGapMm,
    spacerStartMm: p.spacerStartMm,
    blendWidthMm: p.blendWidthMm,
    insertionAxis: p.insertionAxis,
    marginLoop: Array.from(p.marginLoop),
  });
}

onBvhRelease((contentHash) => {
  innerSurfaceCache.delete(contentHash);
});

function cloneCachedResult(r: InnerSurfaceResult): InnerSurfaceResult {
  return {
    positions: r.positions.slice(),
    indices: r.indices.slice(),
    stats: r.stats,
    errorBoundMm: r.errorBoundMm,
    flatZoneErrorBoundMm: r.flatZoneErrorBoundMm,
    patchTriangleCount: r.patchTriangleCount,
    skirtTriangleCount: r.skirtTriangleCount,
    marginVertexCount: r.marginVertexCount,
    marginalGapMm: r.marginalGapMm,
    cementGapMm: r.cementGapMm,
    spacerStartMm: r.spacerStartMm,
    blendWidthMm: r.blendWidthMm,
    pitchMm: r.pitchMm,
  };
}

function rebuildLoop(flat: Float64Array): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

/**
 * `innerSurface` worker job — see this file's module doc for the staged
 * progress/cancellation contract, the per-worker cache, and the byte-identity
 * argument vs. `buildInnerSurface`. `buildBvh` must have been called for
 * `payload.contentHash` on THIS worker first (its cached MESH is used).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) on a cache MISS if BVH was never built.
 * @throws {TypeError} for invalid pitch/gaps/spacer/blend/loop/axis (before heavy work).
 * @throws {PitchTooSmallError} / {BlendWidthTooNarrowError} / {NonWatertightMeshError}
 * / {SdfGridTooLargeError} / {EmptyOffsetResultError} / {NoBoundaryLoopError} (@dqcad/kernel).
 */
export const innerSurfaceJob = async (payload: InnerSurfacePayload, ctx: JobContext): Promise<InnerSurfaceResult> => {
  const { contentHash, pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, insertionAxis } = payload;

  // Fail-fast validation, mirroring buildInnerSurface's own guards.
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`innerSurface: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  if (pitchMm < MIN_PITCH_MM) {
    throw new PitchTooSmallError(pitchMm);
  }
  for (const [name, value] of [
    ['marginalGapMm', marginalGapMm],
    ['cementGapMm', cementGapMm],
  ] as const) {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new TypeError(`innerSurface: ${name} must be finite and >= 0, got ${value}`);
    }
  }
  if (!(Number.isFinite(spacerStartMm) && spacerStartMm > 0)) {
    throw new TypeError(`innerSurface: spacerStartMm must be finite and > 0, got ${spacerStartMm}`);
  }
  if (!(Number.isFinite(blendWidthMm) && blendWidthMm > 0)) {
    throw new TypeError(`innerSurface: blendWidthMm must be finite and > 0, got ${blendWidthMm}`);
  }
  const gapParams: InnerSurfaceGapParams = { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm };
  if (!(blendZoneLipschitz(gapParams) < 1)) {
    throw new BlendWidthTooNarrowError(blendWidthMm, Math.abs(cementGapMm - marginalGapMm));
  }
  if (!payload.marginLoop || payload.marginLoop.length < 9) {
    throw new TypeError(`innerSurface: marginLoop must have >= 3 points (>= 9 flat coords)`);
  }

  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const cached = innerSurfaceCache.get(contentHash)?.get(paramKey(payload));
  if (cached) {
    ctx.progress(1);
    return cloneCachedResult(cached);
  }

  const { mesh } = requireCachedBvh(contentHash);
  const marginLoop = rebuildLoop(payload.marginLoop);

  const result = await buildInnerSurface(
    mesh,
    { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, pitchMm, marginLoop, insertionAxis },
    {
      onProgress: (f) => ctx.progress(f),
      checkCancel: async () => {
        if (await ctx.cancelled()) throw new JobCancelledError();
      },
    },
  );

  const jobResult: InnerSurfaceResult = {
    positions: result.mesh.positions,
    indices: result.mesh.indices,
    stats: result.stats,
    errorBoundMm: result.errorBoundMm,
    flatZoneErrorBoundMm: result.flatZoneErrorBoundMm,
    patchTriangleCount: result.patchTriangleCount,
    skirtTriangleCount: result.skirtTriangleCount,
    marginVertexCount: result.marginVertexCount,
    marginalGapMm: result.marginalGapMm,
    cementGapMm: result.cementGapMm,
    spacerStartMm: result.spacerStartMm,
    blendWidthMm: result.blendWidthMm,
    pitchMm: result.pitchMm,
  };

  let byParams = innerSurfaceCache.get(contentHash);
  if (!byParams) {
    byParams = new Map();
    innerSurfaceCache.set(contentHash, byParams);
  }
  byParams.set(paramKey(payload), jobResult);

  return cloneCachedResult(jobResult);
};
