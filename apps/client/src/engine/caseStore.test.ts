import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import type { Measurement, Operation } from '@dqcad/shared-types';
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

  it('removeSceneNode releases the mesh from meshStore when it was the last node referencing it', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    expect(caseStore.meshStore.has('hash-a')).toBe(true);

    caseStore.removeSceneNode(node.id);

    expect(caseStore.meshStore.has('hash-a')).toBe(false);
    expect(caseStore.meshStore.get('hash-a')).toBeUndefined();
    // The MeshAsset itself is journal/history metadata, not a live buffer —
    // it stays in document.meshes even after the buffers are released.
    expect(useCaseStore.getState().document.meshes.some((m) => m.contentHash === 'hash-a')).toBe(true);
  });

  it('removeSceneNode does NOT release the mesh while another node still references it', () => {
    registerMesh('hash-a');
    const nodeA = caseStore.addSceneNode('hash-a', 'upperJaw');
    const nodeB = caseStore.addSceneNode('hash-a', 'antagonist');

    caseStore.removeSceneNode(nodeA.id);

    expect(caseStore.meshStore.has('hash-a')).toBe(true);
    expect(useCaseStore.getState().document.scene).toHaveLength(1);
    expect(useCaseStore.getState().document.scene[0]!.id).toBe(nodeB.id);
  });

  it('re-importing the same content hash after removal works and yields fresh, usable buffers', () => {
    registerMesh('hash-a');
    const firstNode = caseStore.addSceneNode('hash-a', 'upperJaw');
    caseStore.removeSceneNode(firstNode.id);
    expect(caseStore.meshStore.has('hash-a')).toBe(false);

    // Re-import: registerImportedMesh -> meshStore.register must NOT return
    // a stale/deleted record just because document.meshes still lists the
    // MeshAsset — it should see the registry has no live record and store a
    // fresh one.
    registerMesh('hash-a');
    expect(caseStore.meshStore.has('hash-a')).toBe(true);

    const secondNode = caseStore.addSceneNode('hash-a', 'upperJaw');
    const renderNodes = caseStore.getRenderNodes();
    const renderNode = renderNodes.find((n) => n.id === secondNode.id);
    expect(renderNode).toBeDefined();
    expect(renderNode!.positions).toBeInstanceOf(Float32Array);
    expect(renderNode!.positions.length).toBeGreaterThan(0);
  });

  it('getRenderNodes resolves each SceneNode against its mesh record, including its role', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    const renderNodes = caseStore.getRenderNodes();
    expect(renderNodes).toHaveLength(1);
    expect(renderNodes[0]!.id).toBe(node.id);
    expect(renderNodes[0]!.positions).toBeInstanceOf(Float32Array);
    expect(renderNodes[0]!.visible).toBe(true);
    expect(renderNodes[0]!.opacity).toBe(1);
    expect(renderNodes[0]!.role).toBe('upperJaw');
  });

  it('getRenderWorldOffset mirrors meshStore.getWorldOffset', () => {
    registerMesh('hash-a');
    caseStore.addSceneNode('hash-a', 'upperJaw');
    expect(caseStore.getRenderWorldOffset()).toEqual(caseStore.meshStore.getWorldOffset());
  });
});

