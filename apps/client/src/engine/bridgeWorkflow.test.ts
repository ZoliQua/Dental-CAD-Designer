// apps/client/src/engine/bridgeWorkflow.test.ts
//
// Node-lane unit tests for the bridge (multi-unit) design workflow STATE MACHINE
// (Phase 6 Task 7) — the pure gate/order/cascade logic on the shared core
// (engine/restorationWorkflow.ts). Mirrors engine/cavityWorkflow.test.ts. The
// coupled controller behaviour is in bridgeDesign.test.ts; the real pipeline is
// proven in ui/BridgeDesignPanel.dom.test.tsx's browser lane.
import { describe, expect, it } from 'vitest';
import type { FdiTooth, MarginLine, QcReport, Restoration, Vec3 } from '@dqcad/shared-types';
import {
  BRIDGE_STAGES,
  bridgeDownstreamInvalidations,
  bridgeStageGate,
  bridgeWorkflowGates,
  canRunBridgeStage,
  hasAbutmentMargins,
  isBridgeQcStale,
  isBridgeStageComplete,
  nextRunnableBridgeStage,
  type BridgeStage,
} from './bridgeWorkflow';

const RING: Vec3[] = Array.from({ length: 8 }, (_, i) => {
  const th = (2 * Math.PI * i) / 8;
  return [Math.cos(th), Math.sin(th), 0] as Vec3;
});

function marginLine(): MarginLine {
  return { anchors: [], closed: true, resampledPoints: RING };
}

interface BuildOpts {
  targetNodeId?: string | null;
  margins?: readonly FdiTooth[];
  stages?: Restoration['stages'];
  qc?: QcReport | null;
}

function bridge(opts: BuildOpts = {}): Restoration {
  const marginLines: Partial<Record<FdiTooth, MarginLine>> = {};
  for (const tooth of opts.margins ?? [14, 16]) marginLines[tooth] = marginLine();
  return {
    id: 'r1',
    type: 'bridge',
    teeth: [14, 15, 16],
    pontics: [15],
    targetNodeId: opts.targetNodeId === undefined ? 'node-1' : opts.targetNodeId,
    marginLines,
    insertionAxis: [0, 0, 1],
    params: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.5, proximalContactPenetrationMm: 0.02, occlusalContactMm: 0.02 },
    stages: opts.stages ?? {},
    qc: opts.qc ?? null,
  };
}

const FULL_STAGES: Restoration['stages'] = {
  bridgeAbutmentSurfaces: 'a',
  bridgePontic: 'p',
  bridgeConnectors: 'c',
  bridgeFramework: 'f',
  finalMesh: 'm',
};

describe('bridgeWorkflow — stage order + presence', () => {
  it('the fixed stage order is margins → abutmentSurfaces → pontic → connectors → framework → assembly → qc', () => {
    expect([...BRIDGE_STAGES]).toEqual(['margins', 'abutmentSurfaces', 'pontic', 'connectors', 'framework', 'assembly', 'qc']);
  });

  it('hasAbutmentMargins requires EVERY abutment (14 & 16), ignoring the pontic 15', () => {
    expect(hasAbutmentMargins(bridge({ margins: [14, 16] }))).toBe(true);
    expect(hasAbutmentMargins(bridge({ margins: [14] }))).toBe(false); // 16 missing
    expect(hasAbutmentMargins(bridge({ margins: [] }))).toBe(false);
    // a margin on the pontic doesn't help
    expect(hasAbutmentMargins(bridge({ margins: [14, 15] }))).toBe(false);
  });

  it('isBridgeStageComplete reads the matching stages hash / qc', () => {
    const r = bridge({ stages: FULL_STAGES, qc: { passed: true, gates: [], journalHash: 'm', kernelVersion: '0', profileVersion: '0' } as QcReport });
    for (const stage of BRIDGE_STAGES) expect(isBridgeStageComplete(stage, r)).toBe(true);
    const empty = bridge();
    expect(isBridgeStageComplete('margins', empty)).toBe(true); // margins present by default
    expect(isBridgeStageComplete('abutmentSurfaces', empty)).toBe(false);
    expect(isBridgeStageComplete('qc', empty)).toBe(false);
  });
});

