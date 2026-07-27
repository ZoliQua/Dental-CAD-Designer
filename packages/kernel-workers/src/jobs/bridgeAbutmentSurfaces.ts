// jobs/bridgeAbutmentSurfaces.ts — the BRIDGE abutment fit-surfaces stage
// (Phase 6 Task 2): @dqcad/kernel's `buildInnerSurface` run PER ABUTMENT against
// the ONE SHARED insertion axis (NOT each die's own axis). A bridge seats as one
// rigid piece; every abutment intaglio is draft-closed to the same axis. The
// kernel op is the SAME crown fit-surface op (jobs/innerSurface.ts) — this job
// is the multi-unit driver: loop the abutments, spread progress across them,
// cancel cooperatively between (and within) abutments.
//
// ## Progress, cancellation & byte-identity
//
// Each abutment's `buildInnerSurface` gets progress/cancel HOOKS; the job maps
// each abutment's [0,1] fraction into its slice of the overall [0,1] bar
// (abutment i of N → [i/N, (i+1)/N]). Hooks affect NO computed value, so each
// abutment's mesh is BYTE-IDENTICAL to a direct `buildInnerSurface` call with
// the shared axis (pinned by the job test) — same contract as jobs/innerSurface.ts.
// `checkCancel` throws `JobCancelledError` between field slices AND the job
// checks cancellation between abutments.
//
// ## Per-worker cache
//
// Takes the arch/prep mesh's `contentHash` (NOT raw buffers) — `buildBvh` must
// have cached it on THIS worker (jobs/bvh.ts's `requireCachedBvh`); the kernel
// op builds its own axis-frame BVH internally, so only the cached MESH is
// reused. Result caching is left to the caller layer (the crown innerSurface job
// caches; a bridge build is a rarer, coarser-grained action — YAGNI here).
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
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
import { requireCachedBvh } from './bvh.ts';

/** One abutment's input: its FDI number + its dense on-surface margin loop,
 * flat xyz (transferable), rebuilt into Vec3[] inside the job. */
export interface BridgeAbutmentInputPayload {
  tooth: number;
  marginLoop: Float64Array;
}

export interface BridgeAbutmentSurfacesPayload {
  contentHash: string;
  pitchMm: number;
  marginalGapMm: number;
  cementGapMm: number;
  spacerStartMm: number;
  blendWidthMm: number;
  /** The SHARED insertion axis — every abutment intaglio is draft-closed to it. */
  insertionAxis: Vec3;
  /** One entry per abutment (>= 1). */
  abutments: readonly BridgeAbutmentInputPayload[];
}

export interface BridgeAbutmentSurfaceResult {
  tooth: number;
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  errorBoundMm: number;
  flatZoneErrorBoundMm: number;
  patchTriangleCount: number;
  skirtTriangleCount: number;
  marginVertexCount: number;
}

export interface BridgeAbutmentSurfacesResult {
  /** One built fit surface per input abutment (same order as `payload.abutments`). */
  abutments: readonly BridgeAbutmentSurfaceResult[];
  pitchMm: number;
  insertionAxis: Vec3;
  /** Max abutment error bound (mm). */
  errorBoundMm: number;
}

function rebuildLoop(flat: Float64Array): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

function validateScalars(payload: BridgeAbutmentSurfacesPayload): void {
  const { pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm } = payload;
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`bridgeAbutmentSurfaces: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  if (pitchMm < MIN_PITCH_MM) {
    throw new PitchTooSmallError(pitchMm);
  }
  for (const [name, value] of [
    ['marginalGapMm', marginalGapMm],
    ['cementGapMm', cementGapMm],
  ] as const) {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new TypeError(`bridgeAbutmentSurfaces: ${name} must be finite and >= 0, got ${value}`);
    }
  }
  if (!(Number.isFinite(spacerStartMm) && spacerStartMm > 0)) {
    throw new TypeError(`bridgeAbutmentSurfaces: spacerStartMm must be finite and > 0, got ${spacerStartMm}`);
  }
  if (!(Number.isFinite(blendWidthMm) && blendWidthMm > 0)) {
    throw new TypeError(`bridgeAbutmentSurfaces: blendWidthMm must be finite and > 0, got ${blendWidthMm}`);
  }
  const gapParams: InnerSurfaceGapParams = { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm };
  if (!(blendZoneLipschitz(gapParams) < 1)) {
    throw new BlendWidthTooNarrowError(blendWidthMm, Math.abs(cementGapMm - marginalGapMm));
  }
  if (payload.abutments.length === 0) {
    throw new TypeError('bridgeAbutmentSurfaces: at least one abutment is required');
  }
  for (const ab of payload.abutments) {
    if (!ab.marginLoop || ab.marginLoop.length < 9) {
      throw new TypeError(`bridgeAbutmentSurfaces: abutment ${ab.tooth} marginLoop must have >= 3 points (>= 9 flat coords)`);
    }
  }
}

/**
 * `bridgeAbutmentSurfaces` worker job — see this file's module doc for the
 * multi-unit progress/cancellation contract and the byte-identity argument vs.
 * a per-abutment `buildInnerSurface` call. `buildBvh` must have been called for
 * `payload.contentHash` on THIS worker first (its cached MESH is used).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if BVH was never built for the hash.
 * @throws {TypeError} for invalid pitch/gaps/spacer/blend/abutments (before heavy work).
 * @throws {PitchTooSmallError} / {BlendWidthTooNarrowError} and `buildInnerSurface`'s
 * typed errors (@dqcad/kernel).
 */
export const bridgeAbutmentSurfacesJob = async (
  payload: BridgeAbutmentSurfacesPayload,
  ctx: JobContext,
): Promise<BridgeAbutmentSurfacesResult> => {
  validateScalars(payload);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh } = requireCachedBvh(payload.contentHash);
  const { pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, insertionAxis } = payload;
  const n = payload.abutments.length;

  const abutments: BridgeAbutmentSurfaceResult[] = [];
  let errorBoundMm = 0;
  for (let i = 0; i < n; i++) {
    if (await ctx.cancelled()) throw new JobCancelledError();
    const ab = payload.abutments[i]!;
    const marginLoop = rebuildLoop(ab.marginLoop);
    const result = await buildInnerSurface(
      mesh,
      { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, pitchMm, marginLoop, insertionAxis },
      {
        onProgress: (f) => ctx.progress((i + f) / n), // abutment i's [0,1] -> global [i/n, (i+1)/n]
        checkCancel: async () => {
          if (await ctx.cancelled()) throw new JobCancelledError();
        },
      },
    );
    if (result.errorBoundMm > errorBoundMm) errorBoundMm = result.errorBoundMm;
    abutments.push({
      tooth: ab.tooth,
      positions: result.mesh.positions,
      indices: result.mesh.indices,
      stats: result.stats,
      errorBoundMm: result.errorBoundMm,
      flatZoneErrorBoundMm: result.flatZoneErrorBoundMm,
      patchTriangleCount: result.patchTriangleCount,
      skirtTriangleCount: result.skirtTriangleCount,
      marginVertexCount: result.marginVertexCount,
    });
  }

  ctx.progress(1);
  return { abutments, pitchMm, insertionAxis, errorBoundMm };
};
