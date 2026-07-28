// packages/cad-pipeline/src/stages/bridgeAbutmentSurfaces.test.ts
//
// Phase 6 Task 2 — the BRIDGE abutment fit-surfaces STAGE (orchestration, not
// re-testing kernel geometry). Proves: every abutment is built against the ONE
// SHARED insertion axis; per-abutment margin fit ≤10 µm (the acceptance,
// measured with the real `marginFitGate`); the ONE multi-unit journal op shape
// (params carry the shared axis + per-abutment sub-params; outputHashes list
// every abutment); determinism (replay reproduces identical hashes); and the
// bridge guard rails fire (crown/cavity contexts rejected; incomplete bridge
// rejected).
//
// The target is a small "arch": TWO watertight cone-frustum dies (parallel,
// axis +Z) placed at x = ∓6, concatenated into one mesh — the crown stage
// test's inline frustum, doubled (a cross-package import of @dqcad/kernel TEST
// fixtures would sit outside cad-pipeline's rootDir).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import type { IndexedMesh } from '@dqcad/kernel';
import type { BridgePipelineContext, PipelineMaterialProfile } from '../pipeline/context.ts';
import { RestorationTypeMismatchError, BridgeContextIncompleteError } from '../pipeline/context.ts';
import { marginFitGate } from '../gates/index.ts';
import {
  runBridgeAbutmentSurfacesStage,
  NoAbutmentMarginsError,
  MissingClinicalParamError,
} from './bridgeAbutmentSurfaces.ts';

const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;

function sixSignedVolume(pos: Float64Array, idx: Uint32Array): number {
  let s = 0;
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    s += pos[a]! * (pos[b + 1]! * pos[c + 2]! - pos[b + 2]! * pos[c + 1]!) -
      pos[a + 1]! * (pos[b]! * pos[c + 2]! - pos[b + 2]! * pos[c]!) +
      pos[a + 2]! * (pos[b]! * pos[c + 1]! - pos[b + 1]! * pos[c]!);
  }
  return s;
}

/** One watertight cone-frustum die centred at (cx, 0). Bottom rim = margin circle. */
function buildFrustumDie(cx: number, segments = 96): IndexedMesh {
  const positions: number[] = [];
  const push = (x: number, y: number, z: number): number => { positions.push(x, y, z); return positions.length / 3 - 1; };
  const bottom: number[] = [];
  const top: number[] = [];
  for (let s = 0; s < segments; s++) { const th = (2 * Math.PI * s) / segments; bottom.push(push(cx + MARGIN_R * Math.cos(th), MARGIN_R * Math.sin(th), MARGIN_Z)); }
  for (let s = 0; s < segments; s++) { const th = (2 * Math.PI * s) / segments; top.push(push(cx + TOP_R * Math.cos(th), TOP_R * Math.sin(th), TOP_Z)); }
  const bottomCenter = push(cx, 0, MARGIN_Z);
  const topCenter = push(cx, 0, TOP_Z);
  const tris: number[] = [];
  for (let s = 0; s < segments; s++) {
    const sn = (s + 1) % segments;
    tris.push(bottom[s]!, bottom[sn]!, top[sn]!);
    tris.push(bottom[s]!, top[sn]!, top[s]!);
    tris.push(bottomCenter, bottom[sn]!, bottom[s]!);
    tris.push(topCenter, top[s]!, top[sn]!);
  }
  const pos = new Float64Array(positions);
  let idx = new Uint32Array(tris);
  if (sixSignedVolume(pos, idx) < 0) {
    const flipped: number[] = [];
    for (let t = 0; t < idx.length / 3; t++) flipped.push(idx[t * 3]!, idx[t * 3 + 2]!, idx[t * 3 + 1]!);
    idx = Uint32Array.from(flipped);
  }
  return { positions: pos, indices: idx };
}

function concat(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  const va = a.positions.length / 3;
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i]! + va;
  return { positions, indices };
}

function marginCircle(cx: number, n: number): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) { const th = (2 * Math.PI * i) / n; loop.push([cx + MARGIN_R * Math.cos(th), MARGIN_R * Math.sin(th), MARGIN_Z]); }
  return loop;
}

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia',
  version: '1.3.0',
  restorationParams: {
    cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.5,
    proximalContactPenetrationMm: 0.02, occlusalContactMm: 0,
  },
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0, occlusalMinWallThicknessMm: 0.5, maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: 0.5, onlayMinThicknessMm: 0.5, cuspCoverageMinThicknessMm: 0.7,
  marginExclusionMm: 0.2, inlayMarginExclusionMm: 1.3, onlayMarginExclusionMm: 1.8,
  frameworkMinThicknessMm: 0.5, ponticHygienicClearanceMm: 2.0, ponticRidgeLapReliefMm: 0.05, ponticOvateDepthMm: 1.0, veneeringSpaceMm: 1.0,
};

const MESIAL: FdiTooth = 14 as FdiTooth;
const PONTIC: FdiTooth = 15 as FdiTooth;
const DISTAL: FdiTooth = 16 as FdiTooth;
const CX_MESIAL = -6;
const CX_DISTAL = 6;

