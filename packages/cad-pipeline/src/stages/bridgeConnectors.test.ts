// packages/cad-pipeline/src/stages/bridgeConnectors.test.ts
//
// Phase 6 Task 4 — the bridge connectors stage: auto-placement + measurement +
// the ACCEPTANCE falsifiable pair (a 5 mm² posterior connector BLOCKS; the
// healthy default PASSES), driven through the real stage + the real gate.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { analyzeMesh, makeEllipseConnectorProfile, ellipseConnectorProfileAreaMm2, type IndexedMesh } from '@dqcad/kernel';
import type { FdiTooth } from '@dqcad/shared-types';
import type { BridgePipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import { RestorationTypeMismatchError, BridgeContextIncompleteError } from '../pipeline/context.ts';
import {
  runBridgeConnectorsStage,
  NoConnectorsError,
  MissingUnitMeshError,
  type EditableConnectorProfiles,
} from './bridgeConnectors.ts';
import { connectorCrossSectionGate } from '../gates/connectorCrossSection.ts';

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

/** A tiny tetrahedron whose centroid is `c` — a stand-in unit body (only its
 * centroid is read for the connector frame). */
function unitBody(c: readonly [number, number, number], hash: string): PipelineMeshHandle {
  const [x, y, z] = c;
  // Four vertices whose mean is exactly (x,y,z): offsets summing to zero.
  const offsets = [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ];
  const positions = new Float64Array(12);
  offsets.forEach((o, i) => {
    positions[i * 3] = x + o[0]! * 0.5;
    positions[i * 3 + 1] = y + o[1]! * 0.5;
    positions[i * 3 + 2] = z + o[2]! * 0.5;
  });
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
  return { contentHash: hash, mesh: { positions, indices } };
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
  frameworkMinThicknessMm: 0.5, ponticHygienicClearanceMm: 2.0, ponticRidgeLapReliefMm: 0.05, ponticOvateDepthMm: 1.0,
};

// A 3-unit POSTERIOR bridge: premolar abutment 14, pontic 15, molar abutment 16.
const A: FdiTooth = 14 as FdiTooth;
const P: FdiTooth = 15 as FdiTooth;
const B: FdiTooth = 16 as FdiTooth;

function unitMeshes(): Partial<Record<FdiTooth, PipelineMeshHandle>> {
  return {
    [A]: unitBody([-7, 0, 2], 'unit-14'),
    [P]: unitBody([0, 0, 2], 'unit-15'),
    [B]: unitBody([7, 0, 2], 'unit-16'),
  };
}

function makeBridgeContext(overrides?: Partial<BridgePipelineContext>): BridgePipelineContext {
  return {
    restorationId: 'bridge-connectors-test',
    restorationType: 'bridge',
    materialProfile: PROFILE,
    insertionAxis: [0, 0, 1],
    targetMesh: { contentHash: 'arch-hash', mesh: { positions: new Float64Array(9), indices: new Uint32Array([0, 1, 2]) } },
    marginLoops: {},
    neighbors: {},
    antagonist: null,
    stages: {},
    ponticSites: [P],
    gingivaMesh: null,
    unitAdjacency: [[A, P], [P, B]],
    ...overrides,
  };
}

describe('runBridgeConnectorsStage — auto-placement + acceptance', () => {
  it('auto-places a watertight connector between each adjacent pair (healthy default) and PASSES the gate', () => {
    const ctx = makeBridgeContext();
    const result = runBridgeConnectorsStage(ctx, { unitMeshes: unitMeshes(), hashMesh });

    expect(result.stage).toBe('connectors');
    expect(result.operationName).toBe('bridge.connectors');
    expect(result.connectors.map((c) => c.label)).toEqual(['14–15', '15–16']);
    expect(result.outputHashes).toEqual(result.connectors.map((c) => c.contentHash));

    const healthyArea = ellipseConnectorProfileAreaMm2(2.2, 1.8, 64); // straight prism → polygon area
    for (const c of result.connectors) {
      const stats = analyzeMesh(c.mesh);
      expect(stats.watertight).toBe(true);
      expect(stats.manifoldEdges).toBe(true);
      expect(stats.componentCount).toBe(1);
      expect(c.targetMm2).toBe(9); // all-posterior bridge
      expect(c.minAreaMm2).toBeCloseTo(healthyArea, 3);
      expect(c.minAreaMm2).toBeGreaterThanOrEqual(9);
      expect(c.meetsTarget).toBe(true);
    }

    // Drive the real QC gate on the stage's gate-ready connectors.
    const gate = connectorCrossSectionGate({ connectorAreaTargetMm2: 9, connectors: result.gateConnectors });
    expect(gate.passed).toBe(true);
    console.log(
      `[bridge][connectors] healthy default: ${result.connectors.map((c) => `${c.label}=${c.minAreaMm2.toFixed(2)}mm²`).join(', ')} ` +
        `(target ${result.connectors[0]!.targetMm2} mm²) → gate PASSES`,
    );
  });

  it('ACCEPTANCE: a 5 mm² posterior connector BLOCKS (falsifiable pair with the healthy pass)', () => {
    const ctx = makeBridgeContext();
    // Size an ellipse so its polygon area is exactly 5 mm²: ½·n·a·b·sin(2π/n)=5.
    const n = 64;
    const k = ellipseConnectorProfileAreaMm2(1, 1, n); // unit-semi-axes polygon area
    const ab = 5 / k; // a·b needed for area 5
    const semi = Math.sqrt(ab);
    const fiveProfile = makeEllipseConnectorProfile(semi, semi, n);
    const editable: EditableConnectorProfiles = { profileA: fiveProfile, profileB: fiveProfile };
    const profiles = new Map<string, EditableConnectorProfiles>([[`${P}-${B}`, editable]]);

    const result = runBridgeConnectorsStage(ctx, { unitMeshes: unitMeshes(), hashMesh, profiles });
    const weak = result.connectors.find((c) => c.label === '15–16')!;
    const healthy = result.connectors.find((c) => c.label === '14–15')!;

    expect(weak.minAreaMm2).toBeCloseTo(5, 2);
    expect(weak.meetsTarget).toBe(false);
    expect(healthy.meetsTarget).toBe(true);

    const gate = connectorCrossSectionGate({ connectorAreaTargetMm2: 9, connectors: result.gateConnectors });
    expect(gate.passed).toBe(false); // BLOCKS — the acceptance
    expect(gate.message).toContain('15–16');

    console.log(
      `[bridge][connectors][ACCEPTANCE] weak 15–16 = ${weak.minAreaMm2.toFixed(3)} mm² (target 9) BLOCKS; ` +
        `healthy 14–15 = ${healthy.minAreaMm2.toFixed(3)} mm² PASSES → whole-bridge connector gate passed=${gate.passed}`,
    );
  });

  it('is deterministic — replay reproduces identical output hashes + params', () => {
    const a = runBridgeConnectorsStage(makeBridgeContext(), { unitMeshes: unitMeshes(), hashMesh });
    const b = runBridgeConnectorsStage(makeBridgeContext(), { unitMeshes: unitMeshes(), hashMesh });
    expect(b.outputHashes).toEqual(a.outputHashes);
    expect(b.params).toEqual(a.params);
  });

  it('editable profiles are journaled as an editable design decision', () => {
    const ctx = makeBridgeContext();
    const prof = makeEllipseConnectorProfile(2.5, 2.0, 48);
    const profiles = new Map<string, EditableConnectorProfiles>([[`${A}-${P}`, { profileA: prof, profileB: prof }]]);
    const result = runBridgeConnectorsStage(ctx, { unitMeshes: unitMeshes(), hashMesh, profiles });
    const pairParams = result.params['pairs'] as { profileSource: string; profileVertexCount: number }[];
    expect(pairParams[0]!.profileSource).toBe('editable');
    expect(pairParams[0]!.profileVertexCount).toBe(48);
    expect(pairParams[1]!.profileSource).toBe('default');
  });
});

describe('runBridgeConnectorsStage — guard rails', () => {
  it('rejects a CROWN context (RestorationTypeMismatchError)', () => {
    const crown = { ...makeBridgeContext(), restorationType: 'crown' } as unknown as BridgePipelineContext;
    expect(() => runBridgeConnectorsStage(crown, { unitMeshes: unitMeshes(), hashMesh })).toThrow(RestorationTypeMismatchError);
  });

  it('rejects an INCOMPLETE bridge context (missing unitAdjacency → BridgeContextIncompleteError)', () => {
    const incomplete = { ...makeBridgeContext(), unitAdjacency: undefined } as unknown as BridgePipelineContext;
    expect(() => runBridgeConnectorsStage(incomplete, { unitMeshes: unitMeshes(), hashMesh })).toThrow(BridgeContextIncompleteError);
  });

  it('throws NoConnectorsError when there are no adjacency pairs', () => {
    const ctx = makeBridgeContext({ unitAdjacency: [] });
    expect(() => runBridgeConnectorsStage(ctx, { unitMeshes: unitMeshes(), hashMesh })).toThrow(NoConnectorsError);
  });

  it('throws MissingUnitMeshError when a pair unit has no mesh', () => {
    const ctx = makeBridgeContext();
    const partial = { [A]: unitBody([-7, 0, 2], 'unit-14'), [P]: unitBody([0, 0, 2], 'unit-15') };
    expect(() => runBridgeConnectorsStage(ctx, { unitMeshes: partial, hashMesh })).toThrow(MissingUnitMeshError);
  });
});
