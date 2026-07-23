// jobs/innerSurface.ts — innerSurfaceOffset (Phase 4 Task 3): @dqcad/kernel's
// two-zone crown inner-surface (cement-gap) offset — a spatially-varying
// outward offset of the prep with a C1 blend between the marginal-gap and
// cement-gap zones, extracted by SDF -> marching cubes restricted to the prep
// ROI. See @dqcad/kernel's innerSurfaceOffset.ts for the formulation, the
// Euclidean-distance-to-margin height field, and `@errorBound`.
//
// ## Progress & cancellation (follows jobs/offset.ts exactly)
//
// This job does NOT call the kernel's `innerSurfaceOffsetRoi` convenience
// function — it drives the SAME per-slice/per-slab primitives itself
// (`computeTwoZoneSdfGridSlice`, `marchingCubesSlab` over the identical
// `offsetGridSpec` grid at iso = 0), awaiting `ctx.cancelled()` and reporting
// `ctx.progress` between z-slices (field-grid stage) and z-slabs (MC stage),
// and once more between pipeline stages. Because both paths run the same
// primitives in the same order over the same inputs, this job's result is
// byte-identical to a direct `innerSurfaceOffsetRoi` call (pinned by
// innerSurfaceJob.test.ts's hash-equality test).
//
// Progress budget: pseudonormals 0->0.05, field-grid slices 0.05->0.80, MC
// slabs 0.80->0.95, weld 0.95->0.98, final stats 0.98->1. A cache HIT skips
// to 1.
//
// ## Per-worker result cache (follows jobs/offset.ts)
//
// Takes a `contentHash` (NOT raw buffers) and requires `buildBvh` to have run
// for it on THIS worker (jobs/bvh.ts's `requireCachedBvh`) — reusing the
// mesh's BVH and evicting on `onBvhRelease`. Keyed by `contentHash` at the
// outer level, by a `paramKey` (all gaps/spacer/blend/pitch/ROI + the margin
// loop) at the inner level: a repeat call with identical params skips the
// whole SDF/MC/weld pipeline.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  analyzeMesh,
  blendZoneLipschitz,
  computePseudonormals,
  computeTwoZoneSdfGridSlice,
  marchingCubesSlab,
  markCandidateCells,
  maxAbsCoordOf,
  offsetErrorBoundMm,
  offsetGridSpec,
  sdfGridDims,
  weldVertices,
  BlendWidthTooNarrowError,
  EmptyOffsetResultError,
  MIN_PITCH_MM,
  PitchTooSmallError,
  type InnerSurfaceGapParams,
  type MarchingCubesSoup,
  type MeshStats,
  type ScalarGrid,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { onBvhRelease, requireCachedBvh } from './bvh.ts';

export interface InnerSurfaceOffsetPayload {
  contentHash: string;
  pitchMm: number;
  marginalGapMm: number;
  cementGapMm: number;
  spacerStartMm: number;
  blendWidthMm: number;
  /** The dense on-surface margin loop, flat xyz (transferable) — rebuilt into
   * Vec3[] inside the job. */
  marginLoop: Float64Array;
  roiBboxMm: { min: Vec3; max: Vec3 };
}

export interface InnerSurfaceOffsetResult {
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  /** Worst-case (blend-zone) offset error bound, mm — see @dqcad/kernel's
   * innerSurfaceOffset.ts `@errorBound`. */
  errorBoundMm: number;
  /** Tighter flat-zone (marginal/cement) bound, mm. */
  flatZoneErrorBoundMm: number;
  marginalGapMm: number;
  cementGapMm: number;
  spacerStartMm: number;
  blendWidthMm: number;
  pitchMm: number;
}

const innerSurfaceCache = new Map<string, Map<string, InnerSurfaceOffsetResult>>();

function paramKey(p: InnerSurfaceOffsetPayload): string {
  return JSON.stringify({
    pitchMm: p.pitchMm,
    marginalGapMm: p.marginalGapMm,
    cementGapMm: p.cementGapMm,
    spacerStartMm: p.spacerStartMm,
    blendWidthMm: p.blendWidthMm,
    roiBboxMm: p.roiBboxMm,
    marginLoop: Array.from(p.marginLoop),
  });
}

onBvhRelease((contentHash) => {
  innerSurfaceCache.delete(contentHash);
});

