// morphAnatomy / resolveMorph job tests (Phase 4 Task 6) — the RBF contact
// morph worker jobs + their per-worker plan cache. Exercised by calling the
// handlers directly with a noop JobContext (the kernel's anatomy/morph.test.ts
// covers the geometry; here we prove the payload→kernel wiring, the plan-cache
// re-solve path, the contact heatmaps, progress/cancel, and the not-cached
// guard).
import { describe, expect, it, vi } from 'vitest';
import type { Vec3 } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './jobs/context.js';
import {
  morphAnatomyJob,
  resolveMorphJob,
  MorphPlanNotCachedError,
  type MorphAnatomyPayload,
} from './jobs/morphAnatomy.js';

const NOOP_CTX: JobContext = { progress: () => {}, cancelled: () => false };

function outwardBox(min: Vec3, max: Vec3): { positions: Float64Array; indices: Uint32Array } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float64Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const indices = Uint32Array.from([0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { positions, indices };
}

function cylinderTooth(radius: number, height: number, rings: number, segments: number): { positions: Float64Array; indices: Uint32Array } {
  const positions: number[] = [];
  for (let r = 0; r < rings; r++) {
    const z = (height * r) / (rings - 1);
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      positions.push(radius * Math.cos(th), radius * Math.sin(th), z);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = r * segments + s;
      const b = r * segments + s1;
      const c = (r + 1) * segments + s;
      const d = (r + 1) * segments + s1;
      indices.push(a, b, d, a, d, c);
    }
  }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

function marginLoopFlat(radius: number, z: number, n = 48): Float64Array {
  const flat: number[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    flat.push(radius * Math.cos(th), radius * Math.sin(th), z);
  }
  return new Float64Array(flat);
}

const R = 1.2;
const H = 5;

function basePayload(overrides?: Partial<MorphAnatomyPayload>): MorphAnatomyPayload {
  const tooth = cylinderTooth(R, H, 11, 24);
  const distal = outwardBox([R + 0.1, -2, 2.3], [3, 2, 4.7]);
  const mesial = outwardBox([-3, -2, 2.3], [-(R + 0.1), 2, 4.7]);
  const anta = outwardBox([-2, -2, H + 0.1], [2, 2, H + 2]);
  return {
    planId: 'session-1',
    placedPositions: tooth.positions,
    placedIndices: tooth.indices,
    marginLoop: marginLoopFlat(R, 0),
    contacts: [
      { kind: 'proximalDistal', positions: distal.positions, indices: distal.indices, targetPenetrationMm: 0.02 },
      { kind: 'proximalMesial', positions: mesial.positions, indices: mesial.indices, targetPenetrationMm: 0.02 },
      { kind: 'antagonist', positions: anta.positions, indices: anta.indices, targetPenetrationMm: 0 },
    ],
    options: { contactInfluenceRadiusMm: 0.8, contactFacingRadiusMm: 1.0, cervicalSealBandMm: 0.6 },
    ...overrides,
  };
}

describe('morphAnatomyJob', () => {
  it('morphs the tooth to the contact targets and reports progress', async () => {
    const progress = vi.fn();
    const r = await morphAnatomyJob(basePayload(), { progress, cancelled: () => false });
    expect(r.positions.length).toBe(basePayload().placedPositions.length);
    expect(r.contacts.length).toBe(3);
    const byKind = Object.fromEntries(r.contacts.map((c) => [c.kind, c]));
    expect(byKind['proximalDistal']!.achievedSignedDistanceMm).toBeCloseTo(-0.02, 4);
    expect(byKind['antagonist']!.achievedSignedDistanceMm).toBeCloseTo(0, 4);
    expect(r.maxContactResidualMm!).toBeLessThan(1e-4);
    expect(r.marginSealMaxDeviationMm).toBeLessThan(0.010);
    expect(progress).toHaveBeenCalledWith(1);
  });

  it('computes per-vertex contact heatmaps when requested (reuses closestPointBatch)', async () => {
    const r = await morphAnatomyJob(basePayload({ computeHeatmaps: true }), NOOP_CTX);
    expect(r.heatmaps).toBeDefined();
    expect(r.heatmaps!.length).toBe(3);
    for (const h of r.heatmaps!) {
      expect(h.distances.length).toBe(basePayload().placedPositions.length / 3);
      expect(h.min).toBeLessThanOrEqual(h.max);
    }
  });

  it('caches the plan so resolveMorph re-solves fast at a new strength', async () => {
    await morphAnatomyJob(basePayload(), NOOP_CTX);
    const re = await resolveMorphJob({ planId: 'session-1', strengths: { proximalDistal: 0.5, proximalMesial: 0.5, antagonist: 0.5 } }, NOOP_CTX);
    const dist = re.contacts.find((c) => c.kind === 'proximalDistal')!.achievedSignedDistanceMm;
    // Half strength -> less penetration than the full -0.02.
    expect(dist).toBeGreaterThan(-0.02);
  });

  it('resolveMorph is deterministic across two re-solves', async () => {
    await morphAnatomyJob(basePayload(), NOOP_CTX);
    const a = await resolveMorphJob({ planId: 'session-1', strengths: { proximalDistal: 0.7 } }, NOOP_CTX);
    const b = await resolveMorphJob({ planId: 'session-1', strengths: { proximalDistal: 0.7 } }, NOOP_CTX);
    expect(Buffer.from(a.positions.buffer)).toEqual(Buffer.from(b.positions.buffer));
  });

  it('throws MorphPlanNotCachedError for an unknown planId', async () => {
    await expect(resolveMorphJob({ planId: 'never-built' }, NOOP_CTX)).rejects.toThrow(MorphPlanNotCachedError);
  });

  it('throws JobCancelledError when cancelled up front', async () => {
    await expect(morphAnatomyJob(basePayload(), { progress: () => {}, cancelled: () => true })).rejects.toThrow(JobCancelledError);
  });
});
