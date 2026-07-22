import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RESTORATION_PARAMS } from '@dqcad/clinical-profiles';
import type { FdiTooth, MarginLine, RestorationParams } from '@dqcad/shared-types';
import { caseStore } from './caseStore';
import { createRestoration, deleteRestoration, PREP_CAPABLE_ROLES, updateRestoration } from './restorations';
import { useCaseStore } from '../state/caseStore';

const CUSTOM_PARAMS: RestorationParams = {
  cementGapMm: 0.06,
  marginalGapMm: 0.03,
  spacerStartMm: 0.9,
  minWallThicknessMm: 0.5,
  proximalContactPenetrationMm: 0.01,
  occlusalContactMm: -0.01,
};

beforeEach(() => {
  caseStore.resetForTests();
});

describe('createRestoration', () => {
  it('creates a crown with default params, empty marginLines/pontics, placeholder axis, and no stages/qc', () => {
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: 'node-1' });

    expect(restoration.type).toBe('crown');
    expect(restoration.teeth).toEqual([11]);
    expect(restoration.pontics).toEqual([]);
    expect(restoration.targetNodeId).toBe('node-1');
    expect(restoration.marginLines).toEqual({});
    expect(restoration.insertionAxis).toEqual([0, 0, 1]);
    expect(restoration.params).toEqual(DEFAULT_RESTORATION_PARAMS);
    expect(restoration.stages).toEqual({});
    expect(restoration.qc).toBeNull();

    const doc = useCaseStore.getState().document;
    expect(doc.restorations).toHaveLength(1);
    expect(doc.restorations[0]).toEqual(restoration);
  });

  it('accepts explicit params overriding the clinical-profiles default', () => {
    const restoration = createRestoration({
      type: 'crown',
      teeth: [11],
      targetNodeId: null,
      params: CUSTOM_PARAMS,
    });
    expect(restoration.params).toEqual(CUSTOM_PARAMS);
  });

  it('journals a restoration-create Operation with a full params snapshot, no geometry hashes', () => {
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: 'node-1' });
    const doc = useCaseStore.getState().document;
    expect(doc.history).toHaveLength(1);
    const op = doc.history[0]!;
    expect(op.name).toBe('restoration-create');
    expect(op.inputHashes).toEqual([]);
    expect(op.outputHashes).toEqual([]);
    expect(op.params['restorationId']).toBe(restoration.id);
    expect(op.params['type']).toBe('crown');
    expect(op.params['teeth']).toEqual([11]);
    expect(op.params['targetNodeId']).toBe('node-1');
    expect(op.params['params']).toEqual(DEFAULT_RESTORATION_PARAMS);
  });

  it('selects the newly created restoration', () => {
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: null });
    expect(caseStore.getSelectedRestorationId()).toBe(restoration.id);
    expect(useCaseStore.getState().selectedRestorationId).toBe(restoration.id);
  });

  it('forces pontics to [] for a crown even if some were (incorrectly) supplied', () => {
    const restoration = createRestoration({
      type: 'crown',
      teeth: [11],
      pontics: [11] as readonly FdiTooth[],
      targetNodeId: null,
    });
    expect(restoration.pontics).toEqual([]);
  });

  it('bridge: keeps only pontics that are actually in teeth, de-duplicated', () => {
    const teeth: FdiTooth[] = [12, 11, 21, 22];
    const restoration = createRestoration({
      type: 'bridge',
      teeth,
      pontics: [11, 11, 21, 99 as FdiTooth], // 21 duped; 99 isn't in teeth
      targetNodeId: 'node-1',
    });
    expect(restoration.pontics.slice().sort()).toEqual([11, 21]);
  });

  it('real arch-case-01 shape: 12,11,21,22 as one bridge with 11+21 abutments implied (12,22 pontics)', () => {
    const teeth: FdiTooth[] = [12, 11, 21, 22];
    const restoration = createRestoration({
      type: 'bridge',
      teeth,
      pontics: [12, 22],
      targetNodeId: 'node-1',
    });
    expect(restoration.teeth).toEqual(teeth);
    expect(restoration.pontics.slice().sort()).toEqual([12, 22]);
    // Abutments = teeth not marked pontic.
    const abutments = restoration.teeth.filter((t) => !restoration.pontics.includes(t));
    expect(abutments.slice().sort()).toEqual([11, 21]);
  });
});

