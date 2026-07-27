// packages/cad-pipeline/src/stages/bridgeFramework.test.ts
//
// Phase 6 Task 5 — the bridge framework/full-contour stage: the mode-switched
// cutback orchestration, the journaled mode decision, the byte-identical
// full-contour pass-through, and the fit/margin preservation carried through the
// stage.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { analyzeMesh, type IndexedMesh } from '@dqcad/kernel';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import type { BridgePipelineContext, PipelineMaterialProfile } from '../pipeline/context.ts';
import { RestorationTypeMismatchError } from '../pipeline/context.ts';
import {
  runBridgeFrameworkStage,
  MissingVeneeringSpaceError,
  NoFrameworkUnitsError,
  type FrameworkUnitInput,
} from './bridgeFramework.ts';

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

// A compact closed HEX-PRISM "unit": bottom cap (fit + margin, preserved), side
// walls + top cap (outer, cut back). Inline (not a ported kernel construction) —
// the cutback accuracy is proven in the kernel test; this exercises the stage's
// orchestration on a real closed solid.
function hexPrismUnit(tooth: FdiTooth): FrameworkUnitInput {
  const n = 6;
  const R = 2.0;
  const H = 3.0;
  const P: number[] = [];
  const fit: boolean[] = [];
  const push = (x: number, y: number, z: number, isFit: boolean): number => {
    P.push(x, y, z);
    fit.push(isFit);
    return P.length / 3 - 1;
  };
  const bottom: number[] = [];
  const top: number[] = [];
  for (let s = 0; s < n; s++) {
    const th = (2 * Math.PI * s) / n;
    bottom.push(push(R * Math.cos(th), R * Math.sin(th), 0, true)); // margin/fit ring
  }
  for (let s = 0; s < n; s++) {
    const th = (2 * Math.PI * s) / n;
    top.push(push(R * Math.cos(th), R * Math.sin(th), H, false)); // outer
  }
  const bc = push(0, 0, 0, true); // bottom cap centre — fit
  const tc = push(0, 0, H, false); // top cap centre — outer
  const tris: number[] = [];
  for (let s = 0; s < n; s++) {
    const sn = (s + 1) % n;
    // wall
    tris.push(bottom[s]!, bottom[sn]!, top[sn]!, bottom[s]!, top[sn]!, top[s]!);
    // bottom cap
    tris.push(bc, bottom[sn]!, bottom[s]!);
    // top cap
    tris.push(tc, top[s]!, top[sn]!);
  }
  const mesh: IndexedMesh = { positions: new Float64Array(P), indices: Uint32Array.from(tris) };
  const marginLoop: Vec3[] = bottom.map((vi) => [P[vi * 3]!, P[vi * 3 + 1]!, P[vi * 3 + 2]!] as Vec3);
  return { tooth, mesh, meshContentHash: hashMesh(mesh), fitVertexMask: fit, marginLoop };
}

const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia',
  version: '1.4.0',
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

const A: FdiTooth = 14 as FdiTooth;
const B: FdiTooth = 16 as FdiTooth;

function makeBridgeContext(overrides?: Partial<BridgePipelineContext>): BridgePipelineContext {
  return {
    restorationId: 'bridge-framework-test',
    restorationType: 'bridge',
    materialProfile: PROFILE,
    insertionAxis: [0, 0, 1],
    targetMesh: { contentHash: 'arch-hash', mesh: { positions: new Float64Array(9), indices: new Uint32Array([0, 1, 2]) } },
    marginLoops: {},
    neighbors: {},
    antagonist: null,
    stages: {},
    ponticSites: [15 as FdiTooth],
    gingivaMesh: null,
    unitAdjacency: [],
    ...overrides,
  };
}

