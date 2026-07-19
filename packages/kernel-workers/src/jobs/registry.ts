// Job registry: assembles every domain module under jobs/ (io, intake, bvh,
// heatmap, section, repair, misc) into the one typed `JobPayloadMap`/
// `JobResultMap`/`JobName` surface and the `runJob` dispatcher both worker
// entries `Comlink.expose()` as-is — the pure, environment-agnostic
// business logic that runs inside a worker (browser or Node — see
// worker-entry.browser.ts / worker-entry.node.ts). Individual job handlers
// (echoMesh, longTask, ...) never touch Comlink; only `runJob` at the
// bottom of this file does (including wrapping results for zero-copy
// transfer back — see transferablesOf in transfer.ts) — keeping that
// dispatch glue here rather than duplicated per entry is what "sharing this
// registry" means for the two entries.
//
// ## File map (Phase 2 Task 1: "split jobs.ts before new jobs" — this
// registry replaces the original 1575-line monolithic jobs.ts, deleted by
// this same change)
//
//   jobs/context.ts   JobContext, JobCancelledError (dependency-free leaf)
//   jobs/shared.ts     Vec3Payload, requireMeshPayload (dependency-free leaf)
//   jobs/io.ts         parseMeshFile, weldMeshSoup
//   jobs/intake.ts     intakeMesh
//   jobs/bvh.ts        buildBvh, releaseBvh, measurePointToSurface, raycastMesh
//   jobs/heatmap.ts    distanceHeatmap
//   jobs/section.ts    sectionMesh
//   jobs/repair.ts     repairRemoveComponents, repairSplitNonManifoldEdges,
//                      repairFillSmallHoles
//   jobs/misc.ts       echoMesh, longTask, manifoldSmoke, rescaleMesh,
//                      serializeMeshStl, hashMesh
//   jobs/geodesic.ts   geodesicPath, snapPolyline (Phase 2 Task 4)
//   jobs/sdf.ts        buildSdf, signedClosestPoint, sampleSdfGrid (Phase 2 Task 6)
//   jobs/offset.ts     offsetMesh (Phase 2 Task 7)
//   jobs/decimate.ts   decimateMesh (Phase 2 Task 10 — render LODs)
//   jobs/registry.ts   this file — types + runJob + registry assembly
//
// This was a PURE MECHANICAL MOVE (plus this same task's worker-side-hashing
// additions, made to the monolith first and carried over unchanged) — the
// public API (`JobName`/`JobPayloadMap`/`JobResultMap`, worker entries) is
// unchanged; every domain-file export needed outside jobs/ is re-exported
// from here so pool.ts/index.ts only need their OWN import path updated
// (`./jobs.js` -> `./jobs/registry.js`), not their import lists.
//
// ## No circular VALUE imports
//
// This file imports every domain module's handler functions (VALUES, not
// just types) to assemble `registry` below. None of those domain modules
// import anything back from HERE — they only import from the dependency-free
// leaves `./context.ts`/`./shared.ts` (plus, for jobs/heatmap.ts, a named
// export from jobs/bvh.ts) — so the dependency graph among jobs/*.ts files
// is a strict DAG with this file as the sole "top", never a cycle.
import * as Comlink from 'comlink';
// `.ts` extension (not this repo's usual `.js`): this file (and every other
// file under jobs/) is loaded natively by Node inside worker_threads (via
// worker-entry.node.ts), which doesn't map `.js` specifiers to `.ts` files
// — see tsconfig.json's allowImportingTsExtensions comment and CLAUDE.md's
// "Import extension convention".
import { transferablesOf } from '../transfer.ts';
// Bare package specifier, not a relative path, so no extension concern here
// — Node's native resolver and the bundler/vitest resolver both resolve
// '@dqcad/kernel' via its package.json the same way. kernel-workers -> kernel
// is an allowed dependency direction (see eslint.config.js's boundaries
// policy).
import { KERNEL_VERSION } from '@dqcad/kernel';

