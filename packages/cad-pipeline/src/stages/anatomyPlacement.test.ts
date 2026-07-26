// packages/cad-pipeline/src/stages/anatomyPlacement.test.ts
//
// Tests for the anatomy-placement STAGE (anatomyPlacement.ts) — orchestration,
// not re-testing the kernel solve (that is @dqcad/kernel's
// anatomy/placement.test.ts). Here we prove: the FDI mesial/distal
// identification is correct; the tooth asset + neighbours + antagonist flow
// through to the kernel; the RestorationStageResult shape (mesh, injected hash,
// operationName, journal params incl. the transform, inputHashes, null
// errorBound) is right; the stage is deterministic (replay = identical hash);
// the manual landmark-handle override lands the landmark on target; and the
// missing-margin / insufficient-neighbour / unknown-landmark guards fire.
//
// Fully SYNTHETIC (inline boxes) — a cross-package import of @dqcad/tooth-library
// is disallowed for cad-pipeline (layer rule); the real library-asset flow is
// exercised in test/golden/anatomy-placement.test.ts.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { applyMat4ToPoint, type CanonicalFrameAxes, type IndexedMesh } from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import {
  runAnatomyPlacementStage,
  identifyNeighbors,
  InsufficientNeighborsError,
  UnknownLandmarkError,
  MissingMarginLoopError,
  type PipelineToothAsset,
} from './anatomyPlacement.ts';

function box(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function marginCircle(c: Vec3, r: number, n = 64): { closed: true; resampledPoints: Vec3[] } {
  const resampledPoints: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    resampledPoints.push([c[0] + r * Math.cos(th), c[1] + r * Math.sin(th), c[2]]);
  }
  return { closed: true, resampledPoints };
}

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

const IDENTITY_CANONICAL: CanonicalFrameAxes = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};

const ASSET: PipelineToothAsset = {
  contentHash: 'asset-hash-11',
  mesh: box([-1, -1, 0], [1, 1, 4]),
  landmarks: { incisalEdge: [0, 0, 4], cingulum: [0, -0.8, 1] },
  canonicalFrame: IDENTITY_CANONICAL,
};

const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia',
  version: '1.1.0',
  restorationParams: {
    cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.5,
    proximalContactPenetrationMm: 0.02, occlusalContactMm: 0,
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

const TOOTH = 11 as FdiTooth;
const DISTAL = 12 as FdiTooth; // farther from midline
const MESIAL = 21 as FdiTooth; // across the midline, nearer

function handle(contentHash: string, mesh: IndexedMesh): PipelineMeshHandle {
  return { contentHash, mesh };
}

function makeContext(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    restorationId: 'r-anatomy',
    restorationType: 'crown',
    materialProfile: PROFILE,
    insertionAxis: [0, 0, 1],
    targetMesh: handle('die-hash', box([-1, -1, 0], [1, 1, 3])),
    marginLoops: { [TOOTH]: marginCircle([0, 0, 0], 1.5) },
    // distal (12) at +x, mesial (21) at -x → md = +x, proximal gap 4mm
    neighbors: {
      [DISTAL]: handle('nb-12', box([2, -1, 0], [4, 1, 3])),
      [MESIAL]: handle('nb-21', box([-4, -1, 0], [-2, 1, 3])),
    },
    // opposing surface over the site, z∈[8,10] (narrow in x/y → inside window)
    antagonist: handle('anta', box([-0.75, -0.75, 8], [0.75, 0.75, 10])),
    stages: {},
    ...overrides,
  };
}

describe('identifyNeighbors — mesial/distal from FDI', () => {
  it('picks the neighbour farther from the midline as distal (11: 12 distal, 21 mesial)', () => {
    const { mesial, distal } = identifyNeighbors(TOOTH, {
      [DISTAL]: handle('a', box([0, 0, 0], [1, 1, 1])),
      [MESIAL]: handle('b', box([0, 0, 0], [1, 1, 1])),
    });
    expect(distal).toBe(12);
    expect(mesial).toBe(21);
  });

  it('orders a posterior pair by position (16: 17 distal, 15 mesial)', () => {
    const { mesial, distal } = identifyNeighbors(16 as FdiTooth, {
      [15 as FdiTooth]: handle('a', box([0, 0, 0], [1, 1, 1])),
      [17 as FdiTooth]: handle('b', box([0, 0, 0], [1, 1, 1])),
    });
    expect(distal).toBe(17);
    expect(mesial).toBe(15);
  });

  it('throws when not exactly two neighbours', () => {
    expect(() => identifyNeighbors(TOOTH, {})).toThrow(InsufficientNeighborsError);
    expect(() => identifyNeighbors(TOOTH, { [DISTAL]: handle('a', box([0, 0, 0], [1, 1, 1])) })).toThrow(
      InsufficientNeighborsError,
    );
  });
});

