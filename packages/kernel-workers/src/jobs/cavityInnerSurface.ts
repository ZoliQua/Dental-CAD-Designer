// jobs/cavityInnerSurface.ts — the INLAY/ONLAY inner (fit) surface stage
// (Phase 5 Task 3): @dqcad/kernel's `buildCavityInnerSurface` — the two-zone
// cement-gap offset off the cavity surface + solid undercut blockout
// (draft-close along the insertion axis) + skirt-to-outline, producing the
// finished cavity fit surface whose boundary loop == the cavity-outline
// polyline. See @dqcad/kernel's cavity/innerSurface.ts for the formulation, the
// VERIFIED draft-close direction, the outline-distance crop, and `@errorBound`.
//
// ## Progress, cancellation & byte-identity
//
// The job calls `buildCavityInnerSurface` directly, passing progress/cancel
// HOOKS (`onProgress`/`checkCancel`) that the kernel op invokes across its
// field-grid loop and phase boundaries. Those hooks affect NO computed value,
// so the job's result is BYTE-IDENTICAL to a direct `buildCavityInnerSurface`
// call (pinned by cavityInnerSurfaceJob.test.ts) — the same "hooks don't change
// the math" contract as the crown inner-surface job, without re-driving the
// primitives here. `checkCancel` throws `JobCancelledError` to cancel
// cooperatively between field slices.
//
// ## Per-worker result cache
//
// Takes a `contentHash` (NOT raw buffers) and requires `buildBvh` to have run
// for it on THIS worker (jobs/bvh.ts's `requireCachedBvh`) — reusing only the
// cached MESH (the kernel op builds its own axis-frame BVH internally, so the
// world-frame cached BVH is not reused here; documented). Keyed by `contentHash`
// then a `paramKey` (gaps/spacer/blend/pitch/axis + the cavity outline).
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
//
// NOTE: no TypeScript constructor parameter properties anywhere in this file
// (the Task 1 worker-loader landmine) — there are no classes here; the payload/
// result are plain interfaces.
import {
  buildCavityInnerSurface,
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

export interface CavityInnerSurfacePayload {
  contentHash: string;
  pitchMm: number;
  marginalGapMm: number;
  cementGapMm: number;
  spacerStartMm: number;
  blendWidthMm: number;
  /** The dense on-surface cavity outline, flat xyz (transferable) — rebuilt into
   * Vec3[] inside the job. */
  cavityOutline: Float64Array;
  /** Insertion axis (the inlay's lift-out direction) — the blockout draft-closes
   * along it. */
  insertionAxis: Vec3;
}

export interface CavityInnerSurfaceResult {
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  /** Worst-case (blend-zone) offset error bound, mm — see @dqcad/kernel's
   * cavity/innerSurface.ts `@errorBound`. */
  errorBoundMm: number;
  /** Tighter flat-zone (marginal/cement) bound, mm. */
  flatZoneErrorBoundMm: number;
  /** Triangle counts (blocked offset patch / outline skirt). */
  patchTriangleCount: number;
  skirtTriangleCount: number;
  marginVertexCount: number;
  marginalGapMm: number;
  cementGapMm: number;
  spacerStartMm: number;
  blendWidthMm: number;
  pitchMm: number;
}

const cavityInnerSurfaceCache = new Map<string, Map<string, CavityInnerSurfaceResult>>();

function paramKey(p: CavityInnerSurfacePayload): string {
  return JSON.stringify({
    pitchMm: p.pitchMm,
    marginalGapMm: p.marginalGapMm,
    cementGapMm: p.cementGapMm,
    spacerStartMm: p.spacerStartMm,
    blendWidthMm: p.blendWidthMm,
    insertionAxis: p.insertionAxis,
    cavityOutline: Array.from(p.cavityOutline),
  });
}

onBvhRelease((contentHash) => {
  cavityInnerSurfaceCache.delete(contentHash);
});

function cloneCachedResult(r: CavityInnerSurfaceResult): CavityInnerSurfaceResult {
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
 * `cavityInnerSurface` worker job — see this file's module doc for the staged
 * progress/cancellation contract, the per-worker cache, and the byte-identity
 * argument vs. `buildCavityInnerSurface`. `buildBvh` must have been called for
 * `payload.contentHash` on THIS worker first (its cached MESH is used).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) on a cache MISS if BVH was never built.
 * @throws {TypeError} for invalid pitch/gaps/spacer/blend/outline/axis (before heavy work).
 * @throws {PitchTooSmallError} / {BlendWidthTooNarrowError} / {NonWatertightMeshError}
 * / {SdfGridTooLargeError} / {EmptyOffsetResultError} / {NoBoundaryLoopError} (@dqcad/kernel).
 */
export const cavityInnerSurfaceJob = async (payload: CavityInnerSurfacePayload, ctx: JobContext): Promise<CavityInnerSurfaceResult> => {
  const { contentHash, pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, insertionAxis } = payload;

  // Fail-fast validation, mirroring buildCavityInnerSurface's own guards.
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`cavityInnerSurface: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  if (pitchMm < MIN_PITCH_MM) {
    throw new PitchTooSmallError(pitchMm);
  }
  for (const [name, value] of [
    ['marginalGapMm', marginalGapMm],
    ['cementGapMm', cementGapMm],
  ] as const) {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new TypeError(`cavityInnerSurface: ${name} must be finite and >= 0, got ${value}`);
    }
  }
  if (!(Number.isFinite(spacerStartMm) && spacerStartMm > 0)) {
    throw new TypeError(`cavityInnerSurface: spacerStartMm must be finite and > 0, got ${spacerStartMm}`);
  }
  if (!(Number.isFinite(blendWidthMm) && blendWidthMm > 0)) {
    throw new TypeError(`cavityInnerSurface: blendWidthMm must be finite and > 0, got ${blendWidthMm}`);
  }
  const gapParams: InnerSurfaceGapParams = { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm };
  if (!(blendZoneLipschitz(gapParams) < 1)) {
    throw new BlendWidthTooNarrowError(blendWidthMm, Math.abs(cementGapMm - marginalGapMm));
  }
  if (!payload.cavityOutline || payload.cavityOutline.length < 9) {
    throw new TypeError(`cavityInnerSurface: cavityOutline must have >= 3 points (>= 9 flat coords)`);
  }

  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const cached = cavityInnerSurfaceCache.get(contentHash)?.get(paramKey(payload));
  if (cached) {
    ctx.progress(1);
    return cloneCachedResult(cached);
  }

  const { mesh } = requireCachedBvh(contentHash);
  const cavityOutline = rebuildLoop(payload.cavityOutline);

  const result = await buildCavityInnerSurface(
    mesh,
    { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, pitchMm, cavityOutline, insertionAxis },
    {
      onProgress: (f) => ctx.progress(f),
      checkCancel: async () => {
        if (await ctx.cancelled()) throw new JobCancelledError();
      },
    },
  );

  const jobResult: CavityInnerSurfaceResult = {
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

  let byParams = cavityInnerSurfaceCache.get(contentHash);
  if (!byParams) {
    byParams = new Map();
    cavityInnerSurfaceCache.set(contentHash, byParams);
  }
  byParams.set(paramKey(payload), jobResult);

  return cloneCachedResult(jobResult);
};