// Re-exported so apps/client/src/engine — which may depend on
// kernel-workers but NOT directly on kernel (see eslint.config.js's
// boundaries policy: engine -> kernel-workers|state|shared-types) — can
// stamp journal `Operation.kernelVersion` (shared-types) without importing
// `@dqcad/kernel` itself.
export { KERNEL_VERSION };

export { JobCancelledError, type JobContext } from './context.ts';
import type { JobContext } from './context.ts';

import {
  parseMeshFile,
  weldMeshSoup,
  type ParseMeshFilePayload,
  type ParseMeshFileResult,
  type StlSoupResult,
  type PlyMeshResult,
  type WeldMeshSoupPayload,
  type WeldMeshSoupResult,
} from './io.ts';
export type { ParseMeshFilePayload, ParseMeshFileResult, StlSoupResult, PlyMeshResult, WeldMeshSoupPayload, WeldMeshSoupResult };

import { intakeMesh, type IntakeMeshPayload, type IntakeMeshResult } from './intake.ts';
export type { IntakeMeshPayload, IntakeMeshResult };

import {
  buildBvhJob,
  releaseBvh,
  measurePointToSurface,
  raycastMesh,
  BvhNotCachedError,
  type BuildBvhPayload,
  type BuildBvhResult,
  type ReleaseBvhPayload,
  type ReleaseBvhResult,
  type MeasurePointToSurfacePayload,
  type MeasurePointToSurfaceResult,
  type RaycastMeshPayload,
  type RaycastMeshResult,
} from './bvh.ts';
export {
  BvhNotCachedError,
  type BuildBvhPayload,
  type BuildBvhResult,
  type ReleaseBvhPayload,
  type ReleaseBvhResult,
  type MeasurePointToSurfacePayload,
  type MeasurePointToSurfaceResult,
  type RaycastMeshPayload,
  type RaycastMeshResult,
};

import { distanceHeatmap, type DistanceHeatmapPayload, type DistanceHeatmapResult } from './heatmap.ts';
export type { DistanceHeatmapPayload, DistanceHeatmapResult };

import {
  buildSdf,
  signedClosestPointJob,
  sampleSdfGridJob,
  SdfNotCachedError,
  type BuildSdfPayload,
  type BuildSdfResult,
  type SignedClosestPointPayload,
  type SignedClosestPointResult,
  type SampleSdfGridPayload,
  type SampleSdfGridResult,
} from './sdf.ts';
export {
  SdfNotCachedError,
  type BuildSdfPayload,
  type BuildSdfResult,
  type SignedClosestPointPayload,
  type SignedClosestPointResult,
  type SampleSdfGridPayload,
  type SampleSdfGridResult,
};

import { computeCurvatureJob, type ComputeCurvaturePayload, type ComputeCurvatureResult } from './curvature.ts';
export type { ComputeCurvaturePayload, ComputeCurvatureResult };

import { offsetMeshJob, type OffsetMeshPayload, type OffsetMeshResult } from './offset.ts';
export type { OffsetMeshPayload, OffsetMeshResult };

import { decimateMeshJob, type DecimateMeshPayload, type DecimateMeshResult } from './decimate.ts';
export type { DecimateMeshPayload, DecimateMeshResult };

import {
  undercutScanJob,
  undercutScanBatchJob,
  type UndercutScanPayload,
  type UndercutScanResult,
  type UndercutScanBatchPayload,
  type UndercutScanBatchResult,
} from './undercut.ts';
export type { UndercutScanPayload, UndercutScanResult, UndercutScanBatchPayload, UndercutScanBatchResult };

import { sectionMeshJob, type SectionMeshPayload, type SectionMeshResult } from './section.ts';
export type { SectionMeshPayload, SectionMeshResult };

