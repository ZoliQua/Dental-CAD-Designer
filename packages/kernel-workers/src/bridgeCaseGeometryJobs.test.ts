// Phase 9 Task 6 — the bridge-built-from-the-case jobs (fitRidgeCrest,
// bridgePonticUnit, placeBridgeConnectors) and the bridgeAbutmentSurfaces
// `assess` extension. The ops are proven at the kernel level (ponticUnit /
// connector / ridgeCrest tests); these tests prove the jobs drive them
// byte-identically, through a real worker where it matters (registration +
// transfer of nested results), and refuse bad input.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPlacementTransform,
  buildPonticUnit,
  fitRidgeCrestCylinder,
  placeConnectorBetweenUnits,
  placeMesh,
  rescalePlacement,
  solveAnatomyPlacement,
  synthPonticSeatRing,
  type IndexedMesh,
  type Vec3,
} from '@dqcad/kernel';
import { WorkerPool } from './pool.js';
import { bridgePonticUnitJob, fitRidgeCrestJob, placeBridgeConnectorsJob, RidgeSiteMissError } from './jobs/bridgeCaseGeometry.ts';
import type { JobContext } from './jobs/context.ts';

const NOOP_CTX: JobContext = { progress: () => undefined, cancelled: async () => false };

const pools: WorkerPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

function hash(m: { positions: Float64Array; indices: Uint32Array }): string {
  const h = createHash('sha256');
  h.update(Buffer.from(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength));
  h.update(Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength));
  return h.digest('hex');
}

/** A vertical capped cylinder (the "library body"), base at z = 0, axis +Z. */
function cylinder(rho: number, height: number, segments = 64): IndexedMesh {
  const positions: number[] = [];
  for (const z of [0, height]) {
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      positions.push(rho * Math.cos(th), rho * Math.sin(th), z);
    }
  }
  const b = positions.length / 3;
  positions.push(0, 0, 0);
  const t = positions.length / 3;
  positions.push(0, 0, height);
  const tris: number[] = [];
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    tris.push(s, s1, segments + s1, s, segments + s1, segments + s, b, s1, s, t, segments + s, segments + s1);
  }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(tris) };
}

// The closed-form arch case, read as DATA from the committed client asset
// (byte-guarded against the kernel fixture by archBridge.fixture-asset.test.ts).
const ASSET = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../apps/client/src/engine/archBridgeFixture.asset.json', import.meta.url)), 'utf8'),
) as {
  targetScan: { positions: number[]; indices: number[] };
  gingiva: { positions: number[]; indices: number[] };
  abutments: { tooth: number; marginLoop: number[][] }[];
};
const mesh = (m: { positions: number[]; indices: number[] }): IndexedMesh => ({
  positions: Float64Array.from(m.positions),
  indices: Uint32Array.from(m.indices),
});
const FX = {
  targetScan: mesh(ASSET.targetScan),
  gingiva: mesh(ASSET.gingiva),
  abutments: ASSET.abutments.map((a) => ({ tooth: a.tooth, marginLoop: a.marginLoop.map((p) => [p[0]!, p[1]!, p[2]!] as Vec3) })),
  // The analytic crest the fixture's gingiva was built on (archBridge.test-fixtures.ts).
  crest: { axisPointMm: [0, 0, -1.5] as Vec3, mesialDistalDir: [1, 0, 0] as Vec3, buccalDir: [0, 1, 0] as Vec3, upDir: [0, 0, 1] as Vec3, radiusMm: 3 },
};
const AXIS: Vec3 = [0, 0, 1];
const CANONICAL = { origin: [0, 0, 0] as Vec3, mesialDistal: [1, 0, 0] as Vec3, buccoLingual: [0, 1, 0] as Vec3, occlusoGingival: [0, 0, 1] as Vec3 };
const RES = { meshStations: 24, meshAngularSegments: 48, sampleStations: 40, sampleAngularSegments: 80 };
const UNIT = { flangeMm: 0.2, plateThicknessMm: 1, seatOffsetMm: 0.3, resolution: RES };

