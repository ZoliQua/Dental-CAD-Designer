// apps/client/src/engine/cavityWorkflow.test.ts
//
// Node-lane unit tests for the PURE inlay/onlay (cavity) design state machine
// (no worker, no store) — the order-enforcement heart of Phase 5 Task 8. Covers
// the stage-prerequisite matrix, the restoration-type-awareness (cuspCoverage is
// onlay-only), and the full downstream-invalidation cascade (the P4 Critical
// lesson: an upstream re-run clears every downstream hash + qc).
import { describe, expect, it } from 'vitest';
import type { MarginLine, QcReport, Restoration, RestorationParams, RestorationType, Vec3 } from '@dqcad/shared-types';
import {
  cavityStages,
  canRunCavityStage,
  cavityDownstreamInvalidations,
  cavityWorkflowGates,
  firstCavityOutline,
  isCavityQcStale,
  isCavityStageComplete,
  nextRunnableCavityStage,
  cavityStageGate,
} from './cavityWorkflow';

const PARAMS: RestorationParams = {
  cementGapMm: 0.05,
  marginalGapMm: 0.02,
  spacerStartMm: 0.8,
  minWallThicknessMm: 1.0,
  proximalContactPenetrationMm: 0.02,
  occlusalContactMm: 0,
};

function ring(n: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    out.push([Math.cos(t), Math.sin(t), 0]);
  }
  return out;
}

function outlineWithResampled(): MarginLine {
  return { anchors: [], closed: true, resampledPoints: ring(64) };
}
function outlineAnchorsOnly(): MarginLine {
  return {
    anchors: ring(5).map((position) => ({ position, triangleIndex: 0, barycentric: [1, 0, 0] as const })),
    closed: true,
  };
}

const EMPTY_QC: QcReport = {
  gates: [],
  passed: true,
  kernelVersion: '0.0.0',
  profileVersion: 'test',
  journalHash: 'jh',
};

function restoration(type: RestorationType, overrides: Partial<Restoration> = {}): Restoration {
  return {
    id: 'r1',
    type,
    teeth: [16],
    pontics: [],
    targetNodeId: 'node-1',
    marginLines: { 16: outlineWithResampled() },
    insertionAxis: [0, 0, 1],
    params: PARAMS,
    stages: {},
    qc: null,
    ...overrides,
  };
}

describe('cavityStages (restoration-type-aware)', () => {
  it('an inlay has NO cuspCoverage stage', () => {
    expect(cavityStages('inlay')).toEqual(['outline', 'fit', 'patch', 'contacts', 'shell', 'qc']);
  });
  it('an onlay includes cuspCoverage between contacts and shell', () => {
    expect(cavityStages('onlay')).toEqual(['outline', 'fit', 'patch', 'contacts', 'cuspCoverage', 'shell', 'qc']);
  });
});

describe('firstCavityOutline', () => {
  it('returns null when there are no outline lines', () => {
    expect(firstCavityOutline(restoration('inlay', { marginLines: {} }))).toBeNull();
  });
  it('prefers resampledPoints, falls back to anchors', () => {
    expect(firstCavityOutline(restoration('inlay'))?.points.length).toBe(64);
    expect(firstCavityOutline(restoration('inlay', { marginLines: { 16: outlineAnchorsOnly() } }))?.points.length).toBe(5);
  });
  it('rejects a degenerate (<3 point) outline', () => {
    const degenerate: MarginLine = { anchors: [], closed: true, resampledPoints: [[0, 0, 0]] };
    expect(firstCavityOutline(restoration('inlay', { marginLines: { 16: degenerate } }))).toBeNull();
  });
});

describe('isCavityStageComplete', () => {
  it('reads the matching stages hash / outline / qc', () => {
    expect(isCavityStageComplete('outline', restoration('inlay'))).toBe(true);
    expect(isCavityStageComplete('outline', restoration('inlay', { marginLines: {} }))).toBe(false);
    expect(isCavityStageComplete('fit', restoration('inlay', { stages: { fitSurface: 'h' } }))).toBe(true);
    expect(isCavityStageComplete('patch', restoration('inlay', { stages: { occlusalPatch: 'h' } }))).toBe(true);
    expect(isCavityStageComplete('contacts', restoration('inlay', { stages: { proximalContacts: 'h' } }))).toBe(true);
    expect(isCavityStageComplete('cuspCoverage', restoration('onlay', { stages: { cuspCoverage: 'h' } }))).toBe(true);
    expect(isCavityStageComplete('shell', restoration('inlay', { stages: { finalMesh: 'h' } }))).toBe(true);
    expect(isCavityStageComplete('qc', restoration('inlay', { qc: EMPTY_QC }))).toBe(true);
  });
});

