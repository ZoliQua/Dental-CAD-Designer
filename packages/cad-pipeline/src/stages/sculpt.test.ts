// packages/cad-pipeline/src/stages/sculpt.test.ts
//
// Tests for the freeform SCULPTING STAGE (sculpt.ts) — orchestration, not
// re-testing the kernel brush math (that is @dqcad/kernel's sculpt.test.ts).
// Proves: a gesture reaches the kernel and sculpts the outer while the fit
// surface stays locked; the RestorationStageResult shape (mesh, injected hash,
// operationName, coalesced-gesture journal params, inputHashes) is right; the
// stage is deterministic (journal-replay = identical hash); the ≤10 µm margin
// fit is preserved after sculpting (re-measured, incl. measureMarginFit on the
// inner); unlock is explicit + journaled; and the guards fire.
import { createHash } from 'node:crypto';
import { describe, expect, it, beforeAll } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import {
  analyzeMesh,
  buildInnerSurface,
  constructShell,
  type IndexedMesh,
  type SculptStroke,
} from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import { measureMarginFit } from '../gates/marginFit.ts';
import { runSculptStage, MissingMarginLoopError, EmptySculptGestureError } from './sculpt.ts';

const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;
const AXIS: Vec3 = [0, 0, 1];
const TOOTH = 11 as FdiTooth;

function buildFrustum(mR: number, tR: number, mZ: number, tZ: number, seg: number, vLevels: number, capTop: boolean, capBot: boolean): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    P.push(x, y, z);
    return P.length / 3 - 1;
  };
  const rings: number[][] = [];
  for (let l = 0; l <= vLevels; l++) {
    const f = l / vLevels;
    const r = mR + (tR - mR) * f;
    const z = mZ + (tZ - mZ) * f;
    const ring: number[] = [];
    for (let s = 0; s < seg; s++) {
      const th = (2 * Math.PI * s) / seg;
      ring.push(push(r * Math.cos(th), r * Math.sin(th), z));
    }
    rings.push(ring);
  }
  const tr: number[] = [];
  for (let l = 0; l < vLevels; l++) {
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(rings[l]![s]!, rings[l]![sn]!, rings[l + 1]![sn]!);
      tr.push(rings[l]![s]!, rings[l + 1]![sn]!, rings[l + 1]![s]!);
    }
  }
  if (capBot) {
    const bc = push(0, 0, mZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(bc, rings[0]![sn]!, rings[0]![s]!);
    }
  }
  if (capTop) {
    const tc = push(0, 0, tZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(tc, rings[vLevels]![s]!, rings[vLevels]![sn]!);
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
};

let INNER: IndexedMesh;
let SHELL: IndexedMesh;

async function setup(): Promise<void> {
  if (SHELL) return;
  const die = buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, 1, true, true);
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
  const outer = buildFrustum(MARGIN_R + 0.7, TOP_R + 0.7, MARGIN_Z, TOP_Z + 0.7, 96, 8, true, false);
  SHELL = (await constructShell(outer, INNER, { insertionAxis: AXIS })).mesh;
}

function makeContext(): PipelineContext {
  return {
    restorationId: 'r-sculpt',
    materialProfile: PROFILE,
    insertionAxis: AXIS,
    targetMesh: handle('die', buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, 1, true, true)),
    marginLoops: { [TOOTH]: marginCircle(MARGIN_R, MARGIN_Z, 240) },
    neighbors: {},
    antagonist: null,
    stages: { innerSurface: 'inner-11', morphState: 'morph-11', finalMesh: 'shell-11' },
  };
}

const GESTURE: SculptStroke[] = [
  { center: [0, 0, TOP_Z + 0.7], radiusMm: 1.2, strength: 0.2, brush: 'add' },
  { center: [TOP_R + 0.7, 0, TOP_Z], radiusMm: 1.0, strength: 0.15, brush: 'remove' },
  { center: [0, 0, TOP_Z + 0.7], radiusMm: 1.5, strength: 1, brush: 'smooth' },
];