describe('fitRidgeCrest job', () => {
  it('finds the crest point under the site and fits byte-identically to the kernel op', async () => {
    const payload = {
      gingivaPositions: FX.gingiva.positions,
      gingivaIndices: FX.gingiva.indices,
      siteMm: [0, 0, 5] as Vec3,
      upHint: AXIS,
      buccalHint: [0, 1, 0] as Vec3,
      regionRadiusMm: 3,
    };
    const job = await fitRidgeCrestJob(payload, NOOP_CTX);
    expect(job.crestPointMm[2]).toBeCloseTo(FX.crest.axisPointMm[2] + FX.crest.radiusMm, 12);
    const direct = fitRidgeCrestCylinder(FX.gingiva, { centerMm: job.crestPointMm, radiusMm: 3 }, { upHint: AXIS, buccalHint: [0, 1, 0] });
    expect(job.crest).toEqual(direct.crest);
    expect(job.crest.radiusMm).toBeCloseTo(FX.crest.radiusMm, 9);
  });

  it('refuses a site whose line misses the gingiva', async () => {
    await expect(
      fitRidgeCrestJob(
        { gingivaPositions: FX.gingiva.positions, gingivaIndices: FX.gingiva.indices, siteMm: [0, 40, 5], upHint: AXIS, buccalHint: [0, 1, 0], regionRadiusMm: 3 },
        NOOP_CTX,
      ),
    ).rejects.toThrow(RidgeSiteMissError);
  });
});

describe('bridgePonticUnit job', () => {
  const body = cylinder(2.5, 7);
  const mesial = Float64Array.from([-4, 0, 4]);
  const distal = Float64Array.from([4, 0, 4]);

  it('places the body with the proximal clearance and builds every style byte-identically to the kernel ops (through a worker)', async () => {
    const pool = new WorkerPool();
    pools.push(pool);
    const result = await pool.run('bridgePonticUnit', {
      gingivaPositions: FX.gingiva.positions.slice(),
      gingivaIndices: FX.gingiva.indices.slice(),
      crest: FX.crest,
      canonicalFrame: CANONICAL,
      libraryPositions: body.positions,
      libraryIndices: body.indices,
      insertionAxis: AXIS,
      mesialNeighborPositions: mesial,
      distalNeighborPositions: distal,
      antagonistPositions: null,
      proximalClearanceMm: 0.3,
      seatRingRadiusMm: 1.5,
      seatRingSegments: 64,
      styles: [
        { style: 'hygienic', params: { clearanceMm: 2 } },
        { style: 'ovate', params: { depthMm: 1 } },
      ],
      unit: UNIT,
    });
    // Direct reference — the job's own construction.
    const seat = synthPonticSeatRing(FX.crest, 0, 1.5, 64);
    const solution = solveAnatomyPlacement({
      canonicalFrame: CANONICAL,
      libraryMesh: body,
      marginLoop: seat,
      insertionAxis: AXIS,
      mesialNeighborPositions: mesial,
      distalNeighborPositions: distal,
      antagonistPositions: null,
    });
    const width = solution.measurements.targetMesialDistalWidthMm;
    const k = (width - 0.6) / width;
    expect(result.proximalScale).toBe(k);
    const placed = placeMesh(body, buildPlacementTransform(rescalePlacement(solution.frame, { md: k, bl: k, og: k }), CANONICAL));
    expect(hash({ positions: result.bodyPositions, indices: result.bodyIndices })).toBe(hash(placed));
    const directHygienic = await buildPonticUnit(placed, FX.crest, 'hygienic', { clearanceMm: 2 }, UNIT);
    const hygienic = result.styles[0]!;
    expect(hygienic.style).toBe('hygienic');
    expect(hash({ positions: hygienic.solidPositions, indices: hygienic.solidIndices })).toBe(hash(directHygienic.solid));
    expect(hygienic.asBuiltDeviationMm).toBe(directHygienic.asBuiltDeviationMm);
    expect(hygienic.maxAbsDeviationMm).toBe(hygienic.primary.maxAbsDeviationMm + hygienic.asBuiltDeviationMm);
    for (const s of result.styles) expect(s.maxAbsDeviationMm).toBeLessThanOrEqual(0.02);
    expect(result.styles.map((s) => s.style)).toEqual(['hygienic', 'ovate']);
  }, 120_000);

  it('refuses no style and a pontic space too small for the clearance', async () => {
    const base = {
      gingivaPositions: FX.gingiva.positions,
      gingivaIndices: FX.gingiva.indices,
      crest: FX.crest,
      canonicalFrame: CANONICAL,
      libraryPositions: body.positions,
      libraryIndices: body.indices,
      insertionAxis: AXIS,
      mesialNeighborPositions: mesial,
      distalNeighborPositions: distal,
      antagonistPositions: null,
      proximalClearanceMm: 0.3,
      seatRingRadiusMm: 1.5,
      seatRingSegments: 64,
      styles: [{ style: 'hygienic' as const, params: { clearanceMm: 2 } }],
      unit: UNIT,
    };
    await expect(bridgePonticUnitJob({ ...base, styles: [] }, NOOP_CTX)).rejects.toThrow(TypeError);
    await expect(bridgePonticUnitJob({ ...base, proximalClearanceMm: 5 }, NOOP_CTX)).rejects.toThrow(/cannot keep/);
  });
});