function cloneCachedResult(r: InnerSurfaceOffsetResult): InnerSurfaceOffsetResult {
  return {
    positions: r.positions.slice(),
    indices: r.indices.slice(),
    stats: r.stats,
    errorBoundMm: r.errorBoundMm,
    flatZoneErrorBoundMm: r.flatZoneErrorBoundMm,
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
 * `innerSurfaceOffset` worker job — see this file's module doc for the staged
 * progress/cancellation contract, the per-worker cache, and the byte-identity
 * argument vs. `innerSurfaceOffsetRoi`. `buildBvh` must have been called for
 * `payload.contentHash` on THIS worker first.
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) on a cache MISS if BVH was never built.
 * @throws {TypeError} for invalid pitch/gaps/spacer/blend/loop (before heavy work).
 * @throws {PitchTooSmallError} / {BlendWidthTooNarrowError} / {NonWatertightMeshError}
 * / {SdfGridTooLargeError} / {EmptyOffsetResultError} (@dqcad/kernel).
 */
export const innerSurfaceOffsetJob = async (
  payload: InnerSurfaceOffsetPayload,
  ctx: JobContext,
): Promise<InnerSurfaceOffsetResult> => {
  const { contentHash, pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, roiBboxMm } = payload;

  // Fail-fast validation, mirroring innerSurfaceOffsetRoi's own guards.
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`innerSurfaceOffset: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  if (pitchMm < MIN_PITCH_MM) {
    throw new PitchTooSmallError(pitchMm);
  }
  for (const [name, value] of [
    ['marginalGapMm', marginalGapMm],
    ['cementGapMm', cementGapMm],
  ] as const) {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new TypeError(`innerSurfaceOffset: ${name} must be finite and >= 0, got ${value}`);
    }
  }
  if (!(Number.isFinite(spacerStartMm) && spacerStartMm > 0)) {
    throw new TypeError(`innerSurfaceOffset: spacerStartMm must be finite and > 0, got ${spacerStartMm}`);
  }
  if (!(Number.isFinite(blendWidthMm) && blendWidthMm > 0)) {
    throw new TypeError(`innerSurfaceOffset: blendWidthMm must be finite and > 0, got ${blendWidthMm}`);
  }
  const gapParams: InnerSurfaceGapParams = { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm };
  const lgap = blendZoneLipschitz(gapParams);
  if (!(lgap < 1)) {
    throw new BlendWidthTooNarrowError(blendWidthMm, Math.abs(cementGapMm - marginalGapMm));
  }
  if (!payload.marginLoop || payload.marginLoop.length < 6) {
    throw new TypeError(`innerSurfaceOffset: marginLoop must have >= 2 points (>= 6 flat coords)`);
  }

  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const cached = innerSurfaceCache.get(contentHash)?.get(paramKey(payload));
  if (cached) {
    ctx.progress(1);
    return cloneCachedResult(cached);
  }

  const { mesh, bvh } = requireCachedBvh(contentHash);
  const marginLoop = rebuildLoop(payload.marginLoop);

  // Stage 0: pseudonormals (the watertight gate) — BVH reused from cache.
  const pseudonormals = computePseudonormals(mesh);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0.05);

  // Stage 1: two-zone field grid over the ROI (identical grid request to the
  // kernel's innerSurfaceOffsetRoi via the shared offsetGridSpec + max-gap).
  const maxGapMm = Math.max(marginalGapMm, cementGapMm);
  const spec = offsetGridSpec(roiBboxMm, maxGapMm, pitchMm);
  const { dims, origin, cellCount } = sdfGridDims({ bboxMm: spec.bboxMm, pitchMm, padding: spec.padding });
  const [nx, ny, nz] = dims;
  const grid = new Float32Array(cellCount);
  const mask = markCandidateCells(mesh, dims, origin, pitchMm, spec.bandMm);
  for (let z = 0; z < nz; z++) {
    const slice = computeTwoZoneSdfGridSlice(
      mesh,
      bvh,
      pseudonormals,
      dims,
      origin,
      pitchMm,
      z,
      mask,
      gapParams,
      marginLoop,
    );
    grid.set(slice, z * ny * nx);
    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress(0.05 + 0.75 * ((z + 1) / nz));
  }

  // Stage 2: marching cubes at iso = 0 (F = signedDistance - gap = 0), per slab.
  const scalarGrid: ScalarGrid = { grid, dims, origin, pitchMm };
  const slabs: MarchingCubesSoup[] = [];
  let totalTriangles = 0;
  for (let z = 0; z <= nz - 2; z++) {
    const slab = marchingCubesSlab(scalarGrid, 0, z);
    if (slab.triangleCount > 0) {
      slabs.push(slab);
      totalTriangles += slab.triangleCount;
    }
    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress(0.8 + 0.15 * ((z + 1) / (nz - 1)));
  }
  if (totalTriangles === 0) {
    throw new EmptyOffsetResultError(0);
  }
  const soupPositions = new Float64Array(totalTriangles * 9);
  let offset = 0;
  for (const slab of slabs) {
    soupPositions.set(slab.positions, offset);
    offset += slab.positions.length;
  }

  // Stage 3: weld ONLY (open patch — no manifold cleanup, see kernel doc).
  const welded = weldVertices({ positions: soupPositions, normals: null, triangleCount: totalTriangles });
  ctx.progress(0.98);
  const stats = analyzeMesh(welded);

  const maxAbs = maxAbsCoordOf({ min: roiBboxMm.min, max: roiBboxMm.max }, spec.padding);
  const flatZoneErrorBoundMm = offsetErrorBoundMm(pitchMm, maxAbs);
  const f32Terms = flatZoneErrorBoundMm - pitchMm / 2;
  const errorBoundMm = ((1 + lgap) / (1 - lgap)) * (pitchMm / 2) + f32Terms;
  ctx.progress(1);

  const result: InnerSurfaceOffsetResult = {
    positions: welded.positions,
    indices: welded.indices,
    stats,
    errorBoundMm,
    flatZoneErrorBoundMm,
    marginalGapMm,
    cementGapMm,
    spacerStartMm,
    blendWidthMm,
    pitchMm,
  };

  let byParams = innerSurfaceCache.get(contentHash);
  if (!byParams) {
    byParams = new Map();
    innerSurfaceCache.set(contentHash, byParams);
  }
  byParams.set(paramKey(payload), result);

  return cloneCachedResult(result);
};