import {
  geodesicPathJob,
  snapPolyline,
  type GeodesicPathPayload,
  type GeodesicPathResult,
  type SnapPolylinePayload,
  type SnapPolylineResult,
  type SurfacePointPayload,
} from './geodesic.ts';
export type { GeodesicPathPayload, GeodesicPathResult, SnapPolylinePayload, SnapPolylineResult, SurfacePointPayload };

import {
  icpRegisterJob,
  DegenerateTripleError,
  type CoarsePointPair,
  type IcpRegisterPayload,
  type IcpRegisterResult,
} from './register.ts';
export { DegenerateTripleError, type CoarsePointPair, type IcpRegisterPayload, type IcpRegisterResult };

import {
  affectedSpanIndices,
  fitSurfaceSpline,
  fitSurfaceSplineSpan,
  surfacePointPayloadAt,
  type FitSurfaceSplinePayload,
  type FitSurfaceSplineResult,
  type FitSurfaceSplineSpanPayload,
  type FitSurfaceSplineSpanResult,
  type SurfacePointPayload as SplineSurfacePointPayload,
} from './spline.ts';
export {
  affectedSpanIndices,
  surfacePointPayloadAt,
  type FitSurfaceSplinePayload,
  type FitSurfaceSplineResult,
  type FitSurfaceSplineSpanPayload,
  type FitSurfaceSplineSpanResult,
  type SplineSurfacePointPayload,
};

import {
  repairRemoveComponents,
  repairSplitNonManifoldEdges,
  repairSplitNonManifoldVertices,
  repairFillSmallHoles,
  type RepairRemoveComponentsPayload,
  type RepairRemoveComponentsResult,
  type RepairSplitNonManifoldEdgesPayload,
  type RepairSplitNonManifoldEdgesResult,
  type RepairSplitNonManifoldVerticesPayload,
  type RepairSplitNonManifoldVerticesResult,
  type RepairFillSmallHolesPayload,
  type RepairFillSmallHolesResult,
} from './repair.ts';
export type {
  RepairRemoveComponentsPayload,
  RepairRemoveComponentsResult,
  RepairSplitNonManifoldEdgesPayload,
  RepairSplitNonManifoldEdgesResult,
  RepairSplitNonManifoldVerticesPayload,
  RepairSplitNonManifoldVerticesResult,
  RepairFillSmallHolesPayload,
  RepairFillSmallHolesResult,
};

import {
  echoMesh,
  longTask,
  manifoldSmoke,
  rescaleMesh,
  serializeMeshStl,
  hashMesh,
  type EchoMeshPayload,
  type EchoMeshResult,
  type LongTaskPayload,
  type LongTaskResult,
  type ManifoldSmokePayload,
  type ManifoldSmokeResult,
  type RescaleMeshPayload,
  type RescaleMeshResult,
  type SerializeMeshStlPayload,
  type SerializeMeshStlResult,
  type HashMeshPayload,
  type HashMeshResult,
} from './misc.ts';
export {
  type EchoMeshPayload,
  type EchoMeshResult,
  type LongTaskPayload,
  type LongTaskResult,
  type ManifoldSmokePayload,
  type ManifoldSmokeResult,
  type RescaleMeshPayload,
  type RescaleMeshResult,
  type SerializeMeshStlPayload,
  type SerializeMeshStlResult,
  type HashMeshPayload,
  type HashMeshResult,
};

