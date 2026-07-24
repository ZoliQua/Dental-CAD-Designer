// apps/client/src/engine/crownWorkflow.test.ts
//
// Node-lane unit tests for the PURE crown-design state machine (no worker, no
// store) — the order-enforcement heart of Phase 4 Task 10. Exhaustive over
// the stage-prerequisite matrix.
import { describe, expect, it } from 'vitest';
import type { MarginLine, QcReport, Restoration, RestorationParams, Vec3 } from '@dqcad/shared-types';
import {
  CROWN_STAGES,
  canRunStage,
  firstMarginLoop,
  isStageComplete,
  nextRunnableStage,
  stageGate,
  workflowGates,
} from './crownWorkflow';

const PARAMS: RestorationParams = {
  cementGapMm: 0.05,
  marginalGapMm: 0.02,
  spacerStartMm: 0.8,
  minWallThicknessMm: 0.5,
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

function marginWithResampled(): MarginLine {
  return { anchors: [], closed: true, resampledPoints: ring(64) };
}

function marginAnchorsOnly(): MarginLine {
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

function restoration(overrides: Partial<Restoration> = {}): Restoration {
  return {
    id: 'r1',
    type: 'crown',
    teeth: [11],
    pontics: [],
    targetNodeId: 'node-1',
    marginLines: { 11: marginWithResampled() },
    insertionAxis: [0, 0, 1],
    params: PARAMS,
    stages: {},
    qc: null,
    ...overrides,
  };
}

describe('firstMarginLoop', () => {
  it('returns null when there are no margin lines', () => {
    expect(firstMarginLoop(restoration({ marginLines: {} }))).toBeNull();
  });

  it('prefers resampledPoints when present', () => {
    const loop = firstMarginLoop(restoration());
    expect(loop).not.toBeNull();
    expect(loop?.tooth).toBe(11);
    expect(loop?.points.length).toBe(64);
  });

  it('falls back to anchors when resampledPoints absent', () => {
    const loop = firstMarginLoop(restoration({ marginLines: { 11: marginAnchorsOnly() } }));
    expect(loop?.points.length).toBe(5);
  });

  it('rejects a degenerate (<3 point) margin', () => {
    const degenerate: MarginLine = { anchors: [], closed: true, resampledPoints: [[0, 0, 0]] };
    expect(firstMarginLoop(restoration({ marginLines: { 11: degenerate } }))).toBeNull();
  });
});

describe('isStageComplete', () => {
  it('reads the matching stages hash / qc', () => {
    expect(isStageComplete('innerSurface', restoration())).toBe(false);
    expect(isStageComplete('innerSurface', restoration({ stages: { innerSurface: 'h' } }))).toBe(true);
    expect(isStageComplete('anatomy', restoration({ stages: { anatomyPlacement: 'h' } }))).toBe(true);
    expect(isStageComplete('morph', restoration({ stages: { morphState: 'h' } }))).toBe(true);
    expect(isStageComplete('shell', restoration({ stages: { finalMesh: 'h' } }))).toBe(true);
    expect(isStageComplete('qc', restoration({ qc: EMPTY_QC }))).toBe(true);
  });

  it('freeform is never "complete" (it re-writes finalMesh, has no own hash)', () => {
    expect(isStageComplete('freeform', restoration({ stages: { finalMesh: 'h' } }))).toBe(false);
  });
});

describe('order enforcement', () => {
  it('inner surface is blocked without a target scan', () => {
    const gate = stageGate('innerSurface', restoration({ targetNodeId: null }));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('noTargetScan');
  });

  it('inner surface is blocked without a margin line', () => {
    const gate = stageGate('innerSurface', restoration({ marginLines: {} }));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('noMarginLine');
  });

  it('inner surface is allowed with target + margin (axis is never gated)', () => {
    expect(canRunStage('innerSurface', restoration())).toBe(true);
  });

  it('cannot place anatomy before the inner surface exists', () => {
    expect(canRunStage('anatomy', restoration())).toBe(false);
    expect(stageGate('anatomy', restoration()).reason).toBe('innerSurfaceIncomplete');
    expect(canRunStage('anatomy', restoration({ stages: { innerSurface: 'h' } }))).toBe(true);
  });

  it('cannot morph before anatomy', () => {
    const withInner = restoration({ stages: { innerSurface: 'h' } });
    expect(canRunStage('morph', withInner)).toBe(false);
    expect(stageGate('morph', withInner).reason).toBe('anatomyIncomplete');
    expect(canRunStage('morph', restoration({ stages: { innerSurface: 'h', anatomyPlacement: 'h' } }))).toBe(true);
  });

  it('cannot construct the shell before morph', () => {
    const withAnatomy = restoration({ stages: { innerSurface: 'h', anatomyPlacement: 'h' } });
    expect(canRunStage('shell', withAnatomy)).toBe(false);
    expect(stageGate('shell', withAnatomy).reason).toBe('morphIncomplete');
    expect(canRunStage('shell', restoration({ stages: { innerSurface: 'h', anatomyPlacement: 'h', morphState: 'h' } }))).toBe(true);
  });

  it('cannot QC or sculpt before the shell', () => {
    const withMorph = restoration({ stages: { innerSurface: 'h', anatomyPlacement: 'h', morphState: 'h' } });
    expect(canRunStage('qc', withMorph)).toBe(false);
    expect(stageGate('qc', withMorph).reason).toBe('shellIncomplete');
    expect(canRunStage('freeform', withMorph)).toBe(false);
    const withShell = restoration({ stages: { innerSurface: 'h', anatomyPlacement: 'h', morphState: 'h', finalMesh: 'h' } });
    expect(canRunStage('qc', withShell)).toBe(true);
    expect(canRunStage('freeform', withShell)).toBe(true);
  });
});

describe('workflowGates + nextRunnableStage', () => {
  it('returns all six gates in fixed order', () => {
    const gates = workflowGates(restoration());
    expect(gates.map((g) => g.stage)).toEqual([...CROWN_STAGES]);
  });

  it('advances through the pipeline one stage at a time', () => {
    expect(nextRunnableStage(restoration())).toBe('innerSurface');
    expect(nextRunnableStage(restoration({ stages: { innerSurface: 'h' } }))).toBe('anatomy');
    expect(nextRunnableStage(restoration({ stages: { innerSurface: 'h', anatomyPlacement: 'h' } }))).toBe('morph');
    expect(
      nextRunnableStage(restoration({ stages: { innerSurface: 'h', anatomyPlacement: 'h', morphState: 'h' } })),
    ).toBe('shell');
    // Shell done, QC not yet run -> next is qc (freeform, never "complete", is skipped).
    expect(
      nextRunnableStage(restoration({ stages: { innerSurface: 'h', anatomyPlacement: 'h', morphState: 'h', finalMesh: 'h' } })),
    ).toBe('qc');
    // Everything done.
    expect(
      nextRunnableStage(
        restoration({ stages: { innerSurface: 'h', anatomyPlacement: 'h', morphState: 'h', finalMesh: 'h' }, qc: EMPTY_QC }),
      ),
    ).toBeNull();
  });

  it('is null when fully blocked (no margin)', () => {
    expect(nextRunnableStage(restoration({ marginLines: {} }))).toBeNull();
  });
});