describe('runSculptStage — orchestration', () => {
  beforeAll(async () => {
    await setup();
  }, 180000);

  it('sculpts the outer, returns a journalable freeform result, fit surface locked', () => {
    const ctx = makeContext();
    const res = runSculptStage(ctx, TOOTH, {
      shellMesh: handle('shell', SHELL),
      innerSurfaceMesh: handle('inner', INNER),
      strokes: GESTURE,
      hashMesh,
    });
    expect(res.stage).toBe('freeform');
    expect(res.operationName).toBe('freeform.sculpt');
    expect(res.mesh).not.toBeNull();
    expect(res.meshContentHash).toBe(hashMesh(res.mesh!));
    expect(res.inputHashes).toEqual(['shell', 'inner']);
    // coalesced gesture journaled
    expect((res.params.strokes as unknown[]).length).toBe(3);
    expect(res.params.strokeCount).toBe(3);
    expect(res.params.unlockFitSurface).toBe(false);
    expect(res.params.lockedVertexCount as number).toBeGreaterThan(0);
    expect(res.params.sculptableVertexCount as number).toBeGreaterThan(0);
    expect(res.params.movedVertexCount as number).toBeGreaterThan(0);
    // watertight + margin fit preserved
    expect(res.params.shellWatertight).toBe(true);
    expect(res.params.shellComponentCount).toBe(1);
    expect(res.params.marginFitMaxMm as number).toBeLessThanOrEqual(0.01);
    expect(res.params.innerMarginFitMm as number).toBeLessThanOrEqual(0.01);
    const stats = analyzeMesh(res.mesh!);
    expect(stats.watertight).toBe(true);
    console.log(
      `[stage] locked ${res.params.lockedVertexCount}, sculpted ${res.params.movedVertexCount}; margin fit shell ${((res.params.marginFitMaxMm as number) * 1000).toFixed(2)} µm, inner ${((res.params.innerMarginFitMm as number) * 1000).toFixed(2)} µm`,
    );
  });

  it('is deterministic — journal-replay reproduces the identical hash', () => {
    const ctx = makeContext();
    const opts = { shellMesh: handle('shell', SHELL), innerSurfaceMesh: handle('inner', INNER), strokes: GESTURE, hashMesh };
    const a = runSculptStage(ctx, TOOTH, opts);
    const b = runSculptStage(ctx, TOOTH, opts);
    expect(a.meshContentHash).toBe(b.meshContentHash);
    // Replay from the journaled params.strokes (rebuilt as a fresh gesture).
    const replayStrokes = (a.params.strokes as { center: Vec3; radiusMm: number; strength: number; brush: SculptStroke['brush'] }[]).map(
      (s) => ({ center: s.center, radiusMm: s.radiusMm, strength: s.strength, brush: s.brush }),
    );
    const replay = runSculptStage(ctx, TOOTH, { ...opts, strokes: replayStrokes });
    expect(replay.meshContentHash).toBe(a.meshContentHash);
  });

  it('the margin fit is preserved after a stroke NEAR the margin (measureMarginFit ≤10 µm)', () => {
    const ctx = makeContext();
    const nearMargin: SculptStroke[] = [{ center: [MARGIN_R + 0.7, 0, MARGIN_Z], radiusMm: 1.0, strength: 0.4, brush: 'add' }];
    const res = runSculptStage(ctx, TOOTH, {
      shellMesh: handle('shell', SHELL),
      innerSurfaceMesh: handle('inner', INNER),
      strokes: nearMargin,
      hashMesh,
    });
    expect(res.params.marginFitMaxMm as number).toBeLessThanOrEqual(0.01);
    // measureMarginFit on the untouched inner surface (the locked fit surface).
    const inner = measureMarginFit(INNER, marginCircle(MARGIN_R, MARGIN_Z, 240).resampledPoints);
    expect(inner.maxMm).toBeLessThanOrEqual(0.01);
    console.log(`[stage] near-margin sculpt: shell margin fit ${((res.params.marginFitMaxMm as number) * 1000).toFixed(2)} µm, measureMarginFit(inner) ${(inner.maxMm * 1000).toFixed(2)} µm (≤10 µm)`);
  });

  it('unlockFitSurface is explicit + journaled (nothing locked)', () => {
    const ctx = makeContext();
    const res = runSculptStage(ctx, TOOTH, {
      shellMesh: handle('shell', SHELL),
      innerSurfaceMesh: handle('inner', INNER),
      strokes: [{ center: [0, 0, TOP_Z + 0.7], radiusMm: 1.0, strength: 0.05, brush: 'add' }],
      unlockFitSurface: true,
      hashMesh,
    });
    expect(res.params.unlockFitSurface).toBe(true);
    expect(res.params.lockedVertexCount).toBe(0);
  });

  it('guards: missing margin loop + empty gesture', () => {
    const ctx = makeContext();
    const noMargin: PipelineContext = { ...ctx, marginLoops: {} };
    expect(() =>
      runSculptStage(noMargin, TOOTH, { shellMesh: handle('shell', SHELL), innerSurfaceMesh: handle('inner', INNER), strokes: GESTURE, hashMesh }),
    ).toThrow(MissingMarginLoopError);
    expect(() =>
      runSculptStage(ctx, TOOTH, { shellMesh: handle('shell', SHELL), innerSurfaceMesh: handle('inner', INNER), strokes: [], hashMesh }),
    ).toThrow(EmptySculptGestureError);
  });
});
