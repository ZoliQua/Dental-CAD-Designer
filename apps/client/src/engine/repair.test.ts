// engine/repair.ts tests — run through the REAL WorkerPool (Node
// worker_threads path, same convention as importer.test.ts): preview*
// functions call real @dqcad/kernel repair functions via kernel-workers'
// repairRemoveComponents/repairSplitNonManifoldEdges/repairFillSmallHoles
// jobs, and applyRepairPreview commits through the real caseStore. The
// repair ALGORITHMS themselves are exhaustively covered at the kernel level
// (packages/kernel/src/repair/*.test.ts); this file's job is to prove the
// preview/apply split, the journal Operation shape, and the scene-mesh
// replacement wiring.
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import { useCaseStore } from '../state/caseStore';
import { caseStore } from './caseStore';
import {
  applyRepairPreview,
  previewFillSmallHoles,
  previewRemoveComponents,
  previewSplitNonManifoldEdges,
} from './repair';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

// registerImportedMesh stores whatever stats it's given (display metadata) —
// the preview functions below never read `record.stats`, they re-derive
// real MeshStats via a worker-side analyzeMesh call. A placeholder is
// therefore fine here.
const PLACEHOLDER_STATS: MeshStats = {
  watertight: false,
  manifoldEdges: false,
  componentCount: 0,
  bbox: { min: [0, 0, 0], max: [0, 0, 0] },
  surfaceAreaMm2: 0,
  signedVolumeMm3: null,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const CUBE_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 1], [0, 3, 2],
  [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6],
  [0, 4, 7], [0, 7, 3],
];

function cubePositions(): Float64Array {
  return new Float64Array(CUBE_CORNERS.flat());
}
function cubeIndices(): Uint32Array {
  return Uint32Array.from(CUBE_TRIANGLES.flat());
}

