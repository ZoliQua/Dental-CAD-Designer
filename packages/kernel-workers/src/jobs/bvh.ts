// jobs/bvh.ts — buildBvh / releaseBvh / measurePointToSurface / raycastMesh:
// the per-worker BVH cache and its query jobs (Task 7).
//
// Split out of the original monolithic jobs.ts (Phase 2 Task 1: "split
// jobs.ts before new jobs" — see jobs/registry.ts's module doc for the full
// rationale and file map). Pure mechanical move: no behavioral change.
// `requireCachedBvh`/`bvhCache` are exported (not just module-private, as in
// the original monolith) because jobs/heatmap.ts's `distanceHeatmap` also
// queries this SAME per-worker cache — see that file's doc.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import { buildBvh, closestPoint, raycast, type IndexedMesh, type Bvh, type Vec3 } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import type { Vec3Payload } from './shared.ts';

// ---------------------------------------------------------------------------
// ## Per-worker BVH cache (Task 7's brief: "cache per mesh contentHash in
// worker memory")
//
// `bvhCache` below is a MODULE-LEVEL `Map`, exactly like manifold.ts's
// `manifoldPromise` memoization (packages/kernel/src/boolean/manifold.ts) —
// state that lives for the lifetime of THIS worker thread, not shared across
// the pool. A `WorkerPool` (pool.ts) round-robins jobs across up to
// `hardwareConcurrency - 1` workers with no per-job worker affinity, so a
// `buildBvh` call and a LATER `measurePointToSurface`/`raycastMesh`/
// `distanceHeatmap` (jobs/heatmap.ts) call for the SAME contentHash are not
// guaranteed to land on the same worker (and therefore the same cache)
// unless the caller pins them to a single-worker pool.
// apps/client/src/engine/workers.ts does exactly that (a dedicated `size: 1`
// "measurement pool", separate from the general geometry pool) — see its
// module doc — which is what makes "build once, query many times against
// the SAME cached Bvh" actually hold in practice; this cache itself has no
// opinion on how many workers exist, it just does the right thing
// (rebuild-on-miss) either way.
//
// `measurePointToSurface`/`raycastMesh`/`distanceHeatmap` do NOT accept the
// mesh buffers as part of their payload — only `contentHash` plus the query
// itself. This keeps repeated single-pick payloads small (no re-sending a
// quarter-million-triangle mesh on every mouse click) at the cost of
// requiring `buildBvh` to have already cached that mesh on THIS worker — a
// cache miss throws `BvhNotCachedError` (see below) rather than silently
// falling back to some other mesh source, since this job registry has no
// other way to obtain mesh geometry (no filesystem/network access, and
// reaching back into the caller's meshStore would defeat the whole point of
// running in a worker).
// ---------------------------------------------------------------------------

/** Thrown by measurePointToSurface/raycastMesh/distanceHeatmap when
 * `contentHash` has no cached BVH on THIS worker — see the cache doc above
 * for why that can legitimately happen (never built yet on this worker, or
 * released). Named (not just a plain Error) so pool.ts-style callers can
 * recognize it the same way `JobCancelledError` is recognized by `.name`
 * after crossing the Comlink boundary (Comlink reconstructs thrown errors as
 * plain `Error` instances with the original `name`/`message` preserved, not
 * as this exact subclass). */
export class BvhNotCachedError extends Error {
  constructor(contentHash: string) {
    super(`No BVH cached for contentHash ${contentHash} on this worker — call buildBvh first`);
    this.name = 'BvhNotCachedError';
  }
}

export interface CachedBvh {
  mesh: IndexedMesh;
  bvh: Bvh;
}

/** Per-worker cache — see this section's module doc. */
const bvhCache = new Map<string, CachedBvh>();

/** Shared by jobs/heatmap.ts's `distanceHeatmap`, which queries this SAME
 * per-worker cache — see this file's module doc. */
export function requireCachedBvh(contentHash: string): CachedBvh {
  const cached = bvhCache.get(contentHash);
  if (!cached) {
    throw new BvhNotCachedError(contentHash);
  }
  return cached;
}

export interface BuildBvhPayload {
  contentHash: string;
  /** Float64 master mesh buffers — kernel Float64 rule. The caller should
   * pass a PRIVATE copy in the transfer list (e.g. `positions.slice()`),
   * never the mesh's live master buffer: transferring detaches the
   * original ArrayBuffer, and the caller (apps/client's meshStore) needs
   * its master copy to keep living for rendering/other measurements for the
   * mesh's whole session lifetime — see engine/workers.ts's
   * `ensureBvhBuilt` for the call-site convention this assumes. */
  positions: Float64Array;
  indices: Uint32Array;
}

export interface BuildBvhResult {
  contentHash: string;
  triangleCount: number;
  /** Total BVH node count — surfaced only for diagnostics/tests, not
   * consumed by any production call site. */
  nodeCount: number;
}

