// packages/cad-pipeline/src/stages/bridgePontic.test.ts
//
// Phase 6 Task 3 — the BRIDGE PONTIC + GINGIVAL INTERFACE stage (orchestration,
// not re-testing kernel geometry). Proves: deterministic placement + shaping +
// journal shape; per-style measured relief matches the CONFIGURED profile value
// within ±20 µm (the acceptance, measured through the real stage); the gingiva
// gate + guard rails fire; configured relief comes from the profile only.
//
// A self-contained closed-form ridge "loaf" (crest cylinder z=zc+√(R²−y²)) is
// built inline (a cross-package import of @dqcad/kernel TEST fixtures would sit
// outside cad-pipeline's rootDir), consistently oriented via the kernel's
// `orientNormalsConsistently` so the SDF measurement's watertight contract holds.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { orientNormalsConsistently, type IndexedMesh, type CanonicalFrameAxes, type RidgeCrestCylinder } from '@dqcad/kernel';
import type { BridgePipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import { RestorationTypeMismatchError, BridgeContextIncompleteError } from '../pipeline/context.ts';
import type { PipelineToothAsset } from './anatomyPlacement.ts';
import { runBridgePonticStage, MissingGingivaMeshError, MissingPonticParamError } from './bridgePontic.ts';

const R = 3;
const ZC = 1;
const HALF_LEN = 6;
const CREST_SEGS = 160;
const STATIONS = 16;

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

function box(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

/** A closed-form ridge "loaf": crest cylinder arc closed by vertical walls to a
 * flat base at z=0, swept along X — a convex cross-section (fan-triangulable). */
function buildRidge(): IndexedMesh {
  const vmap = new Map<string, number>();
  const pos: number[] = [];
  const vid = (p: Vec3): number => {
    const key = `${p[0]}|${p[1]}|${p[2]}`;
    const e = vmap.get(key);
    if (e !== undefined) return e;
    const i = pos.length / 3;
    pos.push(p[0], p[1], p[2]);
    vmap.set(key, i);
    return i;
  };
  const tris: number[] = [];
  const crestZ = (y: number): number => (y === 0 ? ZC + R : ZC + Math.sqrt(R * R - y * y));
  const ys: number[] = [];
  for (let i = 0; i <= CREST_SEGS; i++) ys.push(i === 0 ? -R : i === CREST_SEGS ? R : -R + (2 * R * i) / CREST_SEGS);
  // cross-section ring (Y-Z at station x): crest arc (-R..+R), then base (R,0),(-R,0).
  const ring = (x: number): Vec3[] => {
    const r: Vec3[] = [];
    for (const y of ys) r.push([x, y, crestZ(y)]);
    r.push([x, R, 0]);
    r.push([x, -R, 0]);
    return r;
  };
  const xs: number[] = [];
  for (let i = 0; i <= STATIONS; i++) xs.push(i === 0 ? -HALF_LEN : i === STATIONS ? HALF_LEN : -HALF_LEN + (2 * HALF_LEN * i) / STATIONS);
  const sections = xs.map(ring);
  // side walls
  for (let s = 0; s < sections.length - 1; s++) {
    const a = sections[s]!;
    const b = sections[s + 1]!;
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      const ia = vid(a[i]!), ib = vid(a[j]!), jb = vid(b[j]!), ja = vid(b[i]!);
      tris.push(ia, ib, jb, ia, jb, ja);
    }
  }
  // end caps: fan from base centre (x,0,0).
  const cap = (sec: Vec3[], x: number): void => {
    const c = vid([x, 0, 0]);
    for (let i = 0; i < sec.length; i++) {
      const j = (i + 1) % sec.length;
      tris.push(c, vid(sec[i]!), vid(sec[j]!));
    }
  };
  cap(sections[0]!, -HALF_LEN);
  cap(sections[sections.length - 1]!, HALF_LEN);
  const raw: IndexedMesh = { positions: new Float64Array(pos), indices: Uint32Array.from(tris) };
  return orientNormalsConsistently(raw).mesh;
}

const CREST: RidgeCrestCylinder = {
  axisPointMm: [0, 0, ZC],
  mesialDistalDir: [1, 0, 0],
  buccalDir: [0, 1, 0],
  upDir: [0, 0, 1],
  radiusMm: R,
};

const IDENTITY_CANONICAL: CanonicalFrameAxes = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};

