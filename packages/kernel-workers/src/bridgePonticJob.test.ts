// bridgePontic job tests (Phase 6 Task 3) — the pontic + gingival-interface
// worker. The per-style relief geometry + the ±20 µm acceptance + the
// measurement's closed-form validation are covered at the kernel level
// (packages/kernel/src/bridge/ponticInterface.test.ts); these tests prove the
// job wires @dqcad/kernel's placement + `shapePonticBase` + `measurePonticRelief`
// through a real worker correctly: registration + progress-to-1 + BYTE-IDENTITY
// with direct kernel calls (through the pool), invalid-input rejection, and
// GENUINE mid-computation cancellation (direct handler, deterministic).
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  orientNormalsConsistently,
  solveAnatomyPlacement,
  buildPlacementTransform,
  placeMesh,
  synthPonticSeatRing,
  shapePonticBase,
  measurePonticRelief,
  buildBvh,
  computePseudonormals,
  type IndexedMesh,
  type Vec3,
  type CanonicalFrameAxes,
  type RidgeCrestCylinder,
} from '@dqcad/kernel';
import { JobCancelledError, WorkerPool } from './pool.js';
import { bridgePonticJob, type BridgePonticPayload } from './jobs/bridgePontic.ts';

const pools: WorkerPool[] = [];
function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

const R = 3, ZC = 1, HALF_LEN = 6, CREST_SEGS = 160, STATIONS = 16;

const CREST: RidgeCrestCylinder = {
  axisPointMm: [0, 0, ZC], mesialDistalDir: [1, 0, 0], buccalDir: [0, 1, 0], upDir: [0, 0, 1], radiusMm: R,
};
const CANONICAL: CanonicalFrameAxes = {
  origin: [0, 0, 0], mesialDistal: [1, 0, 0], buccoLingual: [0, 1, 0], occlusoGingival: [0, 0, 1],
};
const FOOTPRINT = { stationMinMm: -4, stationMaxMm: 4, angularHalfSpanRad: (60 * Math.PI) / 180 };
const RES = { meshStations: 16, meshAngularSegments: 40, sampleStations: 32, sampleAngularSegments: 64 };

function box(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function buildRidge(): IndexedMesh {
  const vmap = new Map<string, number>();
  const pos: number[] = [];
  const vid = (p: Vec3): number => {
    const key = `${p[0]}|${p[1]}|${p[2]}`;
    const e = vmap.get(key);
    if (e !== undefined) return e;
    const i = pos.length / 3;
    pos.push(p[0], p[1], p[2]);
    vmap.set(key, i);
    return i;
  };
  const tris: number[] = [];
  const crestZ = (y: number): number => (y === 0 ? ZC + R : ZC + Math.sqrt(R * R - y * y));
  const ys: number[] = [];
  for (let i = 0; i <= CREST_SEGS; i++) ys.push(i === 0 ? -R : i === CREST_SEGS ? R : -R + (2 * R * i) / CREST_SEGS);
  const ring = (x: number): Vec3[] => {
    const r: Vec3[] = [];
    for (const y of ys) r.push([x, y, crestZ(y)]);
    r.push([x, R, 0]);
    r.push([x, -R, 0]);
    return r;
  };
  const xs: number[] = [];
  for (let i = 0; i <= STATIONS; i++) xs.push(i === 0 ? -HALF_LEN : i === STATIONS ? HALF_LEN : -HALF_LEN + (2 * HALF_LEN * i) / STATIONS);
  const sections = xs.map(ring);
  for (let s = 0; s < sections.length - 1; s++) {
    const a = sections[s]!, b = sections[s + 1]!;
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      tris.push(vid(a[i]!), vid(a[j]!), vid(b[j]!), vid(a[i]!), vid(b[j]!), vid(b[i]!));
    }
  }
  const cap = (sec: Vec3[], x: number): void => {
    const c = vid([x, 0, 0]);
    for (let i = 0; i < sec.length; i++) tris.push(c, vid(sec[i]!), vid(sec[(i + 1) % sec.length]!));
  };
  cap(sections[0]!, -HALF_LEN);
  cap(sections[sections.length - 1]!, HALF_LEN);
  return orientNormalsConsistently({ positions: new Float64Array(pos), indices: Uint32Array.from(tris) }).mesh;
}