describe('runBridgeFrameworkStage — framework mode', () => {
  it('cuts back each unit outward anatomy, journals mode + veneering space, and PRESERVES fit + margin byte-exact', () => {
    const ctx = makeBridgeContext();
    const units = [hexPrismUnit(A), hexPrismUnit(B)];
    const res = runBridgeFrameworkStage(ctx, { mode: 'framework', units, hashMesh });

    expect(res.mode).toBe('framework');
    expect(res.operationName).toBe('bridge.framework');
    expect(res.params['mode']).toBe('framework');
    expect(res.params['veneeringSpaceMm']).toBe(1.0); // resolved from the profile
    expect(res.params['marginTaperBandMm']).toBe(0.2); // defaulted from marginExclusionMm

    for (let ui = 0; ui < units.length; ui++) {
      const u = units[ui]!;
      const r = res.units[ui]!;
      // Outer verts moved (mesh changed → hash moved).
      expect(r.meshContentHash).not.toBe(u.meshContentHash);
      expect(res.outputHashes[ui]).not.toBe(res.inputHashes[ui]);
      expect(r.maxAppliedCutbackMm).toBeCloseTo(1.0, 9);
      expect(r.meanFullWeightCutbackMm).toBeCloseTo(1.0, 9);
      // FIT + margin vertices byte-identical.
      for (let i = 0; i < u.fitVertexMask.length; i++) {
        if (!u.fitVertexMask[i]) continue;
        expect(r.mesh.positions[i * 3]).toBe(u.mesh.positions[i * 3]);
        expect(r.mesh.positions[i * 3 + 1]).toBe(u.mesh.positions[i * 3 + 1]);
        expect(r.mesh.positions[i * 3 + 2]).toBe(u.mesh.positions[i * 3 + 2]);
      }
      // Still a valid closed 2-manifold.
      const stats = analyzeMesh(r.mesh);
      expect(stats.watertight).toBe(true);
    }
  });

  it('is deterministic (byte-identical hashes across runs)', () => {
    const ctx = makeBridgeContext();
    const a = runBridgeFrameworkStage(ctx, { mode: 'framework', units: [hexPrismUnit(A)], hashMesh });
    const b = runBridgeFrameworkStage(ctx, { mode: 'framework', units: [hexPrismUnit(A)], hashMesh });
    expect(a.outputHashes).toEqual(b.outputHashes);
  });

  it('throws when the profile veneering space is missing (never defaults)', () => {
    const ctx = makeBridgeContext({ materialProfile: { ...PROFILE, veneeringSpaceMm: Number.NaN } });
    expect(() => runBridgeFrameworkStage(ctx, { mode: 'framework', units: [hexPrismUnit(A)], hashMesh })).toThrow(MissingVeneeringSpaceError);
  });
});

describe('runBridgeFrameworkStage — full-contour mode (byte-unchanged)', () => {
  it('passes units through BYTE-IDENTICAL and does not move any hash', () => {
    const ctx = makeBridgeContext();
    const units = [hexPrismUnit(A), hexPrismUnit(B)];
    const res = runBridgeFrameworkStage(ctx, { mode: 'fullContour', units, hashMesh });

    expect(res.mode).toBe('fullContour');
    expect(res.params['mode']).toBe('fullContour');
    expect(res.params['veneeringSpaceMm']).toBeNull(); // not applied
    expect(res.outputHashes).toEqual(res.inputHashes); // hashes DO NOT move
    for (let ui = 0; ui < units.length; ui++) {
      const u = units[ui]!;
      const r = res.units[ui]!;
      expect(r.mesh).toBe(u.mesh); // same reference — nothing rebuilt
      expect(r.meshContentHash).toBe(u.meshContentHash);
      expect(r.maxAppliedCutbackMm).toBe(0);
      expect(r.errorBoundMm).toBe(0);
    }
  });
});

describe('runBridgeFrameworkStage — guard rails', () => {
  it('rejects a non-bridge context', () => {
    const crownCtx = makeBridgeContext({ restorationType: 'crown' as unknown as 'bridge' });
    expect(() => runBridgeFrameworkStage(crownCtx, { mode: 'framework', units: [hexPrismUnit(A)], hashMesh })).toThrow(RestorationTypeMismatchError);
  });
  it('rejects an empty unit set', () => {
    const ctx = makeBridgeContext();
    expect(() => runBridgeFrameworkStage(ctx, { mode: 'framework', units: [], hashMesh })).toThrow(NoFrameworkUnitsError);
  });
});
