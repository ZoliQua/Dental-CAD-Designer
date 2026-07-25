// packages/cad-pipeline/src/stages/cavityOcclusalPatch.test.ts
//
// Tests for the CAVITY occlusal-patch STAGE (cavityOcclusalPatch.ts) —
// ORCHESTRATION, not re-testing the kernel geometry (that is @dqcad/kernel's
// cavity/occlusalPatch.test.ts + seamDihedral.test.ts, on the analytic MOD
// fixture + closed-form cases). Here we prove: the restoration-type guard rails
// fire (crown REJECTED, inlay/onlay ACCEPTED — the Task 1 scaffold); the
// RestorationStageResult shape + journal fields are right; ONE journaled op;
// determinism (replay = identical hash); and the seam-dihedral gate PASSES on
// the produced patch (< 5°).
//
// The target is the shared break-through TROUGH fixture (extracted to
// cavityTrough.test-fixtures.ts when Task 5's stage test needed it too — see
// that module's doc for the geometry).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { analyzeMesh, type IndexedMesh } from '@dqcad/kernel';
import { troughFixture } from './cavityTrough.test-fixtures.ts';
import type { PipelineContext, PipelineMaterialProfile } from '../pipeline/context.ts';
import { RestorationTypeMismatchError } from '../pipeline/context.ts';
import { seamDihedralGate } from '../gates/index.ts';
import { runCavityOcclusalPatchStage, CavityOcclusalPatchMissingCavityOutlineError } from './index.ts';

const hashMesh = (mesh: IndexedMesh): string => {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
};

const TOOTH: FdiTooth = 36;

function makeProfile(): PipelineMaterialProfile {
  return {
    id: 'test-emax', version: '1.0.0',
    restorationParams: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.7, proximalContactPenetrationMm: 0.05, occlusalContactMm: 0 },
    connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
    undercutBlockoutThresholdMm: 0.1, occlusalMinWallThicknessMm: 1.0, maxChordDeviationMm: 0.02,
    inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.0, cuspCoverageMinThicknessMm: 1.5, marginExclusionMm: 0.2,
  };
}

function makeContext(restorationType: PipelineContext['restorationType'], mesh: IndexedMesh, outline: Vec3[]): PipelineContext {
  return {
    restorationId: 'r1', restorationType, materialProfile: makeProfile(),
    insertionAxis: [0, 0, 1], targetMesh: { contentHash: 'trough-hash', mesh },
    marginLoops: { [TOOTH]: { closed: true, resampledPoints: outline } },
    neighbors: {}, antagonist: null, stages: {},
  };
}

const OPTS = { hashMesh };

describe('runCavityOcclusalPatchStage', () => {
  it('the trough fixture is watertight + manifold (sanity)', () => {
    const { mesh } = troughFixture();
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
  });

  it('REJECTS a crown context (assertCavityContext throws)', () => {
    const { mesh, outline } = troughFixture();
    expect(() => runCavityOcclusalPatchStage(makeContext('crown', mesh, outline), TOOTH, OPTS)).toThrow(RestorationTypeMismatchError);
  });

  it('throws MissingCavityOutlineError when the tooth has no outline in the context', () => {
    const { mesh, outline } = troughFixture();
    const ctx = makeContext('inlay', mesh, outline);
    const noOutline: PipelineContext = { ...ctx, marginLoops: {} };
    expect(() => runCavityOcclusalPatchStage(noOutline, 37 as FdiTooth, OPTS)).toThrow(CavityOcclusalPatchMissingCavityOutlineError);
  });

  it.each(['inlay', 'onlay'] as const)('ACCEPTS a %s context and produces the occlusal patch', (rt) => {
    const { mesh, outline } = troughFixture();
    const res = runCavityOcclusalPatchStage(makeContext(rt, mesh, outline), TOOTH, OPTS);
    expect(res.stage).toBe('anatomyPlacement');
    expect(res.mesh).not.toBeNull();
    expect(res.seamEdges.length).toBeGreaterThan(0);
  });

  it('result shape + ONE journaled op + errorBoundMm=0; seam dihedral gate PASSES (<5°); replay = identical hash', () => {
    const { mesh, outline } = troughFixture();
    const ctx = makeContext('inlay', mesh, outline);
    const res = runCavityOcclusalPatchStage(ctx, TOOTH, OPTS);

    expect(res.operationName).toBe('cavityOcclusalPatch.build');
    expect(res.meshContentHash).toBe(hashMesh(res.mesh!));
    expect(res.inputHashes).toEqual(['trough-hash']);
    expect(res.errorBoundMm).toBe(0);
    expect(res.params.restorationType).toBe('inlay');
    expect(typeof res.params.seamDihedralMaxDeg).toBe('number');
    expect(res.params.seamDihedralMaxDeg as number).toBeLessThan(5);

    // the seam-dihedral gate passes on the produced patch
    const gate = seamDihedralGate({
      patchMesh: res.mesh!,
      toothMesh: mesh,
      seamEdges: res.seamEdges,
      cavityTriangleIndices: res.cavityTriangleIndices,
    });
    expect(gate.passed).toBe(true);
    expect(gate.value).toBeLessThan(5);

    // determinism (replay)
    const res2 = runCavityOcclusalPatchStage(makeContext('inlay', mesh, outline), TOOTH, OPTS);
    expect(res2.meshContentHash).toBe(res.meshContentHash);
  });
});