function hashBuffers(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

const LIBRARY = box([-3, -3, 0], [3, 3, 7]);
const MESIAL_POS = box([-9, -3, 0], [-5, 3, 6]).positions;
const DISTAL_POS = box([5, -3, 0], [9, 3, 6]).positions;

function payload(style: 'hygienic' | 'ridgeLap' | 'ovate', overrides?: Partial<BridgePonticPayload>): BridgePonticPayload {
  const ridge = buildRidge();
  const params = style === 'hygienic' ? { clearanceMm: 2.0 } : style === 'ridgeLap' ? { reliefMm: 0.05, lingualOpeningMm: 0.5 } : { depthMm: 1.0, seatHalfAngleRad: (18 * Math.PI) / 180, emergenceMm: 0.5 };
  return {
    gingivaPositions: ridge.positions, gingivaIndices: ridge.indices,
    canonicalFrame: CANONICAL, libraryPositions: LIBRARY.positions.slice(), libraryIndices: LIBRARY.indices.slice(),
    insertionAxis: [0, 0, 1], mesialNeighborPositions: MESIAL_POS.slice(), distalNeighborPositions: DISTAL_POS.slice(),
    antagonistPositions: null, style, ridgeCrest: CREST, params, footprint: FOOTPRINT, resolution: RES,
    seatRingRadiusMm: 1.5, seatRingSegments: 64,
    ...overrides,
  };
}

/** The direct-kernel reference for byte-identity (mirrors the job exactly). */
function directRefs(p: BridgePonticPayload) {
  const site = (p.footprint.stationMinMm + p.footprint.stationMaxMm) / 2;
  const seat = synthPonticSeatRing(p.ridgeCrest, site, p.seatRingRadiusMm, p.seatRingSegments);
  const lib: IndexedMesh = { positions: p.libraryPositions, indices: p.libraryIndices };
  const sol = solveAnatomyPlacement({
    canonicalFrame: p.canonicalFrame, libraryMesh: lib, marginLoop: seat, insertionAxis: p.insertionAxis,
    mesialNeighborPositions: p.mesialNeighborPositions, distalNeighborPositions: p.distalNeighborPositions, antagonistPositions: null,
  });
  const body = placeMesh(lib, buildPlacementTransform(sol.frame, p.canonicalFrame));
  const shaped = shapePonticBase(p.ridgeCrest, p.style, p.params, p.footprint, p.resolution);
  const gingiva: IndexedMesh = { positions: p.gingivaPositions, indices: p.gingivaIndices };
  const relief = measurePonticRelief(gingiva, buildBvh(gingiva), computePseudonormals(gingiva), shaped.samples, p.ridgeCrest);
  return { body, base: shaped.mesh, relief, primaryTargetMm: shaped.primaryTargetMm };
}

describe('bridgePontic job — through a real worker', () => {
  it('registered; progress ends at 1; body + base BYTE-IDENTICAL to direct kernel calls; measured relief matches', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const p = payload('hygienic');
    const ref = directRefs(p);
    const progress: number[] = [];
    const res = await pool.run('bridgePontic', p, { onProgress: (f) => progress.push(f) });

    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);

    expect(hashBuffers(res.bodyPositions, res.bodyIndices)).toBe(hashBuffers(ref.body.positions, ref.body.indices));
    expect(hashBuffers(res.basePositions, res.baseIndices)).toBe(hashBuffers(ref.base.positions, ref.base.indices));
    expect(res.primaryTargetMm).toBe(ref.primaryTargetMm);
    expect(res.primary.maxAbsDeviationMm).toBeCloseTo(ref.relief.primary.maxAbsDeviationMm, 12);
    expect(res.primary.maxAbsDeviationMm).toBeLessThanOrEqual(0.02);
  });

  it('rejects invalid input (degenerate gingiva) before heavy work', async () => {
    const pool = createPool({ size: 1 });
    const bad = payload('hygienic', { gingivaPositions: new Float64Array([0, 0, 0]), gingivaIndices: new Uint32Array([0, 0, 0]) });
    await expect(pool.run('bridgePontic', bad)).rejects.toMatchObject({ name: 'TypeError' });
  });
});

describe('bridgePontic job — direct handler (in-process, full path)', () => {
  it('places + shapes + measures, byte-identical to direct kernel calls (all 3 styles)', async () => {
    for (const style of ['hygienic', 'ridgeLap', 'ovate'] as const) {
      const p = payload(style);
      const ref = directRefs(p);
      const progress: number[] = [];
      const res = await bridgePonticJob(p, { progress: (f) => progress.push(f), cancelled: () => false });
      expect(hashBuffers(res.bodyPositions, res.bodyIndices)).toBe(hashBuffers(ref.body.positions, ref.body.indices));
      expect(hashBuffers(res.basePositions, res.baseIndices)).toBe(hashBuffers(ref.base.positions, ref.base.indices));
      expect(res.primaryTargetMm).toBe(ref.primaryTargetMm);
      expect(res.primary.maxAbsDeviationMm).toBeLessThanOrEqual(0.02);
      expect(res.analyticCrossCheckMaxGapMm).not.toBeNull();
      expect(progress[progress.length - 1]).toBe(1);
    }
  });

  it('rejects invalid inputs (seat radius / degenerate library / empty neighbours) with TypeError', async () => {
    const ctx = { progress: () => {}, cancelled: () => false };
    await expect(bridgePonticJob(payload('hygienic', { seatRingRadiusMm: 0 }), ctx)).rejects.toBeInstanceOf(TypeError);
    await expect(bridgePonticJob(payload('hygienic', { libraryIndices: new Uint32Array([0, 0]) }), ctx)).rejects.toBeInstanceOf(TypeError);
    await expect(bridgePonticJob(payload('hygienic', { mesialNeighborPositions: new Float64Array([]) }), ctx)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('bridgePontic job — cancellation (direct handler, deterministic)', () => {
  it('throws JobCancelledError GENUINELY MID-COMPUTATION (cancelled after placement)', async () => {
    let calls = 0;
    const ctx = { progress: () => {}, cancelled: async () => ++calls >= 2 };
    await expect(bridgePonticJob(payload('hygienic'), ctx)).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls).toBeGreaterThanOrEqual(2); // entry check passed, mid-check aborted
  });

  it('throws JobCancelledError when cancelled at entry', async () => {
    const ctx = { progress: () => {}, cancelled: async () => true };
    await expect(bridgePonticJob(payload('hygienic'), ctx)).rejects.toBeInstanceOf(JobCancelledError);
  });
});