export interface JobPayloadMap {
  echoMesh: EchoMeshPayload;
  longTask: LongTaskPayload;
  manifoldSmoke: ManifoldSmokePayload;
  parseMeshFile: ParseMeshFilePayload;
  intakeMesh: IntakeMeshPayload;
  serializeMeshStl: SerializeMeshStlPayload;
  weldMeshSoup: WeldMeshSoupPayload;
  rescaleMesh: RescaleMeshPayload;
  buildBvh: BuildBvhPayload;
  releaseBvh: ReleaseBvhPayload;
  measurePointToSurface: MeasurePointToSurfacePayload;
  raycastMesh: RaycastMeshPayload;
  distanceHeatmap: DistanceHeatmapPayload;
  buildSdf: BuildSdfPayload;
  signedClosestPoint: SignedClosestPointPayload;
  sampleSdfGrid: SampleSdfGridPayload;
  offsetMesh: OffsetMeshPayload;
  decimateMesh: DecimateMeshPayload;
  undercutScan: UndercutScanPayload;
  undercutScanBatch: UndercutScanBatchPayload;
  computeCurvature: ComputeCurvaturePayload;
  repairRemoveComponents: RepairRemoveComponentsPayload;
  repairSplitNonManifoldEdges: RepairSplitNonManifoldEdgesPayload;
  repairSplitNonManifoldVertices: RepairSplitNonManifoldVerticesPayload;
  repairFillSmallHoles: RepairFillSmallHolesPayload;
  sectionMesh: SectionMeshPayload;
  hashMesh: HashMeshPayload;
  geodesicPath: GeodesicPathPayload;
  snapPolyline: SnapPolylinePayload;
  fitSurfaceSpline: FitSurfaceSplinePayload;
  fitSurfaceSplineSpan: FitSurfaceSplineSpanPayload;
  icpRegister: IcpRegisterPayload;
}

export interface JobResultMap {
  echoMesh: EchoMeshResult;
  longTask: LongTaskResult;
  manifoldSmoke: ManifoldSmokeResult;
  parseMeshFile: ParseMeshFileResult;
  intakeMesh: IntakeMeshResult;
  serializeMeshStl: SerializeMeshStlResult;
  weldMeshSoup: WeldMeshSoupResult;
  rescaleMesh: RescaleMeshResult;
  buildBvh: BuildBvhResult;
  releaseBvh: ReleaseBvhResult;
  measurePointToSurface: MeasurePointToSurfaceResult;
  raycastMesh: RaycastMeshResult;
  distanceHeatmap: DistanceHeatmapResult;
  buildSdf: BuildSdfResult;
  signedClosestPoint: SignedClosestPointResult;
  sampleSdfGrid: SampleSdfGridResult;
  offsetMesh: OffsetMeshResult;
  decimateMesh: DecimateMeshResult;
  undercutScan: UndercutScanResult;
  undercutScanBatch: UndercutScanBatchResult;
  computeCurvature: ComputeCurvatureResult;
  repairRemoveComponents: RepairRemoveComponentsResult;
  repairSplitNonManifoldEdges: RepairSplitNonManifoldEdgesResult;
  repairSplitNonManifoldVertices: RepairSplitNonManifoldVerticesResult;
  repairFillSmallHoles: RepairFillSmallHolesResult;
  sectionMesh: SectionMeshResult;
  hashMesh: HashMeshResult;
  geodesicPath: GeodesicPathResult;
  snapPolyline: SnapPolylineResult;
  fitSurfaceSpline: FitSurfaceSplineResult;
  fitSurfaceSplineSpan: FitSurfaceSplineSpanResult;
  icpRegister: IcpRegisterResult;
}

export type JobName = keyof JobPayloadMap;

type JobHandler<J extends JobName> = (
  payload: JobPayloadMap[J],
  ctx: JobContext,
) => Promise<JobResultMap[J]>;

const registry: { [J in JobName]: JobHandler<J> } = {
  echoMesh,
  longTask,
  manifoldSmoke,
  parseMeshFile,
  intakeMesh,
  serializeMeshStl,
  weldMeshSoup,
  rescaleMesh,
  buildBvh: buildBvhJob,
  releaseBvh,
  measurePointToSurface,
  raycastMesh,
  distanceHeatmap,
  buildSdf,
  signedClosestPoint: signedClosestPointJob,
  sampleSdfGrid: sampleSdfGridJob,
  offsetMesh: offsetMeshJob,
  decimateMesh: decimateMeshJob,
  undercutScan: undercutScanJob,
  undercutScanBatch: undercutScanBatchJob,
  computeCurvature: computeCurvatureJob,
  repairRemoveComponents,
  repairSplitNonManifoldEdges,
  repairSplitNonManifoldVertices,
  repairFillSmallHoles,
  sectionMesh: sectionMeshJob,
  hashMesh,
  geodesicPath: geodesicPathJob,
  snapPolyline,
  fitSurfaceSpline,
  fitSurfaceSplineSpan,
  icpRegister: icpRegisterJob,
};

