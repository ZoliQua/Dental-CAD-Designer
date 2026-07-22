import { describe, expect, it } from 'vitest';
import type { CaseDocument, FdiTooth, Restoration } from './index.js';

describe('CaseDocument', () => {
  const upperLeftFirstMolar: FdiTooth = 26;

  const restoration: Restoration = {
    id: 'restoration-1',
    type: 'crown',
    teeth: [upperLeftFirstMolar],
    pontics: [],
    targetNodeId: 'node-1',
    marginLines: {
      [upperLeftFirstMolar]: {
        anchors: [
          { position: [0, 0, 0], triangleIndex: 0, barycentric: [1, 0, 0] },
          { position: [1, 0, 0], triangleIndex: 1, barycentric: [1, 0, 0] },
          { position: [1, 1, 0], triangleIndex: 2, barycentric: [1, 0, 0] },
          { position: [0, 1, 0], triangleIndex: 3, barycentric: [1, 0, 0] },
        ],
        closed: true,
      },
    },
    insertionAxis: [0, 0, 1],
    params: {
      cementGapMm: 0.05,
      marginalGapMm: 0.02,
      spacerStartMm: 0.75,
      minWallThicknessMm: 0.5,
      proximalContactPenetrationMm: 0.02,
      occlusalContactMm: 0,
    },
    stages: {},
    qc: null,
  };

  const caseDocument: CaseDocument = {
    id: 'case-1',
    schemaVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    meshes: [
      {
        id: 'mesh-1',
        contentHash: 'sha256:deadbeef',
        name: 'prep-die.stl',
        unit: 'mm',
        triangleCount: 12000,
      },
    ],
    scene: [
      {
        id: 'node-1',
        meshId: 'mesh-1',
        role: 'prepDie',
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        visible: true,
        opacity: 1,
      },
    ],
    restorations: [restoration],
    measurements: [],
    history: [],
    settings: {
      materialProfileId: 'zirconia-default',
      profileVersion: '1.0.0',
    },
  };

  it('constructs a minimal valid case document', () => {
    expect(caseDocument.schemaVersion).toBe(2);
    expect(caseDocument.meshes).toHaveLength(1);
    expect(caseDocument.restorations).toHaveLength(1);
  });

  it('keys margin lines by FDI tooth number', () => {
    const marginLine = caseDocument.restorations[0]?.marginLines[26];
    expect(marginLine?.closed).toBe(true);
    expect(marginLine?.anchors).toHaveLength(4);
    expect(marginLine?.anchors[0]?.position).toEqual([0, 0, 0]);
  });

  it('stores scene transforms as a 16-element column-major matrix', () => {
    const node = caseDocument.scene[0];
    expect(node?.transform).toHaveLength(16);
  });
});
