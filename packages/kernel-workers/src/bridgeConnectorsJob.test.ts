// bridgeConnectors job tests (Phase 6 Task 4) — the connectors worker. The area
// instrument's closed-form validation + station-spacing fail-safe + the
// acceptance pair are covered at the kernel/stage level
// (packages/kernel/src/bridge/connector.test.ts,
// packages/cad-pipeline/src/stages/bridgeConnectors.test.ts); these tests prove
// the job wires @dqcad/kernel's `loftConnectorProfiles` + `measureConnectorMinArea`
// through a real worker: registration + progress-to-1 + BYTE-IDENTITY with direct
// kernel calls (through the pool), invalid-input rejection, and GENUINE
// mid-computation cancellation.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildConnectorFrame,
  loftConnectorProfiles,
  measureConnectorMinArea,
  makeEllipseConnectorProfile,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, WorkerPool } from './pool.js';
import { bridgeConnectorsJob, type BridgeConnectorsPayload, type BridgeConnectorInputPayload } from './jobs/bridgeConnectors.ts';

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

function flat(profile: readonly (readonly [number, number])[]): Float64Array {
  const out = new Float64Array(profile.length * 2);
  profile.forEach((p, i) => {
    out[i * 2] = p[0];
    out[i * 2 + 1] = p[1];
  });
  return out;
}

const ORIGIN_A: Vec3 = [-2, 0, 2];
const AXIS: Vec3 = [1, 0, 0];

function connectorInput(semi1: number, semi2: number, span = 4): BridgeConnectorInputPayload {
  const prof = makeEllipseConnectorProfile(semi1, semi2, 64);
  return { originMm: ORIGIN_A, axisMm: AXIS, spanMm: span, profileAFlat: flat(prof), profileBFlat: flat(prof) };
}

function payload(overrides?: Partial<BridgeConnectorsPayload>): BridgeConnectorsPayload {
  return { connectors: [connectorInput(2.2, 1.8), connectorInput(2.0, 1.6)], stationCount: 63, ...overrides };
}

/** Direct-kernel reference for byte-identity (mirrors the job exactly). */
function directRef(c: BridgeConnectorInputPayload, stationCount: number) {
  const frame = buildConnectorFrame(c.originMm, c.axisMm, c.spanMm);
  const profA: [number, number][] = [];
  for (let i = 0; i < c.profileAFlat.length; i += 2) profA.push([c.profileAFlat[i]!, c.profileAFlat[i + 1]!]);
  const { mesh } = loftConnectorProfiles(profA, profA, frame);
  const m = measureConnectorMinArea(mesh, frame, profA, profA, { stationCount });
  return { mesh, minAreaMm2: m.minAreaMm2 };
}

describe('bridgeConnectors job — through a real worker', () => {
  it('registered; progress ends at 1; connector meshes + areas BYTE-IDENTICAL to direct kernel calls', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const p = payload();
    const progress: number[] = [];
    const res = await pool.run('bridgeConnectors', p, { onProgress: (f) => progress.push(f) });

    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(res.connectors.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      const ref = directRef(p.connectors[i]!, 63);
      expect(hashBuffers(res.connectors[i]!.positions, res.connectors[i]!.indices)).toBe(hashBuffers(ref.mesh.positions, ref.mesh.indices));
      expect(res.connectors[i]!.minAreaMm2).toBeCloseTo(ref.minAreaMm2, 12);
    }
  });

  it('rejects invalid input (empty connectors) before heavy work', async () => {
    const pool = createPool({ size: 1 });
    await expect(pool.run('bridgeConnectors', payload({ connectors: [] }))).rejects.toMatchObject({ name: 'TypeError' });
  });
});

describe('bridgeConnectors job — direct handler (in-process)', () => {
  it('builds + measures every connector, byte-identical to direct kernel calls', async () => {
    const p = payload();
    const progress: number[] = [];
    const res = await bridgeConnectorsJob(p, { progress: (f) => progress.push(f), cancelled: () => false });
    for (let i = 0; i < 2; i++) {
      const ref = directRef(p.connectors[i]!, 63);
      expect(hashBuffers(res.connectors[i]!.positions, res.connectors[i]!.indices)).toBe(hashBuffers(ref.mesh.positions, ref.mesh.indices));
    }
    expect(res.minAreaMm2).toBeCloseTo(Math.min(res.connectors[0]!.minAreaMm2, res.connectors[1]!.minAreaMm2), 12);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('rejects invalid inputs (bad span / too-few-vertex profile) with TypeError', async () => {
    const ctx = { progress: () => {}, cancelled: () => false };
    await expect(bridgeConnectorsJob(payload({ connectors: [connectorInput(2, 2, 0)] }), ctx)).rejects.toBeInstanceOf(TypeError);
    await expect(
      bridgeConnectorsJob({ connectors: [{ originMm: ORIGIN_A, axisMm: AXIS, spanMm: 3, profileAFlat: new Float64Array([0, 0, 1, 0]), profileBFlat: new Float64Array([0, 0, 1, 0]) }] }, ctx),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('propagates the kernel typed error for a self-intersecting profile', async () => {
    const ctx = { progress: () => {}, cancelled: () => false };
    // Bowtie flat: (0,0)-(1,1)-(1,0)-(0,1) crosses itself.
    const bowtie = new Float64Array([0, 0, 1, 1, 1, 0, 0, 1]);
    await expect(
      bridgeConnectorsJob({ connectors: [{ originMm: ORIGIN_A, axisMm: AXIS, spanMm: 3, profileAFlat: bowtie, profileBFlat: bowtie }] }, ctx),
    ).rejects.toMatchObject({ name: 'SelfIntersectingProfileError' });
  });
});

describe('bridgeConnectors job — cancellation (direct handler, deterministic)', () => {
  it('throws JobCancelledError GENUINELY MID-COMPUTATION (cancelled before the 2nd connector)', async () => {
    let calls = 0;
    const ctx = { progress: () => {}, cancelled: async () => ++calls >= 2 };
    await expect(bridgeConnectorsJob(payload(), ctx)).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('throws JobCancelledError when cancelled at entry', async () => {
    const ctx = { progress: () => {}, cancelled: async () => true };
    await expect(bridgeConnectorsJob(payload(), ctx)).rejects.toBeInstanceOf(JobCancelledError);
  });
});