describe('runAnatomyPlacementStage — orchestration', () => {
  it('places the tooth, returns a correctly-shaped journalable result', () => {
    const ctx = makeContext();
    const result = runAnatomyPlacementStage(ctx, TOOTH, { asset: ASSET, hashMesh });

    expect(result.stage).toBe('anatomyPlacement');
    expect(result.mesh).not.toBeNull();
    expect(result.meshContentHash).toBe(hashMesh(result.mesh!));
    expect(result.operationName).toBe('anatomyPlacement.place');
    expect(result.errorBoundMm).toBeNull();
    // antagonist present → its hash is in inputHashes
    expect(result.inputHashes).toEqual(['asset-hash-11', 'nb-21', 'nb-12', 'anta']);

    // Journaled placement params (proof the case geometry drove the solve).
    expect(result.params['tooth']).toBe(TOOTH);
    expect(result.params['mesialNeighborFdi']).toBe(21);
    expect(result.params['distalNeighborFdi']).toBe(12);
    expect(result.params['antagonistPresent']).toBe(true);
    expect(result.params['usedProximalGap']).toBe(true);
    expect(result.params['antagonistUsed']).toBe(true);
    // native MD=2, proximal gap 4 → scaleMD 2; native OG=4, margin→antagonist 8 → scaleOG 2
    expect(result.params['scaleMesialDistal']).toBeCloseTo(2, 9);
    expect(result.params['targetMesialDistalWidthMm']).toBeCloseTo(4, 9);
    expect(result.params['targetOcclusoGingivalHeightMm'] as number).toBeCloseTo(8, 9);
    expect(result.params['scaleOcclusoGingival']).toBeCloseTo(2, 9);
    expect(Array.isArray(result.params['transform'])).toBe(true);
    expect((result.params['transform'] as number[]).length).toBe(16);
  });

  it('drops the antagonist hash from inputHashes when none is assigned (fallback)', () => {
    const ctx = makeContext({ antagonist: null });
    const result = runAnatomyPlacementStage(ctx, TOOTH, { asset: ASSET, hashMesh });
    expect(result.inputHashes).toEqual(['asset-hash-11', 'nb-21', 'nb-12']);
    expect(result.params['antagonistUsed']).toBe(false);
    expect(result.params['targetOcclusoGingivalHeightMm']).toBeNull();
    // O-G reuses the M-D scale (undistorted).
    expect(result.params['scaleOcclusoGingival']).toBeCloseTo(result.params['scaleMesialDistal'] as number, 12);
  });

  it('is deterministic: replaying the same inputs reproduces the identical mesh hash + transform', () => {
    const r1 = runAnatomyPlacementStage(makeContext(), TOOTH, { asset: ASSET, hashMesh });
    const r2 = runAnatomyPlacementStage(makeContext(), TOOTH, { asset: ASSET, hashMesh });
    expect(r2.meshContentHash).toBe(r1.meshContentHash);
    expect(r2.params['transform']).toEqual(r1.params['transform']);
  });

  it('manual landmark handle lands the named landmark exactly on target', () => {
    const ctx = makeContext();
    const target: Vec3 = [4, -6, 25];
    const result = runAnatomyPlacementStage(ctx, TOOTH, {
      asset: ASSET,
      hashMesh,
      manualOverride: { landmarkHandle: { landmark: 'incisalEdge', targetMm: target } },
    });
    const transform = result.params['transform'] as number[];
    const landed = applyMat4ToPoint(transform, ASSET.landmarks['incisalEdge']!);
    expect(landed[0]).toBeCloseTo(target[0], 6);
    expect(landed[1]).toBeCloseTo(target[1], 6);
    expect(landed[2]).toBeCloseTo(target[2], 6);
    expect((result.params['manualOverride'] as { landmarkHandle: unknown }).landmarkHandle).toBeTruthy();
  });

  it('applies explicit translation + scale overrides (journaled)', () => {
    const ctx = makeContext();
    const base = runAnatomyPlacementStage(ctx, TOOTH, { asset: ASSET, hashMesh });
    const overridden = runAnatomyPlacementStage(ctx, TOOTH, {
      asset: ASSET,
      hashMesh,
      manualOverride: { translationMm: [1, 0, 0], scale: { md: 1.5 } },
    });
    expect(overridden.params['scaleMesialDistal']).toBeCloseTo((base.params['scaleMesialDistal'] as number) * 1.5, 9);
    expect(overridden.meshContentHash).not.toBe(base.meshContentHash);
  });

  it('guards: missing margin, insufficient neighbours, unknown landmark', () => {
    expect(() => runAnatomyPlacementStage(makeContext({ marginLoops: {} }), TOOTH, { asset: ASSET, hashMesh })).toThrow(
      MissingMarginLoopError,
    );
    expect(() => runAnatomyPlacementStage(makeContext({ neighbors: {} }), TOOTH, { asset: ASSET, hashMesh })).toThrow(
      InsufficientNeighborsError,
    );
    expect(() =>
      runAnatomyPlacementStage(makeContext(), TOOTH, {
        asset: ASSET,
        hashMesh,
        manualOverride: { landmarkHandle: { landmark: 'nope', targetMm: [0, 0, 0] } },
      }),
    ).toThrow(UnknownLandmarkError);
  });
});
