// jobs/offset.ts — offsetMesh (Phase 2 Task 7): @dqcad/kernel's offset/
// module (banded SDF grid -> marching cubes at iso = distance -> weld ->
// manifold cleanup -> stats) — see that package's offsetMesh.ts for the
// pipeline, sign convention, and `@errorBound`, and mcTables.ts for the
// cited marching-cubes table source.
//
// ## Progress & cancellation (per this task's brief: "progress across
// SDF/MC/cleanup stages; cancellation between slices/stages")
//
// This job does NOT call @dqcad/kernel's `offsetMesh` convenience function
// (async but internally non-yielding through the two heavy synchronous
// stages) — it drives the SAME per-slice/per-slab primitives itself
// (`computeSdfGridSlice`, `marchingCubesSlab` — the identical functions
// `offsetMesh` composes, over the identical `offsetGridSpec` grid request),
// awaiting `ctx.cancelled()` and reporting `ctx.progress` between z-slices
// (SDF stage) and z-slabs (MC stage), and once more between each pipeline
// stage. Because both paths run the same primitives in the same order over
// the same inputs, this job's result is byte-identical to a direct
// `offsetMesh` call (pinned by offsetJob.test.ts's hash-equality test).
//
// Progress budget (fractions of 1, approximating measured stage costs at
// die scale where SDF sampling dominates): mesh analysis + pseudonormals
// 0→0.05 (the BVH itself no longer counts here — see below), SDF slices
// 0.05→0.75, MC slabs 0.75→0.90, weld 0.90→0.94, manifold cleanup
// 0.94→0.98, final stats 0.98→1. A cache HIT (below) skips straight to 1.
//
// ## Per-worker result cache (Phase 3 Task 1 housekeeping: "jobs/offset.ts
// ... stop rebuilding per call ... unify on contentHash-keyed per-worker
// caches", following jobs/bvh.ts's `bvhCache` pattern)
//
// Like jobs/geodesic.ts/jobs/curvature.ts, this job takes a `contentHash`
// (NOT the raw mesh buffers) and requires `buildBvh` to have already been
// called for that contentHash ON THIS WORKER (jobs/bvh.ts's
// `requireCachedBvh`) — this buys two things:
//   1. The mesh's BVH (Stage 0's most expensive sub-step) is reused from the
//      shared jobs/bvh.ts cache rather than rebuilt from scratch on every
//      call — `computePseudonormals`/`analyzeMesh` are still recomputed
//      locally (cheap relative to the BVH build, and not shared state
//      anything else caches).
//   2. UNLIKE curvature (a pure function of the mesh alone), an offset
//      result depends on `distanceMm`/`pitchMm` too — `offsetCache` below is
//      therefore keyed by `contentHash` at the outer level (so
//      `onBvhRelease` can evict EVERY cached (distanceMm, pitchMm) variant
//      for a released mesh in one `Map.delete`) and by `paramKey(distanceMm,
//      pitchMm)` at the inner level. A repeat call with the SAME mesh AND
//      the SAME distance/pitch (e.g. re-opening a cement-gap preview after
//      toggling something unrelated) skips the ENTIRE SDF/MC/weld/cleanup
//      pipeline — the actual "stop rebuilding" this task's brief asks for —
//      while a call with a DIFFERENT distance/pitch for the SAME mesh still
//      benefits from the shared BVH reuse in (1) even on a cache MISS.
//
// `offsetCache` stores the CANONICAL (never-transferred) result; every
// return path clones the mesh buffers first — see `cloneMeshBuffers`'s doc
// for why (Comlink's zero-copy transfer would otherwise detach the cache's
// own buffers on the very first response).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  analyzeMesh,
  cleanupMesh,
  computePseudonormals,
  computeSdfGridSlice,
  markCandidateCells,
  marchingCubesSlab,
  maxAbsCoordOf,
  offsetErrorBoundMm,
  offsetGridSpec,
  sdfGridDims,
  weldVertices,
  EmptyOffsetResultError,
  MIN_PITCH_MM,
  PitchTooSmallError,
  type MarchingCubesSoup,
  type MeshStats,
  type ScalarGrid,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { onBvhRelease, requireCachedBvh } from './bvh.ts';