function makeBridgeContext(overrides?: Partial<BridgePipelineContext>): BridgePipelineContext {
  const arch = concat(buildFrustumDie(CX_MESIAL), buildFrustumDie(CX_DISTAL));
  return {
    restorationId: 'bridge-test',
    restorationType: 'bridge',
    materialProfile: PROFILE,
    insertionAxis: [0, 0, 1], // the SHARED axis (parallel dies)
    targetMesh: { contentHash: 'arch-hash-xyz', mesh: arch },
    marginLoops: {
      [MESIAL]: { closed: true, resampledPoints: marginCircle(CX_MESIAL, 480) },
      [DISTAL]: { closed: true, resampledPoints: marginCircle(CX_DISTAL, 480) },
    },
    neighbors: {},
    antagonist: null,
    stages: {},
    ponticSites: [PONTIC],
    gingivaMesh: null,
    unitAdjacency: [[MESIAL, PONTIC], [PONTIC, DISTAL]],
    ...overrides,
  };
}

describe('runBridgeAbutmentSurfacesStage — orchestration + acceptance', () => {
  it('builds BOTH abutments against the shared axis; per-abutment margin fit <=10 µm; correct multi-unit journal shape', { timeout: 180_000 }, async () => {
    const ctx = makeBridgeContext();
    const result = await runBridgeAbutmentSurfacesStage(ctx, { pitchMm: 0.06, hashMesh });

    expect(result.stage).toBe('innerSurface');
    expect(result.operationName).toBe('bridge.abutmentSurfaces');
    expect(result.abutments.map((a) => a.tooth)).toEqual([MESIAL, DISTAL]); // ascending FDI, pontic excluded
    expect(result.inputHashes).toEqual(['arch-hash-xyz']);
    expect(result.outputHashes).toEqual(result.abutments.map((a) => a.meshContentHash));
    expect(result.params['sharedInsertionAxis']).toEqual([0, 0, 1]);
    expect(result.params['marginalGapMm']).toBe(0.02);
    expect(result.params['cementGapMm']).toBe(0.05);
    expect(Array.isArray(result.params['perAbutment'])).toBe(true);
    expect((result.params['perAbutment'] as unknown[]).length).toBe(2);

    // ACCEPTANCE: per-abutment margin fit ≤10 µm, measured with the real gate.
    const fits: number[] = [];
    for (const ab of result.abutments) {
      const cx = ab.tooth === MESIAL ? CX_MESIAL : CX_DISTAL;
      const gate = marginFitGate({ innerSurfaceMesh: ab.mesh, marginResampledPoints: marginCircle(cx, 480) });
      expect(gate.passed).toBe(true);
      expect(gate.value!).toBeLessThanOrEqual(0.010);
      fits.push(gate.value!);
    }
    // The two abutments really are distinct meshes (different world positions).
    expect(result.abutments[0]!.meshContentHash).not.toBe(result.abutments[1]!.meshContentHash);

    console.log(
      `[bridge][stage] per-abutment margin fit: tooth ${MESIAL} ${(fits[0]! * 1000).toFixed(3)} µm / ` +
        `tooth ${DISTAL} ${(fits[1]! * 1000).toFixed(3)} µm (gate 10 µm) — both built against shared axis [0,0,1].`,
    );
  });

  it('is deterministic — replay reproduces identical output hashes + params', { timeout: 180_000 }, async () => {
    const a = await runBridgeAbutmentSurfacesStage(makeBridgeContext(), { pitchMm: 0.07, hashMesh });
    const b = await runBridgeAbutmentSurfacesStage(makeBridgeContext(), { pitchMm: 0.07, hashMesh });
    expect(b.outputHashes).toEqual(a.outputHashes);
    expect(b.params).toEqual(a.params);
    expect(b.errorBoundMm).toBe(a.errorBoundMm);
  });
});

describe('runBridgeAbutmentSurfacesStage — guard rails', () => {
  it('rejects a CROWN context (RestorationTypeMismatchError)', async () => {
    const crown = { ...makeBridgeContext(), restorationType: 'crown' } as unknown as BridgePipelineContext;
    await expect(runBridgeAbutmentSurfacesStage(crown, { pitchMm: 0.06, hashMesh })).rejects.toThrow(RestorationTypeMismatchError);
  });

  it('rejects a CAVITY (inlay) context (RestorationTypeMismatchError)', async () => {
    const inlay = { ...makeBridgeContext(), restorationType: 'inlay' } as unknown as BridgePipelineContext;
    await expect(runBridgeAbutmentSurfacesStage(inlay, { pitchMm: 0.06, hashMesh })).rejects.toThrow(RestorationTypeMismatchError);
  });

  it('rejects an INCOMPLETE bridge context (missing ponticSites → BridgeContextIncompleteError)', async () => {
    const ctx = makeBridgeContext();
    const incomplete = { ...ctx, ponticSites: undefined } as unknown as BridgePipelineContext;
    await expect(runBridgeAbutmentSurfacesStage(incomplete, { pitchMm: 0.06, hashMesh })).rejects.toThrow(BridgeContextIncompleteError);
  });

  it('throws NoAbutmentMarginsError when there are no abutment margins', async () => {
    const ctx = makeBridgeContext({ marginLoops: {} });
    await expect(runBridgeAbutmentSurfacesStage(ctx, { pitchMm: 0.06, hashMesh })).rejects.toThrow(NoAbutmentMarginsError);
  });

  it('throws MissingClinicalParamError when a required gap is non-finite (never defaulted)', async () => {
    const badProfile: PipelineMaterialProfile = { ...PROFILE, restorationParams: { ...PROFILE.restorationParams, cementGapMm: Number.NaN } };
    const ctx = makeBridgeContext({ materialProfile: badProfile });
    await expect(runBridgeAbutmentSurfacesStage(ctx, { pitchMm: 0.06, hashMesh })).rejects.toThrow(MissingClinicalParamError);
  });
});
