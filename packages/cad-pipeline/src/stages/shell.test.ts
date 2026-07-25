// packages/cad-pipeline/src/stages/shell.test.ts
//
// Tests for the shell-construction STAGE (shell.ts) — orchestration, not
// re-testing the kernel geometry (that is @dqcad/kernel's shell.test.ts).
// Proves: the outer + inner reach the kernel and produce a watertight shell;
// the RestorationStageResult shape (mesh, injected hash, operationName,
// journal params incl. thickness + seam counts, inputHashes, errorBound) is
// right; the stage is deterministic (journal-replay = identical hash);
// auto-thicken is off by default, user-invoked + journaled when on; and the
// margin / clinical-param guards fire.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { analyzeMesh, buildInnerSurface, type IndexedMesh } from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import { runShellStage, MissingMarginLoopError, MissingClinicalParamError } from './shell.ts';

const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;
const AXIS: Vec3 = [0, 0, 1];
const TOOTH = 11 as FdiTooth;

function buildFrustum(mR: number, tR: number, mZ: number, tZ: number, seg: number, capTop: boolean, capBot: boolean): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    P.push(x, y, z);
    return P.length / 3 - 1;
  };
  const b: number[] = [];
  const t: number[] = [];
  for (let s = 0; s < seg; s++) {
    const th = (2 * Math.PI * s) / seg;
    b.push(push(mR * Math.cos(th), mR * Math.sin(th), mZ));
  }
  for (let s = 0; s < seg; s++) {
    const th = (2 * Math.PI * s) / seg;
    t.push(push(tR * Math.cos(th), tR * Math.sin(th), tZ));
  }
  const tr: number[] = [];
  for (let s = 0; s < seg; s++) {
    const sn = (s + 1) % seg;
    tr.push(b[s]!, b[sn]!, t[sn]!);
    tr.push(b[s]!, t[sn]!, t[s]!);
  }
  if (capBot) {
    const bc = push(0, 0, mZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(bc, b[sn]!, b[s]!);
    }
  }
  if (capTop) {
    const tc = push(0, 0, tZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(tc, t[s]!, t[sn]!);
    }
  }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tr) };
}

function marginCircle(r: number, z: number, n: number): { closed: true; resampledPoints: Vec3[] } {
  const resampledPoints: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    resampledPoints.push([r * Math.cos(th), r * Math.sin(th), z]);
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
};

const outerDome = (out: number): IndexedMesh => buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + out, 96, true, false);
const thinAxialDome = (out: number): IndexedMesh => buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + 0.9, 96, true, false);
/** The CLOSED library tooth (both caps) — the topology the Task-6 morph outputs. */
const closedTooth = (out: number): IndexedMesh => buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + out, 96, true, true);

let INNER: IndexedMesh;
async function intaglio(): Promise<IndexedMesh> {
  if (!INNER) {
    const die = buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, true, true);
    INNER = (
      await buildInnerSurface(die, {
        pitchMm: 0.08,
        marginalGapMm: 0.02,
        cementGapMm: 0.05,
        spacerStartMm: 0.8,
        blendWidthMm: 0.3,
        marginLoop: marginCircle(MARGIN_R, MARGIN_Z, 240).resampledPoints,
        insertionAxis: AXIS,
      })
    ).mesh;
  }
  return INNER;
}

function makeContext(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    restorationId: 'r-shell',
    restorationType: 'crown',
    materialProfile: PROFILE,
    insertionAxis: AXIS,
    targetMesh: handle('die', buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, true, true)),
    marginLoops: { [TOOTH]: marginCircle(MARGIN_R, MARGIN_Z, 240) },
    neighbors: {},
    antagonist: null,
    stages: { innerSurface: 'inner-11', morphState: 'morph-11' },
    ...overrides,
  };
}

