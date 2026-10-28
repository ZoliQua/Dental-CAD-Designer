// packages/cad-pipeline/src/stages/prepDie.test.ts
//
// Tests for the PREPARE-DIE stage (prepDie.ts) — orchestration, not the
// kernel geometry (that is @dqcad/kernel's extractPrepDie.test.ts). Proven
// here: the stage cuts the die from the target's PERSISTED FORM exactly as
// the worker job and the server do (byte-identical to the direct kernel
// call); the result shape (mesh, injected hash, the engine's journal op name,
// params, inputHashes); determinism; and the guards (crown-only, a margin
// loop is required, kernel refusals propagate typed).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { CROWN_DIE_EXTRACT_OP } from '@dqcad/shared-types';
import { extractPrepDie, persistedMeshForm, PrepDieRegionError, type IndexedMesh } from '@dqcad/kernel';
import { closedFrustumDie, openArchPrepCase } from '@dqcad/kernel/die-fixtures';
import { RestorationTypeMismatchError, type PipelineContext, type PipelineMaterialProfile } from '../pipeline/context.ts';
import { MissingMarginLoopError, runPrepDieStage } from './prepDie.ts';

const TOOTH = 11 as FdiTooth;

const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia',
  version: '1.1.0',
  restorationParams: {
    cementGapMm: 0.05,
    marginalGapMm: 0.02,
    spacerStartMm: 0.8,
    minWallThicknessMm: 0.5,
    proximalContactPenetrationMm: 0.02,
    occlusalContactMm: 0,
  },
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0,
  occlusalMinWallThicknessMm: 0.5,
  maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: 0.5,
  onlayMinThicknessMm: 0.5,
  cuspCoverageMinThicknessMm: 0.7,
  marginExclusionMm: 0.2,
  inlayMarginExclusionMm: 1.3,
  onlayMarginExclusionMm: 1.8,
  frameworkMinThicknessMm: 0.5,
  ponticHygienicClearanceMm: 2.0,
  ponticRidgeLapReliefMm: 0.05,
  ponticOvateDepthMm: 1.0,
  veneeringSpaceMm: 1.0,
};

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

function contextFor(scan: IndexedMesh, loop: readonly Vec3[] | null, axis: Vec3): PipelineContext {
  return {
    restorationId: 'r-die',
    restorationType: 'crown',
    materialProfile: PROFILE,
    insertionAxis: axis,
    targetMesh: { contentHash: 'scan-hash', mesh: scan },
    marginLoops: loop ? { [TOOTH]: { closed: true, resampledPoints: loop } } : {},
    neighbors: {},
    antagonist: null,
    stages: {},
  };
}

describe('runPrepDieStage', () => {
  // Coarser than the default so the open sheet stays small (the die region
  // is unchanged in kind: the drop, the shoulder, the prep).
  const arch = openArchPrepCase({ segments: 96, gingivaStepMm: 0.25 });

  it('cuts the die from the persisted form, byte-identical to the direct kernel call', () => {
    const result = runPrepDieStage(contextFor(arch.scan, arch.marginLoop, arch.insertionAxis), TOOTH, { hashMesh });
    const direct = extractPrepDie(persistedMeshForm(arch.scan), arch.marginLoop, arch.insertionAxis);
    expect(result.mesh!.positions).toEqual(direct.mesh.positions);
    expect(result.mesh!.indices).toEqual(direct.mesh.indices);
    expect(result.meshContentHash).toBe(hashMesh(direct.mesh));
    expect(result.stage).toBe('prepDie');
    expect(result.operationName).toBe(CROWN_DIE_EXTRACT_OP);
    expect(result.inputHashes).toEqual(['scan-hash']);
    expect(result.params).toMatchObject({
      tooth: TOOTH,
      scanForm: 'persisted-stl',
      keptTriangleCount: direct.keptTriangleCount,
      syntheticTriangleCount: direct.syntheticTriangleCount,
      clearanceMm: direct.clearanceMm,
      floorHeightMm: direct.floorHeightMm,
      radialSkirtMm: direct.radialSkirtMm,
      depthSkirtMm: direct.depthSkirtMm,
    });
    expect(result.die.clearanceMm).toBe(direct.clearanceMm);
    expect(direct.syntheticTriangleCount).toBeGreaterThan(0);
  });

  it('is deterministic (replay gives the identical hash)', () => {
    const ctx = contextFor(arch.scan, arch.marginLoop, arch.insertionAxis);
    expect(runPrepDieStage(ctx, TOOTH, { hashMesh }).meshContentHash).toBe(
      runPrepDieStage(ctx, TOOTH, { hashMesh }).meshContentHash,
    );
  });

  it('journals an unbounded certificate (a closed scan passed through) as null', () => {
    const frustum = closedFrustumDie();
    const result = runPrepDieStage(contextFor(frustum.die, frustum.marginLoop, [0, 0, 1]), TOOTH, { hashMesh });
    expect(result.die.clearanceMm).toBe(Infinity);
    expect(result.params['clearanceMm']).toBeNull();
    expect(result.params['floorHeightMm']).toBeNull();
    expect(result.params['syntheticTriangleCount']).toBe(0);
  });

  it('requires the margin loop of the tooth', () => {
    expect(() => runPrepDieStage(contextFor(arch.scan, null, arch.insertionAxis), TOOTH, { hashMesh })).toThrow(
      MissingMarginLoopError,
    );
  });

  it('is a crown-only stage', () => {
    const ctx = { ...contextFor(arch.scan, arch.marginLoop, arch.insertionAxis), restorationType: 'inlay' as const };
    expect(() => runPrepDieStage(ctx as PipelineContext, TOOTH, { hashMesh })).toThrow(RestorationTypeMismatchError);
  });

  it('propagates the kernel refusal, typed', () => {
    const lifted = arch.marginLoop.map((p): Vec3 => [p[0], p[1], p[2] + 0.5]);
    expect(() => runPrepDieStage(contextFor(arch.scan, lifted, arch.insertionAxis), TOOTH, { hashMesh })).toThrow(
      PrepDieRegionError,
    );
  });
});
