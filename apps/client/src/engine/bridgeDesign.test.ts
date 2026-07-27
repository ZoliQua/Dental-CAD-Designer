// apps/client/src/engine/bridgeDesign.test.ts
//
// Node-lane unit tests for the bridge (multi-unit) design CONTROLLER (Phase 6
// Task 7), driven through a deterministic FAKE pool (injected via
// `__setPoolForTests`) so order enforcement, coalesced journaling, stage-hash
// updates, the invalidation cascade, ACKNOWLEDGE journaling and HONEST failure
// surfacing are all exercised without real Web Workers (the real coupled
// pipeline is proven in ui/BridgeDesignPanel.dom.test.tsx's browser lane).
// Mirrors engine/cavityDesign.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeshStats } from './repair';
import { caseStore } from './caseStore';
import { createRestoration } from './restorations';
import {
  bridgeDesignEngine,
  BridgeNoSessionError,
  BridgeStageOrderError,
  NonBridgeRestorationError,
  type BridgeSessionGeometry,
  type RunnablePool,
} from './bridgeDesign';
import { useBridgeStore } from '../state/bridgeStore';
import type { FdiTooth, MarginLine, QcReport, Vec3 } from '@dqcad/shared-types';

const STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-10, -5, 0], max: [10, 5, 8] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};
const REPORT = { weldEpsilonMm: 1e-6, steps: [] };

function tetra(tag: number): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: Float64Array.from([tag, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
  };
}

const RING: Vec3[] = Array.from({ length: 8 }, (_, i) => {
  const th = (2 * Math.PI * i) / 8;
  return [Math.cos(th), Math.sin(th), 0] as Vec3;
});

function unit(label: string, kind: 'abutment' | 'pontic', tag: number) {
  return {
    label,
    kind,
    insertionAxis: [0, 0, 1] as Vec3,
    marginFitMm: 0,
    mesh: tetra(tag),
    inner: tetra(tag + 0.1),
    outer: tetra(tag + 0.2),
    marginLoop: RING,
    fitRegion: kind === 'abutment' ? { axisPointMm: [0, 0, 0] as Vec3, axis: [0, 0, 1] as Vec3, maxRadialMm: 1.1, minAxialMm: -0.05, maxAxialMm: 2.05 } : null,
    die: kind === 'abutment' ? tetra(tag + 0.3) : null,
  };
}

function geometry(): BridgeSessionGeometry {
  return {
    sharedAxis: { direction: [0, 0, 1], acceptable: true, perAbutment: [{ label: '14', marginFitMm: 0 }, { label: '16', marginFitMm: 0 }] },
    units: [unit('14', 'abutment', 1), unit('15', 'pontic', 2), unit('16', 'abutment', 3)],
    connectors: [
      { label: '14–15', teeth: [14, 15], originMm: [-4.5, 0, 2.2], axisMm: [1, 0, 0], spanMm: 2, semiAxisMm: 1.9, segments: 8, profileFlat: [1.9, 0, 0, 1.9, -1.9, 0, 0, -1.9], defaultMinAreaMm2: 11.3 },
      { label: '15–16', teeth: [15, 16], originMm: [2.5, 0, 2.2], axisMm: [1, 0, 0], spanMm: 2, semiAxisMm: 1.9, segments: 8, profileFlat: [1.9, 0, 0, 1.9, -1.9, 0, 0, -1.9], defaultMinAreaMm2: 11.3 },
    ],
    ponticReliefByStyle: {
      hygienic: { configuredReliefMm: 2.0, maxAbsDeviationMm: 0.00016 },
      ridgeLap: { configuredReliefMm: 0.05, maxAbsDeviationMm: 0.00019 },
      ovate: { configuredReliefMm: 1.0, maxAbsDeviationMm: 0.00006 },
    },
  };
}

interface FakeCall {
  job: string;
  payload: unknown;
}

