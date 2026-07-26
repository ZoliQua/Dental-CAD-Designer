// packages/cad-pipeline/src/stages/cavityShell.test.ts
//
// Tests for the CAVITY shell-construction STAGE (cavityShell.ts) —
// ORCHESTRATION, not re-testing the kernel weld (that is @dqcad/kernel's
// cavity/inlayShell.test.ts). Here we prove: the restoration-type guard rails
// fire (crown REJECTED, inlay/onlay ACCEPTED); the CavityShellStageResult shape
// + journal fields are right; ONE journaled op producing a watertight solid;
// determinism (replay = identical hash).
//
// The chain is GENUINELY coupled on the trough fixture: the fit surface (kernel
// buildCavityInnerSurface) + the occlusal patch (the Task-4 stage output) are
// the exact surfaces welded — the patch that is shelled is the patch that was
// built.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { buildCavityInnerSurface, type IndexedMesh } from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import { RestorationTypeMismatchError } from '../pipeline/context.ts';
import { troughFixture } from './cavityTrough.test-fixtures.ts';
import { runCavityOcclusalPatchStage } from './cavityOcclusalPatch.ts';
import { runCavityShellStage } from './cavityShell.ts';

const hashMesh = (mesh: IndexedMesh): string => {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
};

const TOOTH: FdiTooth = 36;
const AXIS: Vec3 = [0, 0, 1];

function makeProfile(): PipelineMaterialProfile {
  return {
    id: 'test-emax', version: '1.0.0',
    restorationParams: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.7, proximalContactPenetrationMm: 0.05, occlusalContactMm: 0 },
    connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
    undercutBlockoutThresholdMm: 0.1, occlusalMinWallThicknessMm: 1.0, maxChordDeviationMm: 0.02,
    inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.0, cuspCoverageMinThicknessMm: 1.5, marginExclusionMm: 0.2,
    inlayMarginExclusionMm: 1.3, onlayMarginExclusionMm: 1.8, frameworkMinThicknessMm: 0.5, ponticHygienicClearanceMm: 2.0, ponticRidgeLapReliefMm: 0.05, ponticOvateDepthMm: 1.0,
  };
}

interface Setup {
  ctx: PipelineContext;
  fitHandle: PipelineMeshHandle;
  patchHandle: PipelineMeshHandle;
}

async function setup(restorationType: PipelineContext['restorationType'] = 'inlay'): Promise<Setup> {
  const { mesh, outline } = troughFixture();
  const ctx: PipelineContext = {
    restorationId: 'r1',
    restorationType,
    materialProfile: makeProfile(),
    insertionAxis: AXIS,
    targetMesh: { contentHash: 'trough-hash', mesh },
    marginLoops: { [TOOTH]: { closed: true, resampledPoints: outline } },
    neighbors: {},
    antagonist: null,
    stages: {},
  };
  const cavityCtx: PipelineContext = { ...ctx, restorationType: restorationType === 'crown' ? 'inlay' : restorationType };
  const fit = await buildCavityInnerSurface(mesh, {
    marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3,
    pitchMm: 0.08, cavityOutline: outline, insertionAxis: AXIS,
  });
  const patchStage = runCavityOcclusalPatchStage(cavityCtx, TOOTH, { hashMesh });
  return {
    ctx,
    fitHandle: { contentHash: hashMesh(fit.mesh), mesh: fit.mesh },
    patchHandle: { contentHash: patchStage.meshContentHash!, mesh: patchStage.mesh! },
  };
}

function opts(s: Setup): Parameters<typeof runCavityShellStage>[2] {
  return { fitSurfaceMesh: s.fitHandle, patchMesh: s.patchHandle, hashMesh };
}

describe('runCavityShellStage', () => {
  it('REJECTS a crown context (assertCavityContext throws)', async () => {
    const s = await setup('crown');
    await expect(runCavityShellStage(s.ctx, TOOTH, opts(s))).rejects.toBeInstanceOf(RestorationTypeMismatchError);
  });

  it.each(['inlay', 'onlay'] as const)('ACCEPTS a %s context and produces ONE journaled watertight-shell op', async (rt) => {
    const s = await setup(rt);
    const res = await runCavityShellStage(s.ctx, TOOTH, opts(s));
    expect(res.stage).toBe('shell');
    expect(res.operationName).toBe('cavityShell.construct');
    expect(res.mesh).not.toBeNull();
    expect(res.meshContentHash).toBeTruthy();
    expect(res.params['watertight']).toBe(true);
    expect(res.params['componentCount']).toBe(1);
    expect(res.params['restorationType']).toBe(rt);
    expect(res.volumeMm3).toBeGreaterThan(0);
    expect(res.seamRingVertexCount).toBeGreaterThan(0);
    expect(res.inputHashes).toEqual([s.fitHandle.contentHash, s.patchHandle.contentHash]);
    expect(res.errorBoundMm).toBeNull();
  }, 60_000);

  it('is deterministic: replay reproduces the identical shell hash', async () => {
    const s = await setup('inlay');
    const a = await runCavityShellStage(s.ctx, TOOTH, opts(s));
    const b = await runCavityShellStage(s.ctx, TOOTH, opts(s));
    expect(a.meshContentHash).toBe(b.meshContentHash);
  }, 60_000);
});
