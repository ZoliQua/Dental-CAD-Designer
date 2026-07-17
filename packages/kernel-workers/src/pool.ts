// WorkerPool: main-thread (or main-worker-thread) side of the worker
// infrastructure. Spawns a small, bounded pool of workers — browser Web
// Workers or Node worker_threads Workers, picked at runtime by
// isNodeRuntime() — reuses them across jobs, and layers progress reporting
// and cooperative cancellation on top of jobs/registry.ts's `runJob` dispatcher via
// Comlink.
//
// Environment split: the two `new Worker(new URL('./worker-entry.*.ts',
// import.meta.url), ...)` calls below are the ONLY place the concrete
// worker script paths appear. The browser one is written so Vite's static
// worker-detection sees a literal `new Worker(new URL(...))` expression
// (verified via `vite build`: it produces a dedicated
// `worker-entry.browser-*.js` chunk). The Node one goes through
// `new NodeWorker(...)` (a destructured import, not the bare `Worker`
// identifier) specifically so Vite's detector does *not* also try to treat
// it as a browser worker entry — confirmed empirically that this avoids
// bundling worker-entry.node.ts (and its `node:worker_threads` import) into
// the client build at all. `node:worker_threads` itself is dynamically
// imported only inside the isNodeRuntime() branch, so a browser build never
// needs to resolve it eagerly; Vite externalizes the bare specifier to an
// inert stub, which is never reached at runtime in a browser.
import * as Comlink from 'comlink';
import {
  JobCancelledError,
  type JobName,
  type JobPayloadMap,
  type JobResultMap,
  type RunJob,
} from './jobs/registry.js';

export { JobCancelledError };

export interface RunJobOptions {
  /** Buffers to move (not copy) into the worker — see transfer.ts's
   * meshBuffers() for building this for mesh payloads. */
  transfer?: Transferable[];
  /**
   * Progress delivery ordering guarantee: every call the job makes to
   * `ctx.progress(...)` (jobs/registry.ts) is guaranteed to have already reached
   * `onProgress` — i.e. this callback has actually run for it — by the time
   * this `run()` call's returned promise settles (resolves OR rejects),
   * including the job's final progress event, if any. Callers may safely
   * assume "the last `onProgress` call observed before `run()` settles is
   * the job's true final state" (e.g. a UI progress bar reading 100% exactly
   * when its "done" handler fires) without racing the job's own resolution.
   *
   * This is enforced centrally by jobs/registry.ts's `runJob` dispatcher (see its
   * "Progress delivery ordering contract" doc comment), not by this pool
   * itself — `onProgress` here is `Comlink.proxy()`-wrapped and handed
   * straight to the worker, which invokes it over its own dedicated
   * MessageChannel (a different channel than this call's result travels
   * over); `runJob` is what awaits every such delivery before letting the
   * job's own result/rejection go out. Without that, the two channels have
   * no ordering relationship, and a caller could observe `run()` resolve
   * before ever seeing the job's last progress event — see pool.test.ts's
   * longTask progress test for the concrete, once-flaky symptom this fixes.
   */
  onProgress?: (fraction: number) => void;
  /** Cooperative cancellation: aborting rejects the returned promise with
   * JobCancelledError. If the job is still queued (pool saturated), the
   * rejection is immediate — it never gets a worker. If the job is already
   * running, the worker notices at its next chunk boundary (see jobs/misc.ts's
   * longTask doc comment) — not necessarily instantly. */
  signal?: AbortSignal;
}

/**
 * Thrown by `run()` when `destroy()` is called while that job is queued or
 * in flight. Distinct from JobCancelledError (which means the *caller*
 * asked to stop) — this means the *pool itself* went away.
 */
export class PoolDestroyedError extends Error {
  constructor(message = 'WorkerPool: pool was destroyed') {
    super(message);
    this.name = 'PoolDestroyedError';
  }
}

/**
 * Thrown by `run()` when the worker executing its job crashes (uncaught
 * exception / unexpected exit) before it could respond. The dead worker is
 * evicted from the pool (never recycled into `idle`) — a subsequent `run()`
 * spawns a fresh replacement on demand.
 */