describe('updateRestoration', () => {
  it('patches only the given fields, preserving the rest', () => {
    const created = createRestoration({ type: 'crown', teeth: [11], targetNodeId: 'node-1' });
    const updated = updateRestoration(created.id, { teeth: [12] });
    expect(updated.teeth).toEqual([12]);
    expect(updated.targetNodeId).toBe('node-1'); // unchanged
    expect(updated.params).toEqual(DEFAULT_RESTORATION_PARAMS); // unchanged
    expect(updated.id).toBe(created.id);
  });

  it('an explicit targetNodeId: null clears it (distinct from omitting the field)', () => {
    const created = createRestoration({ type: 'crown', teeth: [11], targetNodeId: 'node-1' });
    const updated = updateRestoration(created.id, { targetNodeId: null });
    expect(updated.targetNodeId).toBeNull();
  });

  it('re-normalizes pontics when switching type away from bridge', () => {
    const created = createRestoration({
      type: 'bridge',
      teeth: [12, 11, 21, 22],
      pontics: [12, 22],
      targetNodeId: 'node-1',
    });
    const updated = updateRestoration(created.id, { type: 'crown', teeth: [11] });
    expect(updated.pontics).toEqual([]);
  });

  it('journals a restoration-update Operation with the new snapshot', () => {
    const created = createRestoration({ type: 'crown', teeth: [11], targetNodeId: null });
    updateRestoration(created.id, { targetNodeId: 'node-2' });
    const doc = useCaseStore.getState().document;
    expect(doc.history).toHaveLength(2);
    const op = doc.history[1]!;
    expect(op.name).toBe('restoration-update');
    expect(op.params['targetNodeId']).toBe('node-2');
  });

  it('throws for an unknown restoration id', () => {
    expect(() => updateRestoration('does-not-exist', { targetNodeId: 'node-1' })).toThrow(/no restoration/);
  });
});

describe('deleteRestoration', () => {
  it('removes the restoration and journals a restoration-delete Operation recording what was deleted', () => {
    const created = createRestoration({ type: 'crown', teeth: [11], targetNodeId: null });
    deleteRestoration(created.id);

    const doc = useCaseStore.getState().document;
    expect(doc.restorations).toHaveLength(0);
    expect(doc.history).toHaveLength(2);
    const op = doc.history[1]!;
    expect(op.name).toBe('restoration-delete');
    expect(op.params['restorationId']).toBe(created.id);
    expect(op.params['type']).toBe('crown');
    expect(op.params['teeth']).toEqual([11]);
    // A bare restoration (no margins, placeholder axis) still gets the new
    // fields — empty/placeholder, not omitted (Task-11-review Critical 2).
    expect(op.params['marginLines']).toEqual({});
    expect(op.params['insertionAxis']).toEqual([0, 0, 1]);
  });

  it('delete-with-margins: snapshots marginLines and a non-placeholder insertionAxis into the delete op params (Task-11-review Critical 2 — journal completeness)', () => {
    const created = createRestoration({ type: 'crown', teeth: [11], targetNodeId: null });
    const marginLine: MarginLine = {
      anchors: [
        { position: [0, 0, 0], triangleIndex: 0, barycentric: [1, 0, 0] },
        { position: [1, 0, 0], triangleIndex: 0, barycentric: [0, 1, 0] },
        { position: [0, 1, 0], triangleIndex: 0, barycentric: [0, 0, 1] },
      ],
      closed: true,
    };
    const current = useCaseStore.getState().document.restorations[0]!;
    caseStore.updateRestoration(
      { ...current, marginLines: { 11: marginLine }, insertionAxis: [0.1, 0.2, 0.9746794] },
      {
        id: 'op-set-margin',
        name: 'margin-edit',
        params: {},
        inputHashes: [],
        outputHashes: [],
        kernelVersion: '0.0.0-test',
        timestamp: new Date().toISOString(),
      },
    );

    deleteRestoration(created.id);

    const doc = useCaseStore.getState().document;
    const op = doc.history.at(-1)!;
    expect(op.name).toBe('restoration-delete');
    expect(op.params['marginLines']).toEqual({ 11: marginLine });
    expect(op.params['insertionAxis']).toEqual([0.1, 0.2, 0.9746794]);
  });

  it('clears selection if the deleted restoration was selected', () => {
    const created = createRestoration({ type: 'crown', teeth: [11], targetNodeId: null });
    expect(caseStore.getSelectedRestorationId()).toBe(created.id);
    deleteRestoration(created.id);
    expect(caseStore.getSelectedRestorationId()).toBeNull();
  });

  it('is tolerant of an already-deleted id (still journals)', () => {
    expect(() => deleteRestoration('never-existed')).not.toThrow();
    const doc = useCaseStore.getState().document;
    expect(doc.history).toHaveLength(1);
    expect(doc.history[0]!.name).toBe('restoration-delete');
  });
});

describe('PREP_CAPABLE_ROLES', () => {
  it('is exactly prepDie/upperJaw/lowerJaw', () => {
    expect(PREP_CAPABLE_ROLES).toEqual(['prepDie', 'upperJaw', 'lowerJaw']);
  });
});
