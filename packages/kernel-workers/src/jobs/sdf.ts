// jobs/sdf.ts — buildSdf / signedClosestPoint / sampleSdfGrid (Phase 2
// Task 6): @dqcad/kernel's sdf/ module (angle-weighted pseudonormals, exact
// signed closest-point queries, regular-grid SDF sampling) — see that
// package's pseudonormals.ts/signedDistance.ts/grid.ts module docs for the
// method, `@errorBound`s, and the watertight-input requirement.
//
// ## Per-worker pseudonormal cache (mirrors jobs/bvh.ts's `bvhCache` /
// jobs/geodesic.ts's `halfedgeCache` — see jobs/bvh.ts's "Per-worker BVH
// cache" module doc for the full "why a per-worker cache, why contentHash,
// why a pinned size:1 pool" writeup, which applies identically here)
//
// `buildSdf` requires `buildBvh` to have already been called for the SAME
// `contentHash` on THIS worker (`requireCachedBvh`, jobs/bvh.ts) — it reuses
// that cached `IndexedMesh`, computes `Pseudonormals` from it
// (`computePseudonormals` — throws `NonWatertightMeshError` for a non-closed
// mesh, this task's brief item 3), and caches the result here, keyed by the
// SAME `contentHash`. `signedClosestPoint`/`sampleSdfGrid` below both take
// only `contentHash` (never re-sending mesh buffers), same convention as
// `measurePointToSurface`/`distanceHeatmap`.
//
// `sdfCache` is evicted whenever the SAME contentHash's BVH is released
// (`onBvhRelease`, jobs/bvh.ts) — identical eviction wiring to
// jobs/geodesic.ts's `halfedgeCache`; a released mesh's SDF jobs would fail
// on `requireCachedBvh` anyway, so a still-cached `Pseudonormals` for it is
// pure leaked memory.
//
// ## Grid job: progress by z-slice, cancellation between slices
//
// `sampleSdfGridJob` does NOT call @dqcad/kernel's `sampleSdfGrid`
// convenience wrapper (which is synchronous, no true cancellation — see that
// function's own doc) — it drives `computeSdfGridSlice` itself, one z-slice
// at a time, `await`ing `ctx.cancelled()` and calling `ctx.progress` between
// slices (same chunked-loop-in-the-job shape as jobs/heatmap.ts's
// `distanceHeatmap`). Because both paths call the exact same
// `computeSdfGridSlice` primitive, results are guaranteed identical to a
// direct (worker-free) `sampleSdfGrid` call over the same inputs.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  computePseudonormals,
  computeSdfGridSlice,
  markCandidateCells,
  sdfGridDims,
  signedClosestPoint,
  type Pseudonormals,
  type Vec3,
} from '@dqcad/kernel';
import { onBvhRelease, requireCachedBvh } from './bvh.ts';
import { JobCancelledError, type JobContext } from './context.ts';
import type { Vec3Payload } from './shared.ts';

/** Per-worker cache — see this file's module doc. */
const sdfCache = new Map<string, Pseudonormals>();

onBvhRelease((contentHash) => {
  sdfCache.delete(contentHash);
});

/** Thrown by `signedClosestPoint`/`sampleSdfGrid` below when `contentHash`
 * has no cached `Pseudonormals` on THIS worker — mirrors jobs/bvh.ts's
 * `BvhNotCachedError` (see its doc for why this can legitimately happen:
 * never built yet on this worker, or released). */
export class SdfNotCachedError extends Error {
  constructor(contentHash: string) {
    super(`No SDF pseudonormals cached for contentHash ${contentHash} on this worker — call buildSdf first`);
    this.name = 'SdfNotCachedError';
  }
}

function requireCachedPseudonormals(contentHash: string): Pseudonormals {
  const cached = sdfCache.get(contentHash);
  if (!cached) {
    throw new SdfNotCachedError(contentHash);
  }
  return cached;
}

export interface BuildSdfPayload {
  contentHash: string;
}

export interface BuildSdfResult {
  contentHash: string;
  faceCount: number;
  vertexCount: number;
  halfedgeCount: number;
}

/**
 * `buildSdf`: computes and caches `Pseudonormals` for the mesh already
 * cached under `payload.contentHash` (via `buildBvh`, jobs/bvh.ts) on THIS
 * worker. ONE synchronous, non-yielding kernel call — same shape as
 * jobs/curvature.ts's `computeCurvature` job (nothing to check cancellation
 * BETWEEN internally at this task's scale).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if `buildBvh` hasn't been called
 * for `payload.contentHash` on this worker.
 * @throws {NonWatertightMeshError} (@dqcad/kernel) if the cached mesh is not
 * watertight — see that error's doc: signed distance requires a closed
 * mesh; repair/hole-filling is the documented upstream fix.
 */
export const buildSdf = async (payload: BuildSdfPayload, ctx: JobContext): Promise<BuildSdfResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const { mesh } = requireCachedBvh(payload.contentHash);
  const pn = computePseudonormals(mesh);
  sdfCache.set(payload.contentHash, pn);
  ctx.progress(1);
  return { contentHash: payload.contentHash, faceCount: pn.faceCount, vertexCount: pn.vertexCount, halfedgeCount: pn.halfedgeCount };
};

