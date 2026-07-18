// ToolManager.test.ts — exercised through the REAL WorkerPool (Node
// worker_threads path), same rationale as importer.test.ts: this module's
// job is orchestration (pick sequencing, worker round trips, caseStore
// wiring), not geometry — the geometry itself (raycast/closestPoint
// correctness) is already covered by packages/kernel/src/bvh's property/
// analytic tests and packages/kernel-workers/src/bvhJobs.test.ts.
//
// Every `handlePick` call below passes a single-element `candidateNodeIds`
// (this file only ever registers one candidate mesh per pick), simulating
// what SceneManager reports when only one mesh is visible/plausible — see
// `MeasurePickRequest`'s doc. The MULTI-candidate resolution property (the
// Phase 2 Task 10 fix batch's central correctness fix: given several
// candidates, `handlePick` keeps only the globally nearest TRUE Float64
// surface hit, immune to LOD silhouette mismatch and candidate order) is
// covered by lod.test.ts's "measurement pick safety" describe block, which
// needs the LOD-build machinery this file doesn't otherwise use.
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import type { MeshRole, Vec3 } from '@dqcad/shared-types';
import { useCaseStore } from '../state/caseStore';
import { useToolStore } from '../state/toolStore';
import { caseStore } from './caseStore';
import { toolManager, type MeasurePickRequest } from './ToolManager';
import { resetBvhCacheForTests } from './workers';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

function statsForBbox(min: [number, number, number], max: [number, number, number]): MeshStats {
  return {
    watertight: false,
    manifoldEdges: false,
    componentCount: 1,
    bbox: { min, max },
    surfaceAreaMm2: 400,
    signedVolumeMm3: null,
    degenerateCount: 0,
    boundaryEdgeCount: 4,
  };
}

/** A flat 20x20mm quad (2 triangles), centered at the origin in x/y, at
 * height `z`. */
