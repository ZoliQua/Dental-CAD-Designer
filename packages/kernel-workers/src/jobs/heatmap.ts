// jobs/heatmap.ts — distanceHeatmap (Task 9): per-vertex-of-A
// closest-surface-point distance to mesh B, batched into ONE job call (not
// one job per vertex — Task 9's brief).
//
// Split out of the original monolithic jobs.ts (Phase 2 Task 1: "split
// jobs.ts before new jobs" — see jobs/registry.ts's module doc for the full
// rationale and file map). Pure mechanical move: no behavioral change.
//
// Like jobs/bvh.ts's measurePointToSurface/raycastMesh, this takes ONLY B's
// contentHash (not its buffers) — B must already be `buildBvh`'d on THIS
// worker, via jobs/bvh.ts's SAME per-worker cache (`requireCachedBvh`,
// imported from there — see that file's "Per-worker BVH cache" module doc).
// apps/client/src/engine/heatmap.ts (the browser call site) always runs
// this on the SAME size:1 measurement pool engine/workers.ts's
// `ensureBvhBuilt`/ToolManager.ts already use, for the same reason spelled
// out in jobs/bvh.ts's doc: a `buildBvh` call for B and this job's later
// query against the same contentHash are only guaranteed to hit the SAME
// worker's cache (build once, query many times) on a pool that never has
// more than one worker.
//
// `payload.points` — UNLIKE measurePointToSurface's single `point` — is the
// whole batch: typically mesh A's entire vertex buffer (one heatmap value
// per vertex of A), but any flat xyz point set works. This keeps the
// Comlink round-trip count at ONE for a quarter-million-vertex heatmap
// (Task 9's guardrail: batch the per-vertex queries internally, not one job
// per vertex) at the cost of the caller pre-flattening its query points —
// exactly the shape `EngineMeshRecord.positions` (Float64, 3-per-vertex,
// see meshStore.ts) already has, so no extra work at the call site either.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import { closestPoint, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { requireCachedBvh } from './bvh.ts';
import { JobCancelledError, type JobContext } from './context.ts';

export interface DistanceHeatmapPayload {
  /** contentHash of the TARGET mesh (B) — must already be cached via
   * `buildBvh` (jobs/bvh.ts) on this worker (see `BvhNotCachedError`). */
  contentHash: string;
  /** Float64 flat xyz query points (length a multiple of 3) — kernel Float64
   * rule. The caller should pass a PRIVATE copy in the transfer list (e.g.
   * `positions.slice()`), never a mesh's live master buffer — same
   * "transferring detaches the original" caution as `BuildBvhPayload.positions`. */
  points: Float64Array;
  /** When true, each distance is SIGNED: positive if the query point sits on
   * the outward side of its closest triangle on B (`dot(query - closest,
   * faceNormal) >= 0`), negative otherwise (see `triangleNormalUnnormalized`
   * below — only the SIGN of that dot product is used, so the normal is
   * deliberately left unnormalized). This requires B to have consistently,
   * outward-oriented winding (true for every synthetic fixture here, and for
   * any mesh that has been through kernel intake's `orientNormalsConsistently`
   * stage — see jobs/intake.ts's `intakeMesh` doc) — an inconsistently-wound
   * B produces a sign that flips per-triangle rather than meaning
   * "inside/outside". Defaults to false (every distance is >= 0, `Math.abs`
   * of the signed value). */
  signed?: boolean;
}

export interface DistanceHeatmapResult {
  /** One entry per input point (same order), mm. Float64 throughout — kernel
   * Float64 rule; any Float32 rounding for on-screen colors happens strictly
   * downstream, in apps/client/src/engine (never here). */
  distances: Float64Array;
  min: number;
  max: number;
  mean: number;
  /** Root-mean-square of `distances` — a single "how far off overall" figure
   * distinct from `mean` (RMS weights large deviations more heavily; useful
   * for e.g. distinguishing "mostly touching, one bad spot" from "uniformly
   * offset" surfaces at a glance). */
  rms: number;
}

/** Unnormalized face normal of `mesh`'s triangle `triangleIndex` — the
 * `signed` option (see `DistanceHeatmapPayload`'s doc) only needs this
 * vector's SIGN relative to the query-to-closest-point vector, which a
 * uniform positive scale (the un-normalized cross product) never changes;
 * skipping the `sqrt` a real normalize would cost is a meaningful saving
 * over a few hundred thousand calls. */
function triangleNormalUnnormalized(mesh: IndexedMesh, triangleIndex: number): Vec3 {
  const i0 = mesh.indices[triangleIndex * 3]!;
  const i1 = mesh.indices[triangleIndex * 3 + 1]!;
  const i2 = mesh.indices[triangleIndex * 3 + 2]!;
  const p = mesh.positions;
  const ax = p[i1 * 3]! - p[i0 * 3]!;
  const ay = p[i1 * 3 + 1]! - p[i0 * 3 + 1]!;
  const az = p[i1 * 3 + 2]! - p[i0 * 3 + 2]!;
  const bx = p[i2 * 3]! - p[i0 * 3]!;
  const by = p[i2 * 3 + 1]! - p[i0 * 3 + 1]!;
  const bz = p[i2 * 3 + 2]! - p[i0 * 3 + 2]!;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

// Points per progress/cancellation checkpoint — same "checked only between
// chunks" cooperative pattern as jobs/misc.ts's rescaleMesh
// (RESCALE_PROGRESS_CHUNK_ELEMENTS), sized so a ~250k-vertex arch scan
// reports on the order of a hundred checkpoints (frequent enough for a
// smooth progress bar, infrequent enough that the checkpoint's `await
// ctx.cancelled()` round trip never dominates).
const DISTANCE_HEATMAP_PROGRESS_CHUNK_POINTS = 2000;

export const distanceHeatmap = async (
  payload: DistanceHeatmapPayload,
  ctx: JobContext,
): Promise<DistanceHeatmapResult> => {
  if (!(payload.points instanceof Float64Array)) {
    throw new TypeError('distanceHeatmap: points must be a Float64Array (kernel Float64 rule)');
  }
  if (payload.points.length % 3 !== 0) {
    throw new TypeError('distanceHeatmap: points.length must be a multiple of 3');
  }
  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const { points, signed = false } = payload;
  const count = points.length / 3;
  const distances = new Float64Array(count);

  if (count === 0) {
    ctx.progress(1);
    return { distances, min: 0, max: 0, mean: 0, rms: 0 };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSquares = 0;
  const chunkSize = Math.max(1, Math.min(DISTANCE_HEATMAP_PROGRESS_CHUNK_POINTS, count));

  for (let i = 0; i < count; i++) {
    const p: Vec3 = [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
    const result = closestPoint(mesh, bvh, p);
    let d = result.distance;
    if (signed && d > 0) {
      const n = triangleNormalUnnormalized(mesh, result.triangleIndex);
      const dot =
        (p[0] - result.point[0]) * n[0] +
        (p[1] - result.point[1]) * n[1] +
        (p[2] - result.point[2]) * n[2];
      if (dot < 0) {
        d = -d;
      }
    }
    distances[i] = d;
    if (d < min) min = d;
    if (d > max) max = d;
    sum += d;
    sumSquares += d * d;

    const atChunkBoundary = i % chunkSize === chunkSize - 1 || i === count - 1;
    if (atChunkBoundary) {
      if (await ctx.cancelled()) {
        throw new JobCancelledError();
      }
      ctx.progress((i + 1) / count);
    }
  }

  return { distances, min, max, mean: sum / count, rms: Math.sqrt(sumSquares / count) };
};