class FakePool {
  calls: FakeCall[] = [];
  private hashCounter = 0;
  failAssembly = false;
  /** Which gate the fake QC report FAILS (null = all pass). */
  failingGate: string | null = null;

  readonly run: RunnablePool['run'] = (async (job: string, payload: unknown): Promise<unknown> => {
    this.calls.push({ job, payload });
    switch (job) {
      case 'hashMesh':
        this.hashCounter += 1;
        return { contentHash: `hash-${this.hashCounter}` };
      case 'bridgeConnectors': {
        const p = payload as { connectors: unknown[] };
        return {
          connectors: p.connectors.map((_, i) => ({ ...tetra(10 + i), minAreaMm2: 11.3, analyticMinAreaMm2: 11.3, sampledMinAreaMm2: 11.4, stationMarginMm2: 0.1, sampledVsAnalyticMaxAbsMm2: 0.001, atStationMm: 1 })),
          minAreaMm2: 11.3,
        };
      }
      case 'bridgeAssembly':
        if (this.failAssembly) throw new Error('BridgeAssemblyError: disjoint fuse (component count 2)');
        return { ...tetra(20), watertight: true, componentCount: 1, inputCount: 5, volumeMm3: 123.4, triangleCount: 4 };
      case 'runBridgeQc': {
        const p = payload as { acknowledgedGates?: readonly string[] };
        const ack = new Set(p.acknowledgedGates ?? []);
        const failing = this.failingGate;
        const gates = ['watertight', 'minWallThickness:14', 'minWallThickness:15', 'minWallThickness:16', 'connectorCrossSection', 'marginFit:14', 'marginFit:16', 'ponticRelief'].map((gate) => {
          const isFail = gate === failing && !ack.has(gate);
          const acknowledged = gate === failing && ack.has(gate);
          return { gate, passed: !isFail, acknowledged, value: gate === 'connectorCrossSection' ? 11.3 : null, threshold: null, unit: null, message: isFail ? 'FAIL' : acknowledged ? 'acknowledged' : 'ok' };
        });
        const report: QcReport = { gates, passed: gates.every((g) => g.passed || g.acknowledged), kernelVersion: '0.0.0-test', profileVersion: 'test', journalHash: (payload as { journalHash: string }).journalHash };
        return { report };
      }
      default:
        throw new Error(`FakePool: unexpected job ${job}`);
    }
  }) as RunnablePool['run'];
}

function marginLine(): MarginLine {
  return { anchors: [], closed: true, resampledPoints: RING };
}

/** Register a target arch mesh + node, create a bridge restoration with confirmed
 * abutment margins (14 & 16), and return its id. */