function quadMesh(z: number): { positions: Float64Array; indices: Uint32Array } {
  const positions = new Float64Array([-10, -10, z, 10, -10, z, 10, 10, z, -10, 10, z]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { positions, indices };
}

/** Registers `quadMesh(z)` as a scene node and returns its SceneNode id. */
function registerQuadNode(contentHash: string, z: number, role: MeshRole = 'situ'): string {
  const { positions, indices } = quadMesh(z);
  caseStore.registerImportedMesh({
    contentHash,
    name: `${contentHash}.stl`,
    format: 'stl',
    positions,
    indices,
    stats: statsForBbox([-10, -10, z], [10, 10, z]),
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode(contentHash, role);
  return node.id;
}

/** A straight-down ray from well above the given x/y, in world space. */
function downwardRayAt(x: number, y: number): { rayOrigin: Vec3; rayDirection: Vec3 } {
  return { rayOrigin: [x, y, 100], rayDirection: [0, 0, -1] };
}

beforeEach(() => {
  caseStore.resetForTests();
  toolManager.resetForTests();
  resetBvhCacheForTests();
});

describe('ToolManager — pointToPoint', () => {
  it('two picks on two meshes at different heights produce a distance measurement', async () => {
    const nodeA = registerQuadNode('mesh-a', 0);
    const nodeB = registerQuadNode('mesh-b', 5);

    toolManager.startTool('pointToPoint');
    expect(useToolStore.getState().activeTool).toBe('pointToPoint');

    const pick1: MeasurePickRequest = { candidateNodeIds: [nodeA], ...downwardRayAt(0, 0) };
    await toolManager.handlePick(pick1);
    expect(useToolStore.getState().pendingPointCount).toBe(1);
    expect(useCaseStore.getState().document.measurements).toHaveLength(0);

    const pick2: MeasurePickRequest = { candidateNodeIds: [nodeB], ...downwardRayAt(0, 0) };
    await toolManager.handlePick(pick2);

    // Tool auto-resets to idle once the measurement completes.
    expect(useToolStore.getState().activeTool).toBeNull();
    expect(useToolStore.getState().pendingPointCount).toBe(0);

    const measurements = useCaseStore.getState().document.measurements;
    expect(measurements).toHaveLength(1);
    expect(measurements[0]!.kind).toBe('pointToPoint');
    expect(measurements[0]!.value).toBeCloseTo(5, 9);
    expect(measurements[0]!.points[0]!.position).toEqual([0, 0, 0]);
    expect(measurements[0]!.points[1]!.position).toEqual([0, 0, 5]);
  });

  it('ignores picks when no tool is active', async () => {
    const nodeA = registerQuadNode('mesh-a', 0);
    await toolManager.handlePick({ candidateNodeIds: [nodeA], ...downwardRayAt(0, 0) });
    expect(useCaseStore.getState().document.measurements).toHaveLength(0);
  });

  it('cancelTool discards in-progress picks without recording a measurement', async () => {
    const nodeA = registerQuadNode('mesh-a', 0);
    toolManager.startTool('pointToPoint');
    await toolManager.handlePick({ candidateNodeIds: [nodeA], ...downwardRayAt(0, 0) });
    expect(useToolStore.getState().pendingPointCount).toBe(1);

    toolManager.cancelTool();
    expect(useToolStore.getState().activeTool).toBeNull();
    expect(useToolStore.getState().pendingPointCount).toBe(0);

    // A stray pick after cancelling (no active tool) has no effect.
    await toolManager.handlePick({ candidateNodeIds: [nodeA], ...downwardRayAt(1, 1) });
    expect(useCaseStore.getState().document.measurements).toHaveLength(0);
  });
});

describe('ToolManager — pointToSurface', () => {
  it("measures the closest-point distance from the first pick to the SECOND mesh's whole surface", async () => {
    const nodeA = registerQuadNode('mesh-a', 0);
    const nodeB = registerQuadNode('mesh-b', 5);

    toolManager.startTool('pointToSurface');
    await toolManager.handlePick({ candidateNodeIds: [nodeA], ...downwardRayAt(3, -2) }); // pick on A at (3, -2, 0)
    // Second pick lands anywhere on B — its exact click position is
    // discarded; what matters is the closest point on B's WHOLE surface to
    // the first pick, which for a parallel flat quad is directly above it.
    await toolManager.handlePick({ candidateNodeIds: [nodeB], ...downwardRayAt(7, 6) });

    const measurements = useCaseStore.getState().document.measurements;
    expect(measurements).toHaveLength(1);
    expect(measurements[0]!.kind).toBe('pointToSurface');
    expect(measurements[0]!.value).toBeCloseTo(5, 9);
    expect(measurements[0]!.points[0]!.position).toEqual([3, -2, 0]);
    expect(measurements[0]!.points[1]!.position).toEqual([3, -2, 5]); // NOT the (7,6) click position
  });
});

describe('ToolManager — angle', () => {
  it('computes a right angle at the vertex (second pick) for a corner-shaped set of picks', async () => {
    const nodeA = registerQuadNode('mesh-a', 0);

    toolManager.startTool('angle');
    await toolManager.handlePick({ candidateNodeIds: [nodeA], ...downwardRayAt(-5, -5) });
    await toolManager.handlePick({ candidateNodeIds: [nodeA], ...downwardRayAt(5, -5) }); // vertex
    await toolManager.handlePick({ candidateNodeIds: [nodeA], ...downwardRayAt(5, 5) });

    const measurements = useCaseStore.getState().document.measurements;
    expect(measurements).toHaveLength(1);
    expect(measurements[0]!.kind).toBe('angle');
    expect(measurements[0]!.value).toBeCloseTo(90, 9);
    expect(measurements[0]!.points).toHaveLength(3);
    expect(measurements[0]!.points[1]!.position).toEqual([5, -5, 0]); // vertex is the SECOND pick
  });
});

describe('ToolManager — stale pick handling', () => {
  it('silently ignores a pick against a nodeId that no longer exists', async () => {
    toolManager.startTool('pointToPoint');
    await toolManager.handlePick({ candidateNodeIds: ['not-a-real-node'], ...downwardRayAt(0, 0) });
    expect(useToolStore.getState().pendingPointCount).toBe(0);
    expect(useCaseStore.getState().document.measurements).toHaveLength(0);
  });
});
