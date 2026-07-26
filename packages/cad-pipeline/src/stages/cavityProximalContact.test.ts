// packages/cad-pipeline/src/stages/cavityProximalContact.test.ts
//
// Phase 5 Task 5 — the CAVITY PROXIMAL-CONTACT stage (cavityProximalContact.ts):
// ORCHESTRATION tests, not re-testing the kernel adaptation geometry (that is
// @dqcad/kernel's cavity/proximalContact.test.ts on the analytic MOD fixture).
// Here: the restoration-type guard rails fire; the clinical target comes from
// the CONTEXT profile (asserted loudly when absent); the FDI neighbours pair to
// the patch's proximal faces GEOMETRICALLY (ambiguity is a typed error); the
// journal fields are right (ONE op, residuals + seam before/after + clamp
// warning REPORTED); determinism (replay = identical hash). The patch is the
// GENUINE Task-4 stage output on the shared trough fixture (coupled chain).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import type { IndexedMesh } from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import { RestorationTypeMismatchError } from '../pipeline/context.ts';
import { troughFixture, outwardBox, TROUGH_HALF_LENGTH_MM } from './cavityTrough.test-fixtures.ts';
import { runCavityOcclusalPatchStage, type CavityOcclusalPatchStageResult } from './cavityOcclusalPatch.ts';
import {
  runCavityProximalContactStage,
  AmbiguousProximalPairingError,
  CavityProximalContactMissingClinicalParamError,
  type CavityProximalContactBoxParams,
} from './cavityProximalContact.ts';
import { InsufficientNeighborsError } from './anatomyPlacement.ts';

const hashMesh = (mesh: IndexedMesh): string => {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
};

const TOOTH: FdiTooth = 36;
const MESIAL_FDI = 35 as FdiTooth; // toward the midline of quadrant 3
const DISTAL_FDI = 37 as FdiTooth;
const PEN = 0.05; // the test profile's proximalContactPenetrationMm

function makeProfile(proximalContactPenetrationMm = PEN): PipelineMaterialProfile {
  return {
    id: 'test-emax', version: '1.0.0',
    restorationParams: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.7, proximalContactPenetrationMm, occlusalContactMm: 0 },
    connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
    undercutBlockoutThresholdMm: 0.1, occlusalMinWallThicknessMm: 1.0, maxChordDeviationMm: 0.02,
    inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.0, cuspCoverageMinThicknessMm: 1.5, marginExclusionMm: 0.2,
  };
}

/** Synthetic neighbours at gap g from the trough's proximal planes x=±4 —
 * mesial FDI 35 on −x, distal FDI 37 on +x (the P4 T6 pattern). */
function neighborHandles(gapMm: number): { mesial: PipelineMeshHandle; distal: PipelineMeshHandle } {
  const L = TROUGH_HALF_LENGTH_MM;
  const mesialMesh = outwardBox([-L - gapMm - 2, -5, -1], [-L - gapMm, 5, 6]);
  const distalMesh = outwardBox([L + gapMm, -5, -1], [L + gapMm + 2, 5, 6]);
  return {
    mesial: { contentHash: hashMesh(mesialMesh), mesh: mesialMesh },
    distal: { contentHash: hashMesh(distalMesh), mesh: distalMesh },
  };
}

interface Setup {
  ctx: PipelineContext;
  patchStage: CavityOcclusalPatchStageResult;
  patchHandle: PipelineMeshHandle;
}

function setup(opts: {
  restorationType?: PipelineContext['restorationType'];
  gapMm?: number;
  profile?: PipelineMaterialProfile;
  neighbors?: PipelineContext['neighbors'];
} = {}): Setup {
  const { mesh, outline } = troughFixture();
  const nb = neighborHandles(opts.gapMm ?? 0.5);
  const ctx: PipelineContext = {
    restorationId: 'r1',
    restorationType: opts.restorationType ?? 'inlay',
    materialProfile: opts.profile ?? makeProfile(),
    insertionAxis: [0, 0, 1],
    targetMesh: { contentHash: 'trough-hash', mesh },
    marginLoops: { [TOOTH]: { closed: true, resampledPoints: outline } },
    neighbors: opts.neighbors ?? { [MESIAL_FDI]: nb.mesial, [DISTAL_FDI]: nb.distal },
    antagonist: null,
    stages: {},
  };
  // GENUINE coupling: the patch this stage adapts is the Task-4 stage output.
  const cavityCtx: PipelineContext = { ...ctx, restorationType: ctx.restorationType === 'crown' ? 'inlay' : ctx.restorationType };
  const patchStage = runCavityOcclusalPatchStage(cavityCtx, TOOTH, { hashMesh });
  const patchHandle: PipelineMeshHandle = { contentHash: patchStage.meshContentHash!, mesh: patchStage.mesh! };
  return { ctx, patchStage, patchHandle };
}

function stageOptions(s: Setup): Parameters<typeof runCavityProximalContactStage>[2] {
  return {
    patchMesh: s.patchHandle,
    proximalFaces: s.patchStage.proximalFaces,
    seamEdges: s.patchStage.seamEdges,
    cavityTriangleIndices: s.patchStage.cavityTriangleIndices,
    hashMesh,
  };
}

