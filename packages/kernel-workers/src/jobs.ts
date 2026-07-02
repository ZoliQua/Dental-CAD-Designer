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
import { union, volume, type IndexedMesh } from '@dqcad/kernel';

/** Context passed to a job handler for progress reporting and cooperative
 * cancellation. Both members are plain functions on the worker side; the
 * pool (pool.ts) supplies Comlink-proxied versions when it calls across the
 * worker boundary, so calling them here is just a normal (possibly async)
 * function call as far as job code is concerned. */
export interface JobContext {
  /** Report fractional progress in [0, 1]. */
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

export interface JobPayloadMap {
  echoMesh: EchoMeshPayload;
  longTask: LongTaskPayload;
  manifoldSmoke: ManifoldSmokePayload;
}

export interface JobResultMap {
  echoMesh: EchoMeshResult;
  longTask: LongTaskResult;
  manifoldSmoke: ManifoldSmokeResult;
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

const registry: { [J in JobName]: JobHandler<J> } = { echoMesh, longTask, manifoldSmoke };

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
  const ctx: JobContext = {
    progress: onProgress ?? noopContext.progress,
    cancelled: cancelled ?? noopContext.cancelled,
  };
  const result = await handler(payload, ctx);
  // Move the result's typed-array buffers back to the caller instead of
  // structured-cloning them — mirrors meshBuffers() on the request side.
  return Comlink.transfer(result, transferablesOf(result));
}

export type RunJob = typeof runJob;
