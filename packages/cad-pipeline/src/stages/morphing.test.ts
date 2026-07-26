// packages/cad-pipeline/src/stages/morphing.test.ts
//
// Tests for the adaptation/morphing STAGE (morphing.ts) — orchestration, not
// re-testing the kernel morph (that is @dqcad/kernel's anatomy/morph.test.ts).
// Proves: clinical targets flow from the profile via the context; the placed
// tooth + neighbours + antagonist reach the kernel; the RestorationStageResult
// shape (mesh, injected hash, operationName, journal params incl. residuals +
// strengths + morphOptions, inputHashes, errorBound = maxContactResidual) is
// right; the stage is deterministic (replay = identical hash); strength sliders
// change the mesh; and the margin / neighbour / antagonist / clinical-param
// guards fire.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import type { IndexedMesh } from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import {
  runMorphingStage,
  buildMorphPlan,
  MissingMarginLoopError,
  MissingAntagonistError,
  MissingClinicalParamError,
  MORPH_RBF_KERNEL,
} from './morphing.ts';
import { InsufficientNeighborsError } from './anatomyPlacement.ts';

function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function cylinderTooth(radius: number, height: number, rings: number, segments: number): IndexedMesh {
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

function marginCircle(radius: number, z: number, n = 48): { closed: true; resampledPoints: Vec3[] } {
  const resampledPoints: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    resampledPoints.push([radius * Math.cos(th), radius * Math.sin(th), z]);
  }
  return { closed: true, resampledPoints };
}

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}
function handle(contentHash: string, mesh: IndexedMesh): PipelineMeshHandle {
  return { contentHash, mesh };
}

const R = 1.2;
const H = 5;
const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia',
  version: '1.1.0',
  restorationParams: {
    cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.5,
    proximalContactPenetrationMm: 0.02, occlusalContactMm: 0,
  },
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0, occlusalMinWallThicknessMm: 0.5, maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: 0.5, onlayMinThicknessMm: 0.5, cuspCoverageMinThicknessMm: 0.7, marginExclusionMm: 0.2,
};

const TOOTH = 11 as FdiTooth;
const DISTAL = 12 as FdiTooth;
const MESIAL = 21 as FdiTooth;

const PLACED = handle('placed-11', cylinderTooth(R, H, 11, 24));
const MORPH_OPTIONS = { contactInfluenceRadiusMm: 0.8, contactFacingRadiusMm: 1.0, cervicalSealBandMm: 0.6 };

function makeContext(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    restorationId: 'r-morph',
    restorationType: 'crown',
    materialProfile: PROFILE,
    insertionAxis: [0, 0, 1],
    targetMesh: handle('die', cylinderTooth(R, H - 1, 6, 16)),
    marginLoops: { [TOOTH]: marginCircle(R, 0) },
    neighbors: {
      [DISTAL]: handle('nb-12', outwardBox([R + 0.1, -2, 2.3], [3, 2, 4.7])), // +x
      [MESIAL]: handle('nb-21', outwardBox([-3, -2, 2.3], [-(R + 0.1), 2, 4.7])), // -x
    },
    antagonist: handle('anta', outwardBox([-2, -2, H + 0.1], [2, 2, H + 2])),
    stages: { anatomyPlacement: 'placed-11' },
    ...overrides,
  };
}