const ASSET: PipelineToothAsset = {
  contentHash: 'pontic-asset-16',
  mesh: box([-3, -3, 0], [3, 3, 7]),
  landmarks: { centralFossa: [0, 0, 7] },
  canonicalFrame: IDENTITY_CANONICAL,
};

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

function handle(contentHash: string, mesh: IndexedMesh): PipelineMeshHandle {
  return { contentHash, mesh };
}

const FOOTPRINT = { stationMinMm: -4, stationMaxMm: 4, angularHalfSpanRad: (60 * Math.PI) / 180 };
const RES = { meshStations: 16, meshAngularSegments: 40, sampleStations: 32, sampleAngularSegments: 64 };
const ACCEPTANCE_MM = 0.02;

let RIDGE: IndexedMesh;
function ridge(): IndexedMesh {
  RIDGE ??= buildRidge();
  return RIDGE;
}

function makeBridgeContext(overrides?: Partial<BridgePipelineContext>): BridgePipelineContext {
  return {
    restorationId: 'bridge-pontic-test',
    restorationType: 'bridge',
    materialProfile: PROFILE,
    insertionAxis: [0, 0, 1],
    targetMesh: handle('arch-hash', box([-8, -3, 0], [8, 3, 4])),
    marginLoops: {},
    neighbors: {
      [MESIAL]: handle('nb-14', box([-9, -3, 0], [-5, 3, 6])),
      [DISTAL]: handle('nb-16', box([5, -3, 0], [9, 3, 6])),
    },
    antagonist: null,
    stages: {},
    ponticSites: [PONTIC],
    gingivaMesh: handle('ridge-hash', ridge()),
    unitAdjacency: [[MESIAL, PONTIC], [PONTIC, DISTAL]],
    ...overrides,
  };
}

function baseOptions(style: 'hygienic' | 'ridgeLap' | 'ovate', shaping?: Record<string, number>) {
  return {
    ponticTooth: PONTIC, asset: ASSET, style, ridgeCrest: CREST,
    footprint: FOOTPRINT, resolution: RES, hashMesh, shaping,
  };
}

