import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import type { Operation } from '@dqcad/shared-types';
import { useCaseStore } from '../state/caseStore';
import { caseStore } from './caseStore';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

function statsForBbox(min: [number, number, number], max: [number, number, number]): MeshStats {
  return {
    watertight: true,
    manifoldEdges: true,
    componentCount: 1,
    bbox: { min, max },
    surfaceAreaMm2: 1,
    signedVolumeMm3: 1,
    degenerateCount: 0,
    boundaryEdgeCount: 0,
  };
}

function importOp(contentHash: string, fileHash = 'file-hash'): Operation {
  return {
    id: 'op-1',
    name: 'import-mesh',
    params: { fileName: 'scan.stl', format: 'stl', triangleCount: 1, vertexCount: 3, contentHash },
    inputHashes: [fileHash],
    outputHashes: [contentHash],
    kernelVersion: '0.0.0',
    timestamp: new Date().toISOString(),
  };
}

beforeEach(() => {
  caseStore.resetForTests();
});

describe('caseStore.registerImportedMesh', () => {
  it('adds a MeshAsset and appends the journal Operation(s), publishing to useCaseStore', () => {
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    caseStore.registerImportedMesh({
      contentHash: 'hash-a',
      name: 'scan.stl',
      format: 'stl',
      positions,
      indices,
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      report: EMPTY_REPORT,
      operations: [importOp('hash-a')],
    });

    const doc = useCaseStore.getState().document;
    expect(doc.meshes).toHaveLength(1);
    expect(doc.meshes[0]).toEqual({
      id: 'hash-a',
      contentHash: 'hash-a',
      name: 'scan.stl',
      unit: 'mm',
      triangleCount: 1,
    });
    expect(doc.history).toHaveLength(1);
    expect(doc.history[0]!.name).toBe('import-mesh');
    expect(caseStore.getDocument()).toBe(doc); // engine and published snapshot agree
  });

  it('does not duplicate the MeshAsset on a repeat import of the same content, but still journals the Operation', () => {
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const input = {
      contentHash: 'hash-a',
      name: 'scan.stl',
      format: 'stl' as const,
      positions,
      indices,
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      report: EMPTY_REPORT,
    };
    caseStore.registerImportedMesh({ ...input, operations: [importOp('hash-a')] });
    caseStore.registerImportedMesh({ ...input, operations: [importOp('hash-a')] });

    const doc = useCaseStore.getState().document;
    expect(doc.meshes).toHaveLength(1);
    expect(doc.history).toHaveLength(2); // both import events are journaled
  });

  it('preserves journal order across multiple imports (unit-rescale before import-mesh)', () => {
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const rescaleOp: Operation = {
      id: 'op-rescale',
      name: 'unit-rescale',
      params: { factor: 10, suspectedUnit: 'cm' },
      inputHashes: ['before'],
      outputHashes: ['after'],
      kernelVersion: '0.0.0',
      timestamp: new Date().toISOString(),
    };
    caseStore.registerImportedMesh({
      contentHash: 'hash-a',
      name: 'scan.stl',
      format: 'stl',
      positions,
      indices,
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      report: EMPTY_REPORT,
      operations: [rescaleOp, importOp('hash-a')],
    });
    const doc = useCaseStore.getState().document;
    expect(doc.history.map((op) => op.name)).toEqual(['unit-rescale', 'import-mesh']);
  });
});

describe('caseStore scene node management', () => {
  function registerMesh(contentHash: string): void {
    caseStore.registerImportedMesh({
      contentHash,
      name: 'scan.stl',
      format: 'stl',
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      report: EMPTY_REPORT,
      operations: [importOp(contentHash)],
    });
  }

  it('addSceneNode creates a visible, full-opacity, identity-transform node', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    expect(node.meshId).toBe('hash-a');
    expect(node.role).toBe('upperJaw');
    expect(node.visible).toBe(true);
    expect(node.opacity).toBe(1);
    expect(node.transform).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(useCaseStore.getState().document.scene).toContainEqual(node);
  });

  it('setSceneNodeVisibility / setSceneNodeOpacity update only the targeted node', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    caseStore.setSceneNodeVisibility(node.id, false);
    caseStore.setSceneNodeOpacity(node.id, 0.4);
    const updated = useCaseStore.getState().document.scene.find((n) => n.id === node.id)!;
    expect(updated.visible).toBe(false);
    expect(updated.opacity).toBe(0.4);
  });

  it('setSceneNodeOpacity clamps to [0, 1]', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    caseStore.setSceneNodeOpacity(node.id, 5);
    expect(useCaseStore.getState().document.scene.find((n) => n.id === node.id)!.opacity).toBe(1);
    caseStore.setSceneNodeOpacity(node.id, -5);
    expect(useCaseStore.getState().document.scene.find((n) => n.id === node.id)!.opacity).toBe(0);
  });

  it('removeSceneNode drops the node from the scene', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    caseStore.removeSceneNode(node.id);
    expect(useCaseStore.getState().document.scene).toHaveLength(0);
  });

  it('getRenderNodes resolves each SceneNode against its mesh record', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    const renderNodes = caseStore.getRenderNodes();
    expect(renderNodes).toHaveLength(1);
    expect(renderNodes[0]!.id).toBe(node.id);
    expect(renderNodes[0]!.positions).toBeInstanceOf(Float32Array);
    expect(renderNodes[0]!.visible).toBe(true);
    expect(renderNodes[0]!.opacity).toBe(1);
  });
});