export interface SignedClosestPointPayload {
  contentHash: string;
  /** Float64 mm world coordinates — the query point. */
  point: Vec3Payload;
}

export interface SignedClosestPointResult {
  /** Closest point ON the cached mesh's surface, Float64 mm world
   * coordinates. */
  point: Vec3Payload;
  /** Unsigned Euclidean distance, mm (>= 0). */
  distance: number;
  /** Signed distance, mm — negative inside the mesh, positive outside, 0 on
   * the surface (see @dqcad/kernel's signedDistance.ts module doc for the
   * convention). */
  signedDistance: number;
  triangleIndex: number;
  barycentric: Vec3Payload;
}

/**
 * `signedClosestPoint`: exact signed closest-point-on-surface query against
 * the mesh cached under `payload.contentHash` — requires BOTH `buildBvh`
 * (jobs/bvh.ts) AND `buildSdf` (above) to have already been called for this
 * contentHash on THIS worker.
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) — see `buildSdf`'s doc.
 * @throws {SdfNotCachedError} if `buildSdf` hasn't been called for this
 * contentHash on this worker.
 */
export const signedClosestPointJob = async (
  payload: SignedClosestPointPayload,
): Promise<SignedClosestPointResult> => {
  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const pn = requireCachedPseudonormals(payload.contentHash);
  const result = signedClosestPoint(mesh, bvh, pn, payload.point as Vec3);
  return {
    point: result.point,
    distance: result.distance,
    signedDistance: result.signedDistance,
    triangleIndex: result.triangleIndex,
    barycentric: result.barycentric,
  };
};

export interface SampleSdfGridPayload {
  contentHash: string;
  bboxMin: Vec3Payload;
  bboxMax: Vec3Payload;
  /** Grid spacing, mm — required (no kernel/job-level default; see
   * @dqcad/kernel's grid.ts's `SdfGridOptions.pitchMm` doc: clinical
   * defaults live only in packages/clinical-profiles). */
  pitchMm: number;
  padding?: number;
  /** See @dqcad/kernel's grid.ts's `SampleSdfGridOptions.bandMm` doc — when
   * provided, restricts the expensive per-cell computation to a band around
   * the mesh surface (this task's guardrail: the documented pragmatic
   * escape hatch for a grid too large to sample densely in reasonable
   * wall-clock time). */
  bandMm?: number;
}

export interface SampleSdfGridResult {
  /** Flat Float32 grid — see @dqcad/kernel's grid.ts module doc for the
   * documented (error-budget-justified) Float32 storage decision and the
   * flat x-fastest-varying layout. */
  grid: Float32Array;
  dims: readonly [number, number, number];
  origin: Vec3Payload;
  pitchMm: number;
  bandMm: number | null;
}

/**
 * `sampleSdfGrid`: samples the signed distance field over a regular grid —
 * see this file's module doc ("Grid job") for why this job drives the
 * z-slice loop itself (real `await ctx.cancelled()` / `ctx.progress` between
 * slices) rather than calling @dqcad/kernel's synchronous `sampleSdfGrid`
 * convenience wrapper.
 *
 * @throws {BvhNotCachedError} / {SdfNotCachedError} — see
 * `signedClosestPoint`'s doc.
 * @throws {SdfGridTooLargeError} (@dqcad/kernel) if the requested
 * bbox/pitch/padding combination exceeds `MAX_SDF_GRID_CELLS` — thrown
 * BEFORE any grid array is allocated (see `sdfGridDims`'s doc).
 */
export const sampleSdfGridJob = async (
  payload: SampleSdfGridPayload,
  ctx: JobContext,
): Promise<SampleSdfGridResult> => {
  if (payload.bandMm !== undefined && !(payload.bandMm > 0)) {
    throw new TypeError(`sampleSdfGrid: bandMm must be > 0 if provided, got ${payload.bandMm}`);
  }
  if (await ctx.cancelled()) throw new JobCancelledError();

  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const pn = requireCachedPseudonormals(payload.contentHash);

  const { dims, origin, cellCount } = sdfGridDims({
    bboxMm: { min: payload.bboxMin as Vec3, max: payload.bboxMax as Vec3 },
    pitchMm: payload.pitchMm,
    padding: payload.padding,
  });
  const [nx, ny, nz] = dims;
  const grid = new Float32Array(cellCount);
  const mask =
    payload.bandMm !== undefined
      ? markCandidateCells(mesh, dims, origin, payload.pitchMm, payload.bandMm)
      : undefined;

  ctx.progress(0);
  for (let z = 0; z < nz; z++) {
    const slice = computeSdfGridSlice(mesh, bvh, pn, dims, origin, payload.pitchMm, z, mask);
    grid.set(slice, z * ny * nx);
    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress((z + 1) / nz);
  }

  return { grid, dims, origin, pitchMm: payload.pitchMm, bandMm: payload.bandMm ?? null };
};
