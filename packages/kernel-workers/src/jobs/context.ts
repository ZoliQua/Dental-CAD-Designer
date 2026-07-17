// Job-handler infrastructure shared by every domain module under jobs/ (io,
// intake, bvh, heatmap, section, repair, misc) — split out of the original
// monolithic jobs.ts (Phase 2 Task 1: "split jobs.ts before new jobs") so
// every domain file can depend on JUST this small, dependency-free leaf
// module rather than on jobs/registry.ts itself (which, in turn, imports
// EVERY domain module to assemble the registry — importing back from here
// would be a real circular VALUE import; see registry.ts's module doc).
//
// `.ts` extension: this file is reachable from the Node worker entry's
// import closure (worker-entry.node.ts -> jobs/registry.ts -> every
// jobs/*.ts domain module -> this file), so its own relative imports (none,
// here) would need literal `.ts` extensions too — see CLAUDE.md's "Import
// extension convention".

/** Context passed to a job handler for progress reporting and cooperative
 * cancellation. Both members are plain functions on the worker side; the
 * pool (pool.ts) supplies Comlink-proxied versions when it calls across the
 * worker boundary, so calling them here is just a normal (possibly async)
 * function call as far as job code is concerned. */
export interface JobContext {
  /** Report fractional progress in [0, 1]. Deliberately typed (and callable)
   * as fire-and-forget — job code is never required to `await` this, and
   * handlers like `longTask` (jobs/misc.ts) don't — but `runJob`'s
   * dispatcher (jobs/registry.ts — see its doc comment) tracks every call's
   * underlying delivery and flushes them before the job settles, so callers
   * of `WorkerPool.run()` still get a strict progress-before-resolution
   * ordering guarantee without job code having to know or care about it. */
  progress: (fraction: number) => void;
  /** Cooperative cancellation flag — see each job handler's own doc for why
   * this is checked only between chunks rather than preemptively. */
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
