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
  type IndexedMesh,
  type IntakeReport,
  type IntakeStepReport,
  type MeshStats,
} from '@dqcad/kernel';
// kernel-workers -> io is also an allowed dependency direction (see
// eslint.config.js's boundaries policy) — packages/io became
// node-worker-reachable starting Phase 1 (see its own module docs' "Import
// extension convention" note) specifically so a job like `parseMeshFile`
// below could run STL/PLY parsing off the main/UI thread.
import {
  iterateInFixedChunks,
  parsePlyStream,
  parseStlStream,
  type ParseFormat,
} from '@dqcad/io';

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

export interface JobPayloadMap {
  echoMesh: EchoMeshPayload;
  longTask: LongTaskPayload;
  manifoldSmoke: ManifoldSmokePayload;
  parseMeshFile: ParseMeshFilePayload;
  intakeMesh: IntakeMeshPayload;
}

export interface JobResultMap {
  echoMesh: EchoMeshResult;
  longTask: LongTaskResult;
  manifoldSmoke: ManifoldSmokeResult;
  parseMeshFile: ParseMeshFileResult;
  intakeMesh: IntakeMeshResult;
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
    offsetX, 0, 0, offsetX + 1, 0, 0, offsetX + 1, 1, 0, offsetX, 1, 0,
    offsetX, 0, 1, offsetX + 1, 0, 1, offsetX + 1, 1, 1, offsetX, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // front (-y)
    1, 2, 6, 1, 6, 5, // right (+x)
    2, 3, 7, 2, 7, 6, // back (+y)
    0, 4, 7, 0, 7, 3, // left (-x)
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
    throw new TypeError(`intakeMesh: kind must be "soup" or "indexed", got ${JSON.stringify(payload.kind)}`);
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
      throw new TypeError('intakeMesh: soup positions length must be a multiple of 9 (9 values per triangle)');
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

const registry: { [J in JobName]: JobHandler<J> } = {
  echoMesh,
  longTask,
  manifoldSmoke,
  parseMeshFile,
  intakeMesh,
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