export interface OffsetMeshPayload {
  contentHash: string;
  /** Offset distance, mm: positive = outward (grow), negative = inward
   * (shrink) — see @dqcad/kernel's offsetMesh.ts sign-convention doc. */
  distanceMm: number;
  /** Voxel pitch, mm — required (no job-level default; clinical defaults
   * live only in packages/clinical-profiles, see
   * `DEFAULT_OFFSET_VOXEL_PITCH_MM` there). */
  pitchMm: number;
}

export interface OffsetMeshResult {
  /** The offset mesh's buffers (transferred, not cloned — registry.ts's
   * `transferablesOf`). */
  positions: Float64Array;
  indices: Uint32Array;
  /** `analyzeMesh` over the FINAL cleaned mesh. */
  stats: MeshStats;
  /** Documented approximation bound, mm (PLAN §6.6) — see @dqcad/kernel's
   * offsetMesh.ts `@errorBound`. */
  errorBoundMm: number;
  distanceMm: number;
  pitchMm: number;
}

/** Per-worker cache — see this file's module doc. Outer key: contentHash
 * (lets `onBvhRelease` evict every cached (distanceMm, pitchMm) variant for
 * a released mesh in one `Map.delete`). Inner key: `paramKey`. */
const offsetCache = new Map<string, Map<string, OffsetMeshResult>>();

function paramKey(distanceMm: number, pitchMm: number): string {
  return `${distanceMm}:${pitchMm}`;
}

onBvhRelease((contentHash) => {
  offsetCache.delete(contentHash);
});

/** Clones an `OffsetMeshResult`'s transferable typed-array fields —
 * REQUIRED before ever returning a value that came out of `offsetCache`
 * (same reason as jobs/curvature.ts's `cloneResult`: `runJob`'s
 * `transferablesOf` auto-transfer would otherwise detach the cache's own
 * mesh buffers). Plain-value fields (`stats`, `errorBoundMm`, `distanceMm`,
 * `pitchMm`) are copied by value already — no cloning needed for them. */
function cloneCachedResult(result: OffsetMeshResult): OffsetMeshResult {
  return {
    positions: result.positions.slice(),
    indices: result.indices.slice(),
    stats: result.stats,
    errorBoundMm: result.errorBoundMm,
    distanceMm: result.distanceMm,
    pitchMm: result.pitchMm,
  };
}

/**
 * `offsetMesh` worker job — see this file's module doc for the staged
 * progress/cancellation contract, the per-worker BVH-reuse + result-cache
 * contract, and the byte-identity argument vs. the kernel's own
 * `offsetMesh`. `buildBvh` must have been called for `payload.contentHash`
 * on THIS worker first (jobs/bvh.ts).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) if `buildBvh` was never called
 * for `payload.contentHash` on this worker (checked only on a cache MISS —
 * a cache HIT needs no mesh at all).
 * @throws {TypeError} for invalid `distanceMm`/`pitchMm` (checked before
 * any heavy work, including before the cache lookup).
 * @throws {NonWatertightMeshError} (@dqcad/kernel) for a non-closed input.
 * @throws {SdfGridTooLargeError} (@dqcad/kernel) if the grid exceeds the
 * memory guard — before any grid allocation.
 * @throws {EmptyOffsetResultError} (@dqcad/kernel) if the offset surface is
 * empty.
 * @throws {PitchTooSmallError} (@dqcad/kernel) if `pitchMm < MIN_PITCH_MM`
 * — checked up front, mirroring offsetMesh.ts's own fail-fast check.
 * @throws {NonManifoldInputError} (@dqcad/kernel) if the extracted surface
 * fails manifold validation (marching cubes' documented ambiguity
 * limitation).
 */
