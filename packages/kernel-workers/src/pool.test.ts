// WorkerPool tests — exercised via the Node worker_threads path (this
// project's vitest config runs with environment: 'node'; see
// pool.ts's isNodeRuntime()). The browser path is verified separately by
// bundling+running the client dev smoke panel (see apps/client/src/engine/
// workers.ts) since jsdom doesn't implement real Web Workers.
import { afterEach, describe, expect, it } from 'vitest';
import type { JobName } from './jobs/registry.js';
import {
  JobCancelledError,
  PoolDestroyedError,
  spawnWorker,
  WorkerCrashedError,
  WorkerPool,
} from './pool.js';
import { meshBuffers } from './transfer.js';

const pools: WorkerPool[] = [];

function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

function buildDeterministicMesh(triangleCount: number): {
  positions: Float64Array;
  indices: Uint32Array;
} {
  const vertexCount = triangleCount * 3;
  const positions = new Float64Array(vertexCount * 3);
  const indices = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v += 1) {
    positions[v * 3] = v * 0.5;
    positions[v * 3 + 1] = v * 0.25;
    positions[v * 3 + 2] = v * 0.125;
    indices[v] = v;
  }
  return { positions, indices };
}

describe('WorkerPool — echoMesh round trip', () => {
  it('returns byte-identical buffers and the source buffers were actually transferred', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = buildDeterministicMesh(1000);
    const expectedPositions = positions.slice();
    const expectedIndices = indices.slice();
    const sourcePositionsBuffer = positions.buffer;
    const sourceIndicesBuffer = indices.buffer;

    const { payload, transfer } = meshBuffers(positions, indices);
    const result = await pool.run('echoMesh', payload, { transfer });

    // Transfer, not copy: the source buffers are detached once posted.
    expect(sourcePositionsBuffer.byteLength).toBe(0);
    expect(sourceIndicesBuffer.byteLength).toBe(0);

    // Byte-identity of the round-tripped data.
    expect(result.positions).toBeInstanceOf(Float64Array);
    expect(result.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(result.positions)).toEqual(Array.from(expectedPositions));
    expect(Array.from(result.indices)).toEqual(Array.from(expectedIndices));
  });

  it('rejects a payload whose positions are not Float64Array (kernel Float64 rule)', async () => {
    const pool = createPool({ size: 1 });
    await expect(
      pool.run('echoMesh', {
        // @ts-expect-error — deliberately wrong typed-array to exercise the runtime guard.
        positions: new Float32Array([1, 2, 3]),
        indices: new Uint32Array([0, 1, 2]),
      }),
    ).rejects.toThrow(/Float64Array/);
  });
});

describe('WorkerPool — longTask progress', () => {
  it('reports monotonically increasing progress fractions ending at 1', async () => {
    const pool = createPool({ size: 1 });
    const fractions: number[] = [];
    const iterations = 5000;

    const result = await pool.run(
      'longTask',
      { iterations },
      { onProgress: (fraction) => fractions.push(fraction) },
    );

    // Why this is deterministic (not a timing assumption): `onProgress` is
    // Comlink-proxied and delivered over a MessageChannel separate from the
    // one this `run()` call's own result travels over, so nothing about
    // postMessage ordering alone would guarantee `fractions` already holds
    // the final `1` by the time `run()` resolves above. What makes it
    // deterministic is jobs/registry.ts's `runJob` dispatcher explicitly awaiting
    // every progress delivery (including this job's last one) before it
    // lets its own result go out — see runJob's "Progress delivery ordering
    // contract" doc comment and pool.ts's `RunJobOptions.onProgress` doc for
    // the guarantee this asserts against. Before that fix, this exact
    // assertion (`fractions.at(-1)` toBe 1) was observed to flake under
    // full-suite concurrent load — reproduced empirically by running six
    // `vitest run --project kernel-workers` processes concurrently, which
    // surfaced `expected 0.95 to be 1` (the final progress event hadn't
    // been delivered yet when `run()` resolved) — and passed on every
    // re-run in isolation, consistent with a cross-channel delivery race
    // rather than a logic bug in `longTask` itself.
    expect(result.sum).toBe((iterations * (iterations - 1)) / 2);
    expect(fractions.length).toBeGreaterThan(1);
    for (let i = 1; i < fractions.length; i += 1) {
      expect(fractions[i]).toBeGreaterThan(fractions[i - 1]!);
    }
    expect(fractions.at(-1)).toBe(1);
  });
});

