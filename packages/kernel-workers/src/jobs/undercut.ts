// jobs/undercut.ts — undercutScan / undercutScanBatch (Phase 2 Task 9):
// @dqcad/kernel's undercut/ module (insertion-axis undercut scan — see that
// package's undercutScan.ts for the sign convention, depth semantics,
// sampling policy `@errorBound`, and ray-origin epsilon policy).
//
// ## BVH reuse (guardrail: NOT the offset-job rebuild-per-call anti-pattern)
//
// Both jobs below take ONLY `contentHash` (not mesh buffers) and require the
// mesh's BVH to already be cached on THIS worker via `buildBvh`
// (jobs/bvh.ts's `requireCachedBvh` — the SAME per-worker cache
// jobs/heatmap.ts's `distanceHeatmap` reuses) — exactly the "reuse the
// cached BVH, don't rebuild per direction" this task's guardrail calls out,
// in explicit contrast to jobs/offset.ts's flagged `buildBvh(mesh)`
// rebuild-per-call. `undercutScanBatchJob` in particular builds the BVH
// ZERO times itself (`requireCachedBvh` is a cache lookup, not a build) and
// runs every direction in `directions` against that SAME cached `Bvh` —
// this is the amortization Phase 3's hemisphere sweep (dozens of
// directions, up to a quarter-million-triangle prep mesh) needs.
//
// ## Progress & cancellation (per this task's brief: "progress per-triangle-
// batch within direction + per-direction; cancellation")
//
// Neither job calls @dqcad/kernel's whole-mesh `undercutScan` convenience
// function directly — both drive the SAME chunked primitive it's built on
// (`undercutScanRange` — see that function's kernel-side doc: "same split as
// offset/marchingCubes.ts's `marchingCubesSlab` vs. `marchingCubes`"),
// `await`ing `ctx.cancelled()` and reporting `ctx.progress` between
// triangle-batch chunks WITHIN a direction, and (for the batch job) between
// directions too — real async cancellation checkpoints a single synchronous
// whole-mesh call could never offer. `runChunkedDirectionScan` below is the
// shared helper both jobs call (kept file-private — not part of either
// job's public payload/result contract): it writes directly into a
// caller-supplied `Uint8Array`/`Float64Array` VIEW (a plain array for the
// single-direction job, one direction-sized SLICE of a larger flat buffer
// for the batch job — see `undercutScanBatchJob`'s doc for why the batch
// result is flattened rather than an array of per-direction objects).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  undercutScanRange,
  type IndexedMesh,
  type Bvh,
  type UndercutSamplingPolicy,
  type Vec3,
} from '@dqcad/kernel';
import { requireCachedBvh } from './bvh.ts';
import { JobCancelledError, type JobContext } from './context.ts';
import type { Vec3Payload } from './shared.ts';

/** Triangles per progress/cancellation checkpoint WITHIN a single
 * direction's scan — same "checked only between chunks" cooperative pattern
 * and similar magnitude as jobs/heatmap.ts's
 * `DISTANCE_HEATMAP_PROGRESS_CHUNK_POINTS` (2000): frequent enough for a
 * smooth progress bar on a quarter-million-triangle prep mesh (~125
 * checkpoints), infrequent enough that the checkpoint's `await
 * ctx.cancelled()` round trip never dominates (each chunk still does real
 * BVH-raycast work for every undercut triangle in it).
 */
const UNDERCUT_PROGRESS_CHUNK_TRIANGLES = 2000;

function normalizeDirection(direction: Vec3Payload, callerName: string): Vec3 {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 0)) {
    throw new TypeError(`${callerName}: direction must be a non-zero-length vector`);
  }
  return [direction[0] / len, direction[1] / len, direction[2] / len];
}

interface DirectionScanStats {
  directionUnit: Vec3;
  undercutTriangleCount: number;
  maxDepthMm: number;
}

