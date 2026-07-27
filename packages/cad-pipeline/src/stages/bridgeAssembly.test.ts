// packages/cad-pipeline/src/stages/bridgeAssembly.test.ts
//
// Phase 6 Task 6 — the bridge assembly stage: fuses units + connectors into one
// watertight solid, journals ONE op, deterministic; guard rails + disjoint
// propagation. Uses small inline watertight boxes (only the union is under test
// here; the full 3-unit acceptance is test/golden/bridge-acceptance.test.ts).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { analyzeMesh, BridgeAssemblyError, type IndexedMesh } from '@dqcad/kernel';
import type { BridgePipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import { RestorationTypeMismatchError, BridgeContextIncompleteError } from '../pipeline/context.ts';
import { runBridgeAssemblyStage, NoAssemblySolidsError } from './bridgeAssembly.ts';

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

/** An axis-aligned watertight box [cx±hx]×[±h]×[±h]. */
function box(cx: number, hx: number, h: number, hash: string): PipelineMeshHandle {
  const x0 = cx - hx, x1 = cx + hx, y0 = -h, y1 = h, z0 = -h, z1 = h;
  const v: number[] = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  // 12 tris, consistent outward winding.
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { contentHash: hash, mesh: { positions: new Float64Array(v), indices: new Uint32Array(f) } };
}

const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia', version: '1.4.0',
  restorationParams: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.5, proximalContactPenetrationMm: 0.02, occlusalContactMm: 0 },
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0, occlusalMinWallThicknessMm: 0.5, maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: 0.5, onlayMinThicknessMm: 0.5, cuspCoverageMinThicknessMm: 0.7,
  marginExclusionMm: 0.2, inlayMarginExclusionMm: 1.3, onlayMarginExclusionMm: 1.8,
  frameworkMinThicknessMm: 0.5, ponticHygienicClearanceMm: 2.0, ponticRidgeLapReliefMm: 0.05, ponticOvateDepthMm: 1.0, veneeringSpaceMm: 1.0,
};

function makeBridgeContext(overrides?: Partial<BridgePipelineContext>): BridgePipelineContext {
  return {
    restorationId: 'bridge-assembly-test', restorationType: 'bridge', materialProfile: PROFILE,
    insertionAxis: [0, 0, 1],
    targetMesh: { contentHash: 'arch', mesh: { positions: new Float64Array(9), indices: new Uint32Array([0, 1, 2]) } },
    marginLoops: {}, neighbors: {}, antagonist: null, stages: {},
    ponticSites: [15 as never], gingivaMesh: null, unitAdjacency: [[14, 15], [15, 16]] as never,
    ...overrides,
  };
}

// Two boxes that OVERLAP (a "connector" bridging them) + a middle box → one solid.
function fusingSolids(): { units: PipelineMeshHandle[]; connectors: PipelineMeshHandle[] } {
  return {
    units: [box(-2, 1.2, 1, 'u-left'), box(2, 1.2, 1, 'u-right')],
    connectors: [box(0, 1.5, 0.5, 'conn-mid')], // spans the gap, overlapping both
  };
}

describe('runBridgeAssemblyStage', () => {
  it('fuses units + connectors into ONE watertight solid and journals bridge.assembly', async () => {
    const { units, connectors } = fusingSolids();
    const r = await runBridgeAssemblyStage(makeBridgeContext(), { unitMeshes: units, connectorMeshes: connectors, hashMesh });
    expect(r.stage).toBe('assembly');
    expect(r.operationName).toBe('bridge.assembly');
    expect(r.watertight).toBe(true);
    expect(r.componentCount).toBe(1);
    expect(analyzeMesh(r.assembledSolid).watertight).toBe(true);
    // Journal shape: every input solid hashed in, one output.
    expect(r.inputHashes).toEqual(['u-left', 'u-right', 'conn-mid']);
    expect(r.outputHashes).toEqual([r.contentHash]);
    expect(r.params.inputCount).toBe(3);
  });

  it('is deterministic — replay reproduces the same content hash', async () => {
    const a = await runBridgeAssemblyStage(makeBridgeContext(), { ...fusingSolids2(), hashMesh });
    const b = await runBridgeAssemblyStage(makeBridgeContext(), { ...fusingSolids2(), hashMesh });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('propagates BridgeAssemblyError(disjoint) when a connector does not bridge', async () => {
    // A middle "connector" too small to reach either unit → three components.
    const units = [box(-3, 1, 1, 'u-l'), box(3, 1, 1, 'u-r')];
    const connectors = [box(0, 0.3, 0.3, 'conn-float')];
    await expect(
      runBridgeAssemblyStage(makeBridgeContext(), { unitMeshes: units, connectorMeshes: connectors, hashMesh }),
    ).rejects.toBeInstanceOf(BridgeAssemblyError);
  });

  it('rejects a NON-bridge context (guard rail)', async () => {
    const crown = { ...makeBridgeContext(), restorationType: 'crown' } as unknown as BridgePipelineContext;
    await expect(runBridgeAssemblyStage(crown, { ...fusingSolids2(), hashMesh })).rejects.toBeInstanceOf(RestorationTypeMismatchError);
  });

  it('rejects an INCOMPLETE bridge context', async () => {
    const incomplete = { ...makeBridgeContext(), unitAdjacency: undefined } as unknown as BridgePipelineContext;
    await expect(runBridgeAssemblyStage(incomplete, { ...fusingSolids2(), hashMesh })).rejects.toBeInstanceOf(BridgeContextIncompleteError);
  });

  it('throws NoAssemblySolidsError when no solids are supplied', async () => {
    await expect(runBridgeAssemblyStage(makeBridgeContext(), { unitMeshes: [], connectorMeshes: [], hashMesh })).rejects.toBeInstanceOf(NoAssemblySolidsError);
  });
});

function fusingSolids2(): { unitMeshes: PipelineMeshHandle[]; connectorMeshes: PipelineMeshHandle[] } {
  const s = fusingSolids();
  return { unitMeshes: s.units, connectorMeshes: s.connectors };
}
