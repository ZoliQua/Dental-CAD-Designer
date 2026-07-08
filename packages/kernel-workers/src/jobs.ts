// Job registry: the pure, environment-agnostic business logic that runs
// inside a worker (browser or Node — see worker-entry.browser.ts /
// worker-entry.node.ts). Individual job handlers (echoMesh, longTask) never
// touch Comlink; only the `runJob` dispatcher at the bottom of this file
// does (it's the one piece both worker entries `Comlink.expose()` as-is,
// including wrapping results for zero-copy transfer back — see
// transferablesOf in transfer.ts) — keeping that dispatch glue here rather
// than duplicated per entry is what "sharing jobs.ts" means for the two
// entries.
import * as Comlink from 'comlink';
// `.ts` extension (not this repo's usual `.js`): jobs.ts is loaded natively
// by Node inside worker_threads (via worker-entry.node.ts), which doesn't
// map `.js` specifiers to `.ts` files — see tsconfig.json's
// allowImportingTsExtensions comment.
import { transferablesOf } from './transfer.ts';
// Bare package specifier, not a relative path, so no extension concern here
// — Node's native resolver and the bundler/vitest resolver both resolve
// '@dqcad/kernel' via its package.json the same way. kernel-workers -> kernel
// is an allowed dependency direction (see eslint.config.js's boundaries
// policy).
import {
  union,
  volume,
  weldVertices,
  dropDegenerateTriangles,
  orientNormalsConsistently,
  analyzeMesh,
  countsOf,
  makeStepReport,
  MESH_WELD_EPSILON_MM,
  KERNEL_VERSION,
  buildBvh,
  closestPoint,
  raycast,
  removeComponents,
  splitNonManifoldEdges,
  fillSmallHoles,
  type IndexedMesh,
  type IntakeReport,
  type IntakeStepReport,
  type MeshStats,
  type Bvh,
  type Vec3,
  type RemoveComponentsSelector,
  type RemoveComponentsReport,
  type SplitNonManifoldEdgesReport,
  type FillSmallHolesOptions,
  type FillSmallHolesReport,
} from '@dqcad/kernel';

// Re-exported (via index.ts) so apps/client/src/engine — which may depend on
// kernel-workers but NOT directly on kernel (see eslint.config.js's
// boundaries policy: engine -> kernel-workers|state|shared-types) — can
// stamp journal `Operation.kernelVersion` (shared-types) without importing
// `@dqcad/kernel` itself.
export { KERNEL_VERSION };
// kernel-workers -> io is also an allowed dependency direction (see
// eslint.config.js's boundaries policy) — packages/io became
// node-worker-reachable starting Phase 1 (see its own module docs' "Import
// extension convention" note) specifically so a job like `parseMeshFile`
// below could run STL/PLY parsing off the main/UI thread.
import { iterateInFixedChunks, parsePlyStream, parseStlStream, type ParseFormat } from '@dqcad/io';

/** Context passed to a job handler for progress reporting and cooperative
 * cancellation. Both members are plain functions on the worker side; the
 * pool (pool.ts) supplies Comlink-proxied versions when it calls across the
 * worker boundary, so calling them here is just a normal (possibly async)
 * function call as far as job code is concerned. */
export interface JobContext {
  /** Report fractional progress in [0, 1]. Deliberately typed (and callable)
   * as fire-and-forget — job code is never required to `await` this, and
   * handlers like `longTask` below don't — but `runJob`'s dispatcher (see
   * its doc comment) tracks every call's underlying delivery and flushes
   * them before the job settles, so callers of `WorkerPool.run()` still get
   * a strict progress-before-resolution ordering guarantee without job code
   * having to know or care about it. */
  progress: (fraction: number) => void;
  /** Cooperative cancellation flag — see the module doc below for why this
   * is checked only between chunks rather than preemptively. */
  cancelled: () => boolean | Promise<boolean>;
}

/**
 * Thrown by a job when it observes `ctx.cancelled()` returning true.
 * WorkerPool.run() recognizes this (by `.name`, since Comlink reconstructs
 * thrown errors as plain `Error` instances with the original name/message
 * preserved, not as this exact subclass — see pool.ts) and rejects with a
 * real `JobCancelledError` on the caller's side.
 */