describe('caseStore.applyRepair', () => {
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

  function repairOp(inputHash: string, outputHash: string): Operation {
    return {
      id: 'op-repair',
      name: 'repair-remove-components',
      params: { selector: { mode: 'minTriangles', minTriangles: 2 } },
      inputHashes: [inputHash],
      outputHashes: [outputHash],
      kernelVersion: '0.0.0',
      timestamp: new Date().toISOString(),
    };
  }

  function measurementOnNode(id: string, nodeId: string): Measurement {
    return {
      id,
      kind: 'pointToPoint',
      points: [
        { nodeId, position: [0, 0, 0] },
        { nodeId, position: [1, 0, 0] },
      ],
      value: 1,
      createdAt: new Date().toISOString(),
    };
  }

  it('registers the repaired mesh, repoints the SceneNode, and appends the journal Operation', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');

    const repairedPositions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const repairedIndices = new Uint32Array([0, 1, 2]);
    const record = caseStore.applyRepair({
      previousContentHash: 'hash-a',
      positions: repairedPositions,
      indices: repairedIndices,
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      operation: repairOp('hash-a', 'hash-a-repaired'),
    });

    expect(record.contentHash).toBe('hash-a-repaired');
    const doc = useCaseStore.getState().document;
    expect(doc.scene.find((n) => n.id === node.id)!.meshId).toBe('hash-a-repaired');
    expect(doc.history.at(-1)!.name).toBe('repair-remove-components');
    expect(doc.history.at(-1)!.inputHashes).toEqual(['hash-a']);
    expect(doc.history.at(-1)!.outputHashes).toEqual(['hash-a-repaired']);
    expect(doc.meshes.some((m) => m.contentHash === 'hash-a-repaired')).toBe(true);
  });

  it('releases the pre-repair mesh buffers/BVH once no SceneNode references it anymore', () => {
    registerMesh('hash-a');
    caseStore.addSceneNode('hash-a', 'upperJaw');
    expect(caseStore.meshStore.has('hash-a')).toBe(true);

    caseStore.applyRepair({
      previousContentHash: 'hash-a',
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      operation: repairOp('hash-a', 'hash-a-repaired'),
    });

    expect(caseStore.meshStore.has('hash-a')).toBe(false);
    expect(caseStore.meshStore.has('hash-a-repaired')).toBe(true);
  });

  it('repoints EVERY SceneNode referencing the pre-repair mesh, not just the first', () => {
    registerMesh('hash-a');
    const nodeA = caseStore.addSceneNode('hash-a', 'upperJaw');
    const nodeB = caseStore.addSceneNode('hash-a', 'antagonist');

    caseStore.applyRepair({
      previousContentHash: 'hash-a',
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      operation: repairOp('hash-a', 'hash-a-repaired'),
    });

    const doc = useCaseStore.getState().document;
    expect(doc.scene.find((n) => n.id === nodeA.id)!.meshId).toBe('hash-a-repaired');
    expect(doc.scene.find((n) => n.id === nodeB.id)!.meshId).toBe('hash-a-repaired');
    // Both references moved to the new hash — the old one is now fully
    // unreferenced and gets released (same "last reference gone" rule
    // removeSceneNode uses, just reaching zero in one call here instead of
    // incrementally).
    expect(caseStore.meshStore.has('hash-a')).toBe(false);
  });

  it('leaves an UNRELATED SceneNode (different mesh) untouched', () => {
    registerMesh('hash-a');
    registerMesh('hash-b');
    caseStore.addSceneNode('hash-a', 'upperJaw');
    const nodeB = caseStore.addSceneNode('hash-b', 'lowerJaw');

    caseStore.applyRepair({
      previousContentHash: 'hash-a',
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      operation: repairOp('hash-a', 'hash-a-repaired'),
    });

    const doc = useCaseStore.getState().document;
    expect(doc.scene.find((n) => n.id === nodeB.id)!.meshId).toBe('hash-b');
    expect(caseStore.meshStore.has('hash-b')).toBe(true);
  });

  it('throws if previousContentHash has no registered mesh', () => {
    expect(() =>
      caseStore.applyRepair({
        previousContentHash: 'nonexistent',
        positions: new Float64Array(0),
        indices: new Uint32Array(0),
        stats: statsForBbox([0, 0, 0], [0, 0, 0]),
        operation: repairOp('nonexistent', 'new-hash'),
      }),
    ).toThrow();
  });

  it('throws if the operation carries no outputHashes[0]', () => {
    registerMesh('hash-a');
    const badOp: Operation = { ...repairOp('hash-a', 'unused'), outputHashes: [] };
    expect(() =>
      caseStore.applyRepair({
        previousContentHash: 'hash-a',
        positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        stats: statsForBbox([0, 0, 0], [1, 1, 0]),
        operation: badOp,
      }),
    ).toThrow();
  });

  // A repaired mesh's SceneNode keeps its id but gets a NEW meshId — any
  // Measurement whose points reference that node were snapshotted against
  // the PRE-repair surface, so they'd silently display a stale value against
  // the repaired mesh if left in place (this project's "a silently wrong
  // value is worse than no value" principle — see applyRepair's doc).
  it('removes every measurement anchored to a repointed node, keeps unrelated ones, and records the removal on the journal Operation', () => {
    registerMesh('hash-a');
    registerMesh('hash-b');
    const nodeA = caseStore.addSceneNode('hash-a', 'upperJaw');
    const nodeB = caseStore.addSceneNode('hash-b', 'lowerJaw');

    caseStore.addMeasurement(measurementOnNode('m-1', nodeA.id));
    caseStore.addMeasurement(measurementOnNode('m-2', nodeA.id));
    const kept = measurementOnNode('m-3', nodeB.id);
    caseStore.addMeasurement(kept);

    caseStore.applyRepair({
      previousContentHash: 'hash-a',
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      operation: repairOp('hash-a', 'hash-a-repaired'),
    });

    const doc = useCaseStore.getState().document;
    expect(doc.measurements).toEqual([kept]);

    const op = doc.history.at(-1)!;
    expect(op.params.measurementsCleared).toBe(2);
    expect(op.params.clearedMeasurementIds).toEqual(['m-1', 'm-2']);
  });

  it('records measurementsCleared: 0 (and omits clearedMeasurementIds) when a repair touches no measurements — no journal noise', () => {
    registerMesh('hash-a');
    caseStore.addSceneNode('hash-a', 'upperJaw');

    caseStore.applyRepair({
      previousContentHash: 'hash-a',
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      operation: repairOp('hash-a', 'hash-a-repaired'),
    });

    const op = useCaseStore.getState().document.history.at(-1)!;
    expect(op.params.measurementsCleared).toBe(0);
    expect('clearedMeasurementIds' in op.params).toBe(false);
  });
});