describe('order enforcement', () => {
  it('fit is blocked without a target scan / without an outline', () => {
    expect(cavityStageGate('fit', restoration('inlay', { targetNodeId: null })).reason).toBe('noTargetScan');
    expect(cavityStageGate('fit', restoration('inlay', { marginLines: {} })).reason).toBe('noCavityOutline');
    expect(canRunCavityStage('fit', restoration('inlay'))).toBe(true);
  });

  it('patch → contacts require their predecessors', () => {
    expect(cavityStageGate('patch', restoration('inlay')).reason).toBe('fitIncomplete');
    expect(canRunCavityStage('patch', restoration('inlay', { stages: { fitSurface: 'h' } }))).toBe(true);
    expect(cavityStageGate('contacts', restoration('inlay', { stages: { fitSurface: 'h' } })).reason).toBe('patchIncomplete');
    expect(canRunCavityStage('contacts', restoration('inlay', { stages: { fitSurface: 'h', occlusalPatch: 'h' } }))).toBe(true);
  });

  it('ONLAY: cuspCoverage gates the shell; an inlay skips straight to shell', () => {
    const onlayContacts = restoration('onlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h' } });
    expect(cavityStageGate('cuspCoverage', onlayContacts).allowed).toBe(true);
    // Onlay shell is blocked until cuspCoverage completes.
    expect(cavityStageGate('shell', onlayContacts).reason).toBe('cuspCoverageIncomplete');
    expect(canRunCavityStage('shell', restoration('onlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h', cuspCoverage: 'h' } }))).toBe(true);
    // Inlay shell runs right after contacts (no cuspCoverage in the way).
    expect(canRunCavityStage('shell', restoration('inlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h' } }))).toBe(true);
  });

  it('QC is blocked before the shell', () => {
    expect(cavityStageGate('qc', restoration('inlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h' } })).reason).toBe('shellIncomplete');
    expect(canRunCavityStage('qc', restoration('inlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h', finalMesh: 'h' } }))).toBe(true);
  });
});

describe('cavityWorkflowGates + nextRunnableCavityStage', () => {
  it('gates are in the type-aware fixed order', () => {
    expect(cavityWorkflowGates(restoration('inlay')).map((g) => g.stage)).toEqual(cavityStages('inlay'));
    expect(cavityWorkflowGates(restoration('onlay')).map((g) => g.stage)).toEqual(cavityStages('onlay'));
  });

  it('INLAY advances one stage at a time', () => {
    expect(nextRunnableCavityStage(restoration('inlay'))).toBe('fit');
    expect(nextRunnableCavityStage(restoration('inlay', { stages: { fitSurface: 'h' } }))).toBe('patch');
    expect(nextRunnableCavityStage(restoration('inlay', { stages: { fitSurface: 'h', occlusalPatch: 'h' } }))).toBe('contacts');
    expect(nextRunnableCavityStage(restoration('inlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h' } }))).toBe('shell');
    expect(nextRunnableCavityStage(restoration('inlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h', finalMesh: 'h' } }))).toBe('qc');
    expect(nextRunnableCavityStage(restoration('inlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h', finalMesh: 'h' }, qc: EMPTY_QC }))).toBeNull();
  });

  it('ONLAY inserts cuspCoverage before shell', () => {
    expect(nextRunnableCavityStage(restoration('onlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h' } }))).toBe('cuspCoverage');
    expect(nextRunnableCavityStage(restoration('onlay', { stages: { fitSurface: 'h', occlusalPatch: 'h', proximalContacts: 'h', cuspCoverage: 'h' } }))).toBe('shell');
  });

  it('points at the outline trace when no outline exists yet', () => {
    expect(nextRunnableCavityStage(restoration('inlay', { marginLines: {} }))).toBe('outline');
  });
});

describe('cavityDownstreamInvalidations (the P4 Critical cascade)', () => {
  it('INLAY: an upstream commit clears every later hash + qc', () => {
    expect(cavityDownstreamInvalidations('fit', 'inlay')).toEqual({ stageFields: ['occlusalPatch', 'proximalContacts', 'finalMesh'], clearQc: true });
    expect(cavityDownstreamInvalidations('patch', 'inlay')).toEqual({ stageFields: ['proximalContacts', 'finalMesh'], clearQc: true });
    expect(cavityDownstreamInvalidations('contacts', 'inlay')).toEqual({ stageFields: ['finalMesh'], clearQc: true });
    expect(cavityDownstreamInvalidations('shell', 'inlay')).toEqual({ stageFields: [], clearQc: true });
    expect(cavityDownstreamInvalidations('qc', 'inlay')).toEqual({ stageFields: [], clearQc: false });
  });

  it('ONLAY: cuspCoverage sits in the cascade between contacts and shell', () => {
    expect(cavityDownstreamInvalidations('fit', 'onlay')).toEqual({ stageFields: ['occlusalPatch', 'proximalContacts', 'cuspCoverage', 'finalMesh'], clearQc: true });
    expect(cavityDownstreamInvalidations('contacts', 'onlay')).toEqual({ stageFields: ['cuspCoverage', 'finalMesh'], clearQc: true });
    expect(cavityDownstreamInvalidations('cuspCoverage', 'onlay')).toEqual({ stageFields: ['finalMesh'], clearQc: true });
  });

  it('an outline change invalidates EVERYTHING downstream', () => {
    expect(cavityDownstreamInvalidations('outline', 'inlay')).toEqual({ stageFields: ['fitSurface', 'occlusalPatch', 'proximalContacts', 'finalMesh'], clearQc: true });
    expect(cavityDownstreamInvalidations('outline', 'onlay')).toEqual({ stageFields: ['fitSurface', 'occlusalPatch', 'proximalContacts', 'cuspCoverage', 'finalMesh'], clearQc: true });
  });
});

describe('isCavityQcStale', () => {
  it('false with no report; false when journalHash matches finalMesh', () => {
    expect(isCavityQcStale(restoration('inlay'))).toBe(false);
    expect(isCavityQcStale(restoration('inlay', { stages: { finalMesh: 'h9' }, qc: { ...EMPTY_QC, journalHash: 'h9' } }))).toBe(false);
  });
  it('true when the design changed under the report', () => {
    expect(isCavityQcStale(restoration('inlay', { stages: { finalMesh: 'hNEW' }, qc: { ...EMPTY_QC, journalHash: 'hOLD' } }))).toBe(true);
    expect(isCavityQcStale(restoration('inlay', { stages: {}, qc: { ...EMPTY_QC, journalHash: 'hOLD' } }))).toBe(true);
  });
});