const noopContext: JobContext = {
  progress: () => {},
  cancelled: () => false,
};

/**
 * TEST-ONLY escape hatch, not part of the production API: JobName /
 * JobPayloadMap / JobResultMap above deliberately only ever advertise the
 * real job names, so this is unreachable through the typed `run()`
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
 * only means adding an entry to `registry` above (and, since Phase 2 Task
 * 1's split, to the right jobs/*.ts domain module), not touching either
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
 * handler (e.g. `longTask`, jobs/misc.ts) calls `ctx.progress(1)` before
 * returning its result, nothing about postMessage semantics guarantees the
 * caller's `onProgress` callback actually *runs* before the caller's
 * `run()` promise resolves — under load (many workers/ports live at once),
 * the result message can win that race, so a caller can observe its job
 * resolve before ever seeing the final `fraction === 1` progress event
 * (this is exactly what made pool.test.ts's longTask progress test flake
 * under full-suite concurrency — see that test's own comment for the
 * empirical repro).
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
 *
 * ## Pool-destruction progress-flush race (final-review Minor #4; documented
 * per this task's brief rather than adding a settle-escape — see below for
 * why a settle-escape isn't needed)
 *
 * The `finally { await Promise.all(pendingProgress) }` below has no
 * timeout and no escape hatch of its own: if a pending delivery's
 * underlying Comlink call never resolves, this function never returns
 * either. This is a real, intentionally-undefended race with
 * `WorkerPool.destroy()` (pool.ts): `destroy()` rejects every in-flight
 * `run()` call's promise (via `activeRun.reject()`, racing it against the
 * still-live `worker.remote(...)` call) BEFORE it goes on to actually
 * terminate the underlying worker — so there is a window where a caller has
 * already observed `PoolDestroyedError` for a job whose `runJob` (THIS
 * function, running inside the worker) is still awaiting a progress
 * delivery's response.
 *
 * Why this is safe WITHOUT a `Promise.race`/settle-escape here: the thing
 * that actually ends this await is `worker.terminate()`, which `destroy()`
 * calls shortly after rejecting the active runs (pool.ts's `destroy()`
 * `Promise.allSettled(...worker.terminate())` loop) — both Node
 * `worker_threads.Worker#terminate()` and the DOM `Worker#terminate()`
 * unconditionally and immediately stop the worker's JS execution context,
 * mid-`await` or not. There is nothing left to "hang": the whole call stack
 * this `finally` block is running on, `pendingProgress` array included,
 * simply stops existing along with the rest of the worker thread — no
 * leaked timer, no dangling promise anyone is still awaiting (the ONLY
 * thing that was ever awaiting this side of the call was code running
 * inside the now-terminated worker itself), and pool.ts's own `destroy()`
 * doesn't wait on this function at all (it awaits `worker.terminate()`,
 * not any promise `runJob` returns). pool.test.ts's destroy-related tests
 * (destroying a pool with jobs in flight) already assert `destroy()`
 * itself always resolves promptly — this doc is the "why" for that
 * behavior, not a new runtime change: adding a `Promise.race` against a
 * termination signal here would be strictly redundant (the OS/engine-level
 * termination already IS that race's other arm) and would risk the thing
 * this task's brief explicitly rules out — weakening the
 * progress-before-resolution ordering contract above for the (overwhelmingly
 * common) non-destroyed case, by introducing a second code path for when a
 * job's result is allowed to go out before its progress has flushed.
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
