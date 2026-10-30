// fitCervicalRing job tests (Phase 10 Task 5) — via a real Node worker_threads
// WorkerPool. The fit itself (emergence loop, RBF, @errorBound) is covered at
// the kernel level (anatomy/cervicalFit.test.ts); these prove the JOB: it is
// byte-identical to the direct kernel call with the offset built from the
// profile values it is given, and a refusal comes back as a typed result with
// the kernel's reason (the engine falls back to the built-in template and
// says why), never a crash.
import { afterEach, describe, expect, it } from 'vitest';
import { cervicalEmergenceOffsetMm, detCos, detSin, fitCervicalRing, type Vec3 } from '@dqcad/kernel';
import { loadToothAssetInProcess } from '@dqcad/tooth-library';
import { WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];
function createPool(): WorkerPool {
  const pool = new WorkerPool({ size: 1 });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

const GAPS = { marginalGapMm: 0.02, cementGapMm: 0.05, minWallThicknessMm: 0.5 };

/** The library premolar 15 as-is, and a circular margin around its ring
 * (radius 4 mm, at the ring's mean height) — the fit pulls the ring out. */
function premolarCase(): { positions: Float64Array; indices: Uint32Array; ring: number[]; margin: Vec3[] } {
  const asset = loadToothAssetInProcess(15);
  const ring = [...asset.metadata.cervicalRing!];
  const p = asset.mesh.positions;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of ring) {
    cx += p[v * 3]!;
    cy += p[v * 3 + 1]!;
    cz += p[v * 3 + 2]!;
  }
  cx /= ring.length;
  cy /= ring.length;
  cz /= ring.length;
  const margin: Vec3[] = [];
  for (let i = 0; i < 96; i++) {
    const t = (2 * Math.PI * i) / 96;
    margin.push([cx + 4 * detCos(t), cy + 4 * detSin(t), cz]);
  }
  return { positions: asset.mesh.positions, indices: asset.mesh.indices, ring, margin };
}

describe('fitCervicalRing job', () => {
  it('is byte-identical to the direct kernel call, with the offset built from the profile values', async () => {
    const pool = createPool();
    const c = premolarCase();
    const result = await pool.run('fitCervicalRing', {
      positions: c.positions.slice(),
      indices: c.indices.slice(),
      cervicalRing: c.ring,
      marginLoop: new Float64Array(c.margin.flat()),
      insertionAxis: [0, 0, 1],
      ...GAPS,
    });
    const direct = fitCervicalRing({
      mesh: { positions: c.positions, indices: c.indices },
      cervicalRing: c.ring,
      marginLoop: c.margin,
      insertionAxis: [0, 0, 1],
      emergenceOffsetMm: cervicalEmergenceOffsetMm(GAPS),
    });
    if (!result.ok) throw new Error(`expected a fit, got ${result.reason}`);
    expect(Array.from(result.positions)).toEqual(Array.from(direct.mesh.positions));
    expect(Array.from(result.indices)).toEqual(Array.from(direct.mesh.indices));
    expect(result.errorBoundMm).toBe(direct.errorBoundMm);
    expect(result.emergenceOffsetMm).toBe(cervicalEmergenceOffsetMm(GAPS));
    expect(result.maxRingDisplacementMm).toBe(direct.maxRingDisplacementMm);
    expect(result.movedVertexCount).toBe(direct.movedVertexCount);
    expect(result.cervicalBlendMm).toBe(direct.cervicalBlendMm);
  });

  it('returns the kernel refusal reason instead of throwing (a ring that is not an edge loop)', async () => {
    const pool = createPool();
    const c = premolarCase();
    const result = await pool.run('fitCervicalRing', {
      positions: c.positions.slice(),
      indices: c.indices.slice(),
      cervicalRing: [c.ring[0]!, c.ring[2]!, c.ring[4]!, c.ring[6]!],
      marginLoop: new Float64Array(c.margin.flat()),
      insertionAxis: [0, 0, 1],
      ...GAPS,
    });
    expect(result).toMatchObject({ ok: false, reason: 'ring-not-edge-loop' });
  });
});