describe('runCavityProximalContactStage', () => {
  it('REJECTS a crown context (assertCavityContext throws)', () => {
    const s = setup({ restorationType: 'crown' });
    expect(() => runCavityProximalContactStage(s.ctx, TOOTH, stageOptions(s))).toThrow(RestorationTypeMismatchError);
  });

  it('throws InsufficientNeighborsError without exactly two neighbours', () => {
    const s = setup({ neighbors: {} });
    expect(() => runCavityProximalContactStage(s.ctx, TOOTH, stageOptions(s))).toThrow(InsufficientNeighborsError);
  });

  it('asserts the clinical target loudly (profile via context ONLY)', () => {
    const s = setup({ profile: makeProfile(Number.NaN) });
    expect(() => runCavityProximalContactStage(s.ctx, TOOTH, stageOptions(s))).toThrow(CavityProximalContactMissingClinicalParamError);
  });

  it('throws AmbiguousProximalPairingError when both neighbours sit on the SAME side', () => {
    const s = setup();
    const L = TROUGH_HALF_LENGTH_MM;
    const a = outwardBox([-L - 2.5, -5, -1], [-L - 0.5, 5, 6]); // −x, gap 0.5
    const b = outwardBox([-L - 4.0, -5, -1], [-L - 2.0, 5, 6]); // −x, farther
    const ctx: PipelineContext = {
      ...s.ctx,
      neighbors: { [MESIAL_FDI]: { contentHash: hashMesh(a), mesh: a }, [DISTAL_FDI]: { contentHash: hashMesh(b), mesh: b } },
    };
    expect(() => runCavityProximalContactStage(ctx, TOOTH, stageOptions(s))).toThrow(AmbiguousProximalPairingError);
  });

  it.each(['inlay', 'onlay'] as const)('ACCEPTS a %s context and adapts both boxes to target (residuals + seam before/after REPORTED in params)', (rt) => {
    const s = setup({ restorationType: rt });
    const res = runCavityProximalContactStage(s.ctx, TOOTH, stageOptions(s));

    expect(res.stage).toBe('morphing');
    expect(res.operationName).toBe('cavityProximalContact.adapt');
    expect(res.mesh).not.toBeNull();
    expect(res.meshContentHash).toBe(hashMesh(res.mesh!));
    expect(res.meshContentHash).not.toBe(s.patchHandle.contentHash); // a NEW mesh (adapted)
    expect(res.inputHashes).toEqual([
      s.patchHandle.contentHash,
      s.ctx.neighbors[MESIAL_FDI]!.contentHash,
      s.ctx.neighbors[DISTAL_FDI]!.contentHash,
    ]);

    // journal: per-box measured evidence, FDI-paired
    const boxes = res.params['boxes'] as CavityProximalContactBoxParams[];
    expect(boxes.map((b) => b.side)).toEqual(['mesial', 'distal']);
    expect(boxes.map((b) => b.neighborFdi)).toEqual([MESIAL_FDI, DISTAL_FDI]);
    for (const b of boxes) {
      expect(b.targetPenetrationMm).toBe(PEN);
      // closed-form: gap 0.5, planar neighbour → residual ≈ 0
      expect(b.contactResidualMm).toBeLessThan(1e-9);
      expect(Math.abs(b.achievedSignedDistanceMm - -PEN)).toBeLessThan(1e-9);
      expect(b.clampBound).toBe(false);
    }
    expect(res.params['contactClampWarning']).toBe(false);
    expect(res.params['proximalContactPenetrationMm']).toBe(PEN);
    expect(res.errorBoundMm).not.toBeNull();
    expect(res.errorBoundMm!).toBeLessThan(1e-9);

    // seam before/after both measured and < 5° (re-measured AFTER adaptation)
    expect(res.seamDihedralMaxBeforeDeg).toBeLessThan(5);
    expect(res.seamDihedralMaxAfterDeg).toBeLessThan(5);
    expect(res.params['seamDihedralMaxBeforeDeg']).toBe(res.seamDihedralMaxBeforeDeg);
    expect(res.params['seamDihedralMaxAfterDeg']).toBe(res.seamDihedralMaxAfterDeg);

    // outline preserved: every outline point is still a bit-exact vertex
    const coords = new Set<string>();
    const m = res.mesh!;
    for (let v = 0; v < m.positions.length / 3; v++) coords.add(`${m.positions[v * 3]}|${m.positions[v * 3 + 1]}|${m.positions[v * 3 + 2]}`);
    const outline = (s.ctx.marginLoops[TOOTH]!.resampledPoints as readonly Vec3[]);
    for (const p of outline) expect(coords.has(`${p[0]}|${p[1]}|${p[2]}`)).toBe(true);
  });

  it('surfaces the clamp warning when the target is unreachable (neighbours too far) — never a silent success', () => {
    const s = setup({ gapMm: 3 }); // needs travel 3.05 > 1.5 default cap
    const res = runCavityProximalContactStage(s.ctx, TOOTH, stageOptions(s));
    const boxes = res.params['boxes'] as CavityProximalContactBoxParams[];
    for (const b of boxes) {
      expect(b.clampBound).toBe(true);
      expect(b.contactResidualMm).toBeGreaterThan(1); // honestly large
    }
    expect(res.params['contactClampWarning']).toBe(true);
    expect(res.params['clampedBoxes']).toEqual(['mesial', 'distal']);
    expect(res.errorBoundMm!).toBeGreaterThan(1);
  });

  it('determinism: replay produces an identical mesh hash and identical journal residuals', () => {
    const a = setup();
    const b = setup();
    const ra = runCavityProximalContactStage(a.ctx, TOOTH, stageOptions(a));
    const rb = runCavityProximalContactStage(b.ctx, TOOTH, stageOptions(b));
    expect(ra.meshContentHash).toBe(rb.meshContentHash);
    expect(JSON.stringify(ra.params['boxes'])).toBe(JSON.stringify(rb.params['boxes']));
  });
});