export const buildBvhJob = async (payload: BuildBvhPayload, ctx: JobContext): Promise<BuildBvhResult> => {
  if (!(payload.positions instanceof Float64Array)) {
    throw new TypeError('buildBvh: positions must be a Float64Array (kernel Float64 rule)');
  }
  if (!(payload.indices instanceof Uint32Array)) {
    throw new TypeError('buildBvh: indices must be a Uint32Array');
  }
  if (await ctx.cancelled()) {
    // Mid-build cancellation is out of scope for Phase 1 — see kernel's
    // buildBvh.ts BuildBvhOptions.onProgress doc for why a bounded,
    // seconds-scale synchronous build doesn't need it. This is the one
    // cancellation checkpoint this job offers: before doing any work at all.
    throw new JobCancelledError();
  }
  ctx.progress(0);
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };
  const bvh = buildBvh(mesh, {
    onProgress: (done, total) => ctx.progress(total > 0 ? done / total : 1),
  });
  bvhCache.set(payload.contentHash, { mesh, bvh });
  return {
    contentHash: payload.contentHash,
    triangleCount: bvh.triangleCount,
    nodeCount: bvh.nodeLeft.length,
  };
};

export interface ReleaseBvhPayload {
  contentHash: string;
}

export interface ReleaseBvhResult {
  /** Whether a cached BVH for `contentHash` actually existed on this worker
   * to release — `false` is not an error (e.g. releasing a mesh this
   * particular worker never happened to build, in a multi-worker pool).
   * NOTE: `releaseBvh` also evicts the SAME contentHash's per-worker
   * geodesic halfedge cache — see `onBvhRelease`'s doc below and
   * jobs/geodesic.ts's `onBvhRelease` listener. */
  released: boolean;
}

/** Listeners invoked by `releaseBvh` with the released `contentHash`, so
 * OTHER per-worker caches keyed by the same contentHash can evict alongside
 * the BVH (jobs/geodesic.ts's halfedge cache registers here — a ~250k-tri
 * mesh's `HalfedgeMesh` overlay is tens of MB, and a worker that outlives
 * many load/release cycles must not accumulate overlays for meshes whose
 * BVH is already gone). A listener callback, rather than jobs/bvh.ts
 * importing the other caches directly, keeps the jobs/*.ts dependency graph
 * a strict DAG (geodesic.ts already imports THIS module for
 * `requireCachedBvh` — an import in the other direction would be the
 * circular VALUE import jobs/registry.ts's module doc rules out). */
const releaseListeners: ((contentHash: string) => void)[] = [];

export function onBvhRelease(listener: (contentHash: string) => void): void {
  releaseListeners.push(listener);
}

export const releaseBvh = async (payload: ReleaseBvhPayload): Promise<ReleaseBvhResult> => {
  const released = bvhCache.delete(payload.contentHash);
  for (const listener of releaseListeners) listener(payload.contentHash);
  return { released };
};

export interface MeasurePointToSurfacePayload {
  contentHash: string;
  /** Float64 mm world coordinates — the query point (e.g. a point already
   * picked on mesh A, per this task's brief's point-to-surface tool). */
  point: Vec3Payload;
}

export interface MeasurePointToSurfaceResult {
  /** Closest point ON the cached mesh's surface, Float64 mm world
   * coordinates. */
  point: Vec3Payload;
  /** Euclidean distance from `payload.point` to `point`, mm. */
  distance: number;
  triangleIndex: number;
  barycentric: Vec3Payload;
}

/**
 * `measurePointToSurface`: exact Float64 closest-point-on-surface distance
 * from `payload.point` to the mesh cached under `payload.contentHash` (see
 * `buildBvh` above — must have been called for this contentHash on THIS
 * worker first). This is the point-to-surface measurement tool's worker
 * half (apps/client/src/engine/ToolManager.ts) — the authoritative distance
 * is always computed here, in Float64 against the kernel BVH, never derived
 * from a Three.js/Float32 render-copy raycast (see this task's brief: "the
 * render-copy raycast may be used only to find the candidate mesh/screen ray
 * cheaply; the authoritative point comes from the worker").
 */
export const measurePointToSurface = async (
  payload: MeasurePointToSurfacePayload,
): Promise<MeasurePointToSurfaceResult> => {
  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const result = closestPoint(mesh, bvh, payload.point as Vec3);
  return {
    point: result.point,
    distance: result.distance,
    triangleIndex: result.triangleIndex,
    barycentric: result.barycentric,
  };
};

export interface RaycastMeshPayload {
  contentHash: string;
  /** Float64 mm world-space ray origin. */
  origin: Vec3Payload;
  /** Ray direction — need not be normalized (kernel `raycast` normalizes
   * internally; see packages/kernel/src/bvh/raycast.ts). */
  direction: Vec3Payload;
}

export type RaycastMeshResult =
  | {
      hit: true;
      point: Vec3Payload;
      distance: number;
      triangleIndex: number;
      barycentric: Vec3Payload;
    }
  | { hit: false };

/**
 * `raycastMesh`: exact Float64 nearest ray-surface intersection against the
 * mesh cached under `payload.contentHash` (see `buildBvh` above). This is
 * the authoritative pick used by the point-to-point/angle measurement
 * tools: a Three.js raycast against the Float32 render copy (engine/
 * SceneManager.ts) only ever picks WHICH mesh/screen ray to query — the
 * exact Float64 world-space pick point always comes from here (this task's
 * brief's "critical correctness point" — see this module's BVH-job section
 * doc above).
 */
export const raycastMesh = async (payload: RaycastMeshPayload): Promise<RaycastMeshResult> => {
  const { mesh, bvh } = requireCachedBvh(payload.contentHash);
  const hit = raycast(mesh, bvh, payload.origin as Vec3, payload.direction as Vec3);
  if (!hit) {
    return { hit: false };
  }
  return {
    hit: true,
    point: hit.point,
    distance: hit.distance,
    triangleIndex: hit.triangleIndex,
    barycentric: hit.barycentric,
  };
};
