// apps/client/src/engine/neighbourCapture.test.ts
//
// Phase 9 Task 3 — the pure helpers behind neighbour / antagonist capture
// from the case's own scans (engine/neighbourCapture.ts).
import { describe, expect, it } from 'vitest';
import {
  ANTAGONIST_CONFIRM_OP,
  NEIGHBOUR_CAPTURE_OP,
  type CaseDocument,
  type FdiTooth,
  type Operation,
  type SceneNode,
} from '@dqcad/shared-types';
import {
  adjacentTeeth,
  confirmedAntagonistNodeId,
  findArchScan,
  findOppositeArchScan,
  jawOfTooth,
  latestNeighbourCapture,
} from './neighbourCapture';

function node(id: string, role: SceneNode['role'], meshId = `mesh-${id}`): SceneNode {
  return {
    id,
    meshId,
    role,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    visible: true,
    opacity: 1,
  };
}

function op(name: string, params: Record<string, unknown>, inputHashes: string[] = []): Operation {
  return {
    id: `${name}-${JSON.stringify(params)}`,
    name,
    params,
    inputHashes,
    outputHashes: ['out'],
    kernelVersion: 't',
    timestamp: 't',
  };
}

function doc(scene: SceneNode[], history: readonly Operation[] = []): CaseDocument {
  return {
    id: 'c',
    schemaVersion: 2,
    createdAt: 't',
    meshes: [],
    scene,
    restorations: [],
    measurements: [],
    history,
    settings: {} as CaseDocument['settings'],
  };
}

describe('jawOfTooth / adjacentTeeth (FDI)', () => {
  it('maps quadrants 1–2 to the upper jaw and 3–4 to the lower jaw', () => {
    expect(jawOfTooth(11 as FdiTooth)).toBe('upperJaw');
    expect(jawOfTooth(27 as FdiTooth)).toBe('upperJaw');
    expect(jawOfTooth(36 as FdiTooth)).toBe('lowerJaw');
    expect(jawOfTooth(48 as FdiTooth)).toBe('lowerJaw');
  });

  it('mesial is toward the midline (across it for a central incisor), distal away; none past the third molar', () => {
    expect(adjacentTeeth(11 as FdiTooth)).toEqual({ mesial: 21, distal: 12 });
    expect(adjacentTeeth(21 as FdiTooth)).toEqual({ mesial: 11, distal: 22 });
    expect(adjacentTeeth(31 as FdiTooth)).toEqual({ mesial: 41, distal: 32 });
    expect(adjacentTeeth(46 as FdiTooth)).toEqual({ mesial: 45, distal: 47 });
    expect(adjacentTeeth(18 as FdiTooth)).toEqual({ mesial: 17, distal: null });
  });
});

describe('findArchScan / findOppositeArchScan', () => {
  it('prefers the restoration target when it is the tooth’s arch scan', () => {
    const d = doc([node('u1', 'upperJaw'), node('u2', 'upperJaw')]);
    expect(findArchScan(d, 11 as FdiTooth, 'u2')?.id).toBe('u2');
  });

  it('falls back to the first scan with the tooth’s jaw role; never the other jaw or a die', () => {
    const d = doc([node('die', 'prepDie'), node('low', 'lowerJaw'), node('up', 'upperJaw')]);
    expect(findArchScan(d, 11 as FdiTooth, 'die')?.id).toBe('up');
    expect(findArchScan(d, 36 as FdiTooth, 'die')?.id).toBe('low');
    expect(
      findArchScan(doc([node('die', 'prepDie'), node('low', 'lowerJaw')]), 11 as FdiTooth, 'die'),
    ).toBeNull();
  });

  it('the opposite arch is the other jaw role', () => {
    const d = doc([node('low', 'lowerJaw'), node('up', 'upperJaw')]);
    expect(findOppositeArchScan(d, 11 as FdiTooth)?.id).toBe('low');
    expect(findOppositeArchScan(d, 46 as FdiTooth)?.id).toBe('up');
    expect(findOppositeArchScan(doc([node('up', 'upperJaw')]), 11 as FdiTooth)).toBeNull();
  });
});

describe('journal lookups', () => {
  it('latestNeighbourCapture: the last capture op for this restoration and side', () => {
    const history = [
      op(NEIGHBOUR_CAPTURE_OP, { restorationId: 'r', side: 'mesial', n: 1 }),
      op(NEIGHBOUR_CAPTURE_OP, { restorationId: 'r', side: 'distal', n: 2 }),
      op(NEIGHBOUR_CAPTURE_OP, { restorationId: 'other', side: 'mesial', n: 3 }),
      op(NEIGHBOUR_CAPTURE_OP, { restorationId: 'r', side: 'mesial', n: 4 }),
    ];
    expect(latestNeighbourCapture(history, 'r', 'mesial')?.params['n']).toBe(4);
    expect(latestNeighbourCapture(history, 'r', 'distal')?.params['n']).toBe(2);
    expect(latestNeighbourCapture(history, 'x', 'distal')).toBeUndefined();
  });

  it('confirmedAntagonistNodeId: the latest confirmation whose scan is still in the scene', () => {
    const scene = [node('low', 'lowerJaw'), node('up', 'upperJaw')];
    expect(confirmedAntagonistNodeId(doc(scene), 'r')).toBeNull();
    const confirmed = doc(scene, [
      op(ANTAGONIST_CONFIRM_OP, { restorationId: 'r', scanNodeId: 'low' }, ['mesh-low']),
    ]);
    expect(confirmedAntagonistNodeId(confirmed, 'r')).toBe('low');
    expect(confirmedAntagonistNodeId(confirmed, 'other')).toBeNull();
    const gone = doc([node('up', 'upperJaw')], confirmed.history);
    expect(confirmedAntagonistNodeId(gone, 'r')).toBeNull();
  });
});