describe('caseStore selection', () => {
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

  it('starts with no selection', () => {
    expect(caseStore.getSelectedNodeId()).toBeNull();
    expect(useCaseStore.getState().selectedNodeId).toBeNull();
  });

  it('setSelectedNodeId publishes the id to state/caseStore.ts', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    caseStore.setSelectedNodeId(node.id);
    expect(caseStore.getSelectedNodeId()).toBe(node.id);
    expect(useCaseStore.getState().selectedNodeId).toBe(node.id);
  });

  it('setSelectedNodeId(null) clears the selection', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    caseStore.setSelectedNodeId(node.id);
    caseStore.setSelectedNodeId(null);
    expect(caseStore.getSelectedNodeId()).toBeNull();
    expect(useCaseStore.getState().selectedNodeId).toBeNull();
  });

  it('removeSceneNode clears the selection if the removed node was selected', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    caseStore.setSelectedNodeId(node.id);
    caseStore.removeSceneNode(node.id);
    expect(caseStore.getSelectedNodeId()).toBeNull();
    expect(useCaseStore.getState().selectedNodeId).toBeNull();
  });

  it('removeSceneNode leaves an unrelated selection untouched', () => {
    registerMesh('hash-a');
    registerMesh('hash-b');
    const nodeA = caseStore.addSceneNode('hash-a', 'upperJaw');
    const nodeB = caseStore.addSceneNode('hash-b', 'lowerJaw');
    caseStore.setSelectedNodeId(nodeB.id);
    caseStore.removeSceneNode(nodeA.id);
    expect(caseStore.getSelectedNodeId()).toBe(nodeB.id);
  });
});

describe('caseStore.setMeshAssetFileHash (Task 11)', () => {
  it('stamps fileHash onto the matching MeshAsset without touching anything else', () => {
    caseStore.registerImportedMesh({
      contentHash: 'hash-a',
      name: 'scan.stl',
      format: 'stl',
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      report: EMPTY_REPORT,
      operations: [importOp('hash-a')],
    });
    const before = useCaseStore.getState().document;

    caseStore.setMeshAssetFileHash('hash-a', 'file-hash-xyz');

    const after = useCaseStore.getState().document;
    expect(after).not.toBe(before); // a real publish happened
    expect(after.meshes[0]).toEqual({
      id: 'hash-a',
      contentHash: 'hash-a',
      name: 'scan.stl',
      unit: 'mm',
      triangleCount: 1,
      fileHash: 'file-hash-xyz',
    });
    expect(after.history).toEqual(before.history); // journal untouched
  });

  it('is a no-op for an unknown contentHash', () => {
    const before = useCaseStore.getState().document;
    caseStore.setMeshAssetFileHash('no-such-hash', 'file-hash-xyz');
    expect(useCaseStore.getState().document).toBe(before);
  });

  it('is a no-op (no re-publish) if the fileHash is already set to the same value', () => {
    caseStore.registerImportedMesh({
      contentHash: 'hash-a',
      name: 'scan.stl',
      format: 'stl',
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      stats: statsForBbox([0, 0, 0], [1, 1, 0]),
      report: EMPTY_REPORT,
      operations: [importOp('hash-a')],
    });
    caseStore.setMeshAssetFileHash('hash-a', 'file-hash-xyz');
    const afterFirst = useCaseStore.getState().document;

    caseStore.setMeshAssetFileHash('hash-a', 'file-hash-xyz');
    expect(useCaseStore.getState().document).toBe(afterFirst);
  });
});

describe('caseStore.loadDocument (Task 11)', () => {
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

  it('installs the document in one atomic publish and clears any prior selection', () => {
    registerMesh('hash-a');
    const node = caseStore.addSceneNode('hash-a', 'upperJaw');
    caseStore.setSelectedNodeId(node.id);

    const incoming = {
      ...useCaseStore.getState().document,
      id: 'loaded-case-id',
    };
    caseStore.loadDocument(incoming);

    expect(useCaseStore.getState().document).toBe(incoming);
    expect(caseStore.getDocument()).toBe(incoming);
    expect(caseStore.getSelectedNodeId()).toBeNull();
    expect(useCaseStore.getState().selectedNodeId).toBeNull();
  });

  it('does NOT touch meshStore — the caller is responsible for registering referenced meshes first', () => {
    registerMesh('hash-a');
    expect(caseStore.meshStore.has('hash-a')).toBe(true);

    const incoming = { ...useCaseStore.getState().document, id: 'loaded-case-id' };
    caseStore.loadDocument(incoming);

    // meshStore is untouched by loadDocument itself (still has the mesh
    // registered from this test's own setup, not because loadDocument did
    // anything to it).
    expect(caseStore.meshStore.has('hash-a')).toBe(true);
  });
});