export const offsetMeshJob = async (payload: OffsetMeshPayload, ctx: JobContext): Promise<OffsetMeshResult> => {
  const { contentHash, distanceMm, pitchMm } = payload;
  if (!Number.isFinite(distanceMm)) {
    throw new TypeError(`offsetMesh: distanceMm must be finite, got ${distanceMm}`);
  }
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`offsetMesh: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  if (pitchMm < MIN_PITCH_MM) {
    throw new PitchTooSmallError(pitchMm);
  }

  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const cached = offsetCache.get(contentHash)?.get(paramKey(distanceMm, pitchMm));
  if (cached) {
    // Cache hit: the whole point of this task's brief — skip the entire
    // SDF/MC/weld/cleanup pipeline, pay only a cheap buffer clone.
    ctx.progress(1);
    return cloneCachedResult(cached);
  }

  const { mesh, bvh } = requireCachedBvh(contentHash);

  // Stage 0: bbox + pseudonormals (the watertight gate) — BVH itself is
  // reused from jobs/bvh.ts's cache (this file's module doc, point 1), not
  // rebuilt here.
  const inputStats = analyzeMesh(mesh);
  const pseudonormals = computePseudonormals(mesh);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0.05);

  // Stage 1: banded SDF grid, per-slice (identical request to the kernel's
  // offsetMesh via the shared offsetGridSpec — see module doc).
  const spec = offsetGridSpec(inputStats.bbox, distanceMm, pitchMm);
  const { dims, origin, cellCount } = sdfGridDims({ bboxMm: spec.bboxMm, pitchMm, padding: spec.padding });
  const [nx, ny, nz] = dims;
  const grid = new Float32Array(cellCount);
  const mask = markCandidateCells(mesh, dims, origin, pitchMm, spec.bandMm);
  for (let z = 0; z < nz; z++) {
    const slice = computeSdfGridSlice(mesh, bvh, pseudonormals, dims, origin, pitchMm, z, mask);
    grid.set(slice, z * ny * nx);
    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress(0.05 + 0.7 * ((z + 1) / nz));
  }

  // Stage 2: marching cubes at iso = distanceMm, per z-slab.
  const scalarGrid: ScalarGrid = { grid, dims, origin, pitchMm };
  const slabs: MarchingCubesSoup[] = [];
  let totalTriangles = 0;
  for (let z = 0; z <= nz - 2; z++) {
    const slab = marchingCubesSlab(scalarGrid, distanceMm, z);
    if (slab.triangleCount > 0) {
      slabs.push(slab);
      totalTriangles += slab.triangleCount;
    }
    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress(0.75 + 0.15 * ((z + 1) / (nz - 1)));
  }
  if (totalTriangles === 0) {
    throw new EmptyOffsetResultError(distanceMm);
  }
  const soupPositions = new Float64Array(totalTriangles * 9);
  let offset = 0;
  for (const slab of slabs) {
    soupPositions.set(slab.positions, offset);
    offset += slab.positions.length;
  }

  // Stage 3: weld, then manifold cleanup (async WASM — validates
  // watertight/manifold, collapses residual slivers).
  const welded = weldVertices({ positions: soupPositions, normals: null, triangleCount: totalTriangles });
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0.94);
  const cleaned = await cleanupMesh(welded);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0.98);

  // Stage 4: stats over the FINAL mesh.
  const stats = analyzeMesh(cleaned);
  ctx.progress(1);

  const result: OffsetMeshResult = {
    positions: cleaned.positions,
    indices: cleaned.indices,
    stats,
    errorBoundMm: offsetErrorBoundMm(pitchMm, maxAbsCoordOf(inputStats.bbox, spec.padding)),
    distanceMm,
    pitchMm,
  };

  let byParams = offsetCache.get(contentHash);
  if (!byParams) {
    byParams = new Map();
    offsetCache.set(contentHash, byParams);
  }
  byParams.set(paramKey(distanceMm, pitchMm), result);

  return cloneCachedResult(result);
};