describe('runMorphingStage — orchestration', () => {
  it('morphs the tooth to the profile contact targets; returns a journalable result', () => {
    const ctx = makeContext();
    const result = runMorphingStage(ctx, TOOTH, { placedMesh: PLACED, hashMesh, morphOptions: MORPH_OPTIONS });

    expect(result.stage).toBe('morphing');
    expect(result.mesh).not.toBeNull();
    expect(result.meshContentHash).toBe(hashMesh(result.mesh!));
    expect(result.operationName).toBe('morphing.morph');
    expect(result.inputHashes).toEqual(['placed-11', 'nb-21', 'nb-12', 'anta']);

    // Clinical targets came from the profile (journaled).
    expect(result.params['proximalContactPenetrationMm']).toBe(0.02);
    expect(result.params['occlusalContactMm']).toBe(0);
    expect(result.params['rbfKernel']).toBe(MORPH_RBF_KERNEL);
    expect(result.params['mesialNeighborFdi']).toBe(21);
    expect(result.params['distalNeighborFdi']).toBe(12);

    // errorBound is the CONSERVATIVE bound (contact + region), >= the
    // single-vertex max contact residual, sub-micron here on clean boxes.
    expect(result.errorBoundMm!).toBeGreaterThanOrEqual(result.params['maxContactResidualMm'] as number);
    expect(result.errorBoundMm!).toBeLessThan(1e-4);

    // Per-contact residuals journaled; proximal ~0.02 penetration, antagonist ~0.
    const contacts = result.params['contacts'] as Array<{ kind: string; achievedSignedDistanceMm: number; regionResidualMm: number; clampBound: boolean }>;
    const byKind = Object.fromEntries(contacts.map((c) => [c.kind, c]));
    expect(byKind['proximalMesial']!.achievedSignedDistanceMm).toBeCloseTo(-0.02, 4);
    expect(byKind['proximalDistal']!.achievedSignedDistanceMm).toBeCloseTo(-0.02, 4);
    expect(byKind['antagonist']!.achievedSignedDistanceMm).toBeCloseTo(0, 4);
    // Region residual + clamp flag journaled per contact; clean boxes -> no clamp.
    for (const c of contacts) expect(c.clampBound).toBe(false);
    expect(result.params['contactClampWarning']).toBe(false);
    expect(result.params['clampedContacts']).toEqual([]);

    // Margin seal preserved — GENUINE measurement (finish line + between pins),
    // nonzero and under the 10 µm budget.
    expect(result.params['marginSealMaxDeviationMm'] as number).toBeLessThan(0.010);
    expect(result.params['marginSealAtFinishLineMm'] as number).toBeGreaterThan(0);
    expect(result.params['marginSealMaxDeviationMm'] as number).toBe(
      Math.max(result.params['marginSealAtFinishLineMm'] as number, result.params['marginSealBetweenPinsMm'] as number),
    );
  });

  it('is deterministic: replaying the same inputs reproduces the identical mesh hash', () => {
    const r1 = runMorphingStage(makeContext(), TOOTH, { placedMesh: PLACED, hashMesh, morphOptions: MORPH_OPTIONS });
    const r2 = runMorphingStage(makeContext(), TOOTH, { placedMesh: PLACED, hashMesh, morphOptions: MORPH_OPTIONS });
    expect(r2.meshContentHash).toBe(r1.meshContentHash);
  });

  it('strength sliders change the mesh; 0-strength is the placed mesh', () => {
    const ctx = makeContext();
    const full = runMorphingStage(ctx, TOOTH, { placedMesh: PLACED, hashMesh, morphOptions: MORPH_OPTIONS });
    const zero = runMorphingStage(ctx, TOOTH, {
      placedMesh: PLACED,
      hashMesh,
      morphOptions: MORPH_OPTIONS,
      strengths: { proximalMesial: 0, proximalDistal: 0, antagonist: 0 },
    });
    expect(full.meshContentHash).not.toBe(zero.meshContentHash);
    expect(zero.meshContentHash).toBe(hashMesh(PLACED.mesh));
    expect((zero.params['strengths'] as { proximalMesial: number }).proximalMesial).toBe(0);
  });

  it('buildMorphPlan is reusable for interactive slider re-solves', () => {
    const plan = buildMorphPlan(makeContext(), TOOTH, PLACED.mesh, MORPH_OPTIONS);
    expect(plan.contacts.length).toBe(3);
    expect(plan.anchorCenters.length).toBeGreaterThan(0);
  });
});

describe('runMorphingStage — gates', () => {
  it('throws MissingMarginLoopError when the tooth has no margin loop', () => {
    expect(() => runMorphingStage(makeContext({ marginLoops: {} }), TOOTH, { placedMesh: PLACED, hashMesh })).toThrow(
      MissingMarginLoopError,
    );
  });

  it('throws MissingAntagonistError when no antagonist is assigned', () => {
    expect(() => runMorphingStage(makeContext({ antagonist: null }), TOOTH, { placedMesh: PLACED, hashMesh })).toThrow(
      MissingAntagonistError,
    );
  });

  it('throws InsufficientNeighborsError without exactly two neighbours', () => {
    expect(() => runMorphingStage(makeContext({ neighbors: {} }), TOOTH, { placedMesh: PLACED, hashMesh })).toThrow(
      InsufficientNeighborsError,
    );
  });

  it('throws MissingClinicalParamError when a contact target is non-finite', () => {
    const badProfile: PipelineMaterialProfile = {
      ...PROFILE,
      restorationParams: { ...PROFILE.restorationParams, proximalContactPenetrationMm: Number.NaN },
    };
    expect(() =>
      runMorphingStage(makeContext({ materialProfile: badProfile }), TOOTH, { placedMesh: PLACED, hashMesh }),
    ).toThrow(MissingClinicalParamError);
  });
});