function setupBridgeCase(): string {
  const arch = tetra(0);
  caseStore.registerImportedMesh({
    contentHash: 'bridge-arch',
    name: 'arch.stl',
    format: 'stl',
    positions: arch.positions,
    indices: arch.indices,
    stats: STATS,
    report: REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('bridge-arch', 'prepDie');
  const restoration = createRestoration({ type: 'bridge', teeth: [14, 15, 16] as FdiTooth[], pontics: [15] as FdiTooth[], targetNodeId: node.id });
  caseStore.updateRestoration(
    { ...restoration, marginLines: { 14: marginLine(), 16: marginLine() } },
    { id: 'op-margins', name: 'margin-edit', params: {}, inputHashes: [], outputHashes: [], kernelVersion: '0.0.0-test', timestamp: new Date().toISOString() },
  );
  return restoration.id;
}

function historyNames(): string[] {
  return caseStore.getDocument().history.map((o) => o.name);
}
function restoration(id: string) {
  return caseStore.getDocument().restorations.find((r) => r.id === id)!;
}

let pool: FakePool;

beforeEach(() => {
  caseStore.resetForTests();
  bridgeDesignEngine.resetForTests();
  pool = new FakePool();
  bridgeDesignEngine.__setPoolForTests(pool);
});
afterEach(() => {
  bridgeDesignEngine.resetForTests();
  caseStore.resetForTests();
});

/** Drive the full pipeline to a passing (or failingGate-driven) QcReport. */
async function driveToQc(id: string): Promise<void> {
  bridgeDesignEngine.start(id, geometry());
  await bridgeDesignEngine.commitAbutmentSurfaces();
  await bridgeDesignEngine.commitPontic('hygienic');
  await bridgeDesignEngine.commitConnectors();
  await bridgeDesignEngine.selectFramework('fullContour');
  await bridgeDesignEngine.runAssembly();
  await bridgeDesignEngine.runQc();
}

describe('bridgeDesign — session guards', () => {
  it('throws BridgeNoSessionError when a stage runs with no active session', async () => {
    await expect(bridgeDesignEngine.commitAbutmentSurfaces()).rejects.toBeInstanceOf(BridgeNoSessionError);
  });

  it('rejects a non-bridge restoration', () => {
    const arch = tetra(0);
    caseStore.registerImportedMesh({ contentHash: 'm', name: 'a.stl', format: 'stl', positions: arch.positions, indices: arch.indices, stats: STATS, report: REPORT, operations: [] });
    const node = caseStore.addSceneNode('m', 'prepDie');
    const r = createRestoration({ type: 'crown', teeth: [11] as FdiTooth[], targetNodeId: node.id });
    expect(() => bridgeDesignEngine.start(r.id, geometry())).toThrow(NonBridgeRestorationError);
  });
});

describe('bridgeDesign — order enforcement', () => {
  it('blocks a stage called before its prerequisite (pontic before abutmentSurfaces)', async () => {
    const id = setupBridgeCase();
    bridgeDesignEngine.start(id, geometry());
    await expect(bridgeDesignEngine.commitPontic('hygienic')).rejects.toBeInstanceOf(BridgeStageOrderError);
    await expect(bridgeDesignEngine.runAssembly()).rejects.toBeInstanceOf(BridgeStageOrderError);
    await expect(bridgeDesignEngine.runQc()).rejects.toBeInstanceOf(BridgeStageOrderError);
  });
});

describe('bridgeDesign — the happy path (stage hashes + ONE coalesced op per stage)', () => {
  it('drives every stage, writing distinct content hashes and journaling one op each', async () => {
    const id = setupBridgeCase();
    await driveToQc(id);

    const r = restoration(id);
    expect(r.stages.bridgeAbutmentSurfaces).toBeTypeOf('string');
    expect(r.stages.bridgePontic).toBeTypeOf('string');
    expect(r.stages.bridgeConnectors).toBeTypeOf('string');
    expect(r.stages.bridgeFramework).toBe('framework:fullContour');
    expect(r.stages.finalMesh).toBeTypeOf('string');
    expect(r.qc).not.toBeNull();
    // distinct mesh hashes (framework is a marker, not a mesh hash)
    const meshHashes = [r.stages.bridgeAbutmentSurfaces, r.stages.bridgePontic, r.stages.bridgeConnectors, r.stages.finalMesh];
    expect(new Set(meshHashes).size).toBe(4);

    // one coalesced op per stage/sub-action, in order.
    const names = historyNames();
    for (const op of ['bridge-abutment-surfaces', 'bridge-pontic', 'bridge-connectors', 'bridge-framework', 'bridge-assembly', 'bridge-qc']) {
      expect(names.filter((n) => n === op).length, op).toBe(1);
    }
  });

  it('the connector readouts carry the posterior positional target (9 mm²) + gate verdict', async () => {
    const id = setupBridgeCase();
    bridgeDesignEngine.start(id, geometry());
    await bridgeDesignEngine.commitAbutmentSurfaces();
    await bridgeDesignEngine.commitPontic('hygienic');
    await bridgeDesignEngine.commitConnectors();
    const connectors = useBridgeStore.getState().connectors!;
    expect(connectors.connectors).toHaveLength(2);
    for (const c of connectors.connectors) {
      expect(c.targetMm2).toBe(9); // posterior (any tooth position ≥ 4)
      expect(c.passed).toBe(true); // 11.3 ≥ 9
    }
  });
});

describe('bridgeDesign — the LIVE connector editor (preview journals NOTHING)', () => {
  it('previewConnectors publishes the live min-area readout without journaling', async () => {
    const id = setupBridgeCase();
    bridgeDesignEngine.start(id, geometry());
    await bridgeDesignEngine.commitAbutmentSurfaces();
    await bridgeDesignEngine.commitPontic('hygienic');
    const before = historyNames().length;
    await bridgeDesignEngine.previewConnectors({ '14–15': 1.2 });
    // a live readout was published…
    const live = useBridgeStore.getState().liveConnectors!;
    expect(live.connectors).toHaveLength(2);
    expect(live.connectors[0]!.semiAxisMm).toBe(1.2);
    // …but NOTHING was journaled (a preview) and no stage hash was written.
    expect(historyNames().length).toBe(before);
    expect(restoration(id).stages.bridgeConnectors).toBeUndefined();
  });
});

describe('bridgeDesign — the invalidation cascade (no stale PASS survives)', () => {
  it('re-committing an upstream stage clears the downstream hashes + the QcReport', async () => {
    const id = setupBridgeCase();
    await driveToQc(id);
    expect(restoration(id).qc).not.toBeNull();

    // Re-commit CONNECTORS (an upstream edit) → cascade clears framework + finalMesh + qc.
    await bridgeDesignEngine.commitConnectors({ '14–15': 1.5 });
    const r = restoration(id);
    expect(r.qc).toBeNull();
    expect(r.stages.bridgeFramework).toBeUndefined();
    expect(r.stages.finalMesh).toBeUndefined();
    // the store summaries were cleared too.
    expect(useBridgeStore.getState().assembly).toBeNull();
    expect(useBridgeStore.getState().qc).toBeNull();
  });
});

describe('bridgeDesign — HONEST failure surfacing', () => {
  it('a disjoint assembly sets an error state and does NOT write finalMesh / reach QC', async () => {
    const id = setupBridgeCase();
    bridgeDesignEngine.start(id, geometry());
    await bridgeDesignEngine.commitAbutmentSurfaces();
    await bridgeDesignEngine.commitPontic('hygienic');
    await bridgeDesignEngine.commitConnectors();
    await bridgeDesignEngine.selectFramework('fullContour');
    pool.failAssembly = true;
    await expect(bridgeDesignEngine.runAssembly()).rejects.toThrow();

    expect(restoration(id).stages.finalMesh).toBeUndefined();
    const store = useBridgeStore.getState();
    expect(store.error).toContain('BridgeAssemblyError');
    expect(store.errorStage).toBe('assembly');
    // QC stays blocked — a broken bridge can never masquerade as complete.
    await expect(bridgeDesignEngine.runQc()).rejects.toBeInstanceOf(BridgeStageOrderError);
  });
});

describe('bridgeDesign — ACKNOWLEDGE journaling (invariant 4, never a silent bypass)', () => {
  it('a failing connector gate is acknowledged via a re-run, journaling bridge-qc-ack', async () => {
    const id = setupBridgeCase();
    pool.failingGate = 'connectorCrossSection';
    await driveToQc(id);
    // QC failed on the connector gate.
    let r = restoration(id);
    expect(r.qc!.passed).toBe(false);
    expect(r.qc!.gates.find((g) => g.gate === 'connectorCrossSection')!.passed).toBe(false);

    // Acknowledge it (journaled).
    await bridgeDesignEngine.acknowledgeGate('connectorCrossSection');
    r = restoration(id);
    const gate = r.qc!.gates.find((g) => g.gate === 'connectorCrossSection')!;
    expect(gate.acknowledged).toBe(true);
    expect(r.qc!.passed).toBe(true); // now passes WITH the acknowledgment
    expect(historyNames().filter((n) => n === 'bridge-qc-ack').length).toBe(1);
  });
});
