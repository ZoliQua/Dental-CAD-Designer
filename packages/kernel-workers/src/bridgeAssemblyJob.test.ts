// bridgeAssembly job tests (Phase 6 Task 6) — the assembly worker. The full
// 3-unit acceptance is proven at test/golden/bridge-acceptance.test.ts; these
// tests prove the job wires @dqcad/kernel's `assembleBridge` through a real
// worker: registration + progress-to-1 + BYTE-IDENTITY with a direct kernel call
// (through the pool + in-process), invalid-input rejection, disjoint propagation,
// and cancellation.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleBridge } from '@dqcad/kernel';
import { JobCancelledError, WorkerPool } from './pool.js';
import { bridgeAssemblyJob, type BridgeAssemblyPayload, type BridgeAssemblySolidPayload } from './jobs/bridgeAssembly.ts';

const pools: WorkerPool[] = [];
function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

function hashBuffers(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

/** An axis-aligned watertight box centred at (cx,0,0), half-extents (hx,h,h). */
function box(cx: number, hx: number, h: number): BridgeAssemblySolidPayload {
  const x0 = cx - hx, x1 = cx + hx, y0 = -h, y1 = h, z0 = -h, z1 = h;
  const positions = new Float64Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { positions, indices };
}

/** Three overlapping boxes that fuse into one solid. */
function fusingPayload(): BridgeAssemblyPayload {
  return { solids: [box(-2, 1.2, 1), box(2, 1.2, 1), box(0, 1.5, 0.5)] };
}

describe('bridgeAssembly job — through a real worker', () => {
  it('registered; progress ends at 1; fused solid BYTE-IDENTICAL to a direct kernel call', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const p = fusingPayload();
    const progress: number[] = [];
    const res = await pool.run('bridgeAssembly', p, { onProgress: (f) => progress.push(f) });

    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(res.watertight).toBe(true);
    expect(res.componentCount).toBe(1);
    expect(res.inputCount).toBe(3);

    const ref = await assembleBridge(p.solids.map((s) => ({ positions: s.positions, indices: s.indices })));
    expect(hashBuffers(res.positions, res.indices)).toBe(hashBuffers(ref.solid.positions, ref.solid.indices));
  });

  it('rejects invalid input (empty solids) before heavy work', async () => {
    const pool = createPool({ size: 1 });
    await expect(pool.run('bridgeAssembly', { solids: [] })).rejects.toMatchObject({ name: 'TypeError' });
  });
});

describe('bridgeAssembly job — direct handler (in-process)', () => {
  it('fuses to one watertight solid, byte-identical to a direct kernel call', async () => {
    const p = fusingPayload();
    const progress: number[] = [];
    const res = await bridgeAssemblyJob(p, { progress: (f) => progress.push(f), cancelled: () => false });
    const ref = await assembleBridge(p.solids.map((s) => ({ positions: s.positions, indices: s.indices })));
    expect(hashBuffers(res.positions, res.indices)).toBe(hashBuffers(ref.solid.positions, ref.solid.indices));
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('rejects degenerate input (a solid with < 1 triangle) with TypeError', async () => {
    const ctx = { progress: () => {}, cancelled: () => false };
    await expect(bridgeAssemblyJob({ solids: [{ positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([]) }] }, ctx)).rejects.toBeInstanceOf(TypeError);
  });

  it('propagates BridgeAssemblyError(disjoint) for non-bridging solids', async () => {
    const ctx = { progress: () => {}, cancelled: () => false };
    // Two boxes far apart + a tiny middle box that reaches neither → 3 components.
    const p: BridgeAssemblyPayload = { solids: [box(-4, 1, 1), box(4, 1, 1), box(0, 0.3, 0.3)] };
    await expect(bridgeAssemblyJob(p, ctx)).rejects.toMatchObject({ name: 'BridgeAssemblyError', reason: 'disjoint' });
  });
});

describe('bridgeAssembly job — cancellation (direct handler)', () => {
  it('throws JobCancelledError when cancelled at entry', async () => {
    const ctx = { progress: () => {}, cancelled: async () => true };
    await expect(bridgeAssemblyJob(fusingPayload(), ctx)).rejects.toBeInstanceOf(JobCancelledError);
  });

  it('throws JobCancelledError when cancelled AFTER the fuse', async () => {
    let calls = 0;
    const ctx = { progress: () => {}, cancelled: async () => ++calls >= 2 }; // false at entry, true after
    await expect(bridgeAssemblyJob(fusingPayload(), ctx)).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
