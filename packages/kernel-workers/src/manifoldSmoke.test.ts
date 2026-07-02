// Proves the manifoldSmoke job runs end-to-end through a REAL Node
// worker_threads worker (not just as a direct in-process call into
// @dqcad/kernel, which packages/kernel/src/boolean/manifold.test.ts already
// covers). This is the highest-risk seam this task adds: worker-entry.node.ts
// is loaded by Node's own native module resolver, not a bundler, so every
// relative import reachable from it — including, now, into @dqcad/kernel —
// must use literal `.ts` extensions (see packages/kernel/src/boolean/
// manifold.ts's module doc) or native resolution fails outright. This test
// would fail loudly (worker crash / rejected run()) if that wiring were
// wrong. The browser Web Worker path is verified separately via the client
// dev smoke panel (apps/client/src/engine/workers.ts's
// runManifoldSmokeTest), since jsdom doesn't implement real Web Workers.
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

describe('WorkerPool — manifoldSmoke (real Node worker_threads worker)', () => {
  it('loads manifold-3d WASM inside the worker and unions two overlapping cubes', async () => {
    const pool = new WorkerPool({ size: 1 });
    pools.push(pool);

    const result = await pool.run('manifoldSmoke', {});

    expect(result.expected).toBe(1.5);
    expect(Math.abs(result.volume - result.expected)).toBeLessThan(1e-4);
  });
});