describe('WorkerPool — cancellation', () => {
  it('rejects a job aborted mid-run with JobCancelledError, and the worker stays reusable', async () => {
    const pool = createPool({ size: 1 });
    const controller = new AbortController();
    let observedProgress = false;

    const run = pool.run(
      'longTask',
      { iterations: 1_000_000 },
      {
        signal: controller.signal,
        onProgress: (fraction) => {
          // Abort only once real progress has been observed, so this is
          // provably a mid-run cancellation rather than a before-start one.
          if (!observedProgress && fraction > 0) {
            observedProgress = true;
            controller.abort();
          }
        },
      },
    );

    await expect(run).rejects.toBeInstanceOf(JobCancelledError);
    expect(observedProgress).toBe(true);

    // Pool size is 1, so only one worker can ever exist in this pool — a
    // successful call below necessarily reuses the exact worker the
    // cancelled job ran on.
    const { payload } = meshBuffers(new Float64Array([1, 2, 3]), new Uint32Array([0, 1, 2]));
    const result = await pool.run('echoMesh', payload);
    expect(Array.from(result.positions)).toEqual([1, 2, 3]);
  });

  it('rejects immediately if the signal is already aborted before the job starts', async () => {
    const pool = createPool({ size: 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      pool.run('longTask', { iterations: 10 }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(JobCancelledError);
  });

  it('rejects a job aborted while still QUEUED (never acquired a worker), leaves the running job and pool unaffected', async () => {
    const pool = createPool({ size: 1 });
    const controller = new AbortController();

    // Occupies the pool's only worker so the second job below is forced to
    // queue in `waiters` rather than starting immediately.
    const first = pool.run('longTask', { iterations: 200_000 });

    // Queues behind `first` (pool saturated: size 1, one slot already
    // spawned for `first`) — synchronously, before any await yields control
    // back to the event loop, so this is provably still queued (not yet
    // handed a worker) when abort() below fires.
    const second = pool.run('longTask', { iterations: 10 }, { signal: controller.signal });
    controller.abort();

    await expect(second).rejects.toBeInstanceOf(JobCancelledError);

    // `first` was never touched by the abort — it completes normally.
    const firstResult = await first;
    expect(firstResult.sum).toBe((200_000 * (200_000 - 1)) / 2);

    // Pool remains usable after a queued-job cancellation.
    const after = await pool.run('longTask', { iterations: 5 });
    expect(after.sum).toBe(10);
  });
});

describe('WorkerPool — destroy() during an in-flight job', () => {
  it('rejects the in-flight run() promise with PoolDestroyedError, and destroy() itself resolves', async () => {
    const pool = createPool({ size: 1 });
    let destroyPromise: Promise<void> | undefined;

    const run = pool.run(
      'longTask',
      { iterations: 2_000_000 },
      {
        onProgress: (fraction) => {
          // Trigger destroy() only once the job has demonstrably started
          // running on the worker (not while still queued/spawning).
          if (!destroyPromise && fraction > 0) {
            destroyPromise = pool.destroy();
          }
        },
      },
    );

    await expect(run).rejects.toBeInstanceOf(PoolDestroyedError);
    expect(destroyPromise).toBeDefined();
    await destroyPromise;
  });
});

describe('WorkerPool — spawn-branch abort/destroy race', () => {
  it('rejects with JobCancelledError when aborted synchronously while a worker is still spawning (fresh pool, no idle workers), and capacity is not leaked', async () => {
    const pool = createPool({ size: 1 });
    const controller = new AbortController();

    // No `await` before abort(): the pool starts with no idle workers and
    // no spawned slots, so this call is still inside acquireWorker()'s
    // SPAWN branch (the new worker construction is in flight but hasn't
    // resolved) at the moment abort() fires — this is what exercises the
    // previously-unguarded spawn branch (the Waiter/queued branch is
    // already covered by the "still QUEUED" test above).
    const p = pool.run('longTask', { iterations: 10 }, { signal: controller.signal });
    controller.abort();

    await expect(p).rejects.toBeInstanceOf(JobCancelledError);

    // Capacity not leaked: the worker that was mid-spawn during the abort
    // is released back into the pool once its spawn settles, so a
    // subsequent run on this size-1 pool succeeds by reusing it rather than
    // hanging behind a phantom occupied slot.
    const after = await pool.run('longTask', { iterations: 5 });
    expect(after.sum).toBe(10);
  });

  it('rejects with PoolDestroyedError (not WorkerCrashedError) when destroy() races a still-spawning worker, and destroy() itself resolves', async () => {
    const pool = createPool({ size: 1 });

    // No `await` between run() and destroy(): the pool starts with no idle
    // workers, so run() is inside acquireWorker()'s SPAWN branch (worker
    // still under construction) when destroy() clears activeRuns/slots out
    // from under it. Without the destroyed-recheck in run(), this worker
    // would get wired into a fresh activeRun and handed a worker.remote()
    // call after destroy() already started terminating it, surfacing as a
    // WorkerCrashedError (or a permanently hanging promise) instead of the
    // correct PoolDestroyedError.
    const p = pool.run('longTask', { iterations: 10 });
    const d = pool.destroy();

    await expect(p).rejects.toBeInstanceOf(PoolDestroyedError);
    await expect(p).rejects.not.toBeInstanceOf(WorkerCrashedError);
    await d;
  });
});

describe('WorkerPool — worker crash', () => {
  it('rejects the in-flight run() with WorkerCrashedError, and a later run() on the same pool succeeds (dead worker not recycled)', async () => {
    const pool = createPool({ size: 1 });

    // '__test_crashWorker__' is a TEST-ONLY job (see jobs/registry.ts's
    // testOnlyRegistry doc comment) that calls process.exit(1) inside the
    // worker — genuinely killing the worker thread, unlike a normal thrown
    // error (which Comlink would just turn into an ordinary rejection). It
    // is deliberately not part of the JobName union, hence the cast.
    const crashed = pool.run('__test_crashWorker__' as JobName, { iterations: 1 });

    await expect(crashed).rejects.toBeInstanceOf(WorkerCrashedError);

    // Pool size is 1: this can only succeed if the crashed worker was
    // evicted (not returned to `idle`) and a fresh replacement was spawned.
    const result = await pool.run('longTask', { iterations: 5 });
    expect(result.sum).toBe(10);
  });
});

describe('WorkerPool — spawn construction failure', () => {
  it('rejects the triggering run() with the construction error (does not hang), and a later run() succeeds once spawning works again', async () => {
    // Test seam: spawnWorkerOverride fails exactly once (simulating worker
    // construction itself throwing/rejecting — e.g. the worker script
    // failing to load), then falls through to the real spawnWorker() so the
    // pool's self-healing can be verified against an actually-working
    // worker.
    let shouldFail = true;
    const pool = createPool({
      size: 1,
      spawnWorkerOverride: (onCrash) => {
        if (shouldFail) {
          shouldFail = false;
          return Promise.reject(new Error('simulated worker construction failure'));
        }
        return spawnWorker(onCrash);
      },
    });

    await expect(pool.run('longTask', { iterations: 5 })).rejects.toThrow(
      /simulated worker construction failure/,
    );

    // Capacity restored: the dead slot was spliced out of `this.slots` when
    // the spawn rejected, so `this.slots.length < this.size` is true again
    // and this call spawns (and succeeds) rather than hanging behind a
    // phantom occupied slot.
    const result = await pool.run('longTask', { iterations: 5 });
    expect(result.sum).toBe(10);
  });

  it('with THREE concurrent callers queued and the seam failing exactly once: none hang — the triggering caller gets the construction error, the other two self-heal and complete', async () => {
    let shouldFail = true;
    const pool = createPool({
      size: 1,
      spawnWorkerOverride: (onCrash) => {
        if (shouldFail) {
          shouldFail = false;
          return Promise.reject(new Error('simulated worker construction failure'));
        }
        return spawnWorker(onCrash);
      },
    });

    // `first` triggers the spawn (and its eventual failure) directly.
    const first = pool.run('longTask', { iterations: 5 });
    // `second` and `third` queue behind `first` synchronously — before any
    // of these calls yields, the pool is already at capacity (one slot
    // spawned, size 1), so both land in the Waiter branch.
    const second = pool.run('longTask', { iterations: 7 });
    const third = pool.run('longTask', { iterations: 9 });

    // Chosen semantics: the triggering caller (`first`) observes the raw
    // construction error directly — it was holding that spawn's promise.
    await expect(first).rejects.toThrow(/simulated worker construction failure/);

    // `second` and `third` were never spawning anything themselves; the
    // pool self-heals on their behalf via spawnForWaiters() (the seam only
    // fails once, so this retry spawn succeeds) rather than blaming them for
    // a spawn failure that wasn't on their path. Neither hangs and neither
    // errors — `second` gets the self-healed worker directly, `third` gets
    // it once `second`'s job finishes and releases it back via the normal
    // FIFO handoff.
    const secondResult = await second;
    expect(secondResult.sum).toBe((7 * 6) / 2);
    const thirdResult = await third;
    expect(thirdResult.sum).toBe((9 * 8) / 2);

    // Pool stays usable afterward.
    const result = await pool.run('longTask', { iterations: 5 });
    expect(result.sum).toBe(10);
  });

  it('with the seam failing persistently: every queued caller settles with the construction error (no hang), and destroy() still resolves', async () => {
    const pool = createPool({
      size: 1,
      spawnWorkerOverride: () => Promise.reject(new Error('simulated worker construction failure')),
    });

    const first = pool.run('longTask', { iterations: 5 });
    const second = pool.run('longTask', { iterations: 7 });
    const third = pool.run('longTask', { iterations: 9 });

    // `first` observes the raw construction error directly (its own
    // triggering spawn). `second` and `third` are drained by
    // spawnForWaiters()'s retry-and-recurse: each retry attempt also fails
    // (the seam always rejects), so each retry rejects exactly one more
    // queued waiter with that retry's own construction error, then recurses
    // for whoever is left — bounded by the number of waiters, so this
    // terminates instead of retry-storming forever.
    await expect(first).rejects.toThrow(/simulated worker construction failure/);
    await expect(second).rejects.toThrow(/simulated worker construction failure/);
    await expect(third).rejects.toThrow(/simulated worker construction failure/);

    await expect(pool.destroy()).resolves.toBeUndefined();
  });
});

describe('WorkerPool — queueing', () => {
  it('completes more jobs than there are workers', async () => {
    const pool = createPool({ size: 2 });
    const iterationCounts = [50, 60, 70, 80, 90, 100];

    const results = await Promise.all(
      iterationCounts.map((iterations) => pool.run('longTask', { iterations })),
    );

    results.forEach((result, i) => {
      const n = iterationCounts[i]!;
      expect(result.sum).toBe((n * (n - 1)) / 2);
    });
  });
});

describe('WorkerPool — affinity routing (RunJobOptions.affinityKey)', () => {
  it('routes two sequential calls with the SAME affinityKey to the SAME worker, proving per-worker cache locality on a multi-worker pool', async () => {
    // size: 4 — large enough that, absent affinity, two sequential IDLE
    // acquisitions have no guarantee of landing on the same worker (idle.pop()
    // is LIFO over whichever workers happen to be idle). buildBvh/
    // measurePointToSurface are the real per-worker-cache jobs this feature
    // exists for; using them directly (rather than echoMesh/longTask) proves
    // the actual cache-hit behavior, not just "same worker instance".
    const pool = createPool({ size: 4 });
    const { positions, indices } = buildDeterministicMesh(50);
    const contentHash = 'affinity-same-key';

    await pool.run(
      'buildBvh',
      { contentHash, positions, indices },
      { affinityKey: contentHash },
    );

    // Occupy other workers first so a NON-affinity-aware pick would have
    // every incentive to pick a different (idle) worker instead: spin up 3
    // more workers with unrelated jobs, release them back to idle, so the
    // pool's `idle` LIFO stack has several OTHER candidates sitting on top
    // of the buildBvh worker by the time measurePointToSurface runs below.
    await Promise.all([
      pool.run('longTask', { iterations: 5 }),
      pool.run('longTask', { iterations: 5 }),
      pool.run('longTask', { iterations: 5 }),
    ]);

    // If this landed on a DIFFERENT worker than buildBvh above, it would
    // reject with BvhNotCachedError (that worker's own bvhCache never saw
    // this contentHash) — succeeding proves affinity routing worked.
    const measured = await pool.run(
      'measurePointToSurface',
      { contentHash, point: [0, 0, 0] },
      { affinityKey: contentHash },
    );
    expect(measured.distance).toBeGreaterThanOrEqual(0);
  });

  it('a busy affinity target is QUEUED for specifically (not stolen from, not routed to a different idle worker)', async () => {
    // A deterministic (non-timing-based) proof, using the real cache-bearing
    // buildBvh/measurePointToSurface jobs so misrouting is observable as a
    // hard error (BvhNotCachedError) rather than inferred from timing: if
    // the affinity-routed call below were WRONGLY handed the pool's other
    // idle worker instead of queueing for the busy target, that worker
    // never had `buildBvh` called for this contentHash and would reject
    // immediately.
    const pool = createPool({ size: 2 });
    const { positions, indices } = buildDeterministicMesh(50);
    const key = 'affinity-busy-target';

    // Establishes worker W (one of the pool's two workers) as `key`'s
    // affinity target, with a real cached BVH.
    await pool.run(
      'buildBvh',
      { contentHash: key, positions, indices },
      { affinityKey: key },
    );

    // Occupy W again with a slow job under the SAME affinityKey —
    // deterministically confirmed "started running" via its first progress
    // callback before the affinity-routed call below is issued, so this is
    // provably a busy-target scenario, not a race against W still being
    // idle. (longTask is a different job name than buildBvh, but affinity
    // routing keys off WORKER identity, not job name — see pool.ts's
    // `acquireWorker`.)
    let observedProgress = false;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const slowRun = pool.run(
      'longTask',
      { iterations: 2_000_000 },
      {
        affinityKey: key,
        onProgress: (fraction) => {
          if (!observedProgress && fraction > 0) {
            observedProgress = true;
            resolveStarted();
          }
        },
      },
    );
    await started;

    // The pool's SECOND worker is idle and would happily serve a
    // non-affinity-aware pick — but this call asks for `key`'s target (W,
    // busy) specifically. Queueing for W (not stealing, not falling back to
    // the idle worker) means it can only succeed once W finishes `slowRun`
    // AND still has the cache — i.e. this resolving successfully (not
    // rejecting with BvhNotCachedError) is the actual proof.
    const measured = await pool.run(
      'measurePointToSurface',
      { contentHash: key, point: [0, 0, 0] },
      { affinityKey: key },
    );
    expect(measured.distance).toBeGreaterThanOrEqual(0);

    const slowResult = await slowRun;
    expect(slowResult.sum).toBe((2_000_000 * 1_999_999) / 2);
  });

  it('a stale affinity target (worker crashed) falls back to a fresh acquisition instead of hanging', async () => {
    const pool = createPool({ size: 1 });
    const key = 'affinity-stale-target';

    // '__test_crashWorker__' genuinely kills the worker thread (see the
    // "WorkerPool — worker crash" describe block above) — this establishes
    // (then immediately invalidates) `key`'s affinity target.
    await expect(
      pool.run('__test_crashWorker__' as JobName, { iterations: 1 }, { affinityKey: key }),
    ).rejects.toBeInstanceOf(WorkerCrashedError);

    // A later call with the SAME key must not hang waiting for the dead
    // worker — it should fall through to a fresh spawn and succeed.
    const result = await pool.run('longTask', { iterations: 5 }, { affinityKey: key });
    expect(result.sum).toBe(10);
  });

  it('an affinity-targeted wait is abortable while queued, without affecting the target worker or the pool', async () => {
    const pool = createPool({ size: 1 });
    const key = 'affinity-abort-while-queued';

    await pool.run('longTask', { iterations: 1 }, { affinityKey: key });

    const first = pool.run('longTask', { iterations: 200_000 }, { affinityKey: key });
    const controller = new AbortController();
    const second = pool.run(
      'longTask',
      { iterations: 10 },
      { affinityKey: key, signal: controller.signal },
    );
    controller.abort();

    await expect(second).rejects.toBeInstanceOf(JobCancelledError);
    const firstResult = await first;
    expect(firstResult.sum).toBe((200_000 * 199_999) / 2);

    // Pool (and the affinity target) remain usable afterward.
    const after = await pool.run('longTask', { iterations: 5 }, { affinityKey: key });
    expect(after.sum).toBe(10);
  });

  it('destroy() rejects an in-flight affinity-targeted wait with PoolDestroyedError', async () => {
    const pool = createPool({ size: 1 });
    const key = 'affinity-destroy-while-queued';

    await pool.run('longTask', { iterations: 1 }, { affinityKey: key });

    const holdWorker = pool.run('longTask', { iterations: 500_000 }, { affinityKey: key });
    // Give the pool a tick to actually start `holdWorker` on the worker
    // before queueing the targeted waiter behind it — otherwise this could
    // race `holdWorker` for the worker itself (both would just be ordinary
    // FIFO/targeted acquisitions with no meaningful destroy-while-queued
    // race to exercise). At this point the `queued` call below is
    // guaranteed to be a TARGETED wait (the only worker is busy running
    // `holdWorker`).
    await new Promise((resolve) => setTimeout(resolve, 0));

    const queued = pool.run('longTask', { iterations: 5 }, { affinityKey: key });
    const destroyPromise = pool.destroy();

    await expect(queued).rejects.toBeInstanceOf(PoolDestroyedError);
    await expect(holdWorker).rejects.toBeInstanceOf(PoolDestroyedError);
    await destroyPromise;
  });

  it('a job queued behind a busy affinity target rejects with WorkerCrashedError (not a hang) when the target crashes mid-queue, and the affinity mapping is cleaned', async () => {
    // size: 2 — mirrors the "busy affinity target" test above: a second,
    // idle worker sits in the pool the whole time, so a passing result
    // proves the queued call stayed parked on the (crashing) target rather
    // than ever being handed the other, healthy worker.
    const pool = createPool({ size: 2 });
    const key = 'affinity-crash-while-queued';

    // Establishes worker W as `key`'s affinity target (idle afterward).
    await pool.run('longTask', { iterations: 1 }, { affinityKey: key });

    // Occupies W with the genuine-crash test job, under the SAME
    // affinityKey so it's provably routed to W (not the pool's other idle
    // worker). No `await` between this and the `queued` call below: W is
    // synchronously removed from `idle` inside acquireWorker()'s
    // idle-hit branch (see pool.ts) before this call's first real
    // `await`, so the very next synchronous call already sees W as "live
    // but not idle" (busy) and queues for it — mirroring the existing
    // "still QUEUED" cancellation test's back-to-back-calls idiom, rather
    // than relying on a `setTimeout` to *probably* have started the crash
    // job.
    const crashing = pool.run(
      '__test_crashWorker__' as JobName,
      { iterations: 1 },
      { affinityKey: key },
    );

    // Queues specifically for W (busy) rather than being routed to the
    // pool's other, idle worker or falling into the generic FIFO queue.
    const queued = pool.run('longTask', { iterations: 5 }, { affinityKey: key });

    // W genuinely dies (process.exit inside the worker) while `queued` is
    // still parked in `targetedWaiters` for it — handleWorkerCrash() must
    // reject BOTH the in-flight crashing job AND the targeted waiter
    // behind it; before this fix's regression coverage, only the former
    // was exercised.
    await expect(crashing).rejects.toBeInstanceOf(WorkerCrashedError);
    await expect(queued).rejects.toBeInstanceOf(WorkerCrashedError);

    // Mapping cleaned: a later call with the same key doesn't hang trying
    // to route to (or wait on) the now-dead W — it's treated as fresh and
    // succeeds via a live worker.
    const after = await pool.run('longTask', { iterations: 5 }, { affinityKey: key });
    expect(after.sum).toBe(10);
  });

  it('affinityKey whose FIRST spawn attempt fails: no bogus mapping is recorded, and a later call with the same key spawns and routes normally once the seam heals', async () => {
    let shouldFail = true;
    const pool = createPool({
      size: 1,
      spawnWorkerOverride: (onCrash) => {
        if (shouldFail) {
          shouldFail = false;
          return Promise.reject(new Error('simulated worker construction failure'));
        }
        return spawnWorker(onCrash);
      },
    });
    const key = 'affinity-spawn-construction-failure';

    // First call for `key`: no existing affinity target yet, so
    // acquireWorker() falls straight into the SPAWN branch — which fails
    // via the seam above. Because this rejects before acquireWorker()
    // ever resolves, run()'s `this.affinityTargets.set(affinityKey,
    // worker.id)` line (only reached AFTER a successful acquisition, past
    // both the destroyed/aborted rechecks) never runs: no mapping is
    // recorded for a worker that never came to exist.
    await expect(
      pool.run('longTask', { iterations: 5 }, { affinityKey: key }),
    ).rejects.toThrow(/simulated worker construction failure/);

    // A later call with the SAME key must not hang waiting on a bogus
    // target (there is none) — it's treated as a fresh acquisition, spawns
    // a real worker (the seam only failed once), and succeeds. This
    // establishes `key`'s REAL affinity target for the first time.
    const result = await pool.run('longTask', { iterations: 5 }, { affinityKey: key });
    expect(result.sum).toBe(10);

    // And that real target is now genuinely used for affinity routing: on
    // this size-1 pool, a cache-bearing measurePointToSurface call under
    // the same key can only succeed by landing on the SAME worker that
    // built the BVH — proving the earlier failed spawn attempt left no
    // dangling or incorrect mapping that could misroute (or hang) a call
    // made after the seam healed.
    const { positions, indices } = buildDeterministicMesh(50);
    await pool.run('buildBvh', { contentHash: key, positions, indices }, { affinityKey: key });
    const measured = await pool.run(
      'measurePointToSurface',
      { contentHash: key, point: [0, 0, 0] },
      { affinityKey: key },
    );
    expect(measured.distance).toBeGreaterThanOrEqual(0);
  });

  it('no affinityKey: existing idle/spawn/FIFO-waiter behavior is completely unaffected (regression guard)', async () => {
    const pool = createPool({ size: 2 });
    const iterationCounts = [10, 20, 30, 40];
    const results = await Promise.all(
      iterationCounts.map((iterations) => pool.run('longTask', { iterations })),
    );
    results.forEach((result, i) => {
      const n = iterationCounts[i]!;
      expect(result.sum).toBe((n * (n - 1)) / 2);
    });
  });
});