export class JobCancelledError extends Error {
  constructor(message = 'Job cancelled') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

export interface EchoMeshPayload {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface EchoMeshResult {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface LongTaskPayload {
  /** Number of loop iterations to run; must be a positive integer. */
  iterations: number;
}

export interface LongTaskResult {
  /** Deterministic running sum of 0..iterations-1, for asserting the job
   * actually completed the requested amount of work. */
  sum: number;
}

/** manifoldSmoke takes no input — it builds its own fixture meshes (see
 * unitCubeMesh below) purely to prove manifold-3d's WASM loads and runs
 * inside this worker (browser or Node). */
export type ManifoldSmokePayload = Record<string, never>;

export interface ManifoldSmokeResult {
  /** Volume of the union, as computed by manifold-3d. */
  volume: number;
  /** Analytic expected volume for the fixture (see unitCubeMesh below):
   * two unit cubes overlapping by 0.5 on X have union volume 1 + 1 - 0.5 = 1.5. */
  expected: number;
}

/**
 * `parseMeshFile`: parses an STL or PLY file's raw bytes off the UI thread,
 * via packages/io's CHUNKED streaming parsers (`parseStlStream`/
 * `parsePlyStream`) rather than their whole-buffer `parseStl`/`parsePly`
 * entry points — so this job actually exercises the streaming, O(chunk)-
 * scanning-memory core (Task 3's chunked-parsing requirement), not just
 * "the parser, running in a worker".
 *
 * The payload still arrives as ONE transferable `Uint8Array` (matching
 * this file's existing `echoMesh`/`meshBuffers` convention, and how a
 * caller that already read a whole file into memory — e.g. via a
 * browser `File.arrayBuffer()`, or this package's own perf test reading a
 * fixture off disk — naturally has the bytes) rather than the caller
 * itself producing a chunk-by-chunk stream across the Comlink boundary
 * (which would mean one Comlink round trip per chunk — far more
 * expensive than the single structured-clone-avoiding transfer this does
 * instead). Inside the worker, `chunkStream()` below RE-SLICES that single
 * buffer into `chunkBytes`-sized pieces and feeds THOSE to
 * `parseStlStream`/`parsePlyStream` as a real `AsyncIterable<Uint8Array>`
 * — so peak ADDITIONAL memory during parsing is still bounded to O(chunk),
 * and progress/cancellation are checked at real chunk boundaries, exactly
 * as they would be for a genuine multi-message stream. This is a
 * deliberate, documented transport-vs-parsing-memory distinction: the
 * payload transport is O(file) (one buffer in, one buffer out — the same
 * as every other job in this registry), but the PARSING itself never
 * holds more than one buffer's worth of scratch state beyond the input/
 * output buffers already present.
 */
export interface ParseMeshFilePayload {
  format: 'stl' | 'ply';
  bytes: Uint8Array;
  /** Re-chunking size fed to the streaming core — defaults to 1 MiB (see
   * `DEFAULT_CHUNK_BYTES` below), matching stl/stream.ts's own internal
   * binary batch size. */
  chunkBytes?: number;
}

/** STL's `parseStlStream` always yields an unindexed triangle soup (see
 * packages/io's `RawTriangleSoup` doc) — `indices`/`vertexCount`/
 * `faceCount` have no meaning for this format, so this is a distinct
 * result shape from `PlyMeshResult` rather than a lossy shared one. */
export interface StlSoupResult {
  kind: 'stl-soup';
  positions: Float64Array;
  normals: Float64Array | null;
  triangleCount: number;
  format: ParseFormat;
  warnings: readonly string[];
}

/** PLY's `parsePlyStream` always yields an indexed mesh (see packages/io's
 * `PlyMesh` doc) — `indices` is always present (possibly empty, for a
 * point-cloud PLY with no face element). */
export interface PlyMeshResult {
  kind: 'ply-mesh';
  positions: Float64Array;
  normals: Float64Array | null;
  colors: Float64Array | null;
  indices: Uint32Array;
  vertexCount: number;
  faceCount: number;
  format: ParseFormat;
  warnings: readonly string[];
}

export type ParseMeshFileResult = StlSoupResult | PlyMeshResult;

/**
 * `intakeMesh`: runs @dqcad/kernel's mesh-intake pipeline (weld -> drop
 * degenerate -> orient normals -> analyze; see
 * packages/kernel/src/intake/intake.ts) off the UI thread.
 *
 * Mirrors kernel `IntakeInput`'s two shapes, flattened into one payload
 * (Comlink structured-clones plain objects fine, but a flat discriminated
 * shape keeps the transfer list trivially buildable by the caller):
 *  - `kind: 'soup'` — `positions` is a flat 9-per-triangle soup (e.g. STL
 *    parser output); the weld stage runs. `indices` must be absent.
 *  - `kind: 'indexed'` — `positions`/`indices` form an `IndexedMesh` (e.g.
 *    PLY parser output); the weld stage is skipped (see intake.ts's module
 *    doc for when to expand to soup instead).
 *
 * ## Progress + cancellation granularity (BETWEEN stages)
 *
 * Unlike kernel `intake()` (fully synchronous, no cancellation — see its
 * module doc), this job sequences the four stages itself, `await`ing
 * `ctx.cancelled()` and reporting `ctx.progress()` between each — so an
 * abort lands at the next stage boundary (each stage is one uninterruptible
 * CPU-bound chunk; for a ~250k-triangle arch scan each stage is roughly
 * hundreds of ms, an acceptable cancellation latency for Phase 1 intake).
 *
 * Transferables: input `positions`/`indices` buffers should be moved in via
 * `RunJobOptions.transfer`; the result's mesh buffers are moved back
 * automatically by runJob's `transferablesOf` (they're top-level typed-array
 * fields on the result, see below).
 */
export interface IntakeMeshPayload {
  kind: 'soup' | 'indexed';
  /** Float64: 9-per-triangle soup when `kind === 'soup'`, 3-per-vertex
   * shared positions when `kind === 'indexed'`. */
  positions: Float64Array;
  /** Required (3 per triangle) when `kind === 'indexed'`; must be omitted
   * when `kind === 'soup'`. */
  indices?: Uint32Array;
}

/** Flat result shape (mesh buffers at top level, not nested) so runJob's
 * one-level-deep `transferablesOf` moves them back zero-copy — same
 * convention as every other job in this registry. `stats`/`report` are
 * plain JSON-able objects, structured-cloned normally. */
export interface IntakeMeshResult {
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  report: IntakeReport;
}

const DEFAULT_CHUNK_BYTES = 1 << 20; // 1 MiB — see ParseMeshFilePayload's doc.

/** Re-slices `bytes` into `chunkBytes`-sized `AsyncIterable<Uint8Array>`
 * chunks (zero-copy `subarray` views — see packages/io's
 * `iterateInFixedChunks`), checking `ctx.cancelled()` once per chunk (this
 * job's "between chunks" cancellation granularity). On cancellation this
 * THROWS `JobCancelledError` (rather than merely ending the iteration) —
 * `parseStlStream`/`parsePlyStream` (packages/io) just `await` on pulling
 * their next chunk internally, so a rejection here propagates straight out
 * as the streaming call's own rejection, WITH THE RIGHT ERROR TYPE already
 * (`JobCancelledError`, recognized by name in pool.ts's
 * `isJobCancelledError`) — deliberately not routed through packages/io's
 * own `AbortSignal`/`IoStreamCancelledError` mechanism, which exists for io
 * callers that have no kernel-workers `JobCancelledError` to reach for (io
 * has no dependency on kernel-workers — see the layer rule in CLAUDE.md).
 */
async function* chunkStream(
  bytes: Uint8Array,
  chunkBytes: number,
  ctx: JobContext,
): AsyncGenerator<Uint8Array, void, void> {
  for await (const chunk of iterateInFixedChunks(bytes, Math.max(1, chunkBytes))) {
    if (await ctx.cancelled()) {
      throw new JobCancelledError();
    }
    yield chunk;
  }
}

const parseMeshFile: JobHandler<'parseMeshFile'> = async (payload, ctx) => {
  if (!(payload.bytes instanceof Uint8Array)) {
    throw new TypeError('parseMeshFile: bytes must be a Uint8Array');
  }
  const chunkBytes = payload.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const chunks = chunkStream(payload.bytes, chunkBytes, ctx);

  if (payload.format === 'stl') {
    const { soup, diagnostics } = await parseStlStream(chunks, payload.bytes.byteLength, {
      onProgress: ctx.progress,
    });
    const result: StlSoupResult = {
      kind: 'stl-soup',
      positions: soup.positions,
      normals: soup.normals,
      triangleCount: soup.triangleCount,
      format: diagnostics.format,
      warnings: diagnostics.warnings,
    };
    return result;
  }

  const mesh = await parsePlyStream(chunks, {
    totalBytes: payload.bytes.byteLength,
    onProgress: ctx.progress,
  });
  const result: PlyMeshResult = {
    kind: 'ply-mesh',
    positions: mesh.positions,
    normals: mesh.normals,
    colors: mesh.colors,
    indices: mesh.indices,
    vertexCount: mesh.vertexCount,
    faceCount: mesh.faceCount,
    format: mesh.diagnostics.format,
    warnings: mesh.diagnostics.warnings,
  };
  return result;
};

/**
 * `rescaleMesh`: multiplies every coordinate in `positions` by `factor` — the
 * worker-side half of the client's unit-mistake correction flow (see
 * apps/client/src/engine/units.ts's bbox heuristic and importer.ts's
 * confirmation-gated call site). Deliberately format-agnostic: `positions`
 * may be either a flat 9-per-triangle soup (STL) or a 3-per-vertex indexed
 * buffer (PLY) — a uniform scalar rescale is the same flat per-coordinate
 * multiply either way, so this job never needs `indices` at all. Runs in
 * Float64 throughout (kernel Float64 rule) and is the ONLY place a mesh's
 * coordinates change due to a unit mistake — CLAUDE.md's "no silent data
 * mutation" rule is enforced by the CALLER (importer.ts always resolves an
 * explicit user confirmation, journaled as an `Operation` named
 * `unit-rescale`, before ever invoking this job); this job itself performs
 * no confirmation or journaling — it is a pure, mechanical scale.
 */
export interface RescaleMeshPayload {
  /** Float64: kernel Float64 rule. Mutated IN PLACE and returned (this
   * buffer was transferred into the worker, so the worker is its sole
   * owner — see runJob's transfer contract) rather than copied into a
   * fresh array, since a rescale is a lossless, purely multiplicative
   * per-element transform with no shape change. */
  positions: Float64Array;
  /** Must be finite and > 0 — see units.ts's CM_TO_MM_FACTOR /
   * UM_TO_MM_FACTOR for the two factors the client's heuristic ever
   * suggests; this job itself has no opinion on which factors are
   * "reasonable" (that judgment lives entirely in units.ts + the mandatory
   * user confirmation dialog). */
  factor: number;
}

export interface RescaleMeshResult {
  positions: Float64Array;
}

// ---------------------------------------------------------------------------
// BVH jobs: buildBvh / releaseBvh / measurePointToSurface / raycastMesh.
//
// ## Per-worker BVH cache (Task 7's brief: "cache per mesh contentHash in
// worker memory")
//
// `bvhCache` below is a MODULE-LEVEL `Map`, exactly like manifold.ts's
// `manifoldPromise` memoization (packages/kernel/src/boolean/manifold.ts) —
// state that lives for the lifetime of THIS worker thread, not shared across
// the pool. A `WorkerPool` (pool.ts) round-robins jobs across up to
// `hardwareConcurrency - 1` workers with no per-job worker affinity, so a
// `buildBvh` call and a LATER `measurePointToSurface`/`raycastMesh` call for
// the SAME contentHash are not guaranteed to land on the same worker (and
// therefore the same cache) unless the caller pins them to a single-worker
// pool. apps/client/src/engine/workers.ts does exactly that (a dedicated
// `size: 1` "measurement pool", separate from the general geometry pool) —
// see its module doc — which is what makes "build once, query many times
// against the SAME cached Bvh" actually hold in practice; this cache itself
// has no opinion on how many workers exist, it just does the right thing
// (rebuild-on-miss) either way.
//
// `measurePointToSurface`/`raycastMesh` do NOT accept the mesh buffers as
// part of their payload — only `contentHash` plus the query itself (a point,
// or a ray). This keeps repeated single-pick payloads small (no re-sending
// a quarter-million-triangle mesh on every mouse click) at the cost of
// requiring `buildBvh` to have already cached that mesh THIS worker — a
// cache miss throws `BvhNotCachedError` (see below) rather than silently
// falling back to some other mesh source, since this job registry has no
// other way to obtain mesh geometry (jobs.ts has no filesystem/network
// access, and reaching back into the caller's meshStore would defeat the
// whole point of running in a worker).
// ---------------------------------------------------------------------------

/** Thrown by measurePointToSurface/raycastMesh when `contentHash` has no
 * cached BVH on THIS worker — see the cache doc above for why that can
 * legitimately happen (never built yet on this worker, or released). Named
 * (not just a plain Error) so pool.ts-style callers can recognize it the
 * same way `JobCancelledError` is recognized by `.name` after crossing the
 * Comlink boundary (Comlink reconstructs thrown errors as plain `Error`
 * instances with the original `name`/`message` preserved, not as this exact
 * subclass). */
export class BvhNotCachedError extends Error {
  constructor(contentHash: string) {
    super(`No BVH cached for contentHash ${contentHash} on this worker — call buildBvh first`);
    this.name = 'BvhNotCachedError';
  }
}

interface CachedBvh {
  mesh: IndexedMesh;
  bvh: Bvh;
}

/** Per-worker cache — see this section's module doc. */
const bvhCache = new Map<string, CachedBvh>();

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

const buildBvhJob: JobHandler<'buildBvh'> = async (payload, ctx) => {
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
   * particular worker never happened to build, in a multi-worker pool). */
  released: boolean;
}

const releaseBvh: JobHandler<'releaseBvh'> = async (payload) => {
  const released = bvhCache.delete(payload.contentHash);
  return { released };
};

/** Shared shape for a single Float64 mm point/vector crossing the Comlink
 * boundary as a plain (structured-cloned) tuple — no typed array/transfer
 * needed for 3 numbers. */
type Vec3Payload = readonly [number, number, number];

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

function requireCachedBvh(contentHash: string): CachedBvh {
  const cached = bvhCache.get(contentHash);
  if (!cached) {
    throw new BvhNotCachedError(contentHash);
  }
  return cached;
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
const measurePointToSurface: JobHandler<'measurePointToSurface'> = async (payload) => {
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
const raycastMesh: JobHandler<'raycastMesh'> = async (payload) => {
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

// ---------------------------------------------------------------------------
// distanceHeatmap (Task 9): per-vertex-of-A closest-surface-point distance
// to mesh B, batched into ONE job call (not one job per vertex — Task 9's
// brief).
//
// Like measurePointToSurface/raycastMesh above, this takes ONLY B's
// contentHash (not its buffers) — B must already be `buildBvh`'d on THIS
// worker. apps/client/src/engine/heatmap.ts (the browser call site) always
// runs this on the SAME size:1 measurement pool engine/workers.ts's
// `ensureBvhBuilt`/ToolManager.ts already use, for the same reason spelled
// out in this file's "Per-worker BVH cache" doc above: a `buildBvh` call for
// B and this job's later query against the same contentHash are only
// guaranteed to hit the SAME worker's cache (build once, query many times)
// on a pool that never has more than one worker.
//
// `payload.points` — UNLIKE measurePointToSurface's single `point` — is the
// whole batch: typically mesh A's entire vertex buffer (one heatmap value
// per vertex of A), but any flat xyz point set works. This keeps the
// Comlink round-trip count at ONE for a quarter-million-vertex heatmap
// (Task 9's guardrail: batch the per-vertex queries internally, not one job
// per vertex) at the cost of the caller pre-flattening its query points —
// exactly the shape `EngineMeshRecord.positions` (Float64, 3-per-vertex,
// see meshStore.ts) already has, so no extra work at the call site either.
// ---------------------------------------------------------------------------

export interface DistanceHeatmapPayload {
  /** contentHash of the TARGET mesh (B) — must already be cached via
   * `buildBvh` on this worker (see `BvhNotCachedError`). */
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
   * stage — see intakeMesh's job doc) — an inconsistently-wound B produces a
   * sign that flips per-triangle rather than meaning "inside/outside".
   * Defaults to false (every distance is >= 0, `Math.abs` of the signed
   * value). */
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
// chunks" cooperative pattern as rescaleMesh's RESCALE_PROGRESS_CHUNK_ELEMENTS
// above, sized so a ~250k-vertex arch scan reports on the order of a hundred
// checkpoints (frequent enough for a smooth progress bar, infrequent enough
// that the checkpoint's `await ctx.cancelled()` round trip never dominates).
const DISTANCE_HEATMAP_PROGRESS_CHUNK_POINTS = 2000;

const distanceHeatmap: JobHandler<'distanceHeatmap'> = async (payload, ctx) => {
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

// ---------------------------------------------------------------------------
// Repair jobs: repairRemoveComponents / repairSplitNonManifoldEdges /
// repairFillSmallHoles (Task 8).
//
// Each wraps ONE of @dqcad/kernel's pure repair/ functions (see
// packages/kernel/src/repair/*.ts's module docs for the algorithms) plus a
// before/after `analyzeMesh` call, so the caller (apps/client's repair
// preview panel) gets full `MeshStats` (watertight, manifoldEdges,
// boundaryEdgeCount, ...) on both sides without a separate round trip — the
// SAME "stats alongside the operation-specific report" split
// `IntakeMeshResult` uses for intake.
//
// Cancellation/progress granularity: unlike `intakeMesh` (4 real
// between-stage yield points), each repair kernel function here is ONE
// synchronous, non-yielding call — there is nothing to check cancellation
// BETWEEN internally, so (mirroring `buildBvh`'s job above) this offers a
// single checkpoint before starting, then reports 0 -> 1. Acceptable for
// Phase 1: repair operates on already-loaded, already-intake'd meshes (never
// bigger than the scan itself), and every repair function here is at most a
// small constant factor more expensive than intake's own analyzeMesh pass.
// ---------------------------------------------------------------------------

export interface RepairRemoveComponentsPayload {
  positions: Float64Array;
  indices: Uint32Array;
  selector: RemoveComponentsSelector;
}

export interface RepairRemoveComponentsResult {
  positions: Float64Array;
  indices: Uint32Array;
  report: RemoveComponentsReport;
  statsBefore: MeshStats;
  statsAfter: MeshStats;
}

export interface RepairSplitNonManifoldEdgesPayload {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface RepairSplitNonManifoldEdgesResult {
  positions: Float64Array;
  indices: Uint32Array;
  report: SplitNonManifoldEdgesReport;
  statsBefore: MeshStats;
  statsAfter: MeshStats;
}

export interface RepairFillSmallHolesPayload {
  positions: Float64Array;
  indices: Uint32Array;
  options?: FillSmallHolesOptions;
}

export interface RepairFillSmallHolesResult {
  positions: Float64Array;
  indices: Uint32Array;
  report: FillSmallHolesReport;
  statsBefore: MeshStats;
  statsAfter: MeshStats;
}

function requireMeshPayload(positions: unknown, indices: unknown, jobName: string): void {
  if (!(positions instanceof Float64Array)) {
    throw new TypeError(`${jobName}: positions must be a Float64Array (kernel Float64 rule)`);
  }
  if (!(indices instanceof Uint32Array)) {
    throw new TypeError(`${jobName}: indices must be a Uint32Array`);
  }
}

const repairRemoveComponents: JobHandler<'repairRemoveComponents'> = async (payload, ctx) => {
  requireMeshPayload(payload.positions, payload.indices, 'repairRemoveComponents');
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };
  const statsBefore = analyzeMesh(mesh);
  const { mesh: resultMesh, report } = removeComponents(mesh, payload.selector);
  const statsAfter = analyzeMesh(resultMesh);
  ctx.progress(1);
  return { positions: resultMesh.positions, indices: resultMesh.indices, report, statsBefore, statsAfter };
};

const repairSplitNonManifoldEdges: JobHandler<'repairSplitNonManifoldEdges'> = async (payload, ctx) => {
  requireMeshPayload(payload.positions, payload.indices, 'repairSplitNonManifoldEdges');
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };
  const statsBefore = analyzeMesh(mesh);
  const { mesh: resultMesh, report } = splitNonManifoldEdges(mesh);
  const statsAfter = analyzeMesh(resultMesh);
  ctx.progress(1);
  return { positions: resultMesh.positions, indices: resultMesh.indices, report, statsBefore, statsAfter };
};

const repairFillSmallHoles: JobHandler<'repairFillSmallHoles'> = async (payload, ctx) => {
  requireMeshPayload(payload.positions, payload.indices, 'repairFillSmallHoles');
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };
  const statsBefore = analyzeMesh(mesh);
  const { mesh: resultMesh, report } = fillSmallHoles(mesh, payload.options);
  const statsAfter = analyzeMesh(resultMesh);
  ctx.progress(1);
  return { positions: resultMesh.positions, indices: resultMesh.indices, report, statsBefore, statsAfter };
};

export interface JobPayloadMap {
  echoMesh: EchoMeshPayload;
  longTask: LongTaskPayload;
  manifoldSmoke: ManifoldSmokePayload;
  parseMeshFile: ParseMeshFilePayload;
  intakeMesh: IntakeMeshPayload;
  rescaleMesh: RescaleMeshPayload;
  buildBvh: BuildBvhPayload;
  releaseBvh: ReleaseBvhPayload;
  measurePointToSurface: MeasurePointToSurfacePayload;
  raycastMesh: RaycastMeshPayload;
  distanceHeatmap: DistanceHeatmapPayload;
  repairRemoveComponents: RepairRemoveComponentsPayload;
  repairSplitNonManifoldEdges: RepairSplitNonManifoldEdgesPayload;
  repairFillSmallHoles: RepairFillSmallHolesPayload;
}

export interface JobResultMap {
  echoMesh: EchoMeshResult;
  longTask: LongTaskResult;
  manifoldSmoke: ManifoldSmokeResult;
  parseMeshFile: ParseMeshFileResult;
  intakeMesh: IntakeMeshResult;
  rescaleMesh: RescaleMeshResult;
  buildBvh: BuildBvhResult;
  releaseBvh: ReleaseBvhResult;
  measurePointToSurface: MeasurePointToSurfaceResult;
  raycastMesh: RaycastMeshResult;
  distanceHeatmap: DistanceHeatmapResult;
  repairRemoveComponents: RepairRemoveComponentsResult;
  repairSplitNonManifoldEdges: RepairSplitNonManifoldEdgesResult;
  repairFillSmallHoles: RepairFillSmallHolesResult;
}

export type JobName = keyof JobPayloadMap;

type JobHandler<J extends JobName> = (
  payload: JobPayloadMap[J],
  ctx: JobContext,
) => Promise<JobResultMap[J]>;

/**
 * Acceptance round-trip job: hands the same typed-array buffers straight
 * back. On its own this only proves correctness of pass-through logic — the
 * actual "was it transferred, not copied" and "byte-identical" assertions
 * live in pool.ts's caller (WorkerPool.run) and its tests, since only the
 * caller holds the pre-transfer reference needed to check `byteLength`.
 */
const echoMesh: JobHandler<'echoMesh'> = async (payload) => {
  if (!(payload.positions instanceof Float64Array)) {
    // Kernel Float64 rule (docs/plans/phase-0-foundation.md Global
    // Constraints): any buffer crossing the kernel-workers boundary carries
    // positions as Float64.
    throw new TypeError('echoMesh: positions must be a Float64Array');
  }
  if (!(payload.indices instanceof Uint32Array)) {
    throw new TypeError('echoMesh: indices must be a Uint32Array');
  }
  return { positions: payload.positions, indices: payload.indices };
};

// Report progress roughly this many times over a run: frequent enough to
// look smooth, infrequent enough that the Comlink round-trip per progress
// call isn't the bottleneck.
const PROGRESS_STEPS = 20;

/**
 * Deterministic long-running job used to exercise progress reporting and
 * cancellation. Cancellation here is COOPERATIVE: `ctx.cancelled()` is only
 * checked at chunk boundaries (every ~iterations/PROGRESS_STEPS loops), not
 * on every iteration. This is a deliberate, documented tradeoff — checking
 * (and awaiting, since the proxied cancelled() call is a Comlink round
 * trip) every iteration would dominate the running time for cheap
 * per-iteration work. A real abort therefore lands within one chunk of the
 * abort() call, not instantly, which is acceptable for Phase 0's geometry
 * jobs.
 */
const longTask: JobHandler<'longTask'> = async (payload, ctx) => {
  const { iterations } = payload;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new TypeError('longTask: iterations must be a positive integer');
  }
  const chunkSize = Math.max(1, Math.floor(iterations / PROGRESS_STEPS));
  let sum = 0;
  for (let i = 0; i < iterations; i += 1) {
    sum += i;
    const atChunkBoundary = i % chunkSize === chunkSize - 1 || i === iterations - 1;
    if (atChunkBoundary) {
      if (await ctx.cancelled()) {
        throw new JobCancelledError();
      }
      ctx.progress((i + 1) / iterations);
    }
  }
  return { sum };
};

// Unit cube (edge length 1), corner at (offsetX, 0, 0), with vertices/
// triangle winding verified against manifold-3d directly (each triangle's
// (v1-v0)x(v2-v0) cross product checked to point outward — manifold-3d
// requires CCW-from-outside winding and throws NonManifoldInputError
// (surfaced from @dqcad/kernel's `union`/etc.) for meshes with inconsistent
// or inward-facing winding).
function unitCubeMesh(offsetX: number): IndexedMesh {
  const positions = new Float64Array([
    offsetX,
    0,
    0,
    offsetX + 1,
    0,
    0,
    offsetX + 1,
    1,
    0,
    offsetX,
    1,
    0,
    offsetX,
    0,
    1,
    offsetX + 1,
    0,
    1,
    offsetX + 1,
    1,
    1,
    offsetX,
    1,
    1,
  ]);
  const indices = new Uint32Array([
    0,
    2,
    1,
    0,
    3,
    2, // bottom (-z)
    4,
    5,
    6,
    4,
    6,
    7, // top (+z)
    0,
    1,
    5,
    0,
    5,
    4, // front (-y)
    1,
    2,
    6,
    1,
    6,
    5, // right (+x)
    2,
    3,
    7,
    2,
    7,
    6, // back (+y)
    0,
    4,
    7,
    0,
    7,
    3, // left (-x)
  ]);
  return { positions, indices };
}

const MANIFOLD_SMOKE_CUBE_OFFSET_X = 0.5;
const MANIFOLD_SMOKE_EXPECTED_VOLUME = 1.5;

/**
 * Proves manifold-3d's WASM module loads and runs a real boolean op inside
 * THIS worker (browser Web Worker or Node worker_threads worker) — the
 * counterpart, at the kernel-workers layer, to @dqcad/kernel's own
 * union/volume unit tests (packages/kernel/src/boolean/manifold.test.ts),
 * which only prove the same thing on the main/test thread.
 */
const manifoldSmoke: JobHandler<'manifoldSmoke'> = async () => {
  const a = unitCubeMesh(0);
  const b = unitCubeMesh(MANIFOLD_SMOKE_CUBE_OFFSET_X);
  const unioned = await union(a, b);
  const unionVolume = await volume(unioned);
  return { volume: unionVolume, expected: MANIFOLD_SMOKE_EXPECTED_VOLUME };
};

// Stage weights for intakeMesh's progress fractions: 4 between-stage
// checkpoints (after weld/skip-weld, after dropDegenerate, after orient,
// after analyze), evenly spaced. When the weld stage is skipped (indexed
// input) progress starts at the same first checkpoint anyway (the
// "prepare mesh" stage is then trivially cheap) — keeping the fraction
// sequence identical for both input kinds so UI progress bars behave the
// same regardless of source format.
const INTAKE_STAGE_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;

/** See IntakeMeshPayload's doc: sequences the kernel intake stages with an
 * `await ctx.cancelled()` + `ctx.progress()` checkpoint between each —
 * deliberately NOT a call to kernel `intake()` (which is synchronous
 * end-to-end and offers no between-stage yield points; see its module doc
 * for this exact division of labor). The report is assembled with the same
 * `countsOf`/`makeStepReport` helpers `intake()` itself uses, so both call
 * paths produce the identical journal-ready `IntakeReport` shape. */
const intakeMesh: JobHandler<'intakeMesh'> = async (payload, ctx) => {
  if (!(payload.positions instanceof Float64Array)) {
    throw new TypeError('intakeMesh: positions must be a Float64Array (kernel Float64 rule)');
  }
  if (payload.kind !== 'soup' && payload.kind !== 'indexed') {
    throw new TypeError(
      `intakeMesh: kind must be "soup" or "indexed", got ${JSON.stringify(payload.kind)}`,
    );
  }

  const checkpoint = async (stage: number): Promise<void> => {
    if (await ctx.cancelled()) {
      throw new JobCancelledError();
    }
    ctx.progress(INTAKE_STAGE_FRACTIONS[stage]!);
  };

  const steps: IntakeStepReport[] = [];
  let mesh: IndexedMesh;
  if (payload.kind === 'soup') {
    if (payload.indices !== undefined) {
      throw new TypeError('intakeMesh: indices must be omitted for kind "soup"');
    }
    if (payload.positions.length % 9 !== 0) {
      throw new TypeError(
        'intakeMesh: soup positions length must be a multiple of 9 (9 values per triangle)',
      );
    }
    const triangleCount = payload.positions.length / 9;
    const soup = { positions: payload.positions, normals: null, triangleCount };
    mesh = weldVertices(soup);
    steps.push(
      makeStepReport('weld', { vertexCount: triangleCount * 3, triangleCount }, countsOf(mesh), {}),
    );
  } else {
    if (!(payload.indices instanceof Uint32Array)) {
      throw new TypeError('intakeMesh: indices must be a Uint32Array for kind "indexed"');
    }
    mesh = { positions: payload.positions, indices: payload.indices };
  }
  await checkpoint(0);

  const beforeDrop = countsOf(mesh);
  const dropped = dropDegenerateTriangles(mesh);
  steps.push(
    makeStepReport('dropDegenerateTriangles', beforeDrop, countsOf(dropped.mesh), {
      degenerateCount: dropped.degenerateCount,
      duplicateIndexCount: dropped.duplicateIndexCount,
    }),
  );
  await checkpoint(1);

  const beforeOrient = countsOf(dropped.mesh);
  const oriented = orientNormalsConsistently(dropped.mesh);
  steps.push(
    makeStepReport('orientNormalsConsistently', beforeOrient, countsOf(oriented.mesh), {
      flippedCount: oriented.flippedCount,
      componentCount: oriented.componentCount,
      ambiguousComponentCount: oriented.ambiguousComponentCount,
    }),
  );
  await checkpoint(2);

  const stats = analyzeMesh(oriented.mesh);
  await checkpoint(3);

  const report: IntakeReport = { weldEpsilonMm: MESH_WELD_EPSILON_MM, steps };
  const result: IntakeMeshResult = {
    positions: oriented.mesh.positions,
    indices: oriented.mesh.indices,
    stats,
    report,
  };
  return result;
};

// Chunk size (element count, not bytes) for rescaleMesh's progress/
// cancellation checkpoints — same "checked only between chunks" cooperative
// pattern as longTask/chunkStream above, sized so a ~250k-triangle arch scan
// (750k position components) reports a handful of checkpoints rather than
// one giant uninterruptible pass.
const RESCALE_PROGRESS_CHUNK_ELEMENTS = 200_000;

const rescaleMesh: JobHandler<'rescaleMesh'> = async (payload, ctx) => {
  if (!(payload.positions instanceof Float64Array)) {
    throw new TypeError('rescaleMesh: positions must be a Float64Array (kernel Float64 rule)');
  }
  if (!Number.isFinite(payload.factor) || payload.factor <= 0) {
    throw new TypeError(
      `rescaleMesh: factor must be a finite positive number, got ${payload.factor}`,
    );
  }

  const { positions, factor } = payload;
  const total = positions.length;
  if (total === 0) {
    ctx.progress(1);
    return { positions };
  }

  const chunkSize = Math.max(1, Math.min(RESCALE_PROGRESS_CHUNK_ELEMENTS, total));
  for (let i = 0; i < total; i += 1) {
    positions[i] = positions[i]! * factor;
    const atChunkBoundary = i % chunkSize === chunkSize - 1 || i === total - 1;
    if (atChunkBoundary) {
      if (await ctx.cancelled()) {
        throw new JobCancelledError();
      }
      ctx.progress((i + 1) / total);
    }
  }
  return { positions };
};

const registry: { [J in JobName]: JobHandler<J> } = {
  echoMesh,
  longTask,
  manifoldSmoke,
  parseMeshFile,
  intakeMesh,
  rescaleMesh,
  buildBvh: buildBvhJob,
  releaseBvh,
  measurePointToSurface,
  raycastMesh,
  distanceHeatmap,
  repairRemoveComponents,
  repairSplitNonManifoldEdges,
  repairFillSmallHoles,
};

const noopContext: JobContext = {
  progress: () => {},
  cancelled: () => false,
};

/**
 * TEST-ONLY escape hatch, not part of the production API: JobName /
 * JobPayloadMap / JobResultMap above deliberately only ever advertise
 * 'echoMesh' | 'longTask', so this is unreachable through the typed `run()`
 * signature. pool.test.ts reaches it by casting a job name past `JobName`
 * (see its worker-crash test), specifically to exercise WorkerPool's
 * 'error'/'exit' handling (pool.ts's spawnNodeWorker) for a worker that
 * genuinely dies mid-job — something no *thrown* error can simulate, since
 * Comlink just turns a normal throw into an ordinary rejection.
 *
 * `process.exit(1)` immediately and unrecoverably kills the Node
 * worker_threads worker it runs in. Guarded to no-op (well, to throw a
 * regular error) outside Node, since `process.exit` doesn't exist in a
 * browser Worker — fine, because pool.test.ts only exercises the Node path
 * (see its module doc comment).
 */
const TEST_ONLY_CRASH_WORKER_JOB = '__test_crashWorker__';

const testOnlyRegistry: Record<typeof TEST_ONLY_CRASH_WORKER_JOB, () => Promise<never>> = {
  [TEST_ONLY_CRASH_WORKER_JOB]: async () => {
    if (typeof process !== 'undefined' && typeof process.exit === 'function') {
      process.exit(1);
    }
    throw new Error(
      `${TEST_ONLY_CRASH_WORKER_JOB}: process.exit is unavailable in this runtime (Node-only test job)`,
    );
  },
};

function isTestOnlyJobName(name: string): name is typeof TEST_ONLY_CRASH_WORKER_JOB {
  return Object.prototype.hasOwnProperty.call(testOnlyRegistry, name);
}

/**
 * Worker-side Comlink target: both worker-entry.browser.ts and
 * worker-entry.node.ts do `Comlink.expose(runJob, endpoint)`. Kept generic
 * over job name (rather than one exposed method per job) so adding a job
 * only means adding an entry to `registry` above, not touching either
 * worker entry file.
 *
 * Note: TypeScript's generic signature here is for readability/local
 * type-safety only — Comlink's `Remote<T>` mapped type does not preserve
 * generic call signatures across the wire (verified: it collapses to the
 * union of possible results), so pool.ts's WorkerPool.run() narrows the
 * awaited result back to `JobResultMap[J]` with a single documented cast.
 *
 * ## Progress delivery ordering contract
 *
 * `onProgress`, when present, is `Comlink.proxy(callback)` (see pool.ts's
 * `run()`) — invoking it from inside the worker is itself a full postMessage
 * round trip to the caller's thread, over a **dedicated MessageChannel**
 * that Comlink allocates just for this proxied callback, separate from the
 * channel this very `runJob` call's own return value travels over. Separate
 * channels have no cross-channel ordering guarantee: even though a job
 * handler (e.g. `longTask` below) calls `ctx.progress(1)` before returning
 * its result, nothing about postMessage semantics guarantees the caller's
 * `onProgress` callback actually *runs* before the caller's `run()` promise
 * resolves — under load (many workers/ports live at once), the result
 * message can win that race, so a caller can observe its job resolve before
 * ever seeing the final `fraction === 1` progress event (this is exactly
 * what made pool.test.ts's longTask progress test flake under full-suite
 * concurrency — see that test's own comment for the empirical repro).
 *
 * `runJob` closes that gap here, once, for every job — rather than requiring
 * each handler to `await ctx.progress(...)` itself (which would also
 * serialize progress delivery into the hot loop, the exact per-iteration
 * cost `longTask`'s doc comment calls out as unacceptable): every call to
 * the `ctx.progress` wrapped below records the underlying delivery promise,
 * and this function `await`s all of them — in the `finally` below, so this
 * covers both the success and thrown-error paths — before its own result
 * (or rejection) is handed back to Comlink to send over the *other* channel.
 * Because the worker only sends that response after every progress
 * callback invocation has already completed (and been acknowledged) on the
 * caller's thread, `WorkerPool.run()` callers get a real happens-before
 * guarantee: by the time `run()`'s promise settles, `onProgress` has
 * already been called for every progress event the job reported, in order,
 * including the final one. See pool.ts's `RunJobOptions.onProgress` doc for
 * the caller-facing statement of this guarantee.
 */
export async function runJob<J extends JobName>(
  name: J,
  payload: JobPayloadMap[J],
  onProgress?: (fraction: number) => void,
  cancelled?: () => boolean | Promise<boolean>,
): Promise<JobResultMap[J]> {
  // `name` is typed as `J extends JobName`, so TS narrows it to `never`
  // under a `name is typeof TEST_ONLY_CRASH_WORKER_JOB` predicate (the
  // literal is outside J's constraint) — compare the raw string instead of
  // relying on the predicate to narrow `name` itself. See testOnlyRegistry's
  // doc comment above: deliberately outside the typed JobName surface. This
  // branch never resolves normally (the handler always either
  // process.exit()s or throws).
  if (isTestOnlyJobName(name)) {
    return testOnlyRegistry[TEST_ONLY_CRASH_WORKER_JOB]() as Promise<JobResultMap[J]>;
  }

  const handler = registry[name];
  const baseProgress = onProgress ?? noopContext.progress;
  // Every delivery in flight, so it can be flushed before this job settles
  // — see this function's "Progress delivery ordering contract" doc above.
  // Individually `.catch()`ed so a failed/torn-down delivery (e.g. the pool
  // was destroyed and the proxy's port is gone) can never turn into an
  // unhandled rejection or block the job's own result — only *ordering* is
  // this wrapper's job, not delivery guarantees for a pool that's going away
  // anyway.
  const pendingProgress: Promise<unknown>[] = [];
  const ctx: JobContext = {
    progress: (fraction) => {
      let delivery: Promise<unknown>;
      try {
        delivery = Promise.resolve(baseProgress(fraction));
      } catch (error) {
        delivery = Promise.reject(error);
      }
      pendingProgress.push(delivery.catch(() => {}));
    },
    cancelled: cancelled ?? noopContext.cancelled,
  };

  let result: JobResultMap[J];
  try {
    result = await handler(payload, ctx);
  } finally {
    await Promise.all(pendingProgress);
  }
  // Move the result's typed-array buffers back to the caller instead of
  // structured-cloning them — mirrors meshBuffers() on the request side.
  return Comlink.transfer(result, transferablesOf(result));
}

export type RunJob = typeof runJob;