export class WorkerCrashedError extends Error {
  constructor(message = 'WorkerPool: worker crashed') {
    super(message);
    this.name = 'WorkerCrashedError';
  }
}

interface PooledWorker {
  remote: Comlink.Remote<RunJob>;
  terminate: () => Promise<void>;
  /** Set once this worker has crashed (or exited abnormally). A crashed
   * worker is never returned to `idle` or handed to a waiter again. */
  crashed: boolean;
}

/** Bookkeeping for a worker spawn still in flight: `worker` is filled in
 * once the underlying spawn promise resolves, which lets crash handling
 * (a synchronous event-listener callback) find and evict the right slot
 * without needing to `await` anything. */
interface Slot {
  promise: Promise<PooledWorker>;
  worker: PooledWorker | null;
}

interface Waiter {
  resolve: (worker: PooledWorker) => void;
  reject: (error: Error) => void;
}

/** A `run()` call that currently owns a worker (i.e. has an in-flight
 * `worker.remote(...)` Comlink call outstanding) — tracked so `destroy()`
 * and worker-crash handling can reject it externally instead of leaving it
 * hanging forever. */
interface ActiveRun {
  worker: PooledWorker;
  reject: (error: Error) => void;
}

const DEFAULT_MAX_POOL_SIZE = 4;
const MIN_POOL_SIZE = 1;

function detectHardwareConcurrency(): number {
  const count = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  return typeof count === 'number' && count > 0 ? count : DEFAULT_MAX_POOL_SIZE + 1;
}

function defaultPoolSize(): number {
  return Math.min(DEFAULT_MAX_POOL_SIZE, Math.max(MIN_POOL_SIZE, detectHardwareConcurrency() - 1));
}

/** WorkerPool always runs on a main/orchestrating thread (never inside a
 * worker itself — that's worker-entry.*.ts's job), so `window` being
 * present is a reliable "this is a browser main thread" signal even under
 * jsdom-less Node test environments. */
function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.versions?.node != null &&
    typeof window === 'undefined'
  );
}

type OnWorkerCrash = (worker: PooledWorker, error: Error) => void;

async function spawnNodeWorker(onCrash: OnWorkerCrash): Promise<PooledWorker> {
  const [{ Worker: NodeWorker }, { default: nodeEndpoint }] = await Promise.all([
    import('node:worker_threads'),
    import('./comlink-node-adapter.js'),
  ]);
  const worker = new NodeWorker(new URL('./worker-entry.node.ts', import.meta.url));
  const pooled: PooledWorker = {
    remote: Comlink.wrap<RunJob>(nodeEndpoint(worker)),
    terminate: async () => {
      await worker.terminate();
    },
    crashed: false,
  };
  // Node worker_threads: an uncaught exception inside the worker emits
  // 'error'; a hard exit (including a job calling process.exit()) emits
  // 'exit' with a non-zero code and no preceding 'error'. Either way the
  // in-flight Comlink call will never get a response, so both must evict
  // the worker and reject whatever job it was running.
  worker.on('error', (error: unknown) => {
    onCrash(pooled, error instanceof Error ? error : new Error(String(error)));
  });
  worker.on('exit', (code: number) => {
    if (code !== 0) {
      onCrash(pooled, new Error(`worker exited unexpectedly with code ${code}`));
    }
  });
  return pooled;
}

function spawnBrowserWorker(onCrash: OnWorkerCrash): PooledWorker {
  const worker = new Worker(new URL('./worker-entry.browser.ts', import.meta.url), {
    type: 'module',
  });
  const pooled: PooledWorker = {
    remote: Comlink.wrap<RunJob>(worker),
    terminate: async () => {
      worker.terminate();
    },
    crashed: false,
  };
  worker.addEventListener('error', (event: ErrorEvent) => {
    onCrash(pooled, new Error(`worker crashed: ${event.message || 'unknown error'}`));
  });
  return pooled;
}