/** Drives `undercutScanRange` chunk-by-chunk for ONE direction, writing into
 * caller-supplied `undercutOut`/`depthMm` (each exactly `triangleCount`
 * long — a plain array for a single-direction job, a direction-sized
 * SUBARRAY VIEW into a larger flat buffer for the batch job; either way
 * `undercutScanRange` itself only ever sees local `[0, triangleCount)`
 * indices, since a `TypedArray.subarray` view re-bases indexing to 0 — see
 * `undercutScanBatchJob`'s doc). `ctx.progress` is reported within
 * `[progressStart, progressStart + progressSpan]`, linear in triangles
 * processed. */
async function runChunkedDirectionScan(
  mesh: IndexedMesh,
  bvh: Bvh,
  direction: Vec3Payload,
  sampling: UndercutSamplingPolicy,
  ctx: JobContext,
  progressStart: number,
  progressSpan: number,
  undercutOut: Uint8Array,
  depthOut: Float64Array,
): Promise<DirectionScanStats> {
  const directionUnit = normalizeDirection(direction, 'undercutScan');
  const triangleCount = mesh.indices.length / 3;
  let undercutTriangleCount = 0;
  let maxDepthMm = 0;

  if (triangleCount === 0) {
    ctx.progress(progressStart + progressSpan);
    return { directionUnit, undercutTriangleCount, maxDepthMm };
  }

  const chunkSize = Math.max(1, Math.min(UNDERCUT_PROGRESS_CHUNK_TRIANGLES, triangleCount));
  for (let start = 0; start < triangleCount; start += chunkSize) {
    const end = Math.min(start + chunkSize, triangleCount);
    const stats = undercutScanRange(
      mesh,
      bvh,
      directionUnit,
      { start, end },
      { undercut: undercutOut, depthMm: depthOut },
      { sampling },
    );
    undercutTriangleCount += stats.undercutCountInRange;
    if (stats.maxDepthMmInRange > maxDepthMm) maxDepthMm = stats.maxDepthMmInRange;
    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress(progressStart + progressSpan * (end / triangleCount));
  }

  return { directionUnit, undercutTriangleCount, maxDepthMm };
}

// ---------------------------------------------------------------------------
// undercutScan — single direction.
// ---------------------------------------------------------------------------

export interface UndercutScanPayload {
  /** contentHash of the mesh to scan — must already be cached via `buildBvh`
   * (jobs/bvh.ts) on THIS worker (see `BvhNotCachedError`). */
  contentHash: string;
  /** Need not be normalized — normalized internally, same as
   * `raycastMesh`'s `direction` (jobs/bvh.ts). */
  direction: Vec3Payload;
  /** Default `'centroid'` — see @dqcad/kernel's undercutScan.ts "Sampling
   * policy" doc for the error-character tradeoff. */
  sampling?: UndercutSamplingPolicy;
}

export interface UndercutScanResult {
  directionUnit: Vec3Payload;
  triangleCount: number;
  undercut: Uint8Array;
  depthMm: Float64Array;
  undercutTriangleCount: number;
  maxDepthMm: number;
  sampling: UndercutSamplingPolicy;
}

export const undercutScanJob = async (payload: UndercutScanPayload, ctx: JobContext): Promise<UndercutScanResult> => {
  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const sampling = payload.sampling ?? 'centroid';
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const triangleCount = mesh.indices.length / 3;
  const undercut = new Uint8Array(triangleCount);
  const depthMm = new Float64Array(triangleCount);
  const { directionUnit, undercutTriangleCount, maxDepthMm } = await runChunkedDirectionScan(
    mesh,
    bvh,
    payload.direction,
    sampling,
    ctx,
    0,
    1,
    undercut,
    depthMm,
  );

  return { directionUnit, triangleCount, undercut, depthMm, undercutTriangleCount, maxDepthMm, sampling };
};

// ---------------------------------------------------------------------------
// undercutScanBatch — Phase 3's hemisphere sweep entry point.
// ---------------------------------------------------------------------------

export interface UndercutScanBatchPayload {
  contentHash: string;
  /** One scan per entry — Phase 3 drives this with a hemisphere sample
   * (dozens of directions); this job has no opinion on WHICH directions
   * (YAGNI per this task's guardrail: hemisphere sampling / axis
   * optimization is Phase 3's job, not this primitive's). */
  directions: readonly Vec3Payload[];
  sampling?: UndercutSamplingPolicy;
}