function registerMesh(contentHash: string, positions: Float64Array, indices: Uint32Array): void {
  caseStore.registerImportedMesh({
    contentHash,
    name: 'scan.stl',
    format: 'stl',
    positions,
    indices,
    stats: PLACEHOLDER_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
}

beforeEach(() => {
  caseStore.resetForTests();
});

describe('previewRemoveComponents / applyRepairPreview', () => {
  it('previews a small-component removal, then applies it: scene mesh replaced, repair-remove-components journaled', async () => {
    // Cube + a free-floating 1-triangle "speck" — its own small component.
    const positions = new Float64Array(cubePositions().length + 9);
    positions.set(cubePositions(), 0);
    positions.set([100, 100, 100, 101, 100, 100, 100, 101, 100], cubePositions().length);
    const indices = new Uint32Array(cubeIndices().length + 3);
    indices.set(cubeIndices(), 0);
    indices.set([8, 9, 10], cubeIndices().length);

    registerMesh('hash-a', positions, indices);
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    const record = caseStore.getMeshRecord('hash-a')!;

    const preview = await previewRemoveComponents(record, { mode: 'minTriangles', minTriangles: 2 });
    expect(preview.contentHashBefore).toBe('hash-a');
    expect(preview.statsBefore.componentCount).toBe(2);
    expect(preview.statsAfter.componentCount).toBe(1);
    expect(preview.statsAfter.watertight).toBe(true);
    expect(preview.report.removedComponentIds).toEqual([1]);

    // Preview alone must not mutate the case.
    expect(useCaseStore.getState().document.scene.find((n) => n.id === node.id)!.meshId).toBe('hash-a');
    expect(useCaseStore.getState().document.history).toHaveLength(0);
    expect(caseStore.meshStore.has('hash-a')).toBe(true);

    const applied = await applyRepairPreview(preview);

    const doc = useCaseStore.getState().document;
    expect(doc.scene.find((n) => n.id === node.id)!.meshId).toBe(applied.contentHash);
    expect(applied.stats.componentCount).toBe(1);
    expect(applied.stats.watertight).toBe(true);
    expect(caseStore.meshStore.has('hash-a')).toBe(false); // old mesh released (unreferenced)

    // Journal entry shape — this task's brief: `Operation` with input/output
    // hashes, named 'repair-remove-components'.
    expect(doc.history).toHaveLength(1);
    const op = doc.history[0]!;
    expect(op.name).toBe('repair-remove-components');
    expect(typeof op.id).toBe('string');
    expect(op.id.length).toBeGreaterThan(0);
    expect(op.inputHashes).toEqual(['hash-a']);
    expect(op.outputHashes).toEqual([applied.contentHash]);
    expect(op.outputHashes[0]).not.toBe('hash-a');
    expect(typeof op.kernelVersion).toBe('string');
    expect(typeof op.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(op.timestamp))).toBe(false);
    expect(op.params).toMatchObject({ selector: { mode: 'minTriangles', minTriangles: 2 } });
  });
});

describe('previewSplitNonManifoldEdges / applyRepairPreview', () => {
  it('previews resolving a doubled triangle, then applies it: repair-split-non-manifold-edges journaled', async () => {
    const positions = cubePositions();
    const indices = new Uint32Array(cubeIndices().length + 3);
    indices.set(cubeIndices(), 0);
    indices.set(cubeIndices().subarray(0, 3), cubeIndices().length); // duplicate triangle 0

    registerMesh('hash-b', positions, indices);
    caseStore.addSceneNode('hash-b', 'lowerJaw');
    const record = caseStore.getMeshRecord('hash-b')!;

    const preview = await previewSplitNonManifoldEdges(record);
    expect(preview.statsBefore.manifoldEdges).toBe(false);
    expect(preview.statsAfter.manifoldEdges).toBe(true);
    expect(preview.report.duplicatedVertexCount).toBe(3);

    const applied = await applyRepairPreview(preview);
    const doc = useCaseStore.getState().document;
    const op = doc.history[0]!;
    expect(op.name).toBe('repair-split-non-manifold-edges');
    expect(op.inputHashes).toEqual(['hash-b']);
    expect(op.outputHashes).toEqual([applied.contentHash]);
    expect(applied.stats.manifoldEdges).toBe(true);
  });
});

describe('previewFillSmallHoles / applyRepairPreview', () => {
  it('previews filling a single-triangle hole, then applies it: repair-fill-small-holes journaled', async () => {
    // Drop triangle 0 — leaves a clean 3-edge boundary loop over vertices {0,1,2}.
    const positions = cubePositions();
    const indices = Uint32Array.from(cubeIndices().subarray(3));

    registerMesh('hash-c', positions, indices);
    caseStore.addSceneNode('hash-c', 'situ');
    const record = caseStore.getMeshRecord('hash-c')!;

    const preview = await previewFillSmallHoles(record);
    expect(preview.statsBefore.watertight).toBe(false);
    expect(preview.statsAfter.watertight).toBe(true);
    expect(preview.report.loopsFilled).toBe(1);
    expect(preview.report.loopsSkipped).toHaveLength(0);

    const applied = await applyRepairPreview(preview);
    const doc = useCaseStore.getState().document;
    const op = doc.history[0]!;
    expect(op.name).toBe('repair-fill-small-holes');
    expect(op.inputHashes).toEqual(['hash-c']);
    expect(op.outputHashes).toEqual([applied.contentHash]);
    expect(applied.stats.watertight).toBe(true);
  });

  it('previewing with a restrictive maxBoundaryEdges refuses the hole (no crash, honest report)', async () => {
    const positions = cubePositions();
    const indices = Uint32Array.from(cubeIndices().subarray(3));
    registerMesh('hash-d', positions, indices);
    const record = caseStore.getMeshRecord('hash-d')!;

    const preview = await previewFillSmallHoles(record, { maxBoundaryEdges: 2 });
    expect(preview.statsAfter.watertight).toBe(false);
    expect(preview.report.loopsFilled).toBe(0);
    expect(preview.report.loopsSkipped).toHaveLength(1);
    expect(preview.report.loopsSkipped[0]!.reason).toBe('tooManyEdges');
  });
});