describe('runBridgePonticStage — per-style ±20 µm acceptance + orchestration', () => {
  it('HYGIENIC: measured clearance == configured profile value within ±20 µm; ONE journaled op', () => {
    const ctx = makeBridgeContext();
    const r = runBridgePonticStage(ctx, baseOptions('hygienic'));
    expect(r.operationName).toBe('bridge.ponticInterface');
    expect(r.params['style']).toBe('hygienic');
    expect(r.params['configuredParamName']).toBe('ponticHygienicClearanceMm');
    expect(r.params['configuredParamValueMm']).toBe(2.0);
    expect(r.configuredTargetMm).toBe(2.0);
    expect(r.outputHashes).toEqual([r.ponticBodyContentHash, r.baseContentHash]);
    expect(r.relief.primary.maxAbsDeviationMm).toBeLessThanOrEqual(ACCEPTANCE_MM);
    console.log(`[bridge][stage][hygienic] clearance 2.0 mm: dev maxAbs ${(r.relief.primary.maxAbsDeviationMm * 1000).toFixed(2)} µm ≤ 20; errorBound ${(r.errorBoundMm * 1000).toFixed(2)} µm`);
  });

  it('RIDGE-LAP: buccal contact == relief within ±20 µm; lingual relieved reported separately', () => {
    const r = runBridgePonticStage(makeBridgeContext(), baseOptions('ridgeLap', { lingualOpeningMm: 0.5 }));
    expect(r.params['configuredParamName']).toBe('ponticRidgeLapReliefMm');
    expect(r.configuredTargetMm).toBe(0.05);
    expect(r.relief.primary.maxAbsDeviationMm).toBeLessThanOrEqual(ACCEPTANCE_MM);
    expect(r.relief.secondary['relieved']).toBeDefined();
    expect(r.relief.secondary['relieved']!.minSignedMm).toBeGreaterThan(0.05);
    console.log(`[bridge][stage][ridgeLap] relief 0.05 mm: contact dev maxAbs ${(r.relief.primary.maxAbsDeviationMm * 1000).toFixed(2)} µm ≤ 20; relieved min ${r.relief.secondary['relieved']!.minSignedMm.toFixed(3)} mm`);
  });

  it('OVATE: seat penetration == −depth within ±20 µm (measured negative)', () => {
    const r = runBridgePonticStage(makeBridgeContext(), baseOptions('ovate', { seatHalfAngleRad: (18 * Math.PI) / 180, emergenceMm: 0.5 }));
    expect(r.params['configuredParamName']).toBe('ponticOvateDepthMm');
    expect(r.configuredTargetMm).toBe(-1.0);
    expect(r.relief.primary.maxSignedMm).toBeLessThan(0);
    expect(r.relief.primary.maxAbsDeviationMm).toBeLessThanOrEqual(ACCEPTANCE_MM);
    console.log(`[bridge][stage][ovate] depth 1.0 mm: seat signed max ${r.relief.primary.maxSignedMm.toFixed(3)} mm; dev maxAbs ${(r.relief.primary.maxAbsDeviationMm * 1000).toFixed(2)} µm ≤ 20`);
  });

  it('is deterministic — replay reproduces identical hashes + params', () => {
    const a = runBridgePonticStage(makeBridgeContext(), baseOptions('hygienic'));
    const b = runBridgePonticStage(makeBridgeContext(), baseOptions('hygienic'));
    expect(b.outputHashes).toEqual(a.outputHashes);
    expect(b.params).toEqual(a.params);
    expect(b.errorBoundMm).toBe(a.errorBoundMm);
  });

  it('honours an ANTAGONIST + explicit seat-ring params (journaled), still within ±20 µm', () => {
    const ctx = makeBridgeContext({ antagonist: handle('anta', box([-8, -3, 14], [8, 3, 15])) });
    const r = runBridgePonticStage(ctx, {
      ...baseOptions('hygienic'), seatRingRadiusMm: 1.2, seatRingSegments: 48,
    });
    expect(r.params['antagonistPresent']).toBe(true);
    expect(r.params['seatRingRadiusMm']).toBe(1.2);
    expect(r.params['seatRingSegments']).toBe(48);
    expect(r.inputHashes).toContain('anta');
    expect(r.relief.primary.maxAbsDeviationMm).toBeLessThanOrEqual(ACCEPTANCE_MM);
  });
});

describe('runBridgePonticStage — guard rails + gates', () => {
  it('rejects a CROWN context (RestorationTypeMismatchError)', () => {
    const crown = { ...makeBridgeContext(), restorationType: 'crown' } as unknown as BridgePipelineContext;
    expect(() => runBridgePonticStage(crown, baseOptions('hygienic'))).toThrow(RestorationTypeMismatchError);
  });

  it('rejects an INCOMPLETE bridge context (missing gingivaMesh field → BridgeContextIncompleteError)', () => {
    const incomplete = { ...makeBridgeContext(), gingivaMesh: undefined } as unknown as BridgePipelineContext;
    expect(() => runBridgePonticStage(incomplete, baseOptions('hygienic'))).toThrow(BridgeContextIncompleteError);
  });

  it('throws MissingGingivaMeshError when gingivaMesh is null', () => {
    const ctx = makeBridgeContext({ gingivaMesh: null });
    expect(() => runBridgePonticStage(ctx, baseOptions('hygienic'))).toThrow(MissingGingivaMeshError);
  });

  it('throws MissingPonticParamError when the configured relief is non-finite (never defaulted)', () => {
    const bad: PipelineMaterialProfile = { ...PROFILE, ponticHygienicClearanceMm: Number.NaN };
    const ctx = makeBridgeContext({ materialProfile: bad });
    expect(() => runBridgePonticStage(ctx, baseOptions('hygienic'))).toThrow(MissingPonticParamError);
  });
});