/**
 * Exported ONLY as a test seam: lets pool.test.ts compose a
 * `spawnWorkerOverride` (see WorkerPool's constructor) that fails a bounded
 * number of times and then falls through to a *real* worker spawn via this
 * function, so "the pool self-heals after a construction failure" can be
 * asserted against an actually-working worker rather than a mock. Not part
 * of the package's public API — index.ts does not re-export it.
 */
export function spawnWorker(onCrash: OnWorkerCrash): Promise<PooledWorker> {
  return isNodeRuntime() ? spawnNodeWorker(onCrash) : Promise.resolve(spawnBrowserWorker(onCrash));
}

function isJobCancelledError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'JobCancelledError';
}

/**
 * Bounded pool of reusable geometry-job workers. FIFO-queues `run()` calls
 * once all workers are busy; workers are never torn down between jobs
 * (including cancelled ones) — only `destroy()` terminates them, and a
 * worker crash evicts just that one worker (see `handleWorkerCrash`).
 */
export class WorkerPool {
  private readonly size: number;
  private readonly slots: Slot[] = [];
  private readonly idle: PooledWorker[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly activeRuns = new Set<ActiveRun>();
  private destroyed = false;
  private readonly spawnWorkerImpl: (onCrash: OnWorkerCrash) => Promise<PooledWorker>;

  constructor(opts?: {
    size?: number;
    /**
     * Test seam: replaces the worker-construction function acquireWorker()
     * calls when spawning a new slot (normally the module-level
     * `spawnWorker()`, which does a real `new Worker(...)` /
     * `new NodeWorker(...)`). Not intended for production use — it exists so
     * tests can deterministically simulate a worker *construction* failure
     * (the returned promise rejecting before any worker exists) without
     * depending on a real, flaky OS-level failure. See pool.test.ts's
     * "spawn construction failure" describe block.
     */
    spawnWorkerOverride?: (onCrash: OnWorkerCrash) => Promise<PooledWorker>;
  }) {
    const requested = opts?.size;
    this.size =
      typeof requested === 'number' && requested > 0 ? Math.floor(requested) : defaultPoolSize();
    this.spawnWorkerImpl = opts?.spawnWorkerOverride ?? spawnWorker;
  }

  async run<J extends JobName>(
    jobName: J,
    payload: JobPayloadMap[J],
    opts?: RunJobOptions,
  ): Promise<JobResultMap[J]> {
    const signal = opts?.signal;
    if (signal?.aborted) {
      throw new JobCancelledError();
    }

    // Abortable while queued: acquireWorker() itself rejects with
    // JobCancelledError (and dequeues the waiter) if `signal` fires before a
    // worker becomes available — see its Waiter-branch below. This is what
    // fixes the "abort lost while queued" bug: previously the abort
    // listener was only registered after this await resolved.
    //
    // Abortable while a brand-new worker is still spawning: acquireWorker()'s
    // spawn branch is abort-aware the same way (below), so a signal that
    // fires before the spawn settles rejects this await too.
    const worker = await this.acquireWorker(signal);

    // acquireWorker() can resolve here even though the world moved on while
    // it was pending — neither `destroy()` nor an abort actually stops a
    // spawn already in flight (spawnWorker() has no cancellation hook), so
    // by the time we get the worker either could have happened. Recheck
    // both BEFORE this worker is wired into `activeRuns` or handed a
    // `worker.remote(...)` call — this is what fixes the "abort/destroy
    // lost while spawning" bugs: previously neither was rechecked here.
    if (this.destroyed) {
      // This worker is already orphaned from `this.slots` — destroy()
      // spliced its slot out for its own draining/terminate loop before (or
      // as) this resolved, so that loop already owns terminating it. Don't
      // touch idle/activeRuns; just bail without touching the worker.
      throw new PoolDestroyedError('WorkerPool: pool was destroyed while acquiring a worker');
    }
    if (signal?.aborted) {
      // The worker itself is healthy, just no longer wanted by this caller
      // — hand it back (to the next waiter, or idle) so pool capacity isn't
      // leaked.
      this.releaseWorker(worker);
      throw new JobCancelledError();
    }

    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
    };
    signal?.addEventListener('abort', onAbort);

    let externalReject!: (error: Error) => void;
    const externalSettlement = new Promise<never>((_resolve, reject) => {
      externalReject = reject;
    });
    const activeRun: ActiveRun = { worker, reject: externalReject };
    this.activeRuns.add(activeRun);

    try {
      const sendPayload = opts?.transfer ? Comlink.transfer(payload, opts.transfer) : payload;
      const onProgress = opts?.onProgress;
      const result = await Promise.race([
        worker.remote(
          jobName,
          sendPayload,
          onProgress ? Comlink.proxy(onProgress) : undefined,
          Comlink.proxy(() => cancelled),
        ),
        // Settled externally by destroy() (PoolDestroyedError) or by
        // handleWorkerCrash() (WorkerCrashedError) — otherwise this promise
        // never settles on its own, so it never wins the race under normal
        // completion.
        externalSettlement,
      ]);
      // Comlink's Remote<T> mapped type does not preserve runJob's generic
      // call signature across the wire (it collapses to the union of all
      // possible job results) — narrowing back to JobResultMap[J] here is
      // sound because `jobName: J` pins which member of that union this
      // particular call actually produced.
      return result as JobResultMap[J];
    } catch (error) {
      if (isJobCancelledError(error)) {
        throw new JobCancelledError(error.message);
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activeRuns.delete(activeRun);
      this.releaseWorker(worker);
    }
  }

  /**
   * Always resolves, even with jobs queued or in flight (see pool.test.ts's
   * destroy-related tests). Rejects every affected `run()` call with
   * `PoolDestroyedError` BEFORE actually terminating the underlying
   * worker(s) below — see jobs/registry.ts's `runJob` TSDoc, "Pool-
   * destruction progress-flush race" section, for why an in-flight job's
   * own `runJob` (running inside the worker being terminated) can
   * legitimately still be mid-await when its caller already observed this
   * rejection, and why that's safe (no leaked timer/promise — the
   * worker's entire JS context is what actually resolves it, via
   * `worker.terminate()` below).
   */
  async destroy(): Promise<void> {
    this.destroyed = true;

    const pendingWaiters = this.waiters.splice(0);
    for (const waiter of pendingWaiters) {
      waiter.reject(new PoolDestroyedError('WorkerPool: destroyed while a job was queued'));
    }

    // Unstick any in-flight run() calls — without this, their
    // `worker.remote(...)` promise would simply hang forever once the
    // worker underneath them is terminated.
    const pendingRuns = [...this.activeRuns];
    this.activeRuns.clear();
    for (const activeRun of pendingRuns) {
      activeRun.reject(new PoolDestroyedError('WorkerPool: destroyed while a job was running'));
    }

    this.idle.length = 0;
    const spawnedSlots = this.slots.splice(0);
    // allSettled, not all: a slot whose spawn is still in flight can fail to
    // construct (e.g. the worker script throws on load) — that must not
    // make destroy() itself reject, breaking its always-resolves contract.
    // Slots that did resolve still get terminated; a spawn that rejected was
    // never a live worker to begin with, so there's nothing to terminate.
    // Note: a slot's spawn rejecting here surfaces as the raw construction
    // error to whatever else is still awaiting that same `slot.promise`
    // (e.g. the run() caller that triggered it) — not PoolDestroyedError —
    // intentionally, since destroy() didn't cause that failure.
    await Promise.allSettled(
      spawnedSlots.map(async (slot) => {
        const worker = await slot.promise;
        await worker.terminate();
      }),
    );
  }

  private async acquireWorker(signal?: AbortSignal): Promise<PooledWorker> {
    if (this.destroyed) {
      throw new PoolDestroyedError('WorkerPool: pool has been destroyed');
    }

    const idleWorker = this.idle.pop();
    if (idleWorker) {
      return idleWorker;
    }

    if (this.slots.length < this.size) {
      // No `await` before this push: synchronous callers issued back-to-back
      // (e.g. `jobs.map(job => pool.run(...))`) each run to this point
      // before yielding, so `this.slots.length` is always current — this is
      // what keeps concurrent acquisitions from over-spawning past `size`.
      const promise = this.spawnWorkerImpl((worker, error) => this.handleWorkerCrash(worker, error));
      const slot: Slot = { promise, worker: null };
      // Fire-and-forget: fills in `slot.worker` once the spawn settles so
      // handleWorkerCrash can find this slot synchronously later. A spawn
      // failure is surfaced to the caller who triggered it via the returned
      // `promise` itself (below), so on the success path this handler only
      // needs to avoid an unhandled rejection.
      //
      // On the failure path there's real work to do: a slot whose spawn
      // rejected never became a worker, so it must be removed from
      // `this.slots` here — otherwise `this.slots.length` stays permanently
      // inflated by one per failure, and on a size-1 pool (this project's
      // default on single-core/CI machines, and every existing test's
      // config) a SINGLE construction failure would wedge the pool forever:
      // `this.slots.length < this.size` never goes true again, so every
      // future run() falls into the Waiter branch below, and nothing ever
      // drains `this.waiters` because no worker ever spawns again.
      //
      // Waiter semantics on spawn failure (chosen deliberately, see
      // spawnForWaiters()'s doc comment for the full reasoning): the caller
      // whose acquireWorker() call actually triggered this spawn already
      // observes the rejection directly — it's holding `promise` itself (or
      // an abort-aware wrapper around it, below) — so it needs no extra
      // handling here. Any waiter already parked in `this.waiters`, though,
      // has no spawn of its own in flight and no way to observe this
      // rejection; the pool itself must drive their progress, so this hands
      // off to spawnForWaiters() — it does NOT just reject the head waiter,
      // because that head waiter's failure to get a worker has nothing to do
      // with *this* spawn attempt (which was never spawning on its behalf in
      // the first place).
      promise.then(
        (worker) => {
          slot.worker = worker;
        },
        () => {
          const slotIndex = this.slots.indexOf(slot);
          if (slotIndex !== -1) {
            this.slots.splice(slotIndex, 1);
          }
          this.spawnForWaiters();
        },
      );
      this.slots.push(slot);

      if (!signal) {
        return promise;
      }

      // Abort-aware, mirroring the Waiter branch below: spawnWorker() has no
      // cancellation hook, so the spawn itself is left running regardless of
      // `signal` — but if it fires before the spawn settles, the caller is
      // rejected with JobCancelledError right away instead of waiting out
      // the spawn. If the worker does finish spawning afterwards, it's
      // released back into the pool (idle, or the next waiter) rather than
      // silently handed to a caller that already walked away, so this
      // doesn't leak pool capacity — see run()'s destroyed/aborted recheck
      // for the other half of that contract.
      return new Promise<PooledWorker>((resolve, reject) => {
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          reject(new JobCancelledError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
          (worker) => {
            signal.removeEventListener('abort', onAbort);
            if (aborted) {
              this.releaseWorker(worker);
              return;
            }
            resolve(worker);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            if (!aborted) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
      });
    }

    return new Promise<PooledWorker>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const waiter: Waiter = {
        resolve: (worker) => {
          if (onAbort) signal?.removeEventListener('abort', onAbort);
          resolve(worker);
        },
        reject: (error) => {
          if (onAbort) signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      if (signal) {
        onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          waiter.reject(new JobCancelledError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /**
   * Self-heals `this.waiters` after a spawn attempt (the original one in
   * acquireWorker(), or a previous call to this method) rejected and freed
   * up capacity. Called with the dead slot already spliced out of
   * `this.slots`, so `this.slots.length < this.size` here.
   *
   * Chosen semantics (see the Critical review finding this replaced —
   * previously this just did `this.waiters.shift()!.reject(error)`, which
   * permanently stranded any waiters *behind* the head with no spawn in
   * flight and no worker ever coming): a spawn failure is not really "the
   * head waiter's" failure — that waiter never triggered a spawn of its own,
   * it was just parked in the queue. Blaming it for an unrelated spawn's
   * construction error would be arbitrary. Instead, the pool spawns a fresh
   * worker *specifically* to serve the current head waiter:
   *   - success: the new worker is handed off via releaseWorker(), which
   *     resolves the FIFO head (not necessarily the same waiter that was
   *     head when this attempt started — a waiter can have self-removed via
   *     abort in between; that's fine, releaseWorker()'s handoff is
   *     unconditional FIFO regardless of *why* this worker exists).
   *   - failure: *now* it's fair to reject the current head waiter with this
   *     attempt's construction error — this spawn really was on that
   *     waiter's behalf — and then recurse for whichever waiters remain.
   *
   * Termination: every failed attempt strictly shrinks `this.waiters` by one
   * (via `shift()`) before recursing, and the recursion's base case is
   * `this.waiters.length === 0`. So this always halts within at most the
   * waiters-count-at-first-failure attempts — bounded, not a retry storm —
   * and a persistently-failing seam still drains every queued caller with a
   * real rejection instead of leaving any of them hanging.
   */
  private spawnForWaiters(): void {
    if (this.destroyed || this.waiters.length === 0) {
      return;
    }
    // Defense-in-depth: call sites uphold this invariant themselves (the
    // dead slot is always spliced out of `this.slots` before calling this
    // method), so this should never actually trip — but if it ever did, it
    // would silently grow the pool past `this.size` forever.
    if (this.slots.length >= this.size) {
      return;
    }
    const promise = this.spawnWorkerImpl((worker, error) => this.handleWorkerCrash(worker, error));
    const slot: Slot = { promise, worker: null };
    this.slots.push(slot);
    promise.then(
      (worker) => {
        slot.worker = worker;
        this.releaseWorker(worker);
      },
      (error: unknown) => {
        const slotIndex = this.slots.indexOf(slot);
        if (slotIndex !== -1) {
          this.slots.splice(slotIndex, 1);
        }
        if (this.destroyed) {
          // destroy() already rejected every waiter and is draining slots
          // itself; nothing left for this attempt to settle.
          return;
        }
        const nextWaiter = this.waiters.shift();
        if (nextWaiter) {
          nextWaiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
        this.spawnForWaiters();
      },
    );
  }

  private releaseWorker(worker: PooledWorker): void {
    if (this.destroyed || worker.crashed) {
      return;
    }
    const nextWaiter = this.waiters.shift();
    if (nextWaiter) {
      nextWaiter.resolve(worker);
      return;
    }
    this.idle.push(worker);
  }

  /**
   * Called (synchronously, from a worker's 'error'/'exit' listener — see
   * spawnNodeWorker/spawnBrowserWorker) when a worker dies unexpectedly.
   * Evicts it from `idle`/`slots` so it's never handed out again, and
   * rejects whatever job was running on it so that job's `run()` doesn't
   * hang forever waiting for a response that will never arrive.
   */
  private handleWorkerCrash(worker: PooledWorker, error: Error): void {
    if (worker.crashed) {
      // 'error' and 'exit' can both fire for the same underlying crash;
      // only handle the first.
      return;
    }
    worker.crashed = true;

    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex !== -1) {
      this.idle.splice(idleIndex, 1);
    }

    const slotIndex = this.slots.findIndex((slot) => slot.worker === worker);
    if (slotIndex !== -1) {
      // Drop the slot entirely (not just the worker) so pool capacity frees
      // up and the next acquireWorker() spawns a genuine replacement.
      this.slots.splice(slotIndex, 1);
    }

    const crashError = new WorkerCrashedError(`WorkerPool: worker crashed: ${error.message}`);
    for (const activeRun of this.activeRuns) {
      if (activeRun.worker === worker) {
        activeRun.reject(crashError);
        this.activeRuns.delete(activeRun);
      }
    }
  }
}