describe('placeBridgeConnectors job', () => {
  it('places one frame per adjacent pair, byte-identical to the kernel op', async () => {
    const shift = (m: IndexedMesh, dx: number): IndexedMesh => ({
      positions: m.positions.map((v, i) => (i % 3 === 0 ? v + dx : v)),
      indices: m.indices,
    });
    const a = shift(cylinder(3, 6), -7.5);
    const b = cylinder(2, 6);
    const c = shift(cylinder(3.5, 6), 8);
    const result = await placeBridgeConnectorsJob({ units: [a, b, c], overlapMm: 0.5 }, NOOP_CTX);
    expect(result.connectors).toHaveLength(2);
    const first = placeConnectorBetweenUnits(a, b, 0.5);
    expect(result.connectors[0]).toEqual({
      originMm: first.originMm,
      axisMm: first.axisMm,
      spanMm: first.spanMm,
      exitAMm: first.exitAMm,
      entryBMm: first.entryBMm,
    });
    await expect(placeBridgeConnectorsJob({ units: [a], overlapMm: 0.5 }, NOOP_CTX)).rejects.toThrow(TypeError);
  });
});

describe('bridgeAbutmentSurfaces job — assess (Phase 9 Task 6)', () => {
  it('reports the shared axis over each prep and each surface margin fit; the surfaces are byte-identical either way', async () => {
    const pool = new WorkerPool();
    pools.push(pool);
    await pool.run(
      'buildBvh',
      { contentHash: 'arch', positions: FX.targetScan.positions.slice(), indices: FX.targetScan.indices.slice() },
      { affinityKey: 'arch' },
    );
    const flat = (loop: readonly Vec3[]) => Float64Array.from(loop.flatMap((p) => [p[0], p[1], p[2]]));
    const payload = {
      contentHash: 'arch',
      pitchMm: 0.15,
      marginalGapMm: 0.02,
      cementGapMm: 0.05,
      spacerStartMm: 0.8,
      blendWidthMm: 0.3,
      insertionAxis: AXIS,
      abutments: FX.abutments.map((a) => ({ tooth: a.tooth, marginLoop: flat(a.marginLoop) })),
    };
    const plain = await pool.run('bridgeAbutmentSurfaces', payload, { affinityKey: 'arch' });
    const assessed = await pool.run('bridgeAbutmentSurfaces', { ...payload, assess: true }, { affinityKey: 'arch' });
    expect(plain.sharedAxis).toBeUndefined();
    expect(plain.abutments[0]!.marginFitMm).toBeUndefined();
    expect(assessed.sharedAxis!.acceptable).toBe(true);
    expect(assessed.sharedAxis!.perAbutment.map((p) => p.tooth)).toEqual([14, 16]);
    for (const p of assessed.sharedAxis!.perAbutment) {
      expect(p.undercutTriangleCount).toBe(0);
      expect(p.regionTriangleCount).toBeGreaterThan(0);
    }
    assessed.abutments.forEach((a, i) => {
      expect(a.marginFitMm).toBeLessThanOrEqual(0.01);
      expect(hash(a)).toBe(hash(plain.abutments[i]!));
    });
  }, 300_000);
});