export interface UndercutScanBatchResult {
  directionCount: number;
  triangleCount: number;
  /** Flattened xyz per direction (`directionCount * 3`). */
  directionUnits: Float64Array;
  /** Flattened, DIRECTION-MAJOR: `undercut[d * triangleCount + t]` is
   * direction `d`'s flag for triangle `t` — flattening to TOP-LEVEL typed
   * arrays (rather than an array of `directionCount` per-direction result
   * objects, which is what @dqcad/kernel's `undercutScanBatch` returns) is
   * deliberate: jobs/registry.ts's `runJob` auto-transfers (zero-copy) only
   * a result's TOP-LEVEL `TypedArray` fields (`transfer.ts`'s
   * `transferablesOf` doc: "only inspects one level deep") — an array of
   * nested per-direction objects would fall back to a full structured-clone
   * COPY of every direction's buffers, exactly the cost this task's "batch
   * API matters" guardrail is about avoiding at hemisphere-sweep scale
   * (dozens of directions x up to a quarter-million triangles). Same
   * kernel-ergonomics-vs-wire-efficiency split this codebase already uses
   * for `closestPointBatch` (kernel: array of structs) vs. `distanceHeatmap`
   * (job: flat `Float64Array`) — see jobs/heatmap.ts's module doc. */
  undercut: Uint8Array;
  /** Flattened, same direction-major layout as `undercut`. */
  depthMm: Float64Array;
  /** Per-direction aggregate — `undercutTriangleCounts[d]`. */
  undercutTriangleCounts: Uint32Array;
  /** Per-direction aggregate — `maxDepthMmPerDirection[d]`. */
  maxDepthMmPerDirection: Float64Array;
  sampling: UndercutSamplingPolicy;
}

export const undercutScanBatchJob = async (
  payload: UndercutScanBatchPayload,
  ctx: JobContext,
): Promise<UndercutScanBatchResult> => {
  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const sampling = payload.sampling ?? 'centroid';
  const directions = payload.directions;
  const directionCount = directions.length;
  const triangleCount = mesh.indices.length / 3;

  if (directionCount === 0) {
    ctx.progress(1);
    return {
      directionCount: 0,
      triangleCount,
      directionUnits: new Float64Array(0),
      undercut: new Uint8Array(0),
      depthMm: new Float64Array(0),
      undercutTriangleCounts: new Uint32Array(0),
      maxDepthMmPerDirection: new Float64Array(0),
      sampling,
    };
  }

  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const directionUnits = new Float64Array(directionCount * 3);
  const undercut = new Uint8Array(directionCount * triangleCount);
  const depthMm = new Float64Array(directionCount * triangleCount);
  const undercutTriangleCounts = new Uint32Array(directionCount);
  const maxDepthMmPerDirection = new Float64Array(directionCount);

  for (let i = 0; i < directionCount; i++) {
    const undercutSlice = undercut.subarray(i * triangleCount, (i + 1) * triangleCount);
    const depthSlice = depthMm.subarray(i * triangleCount, (i + 1) * triangleCount);
    const { directionUnit, undercutTriangleCount, maxDepthMm } = await runChunkedDirectionScan(
      mesh,
      bvh,
      directions[i]!,
      sampling,
      ctx,
      i / directionCount,
      1 / directionCount,
      undercutSlice,
      depthSlice,
    );
    directionUnits[i * 3] = directionUnit[0];
    directionUnits[i * 3 + 1] = directionUnit[1];
    directionUnits[i * 3 + 2] = directionUnit[2];
    undercutTriangleCounts[i] = undercutTriangleCount;
    maxDepthMmPerDirection[i] = maxDepthMm;
  }

  ctx.progress(1);
  return {
    directionCount,
    triangleCount,
    directionUnits,
    undercut,
    depthMm,
    undercutTriangleCounts,
    maxDepthMmPerDirection,
    sampling,
  };
};