describe('runShellStage — orchestration', () => {
  it('builds a watertight shell from the CLOSED morphed tooth; returns a journalable result', async () => {
    const inner = await intaglio();
    const ctx = makeContext();
    // The pipeline input: a CLOSED library-tooth solid (Task-6 morph topology).
    const result = await runShellStage(ctx, TOOTH, {
      outerAnatomyMesh: handle('morph-11', closedTooth(1.0)),
      innerSurfaceMesh: handle('inner-11', inner),
      hashMesh,
    });

    expect(result.stage).toBe('shell');
    expect(result.mesh).not.toBeNull();
    expect(result.meshContentHash).toBe(hashMesh(result.mesh!));
    expect(result.operationName).toBe('shell.construct');
    expect(result.inputHashes).toEqual(['morph-11', 'inner-11']);
    expect(analyzeMesh(result.mesh!).watertight).toBe(true);
    expect(analyzeMesh(result.mesh!).componentCount).toBe(1);

    // Journaled facts.
    expect(result.params['tooth']).toBe(TOOTH);
    expect(result.params['seamTriangleCount']).toBeGreaterThan(0);
    expect(result.params['autoThickenApplied']).toBe(false);
    expect(result.params['minWallThicknessMm'] as number).toBeGreaterThan(0.5);
    expect(result.errorBoundMm).not.toBeNull();
  }, 120000);

  it('Task 12b: the morph→shell HEAL (healOuterPitchMm) runs, journals its params, and stays deterministic', async () => {
    const inner = await intaglio();
    const ctx = makeContext();
    const outer = handle('morph-11', closedTooth(1.0));
    const opts = { outerAnatomyMesh: outer, innerSurfaceMesh: handle('inner-11', inner), healOuterPitchMm: 0.1, hashMesh } as const;
    const healed = await runShellStage(ctx, TOOTH, opts);

    // The heal ran + journaled its params (surfaced @errorBound = pitch/2).
    expect(healed.params['healOuterApplied']).toBe(true);
    expect(healed.params['healOuterPitchMm']).toBe(0.1);
    expect(healed.params['healOuterErrorBoundMm'] as number).toBeGreaterThan(0.05 - 1e-9);
    expect(healed.params['healOuterErrorBoundMm'] as number).toBeLessThan(0.1);
    expect(healed.params['healOuterTriangleCountAfter'] as number).toBeGreaterThan(0);
    // Still a watertight, single-component crown.
    expect(analyzeMesh(healed.mesh!).watertight).toBe(true);
    expect(analyzeMesh(healed.mesh!).componentCount).toBe(1);
    // Deterministic through the heal.
    const again = await runShellStage(ctx, TOOTH, opts);
    expect(again.meshContentHash).toBe(healed.meshContentHash);

    // WITHOUT the heal, healOuterApplied is false (no heal params journaled).
    const noHeal = await runShellStage(ctx, TOOTH, { outerAnatomyMesh: outer, innerSurfaceMesh: handle('inner-11', inner), hashMesh });
    expect(noHeal.params['healOuterApplied']).toBe(false);
    expect(noHeal.params['healOuterPitchMm']).toBeUndefined();
  }, 120000);

  it('is deterministic (journal replay -> identical hash, same manifold-3d version)', async () => {
    const inner = await intaglio();
    const ctx = makeContext();
    const opts = { outerAnatomyMesh: handle('morph-11', outerDome(0.7)), innerSurfaceMesh: handle('inner-11', inner), hashMesh };
    const a = await runShellStage(ctx, TOOTH, opts);
    const b = await runShellStage(ctx, TOOTH, opts);
    expect(a.meshContentHash).toBe(b.meshContentHash);
  }, 120000);

  it('auto-thicken is OFF by default (no outer mutation, no thicken params journaled)', async () => {
    const inner = await intaglio();
    const ctx = makeContext();
    const result = await runShellStage(ctx, TOOTH, {
      outerAnatomyMesh: handle('morph-11', thinAxialDome(0.3)),
      innerSurfaceMesh: handle('inner-11', inner),
      hashMesh,
    });
    expect(result.params['autoThickenApplied']).toBe(false);
    expect(result.params['autoThickenDisplacedVertexCount']).toBeUndefined();
    // Thin design is still CONSTRUCTED (the gate blocks export, not this stage).
    expect((result.params['minWallThicknessMm'] as number)).toBeLessThan(0.5);
  }, 120000);

  it('auto-thicken (user-invoked) raises the wall + journals the mutation', async () => {
    const inner = await intaglio();
    const ctx = makeContext();
    const thin = thinAxialDome(0.3);
    const plain = await runShellStage(ctx, TOOTH, { outerAnatomyMesh: handle('morph-11', thin), innerSurfaceMesh: handle('inner-11', inner), hashMesh });
    const thickened = await runShellStage(ctx, TOOTH, {
      outerAnatomyMesh: handle('morph-11', thin),
      innerSurfaceMesh: handle('inner-11', inner),
      hashMesh,
      autoThicken: true,
      autoThickenMaxDisplacementMm: 1.0,
    });
    expect(thickened.params['autoThickenApplied']).toBe(true);
    expect(thickened.params['autoThickenDisplacedVertexCount'] as number).toBeGreaterThan(0);
    expect(thickened.params['autoThickenTargetMinThicknessMm']).toBe(0.5);
    // Thickened wall > the un-thickened wall (the mutation did something).
    expect(thickened.params['minWallThicknessMm'] as number).toBeGreaterThan(plain.params['minWallThicknessMm'] as number);
    expect(analyzeMesh(thickened.mesh!).watertight).toBe(true);
  }, 120000);

  it('throws when auto-thicken is requested without a displacement bound (never defaults)', async () => {
    const inner = await intaglio();
    const ctx = makeContext();
    await expect(
      runShellStage(ctx, TOOTH, {
        outerAnatomyMesh: handle('morph-11', thinAxialDome(0.3)),
        innerSurfaceMesh: handle('inner-11', inner),
        hashMesh,
        autoThicken: true,
      }),
    ).rejects.toBeInstanceOf(MissingClinicalParamError);
  }, 120000);

  it('throws when the tooth has no margin loop', async () => {
    const inner = await intaglio();
    const ctx = makeContext({ marginLoops: {} });
    await expect(
      runShellStage(ctx, TOOTH, { outerAnatomyMesh: handle('morph-11', outerDome(0.7)), innerSurfaceMesh: handle('inner-11', inner), hashMesh }),
    ).rejects.toBeInstanceOf(MissingMarginLoopError);
  }, 120000);
});