describe('bridgeWorkflow — prerequisites (hard-gated externals + linear chain)', () => {
  it('margins is blocked by a missing target scan (noTargetScan)', () => {
    const g = bridgeStageGate('margins', bridge({ targetNodeId: null }));
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe('noTargetScan');
  });

  it('abutmentSurfaces is blocked by missing target scan, then by missing margins', () => {
    expect(bridgeStageGate('abutmentSurfaces', bridge({ targetNodeId: null })).reason).toBe('noTargetScan');
    expect(bridgeStageGate('abutmentSurfaces', bridge({ margins: [14] })).reason).toBe('noAbutmentMargins');
    expect(bridgeStageGate('abutmentSurfaces', bridge()).allowed).toBe(true);
  });

  it('the downstream chain is strictly linear — each stage blocked until its predecessor completes', () => {
    const chain: Array<[BridgeStage, keyof Restoration['stages'], string]> = [
      ['pontic', 'bridgeAbutmentSurfaces', 'abutmentSurfacesIncomplete'],
      ['connectors', 'bridgePontic', 'ponticIncomplete'],
      ['framework', 'bridgeConnectors', 'connectorsIncomplete'],
      ['assembly', 'bridgeFramework', 'frameworkIncomplete'],
    ];
    const stages: Restoration['stages'] = {};
    for (const [stage, , reason] of chain) {
      expect(bridgeStageGate(stage, bridge({ stages: { ...stages } })).reason).toBe(reason);
    }
    // qc blocked until assembly (finalMesh)
    expect(bridgeStageGate('qc', bridge({ stages: {} })).reason).toBe('assemblyIncomplete');
    expect(bridgeStageGate('qc', bridge({ stages: { finalMesh: 'm' } })).allowed).toBe(true);
  });

  it('nextRunnableBridgeStage walks the pipeline one step at a time', () => {
    expect(nextRunnableBridgeStage(bridge())).toBe('abutmentSurfaces'); // margins already done
    expect(nextRunnableBridgeStage(bridge({ stages: { bridgeAbutmentSurfaces: 'a' } }))).toBe('pontic');
    expect(nextRunnableBridgeStage(bridge({ stages: FULL_STAGES }))).toBe('qc');
    expect(nextRunnableBridgeStage(bridge({ targetNodeId: null }))).toBeNull(); // fully blocked
  });

  it('bridgeWorkflowGates returns one gate per stage in fixed order', () => {
    expect(bridgeWorkflowGates(bridge()).map((g) => g.stage)).toEqual([...BRIDGE_STAGES]);
  });
});

describe('bridgeWorkflow — the downstream-invalidation cascade (the P4 Critical lesson)', () => {
  it('committing margins clears EVERY milestone field + qc', () => {
    const inv = bridgeDownstreamInvalidations('margins');
    expect(inv.stageFields).toEqual(['bridgeAbutmentSurfaces', 'bridgePontic', 'bridgeConnectors', 'bridgeFramework', 'finalMesh']);
    expect(inv.clearQc).toBe(true);
  });

  it('each milestone clears only what is strictly DOWNSTREAM of it (+ qc)', () => {
    expect(bridgeDownstreamInvalidations('abutmentSurfaces').stageFields).toEqual(['bridgePontic', 'bridgeConnectors', 'bridgeFramework', 'finalMesh']);
    expect(bridgeDownstreamInvalidations('pontic').stageFields).toEqual(['bridgeConnectors', 'bridgeFramework', 'finalMesh']);
    expect(bridgeDownstreamInvalidations('connectors').stageFields).toEqual(['bridgeFramework', 'finalMesh']);
    expect(bridgeDownstreamInvalidations('framework').stageFields).toEqual(['finalMesh']);
    expect(bridgeDownstreamInvalidations('assembly').stageFields).toEqual([]);
    expect(bridgeDownstreamInvalidations('assembly').clearQc).toBe(true);
  });

  it('qc invalidates nothing downstream', () => {
    expect(bridgeDownstreamInvalidations('qc')).toEqual({ stageFields: [], clearQc: false });
  });

  it('EXACT-REPRO — re-running an upstream stage clears the stored QcReport (no stale PASS survives)', () => {
    // A fully built, PASSING bridge.
    const passing: QcReport = { passed: true, gates: [], journalHash: 'm', kernelVersion: '0', profileVersion: '0' } as QcReport;
    let r = bridge({ stages: { ...FULL_STAGES }, qc: passing });
    expect(isBridgeStageComplete('qc', r)).toBe(true);
    expect(isBridgeQcStale(r)).toBe(false);

    // Re-run the CONNECTORS stage (an upstream edit): apply its cascade.
    const inv = bridgeDownstreamInvalidations('connectors');
    const stages: Restoration['stages'] = { ...r.stages, bridgeConnectors: 'c2' };
    for (const f of inv.stageFields) delete stages[f];
    r = { ...r, stages, qc: inv.clearQc ? null : r.qc };

    // The QcReport is GONE, and every downstream milestone hash is cleared.
    expect(r.qc).toBeNull();
    expect(r.stages.bridgeFramework).toBeUndefined();
    expect(r.stages.finalMesh).toBeUndefined();
    // QC is re-BLOCKED (the honest state — a report can never outlive its geometry).
    expect(canRunBridgeStage('qc', r)).toBe(false);
    expect(bridgeStageGate('qc', r).reason).toBe('assemblyIncomplete');
  });

  it('isBridgeQcStale flags a QcReport whose journalHash no longer matches finalMesh', () => {
    const qc = { passed: true, gates: [], journalHash: 'OLD', kernelVersion: '0', profileVersion: '0' } as QcReport;
    expect(isBridgeQcStale(bridge({ stages: { finalMesh: 'NEW' }, qc }))).toBe(true);
    expect(isBridgeQcStale(bridge({ stages: { finalMesh: 'OLD' }, qc }))).toBe(false);
    expect(isBridgeQcStale(bridge({ qc: null }))).toBe(false);
  });
});
