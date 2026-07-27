// bridgeFramework job tests (Phase 6 Task 5) — the framework-cutback worker. The
// cutback accuracy + fit/margin byte-preservation are covered at the kernel/stage
// level (packages/kernel/src/bridge/frameworkCutback.test.ts,
// packages/cad-pipeline/src/stages/bridgeFramework.test.ts); these tests prove the
// job wires @dqcad/kernel's `frameworkCutback` through a real worker: registration
// + progress-to-1 + BYTE-IDENTITY with direct kernel calls (through the pool),
// invalid-input rejection, and GENUINE mid-computation cancellation.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { frameworkCutback, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { JobCancelledError, WorkerPool } from './pool.js';
import { bridgeFrameworkJob, type BridgeFrameworkPayload, type BridgeFrameworkUnitPayload } from './jobs/bridgeFramework.ts';

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

/** A compact closed hex-prism unit, SERIALIZED to the flat worker payload (the
 * P5-T8 lesson — serialized asset, never a ported client construction). */
function hexPrismPayloadUnit(): BridgeFrameworkUnitPayload {
  const n = 6;
  const R = 2.0;
  const H = 3.0;
  const P: number[] = [];
  const fit: number[] = [];
  const push = (x: number, y: number, z: number, isFit: number): number => {
    P.push(x, y, z);
    fit.push(isFit);
    return P.length / 3 - 1;
  };
  const bottom: number[] = [];
  const top: number[] = [];
  for (let s = 0; s < n; s++) { const th = (2 * Math.PI * s) / n; bottom.push(push(R * Math.cos(th), R * Math.sin(th), 0, 1)); }
  for (let s = 0; s < n; s++) { const th = (2 * Math.PI * s) / n; top.push(push(R * Math.cos(th), R * Math.sin(th), H, 0)); }
  const bc = push(0, 0, 0, 1);
  const tc = push(0, 0, H, 0);
  const tris: number[] = [];
  for (let s = 0; s < n; s++) {
    const sn = (s + 1) % n;
    tris.push(bottom[s]!, bottom[sn]!, top[sn]!, bottom[s]!, top[sn]!, top[s]!);
    tris.push(bc, bottom[sn]!, bottom[s]!);
    tris.push(tc, top[s]!, top[sn]!);
  }
  const marginLoopFlat = new Float64Array(bottom.length * 3);
  bottom.forEach((vi, i) => { marginLoopFlat[i * 3] = P[vi * 3]!; marginLoopFlat[i * 3 + 1] = P[vi * 3 + 1]!; marginLoopFlat[i * 3 + 2] = P[vi * 3 + 2]!; });
  return { positions: new Float64Array(P), indices: Uint32Array.from(tris), fitMask: Uint8Array.from(fit), marginLoopFlat };
}

function payload(overrides?: Partial<BridgeFrameworkPayload>): BridgeFrameworkPayload {
  return { units: [hexPrismPayloadUnit(), hexPrismPayloadUnit()], veneeringSpaceMm: 1.0, marginTaperBandMm: 0.3, ...overrides };
}

/** Direct-kernel reference (mirrors the job exactly). */
function directRef(u: BridgeFrameworkUnitPayload, d: number, band: number): IndexedMesh {
  const mesh: IndexedMesh = { positions: u.positions, indices: u.indices };
  const loop: Vec3[] = [];
  for (let i = 0; i < u.marginLoopFlat.length; i += 3) loop.push([u.marginLoopFlat[i]!, u.marginLoopFlat[i + 1]!, u.marginLoopFlat[i + 2]!]);
  return frameworkCutback(mesh, { veneeringSpaceMm: d, fitVertexMask: Array.from(u.fitMask, (v) => v === 1), marginLoop: loop, marginTaperBandMm: band }).mesh;
}

describe('bridgeFramework job — through a real worker', () => {
  it('registered; progress ends at 1; cut-back meshes BYTE-IDENTICAL to direct kernel calls', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const p = payload();
    const progress: number[] = [];
    const res = await pool.run('bridgeFramework', p, { onProgress: (f) => progress.push(f) });

    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(res.units.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      const ref = directRef(p.units[i]!, p.veneeringSpaceMm, p.marginTaperBandMm);
      expect(hashBuffers(res.units[i]!.positions, res.units[i]!.indices)).toBe(hashBuffers(ref.positions, ref.indices));
      expect(res.units[i]!.maxAppliedCutbackMm).toBeCloseTo(1.0, 9);
    }
  });

  it('rejects invalid input (empty units) before heavy work', async () => {
    const pool = createPool({ size: 1 });
    await expect(pool.run('bridgeFramework', payload({ units: [] }))).rejects.toMatchObject({ name: 'TypeError' });
  });
});

describe('bridgeFramework job — direct handler (in-process)', () => {
  it('cuts back every unit, byte-identical to direct kernel calls', async () => {
    const p = payload();
    const progress: number[] = [];
    const res = await bridgeFrameworkJob(p, { progress: (f) => progress.push(f), cancelled: () => false });
    for (let i = 0; i < 2; i++) {
      const ref = directRef(p.units[i]!, p.veneeringSpaceMm, p.marginTaperBandMm);
      expect(hashBuffers(res.units[i]!.positions, res.units[i]!.indices)).toBe(hashBuffers(ref.positions, ref.indices));
    }
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('rejects invalid inputs (bad band / mask-length mismatch) with TypeError', async () => {
    const ctx = { progress: () => {}, cancelled: () => false };
    await expect(bridgeFrameworkJob(payload({ marginTaperBandMm: 0 }), ctx)).rejects.toBeInstanceOf(TypeError);
    const bad = hexPrismPayloadUnit();
    await expect(bridgeFrameworkJob({ units: [{ ...bad, fitMask: new Uint8Array([1, 0]) }], veneeringSpaceMm: 1, marginTaperBandMm: 0.3 }, ctx)).rejects.toBeInstanceOf(TypeError);
  });

  it('propagates the kernel typed error for a negative veneering space', async () => {
    const ctx = { progress: () => {}, cancelled: () => false };
    // Passes the job-level >= 0 check by NaN? No — use the kernel path: a finite
    // negative value fails the job validator (>= 0). A NaN band is caught too.
    await expect(bridgeFrameworkJob(payload({ veneeringSpaceMm: -0.5 }), ctx)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('bridgeFramework job — cancellation (direct handler, deterministic)', () => {
  it('throws JobCancelledError GENUINELY MID-COMPUTATION (cancelled before the 2nd unit)', async () => {
    let calls = 0;
    const ctx = { progress: () => {}, cancelled: async () => ++calls >= 2 };
    await expect(bridgeFrameworkJob(payload(), ctx)).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('throws JobCancelledError when cancelled at entry', async () => {
    const ctx = { progress: () => {}, cancelled: async () => true };
    await expect(bridgeFrameworkJob(payload(), ctx)).rejects.toBeInstanceOf(JobCancelledError);
  });
});
