// apps/client/src/engine/bridgeDesignReload.test.ts
//
// Phase 7 Task 1 — regression tests for the 19b silent no-op
// (docs/demos/phase-6.md item 19b): after a page reload of a case with
// persisted bridge stages, `bridgeDesignEngine`'s in-memory session was never
// reconstructed, so `runQc()` / `acknowledgeGate()` hit `buildQcPayload`'s
// synchronous `BridgeStageOrderError` BEFORE their try blocks — the click
// silently did nothing (no error banner, no busy state, no journal entry).
//
// These are the store-level tests the Phase-6 e2e couldn't have (it documented
// the bug instead of exercising it):
//   1. reload → runQc produces a REAL QC result (session reconstructed from the
//      persisted stages + journal, re-computed geometry VERIFIED against the
//      persisted stage hashes);
//   2. reload → acknowledgeGate re-runs QC with the acknowledgment for real;
//   3. any synchronous validation error at either call site lands in the
//      VISIBLE error state (never a silent pre-try escape);
//   4. an honestly NON-reconstructable persisted design (journal op missing /
//      drifted decision params) FAILS VISIBLY with the i18n'd actionable
//      message, never a guess and never silence.
//
// The fake pool here is CONTENT-ADDRESSED (unlike bridgeDesign.test.ts's
// counter-hash fake): reconstruction re-runs the same deterministic jobs and
// must reproduce the SAME stage hashes the original commits recorded, so the
// fake's hashes must be a pure function of the mesh bytes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeshStats } from './repair';
import { caseStore } from './caseStore';
import { createRestoration } from './restorations';
import {
  bridgeDesignEngine,
  BridgeSessionRestoreError,
  BridgeStageOrderError,
  type BridgeSessionGeometry,
  type RunnablePool,
} from './bridgeDesign';
import { useBridgeStore } from '../state/bridgeStore';
import type { CaseDocument, FdiTooth, MarginLine, QcReport, Vec3 } from '@dqcad/shared-types';

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
    fitRegion:
      kind === 'abutment'
        ? { axisPointMm: [0, 0, 0] as Vec3, axis: [0, 0, 1] as Vec3, maxRadialMm: 1.1, minAxialMm: -0.05, maxAxialMm: 2.05 }
        : null,
    die: kind === 'abutment' ? tetra(tag + 0.3) : null,
  };
}

function geometry(): BridgeSessionGeometry {
  return {
    sharedAxis: {
      direction: [0, 0, 1],
      acceptable: true,
      perAbutment: [
        { label: '14', marginFitMm: 0 },
        { label: '16', marginFitMm: 0 },
      ],
    },
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

/** FNV-1a over the mesh bytes — a CONTENT-ADDRESSED fake hash, so a
 * deterministic re-run of a stage job reproduces the persisted stage hash
 * (what real `hashMesh` guarantees). */
function contentHash(positions: Float64Array, indices: Uint32Array): string {
  const bytes = new Uint8Array(positions.buffer.slice(positions.byteOffset, positions.byteOffset + positions.byteLength));
  const idxBytes = new Uint8Array(indices.buffer.slice(indices.byteOffset, indices.byteOffset + indices.byteLength));
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (const b of idxBytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `hash-${h.toString(16)}`;
}

interface FakeCall {
  job: string;
  payload: unknown;
}

/** Deterministic content-addressed fake pool: every job output is a pure
 * function of its payload, and `hashMesh` hashes the actual bytes. */
class DeterministicPool {
  calls: FakeCall[] = [];
  /** Which gate the fake QC report FAILS (null = all pass). */
  failingGate: string | null = null;

  readonly run: RunnablePool['run'] = (async (job: string, payload: unknown): Promise<unknown> => {
    this.calls.push({ job, payload });
    switch (job) {
      case 'hashMesh': {
        const p = payload as { positions: Float64Array; indices: Uint32Array };
        return { contentHash: contentHash(p.positions, p.indices) };
      }
      case 'bridgeConnectors': {
        const p = payload as { connectors: { profileAFlat: Float64Array }[] };
        return {
          connectors: p.connectors.map((c) => {
            // Output derived from the profile bytes: an edited semi-axis
            // yields a DIFFERENT connector mesh, the same profile the SAME.
            // (Sum of ABSOLUTE values — the raw equal-angular samples of any
            // centred ellipse sum to zero regardless of semi-axis.)
            let tag = 0;
            for (const v of c.profileAFlat) tag += Math.abs(v);
            return { ...tetra(100 + tag), minAreaMm2: 11.3, analyticMinAreaMm2: 11.3, sampledMinAreaMm2: 11.4, stationMarginMm2: 0.1, sampledVsAnalyticMaxAbsMm2: 0.001, atStationMm: 1 };
          }),
          minAreaMm2: 11.3,
        };
      }
      case 'bridgeAssembly': {
        const p = payload as { solids: { positions: Float64Array }[] };
        let tag = 0;
        for (const s of p.solids) tag += s.positions[0]!;
        return { ...tetra(200 + tag), watertight: true, componentCount: 1, inputCount: p.solids.length, volumeMm3: 123.4, triangleCount: 4 };
      }
      case 'runBridgeQc': {
        const p = payload as { acknowledgedGates?: readonly string[]; journalHash: string };
        const ack = new Set(p.acknowledgedGates ?? []);
        const failing = this.failingGate;
        const gates = ['watertight', 'minWallThickness:14', 'minWallThickness:15', 'minWallThickness:16', 'connectorCrossSection', 'marginFit:14', 'marginFit:16', 'ponticRelief'].map((gate) => {
          // Models the REAL gate runner: a failing gate STAYS failed when
          // acknowledged (acknowledged=true, passed=false) — never a bypass.
          const isFailing = gate === failing;
          const acknowledged = isFailing && ack.has(gate);
          return { gate, passed: !isFailing, acknowledged, value: null, threshold: null, unit: null, message: isFailing ? (acknowledged ? 'acknowledged' : 'FAIL') : 'ok' };
        });
        const report: QcReport = { gates, passed: gates.every((g) => g.passed || g.acknowledged), kernelVersion: '0.0.0-test', profileVersion: 'test', journalHash: p.journalHash };
        return { report };
      }
      default:
        throw new Error(`DeterministicPool: unexpected job ${job}`);
    }
  }) as RunnablePool['run'];
}

function marginLine(): MarginLine {
  return { anchors: [], closed: true, resampledPoints: RING };
}

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

let pool: DeterministicPool;

beforeEach(() => {
  caseStore.resetForTests();
  bridgeDesignEngine.resetForTests();
  pool = new DeterministicPool();
  bridgeDesignEngine.__setPoolForTests(pool);
});
afterEach(() => {
  bridgeDesignEngine.resetForTests();
  caseStore.resetForTests();
});

/** Drives the full bridge workflow to a committed assembly (and optionally a
 * stored QcReport), exactly as a pre-reload session would have. */
async function runFullWorkflow(opts: { semiAxisOverrides?: Record<string, number>; framework?: 'fullContour' | 'framework'; runQc?: boolean } = {}): Promise<string> {
  const id = setupBridgeCase();
  bridgeDesignEngine.start(id, geometry());
  await bridgeDesignEngine.commitAbutmentSurfaces();
  await bridgeDesignEngine.commitPontic('ridgeLap');
  await bridgeDesignEngine.commitConnectors(opts.semiAxisOverrides ?? {});
  await bridgeDesignEngine.selectFramework(opts.framework ?? 'fullContour');
  await bridgeDesignEngine.runAssembly();
  if (opts.runQc !== false) await bridgeDesignEngine.runQc();
  return id;
}

/** Simulates a page reload: the persisted CaseDocument survives, every
 * in-memory session/store is gone, then the panel re-opens the bridge session
 * against the SAME captured geometry asset. `mutate` lets a test corrupt the
 * persisted document between "save" and "load". */
function reload(id: string, mutate?: (saved: CaseDocument) => CaseDocument): void {
  let saved = caseStore.getDocument();
  if (mutate) saved = mutate(saved);
  bridgeDesignEngine.resetForTests();
  caseStore.resetForTests();
  caseStore.loadDocument(saved);
  pool = new DeterministicPool();
  bridgeDesignEngine.__setPoolForTests(pool);
  bridgeDesignEngine.start(id, geometry());
}

describe('bridgeDesign — 19b: reload → runQc produces a REAL result (never a silent no-op)', () => {
  it('reconstructs the session from persisted stages + journal and runs real QC', async () => {
    const id = await runFullWorkflow({ runQc: false });
    const historyBefore = historyNames();

    reload(id);
    await bridgeDesignEngine.runQc();

    const state = useBridgeStore.getState();
    expect(state.error).toBeNull();
    expect(state.qc).not.toBeNull();
    expect(state.qc!.passed).toBe(true);
    expect(restoration(id).qc).not.toBeNull();
    // Reconstruction itself journals NOTHING — only the QC run appends its op.
    expect(historyNames()).toEqual([...historyBefore, 'bridge-qc']);
    // The QC job really ran (a real dispatch, not a replayed stale report).
    expect(pool.calls.some((c) => c.job === 'runBridgeQc')).toBe(true);
  });

  it('reconstructs an EDITED connector semi-axis from the journaled design decision', async () => {
    const id = await runFullWorkflow({ semiAxisOverrides: { '14–15': 1.5 }, runQc: false });

    reload(id);
    await bridgeDesignEngine.runQc();

    expect(useBridgeStore.getState().error).toBeNull();
    expect(useBridgeStore.getState().qc).not.toBeNull();
    // The reconstruction re-ran the connector loft with the persisted edit.
    const connectorCall = pool.calls.find((c) => c.job === 'bridgeConnectors');
    expect(connectorCall).toBeDefined();
  });

  it('reconstructs the framework MODE from the persisted stage marker into the QC payload', async () => {
    const id = await runFullWorkflow({ framework: 'framework', runQc: false });

    reload(id);
    await bridgeDesignEngine.runQc();

    const qcCall = pool.calls.find((c) => c.job === 'runBridgeQc');
    expect(qcCall).toBeDefined();
    expect((qcCall!.payload as { frameworkMode: boolean }).frameworkMode).toBe(true);
  });
});

describe('bridgeDesign — 19b: reload → acknowledgeGate re-runs QC for real', () => {
  it('acknowledges a persisted failing gate after reload (journaled bridge-qc-ack)', async () => {
    pool.failingGate = 'connectorCrossSection';
    const id = await runFullWorkflow();
    expect(restoration(id).qc!.passed).toBe(false);
    const historyBefore = historyNames();

    reload(id, (saved) => saved);
    pool.failingGate = 'connectorCrossSection';
    await bridgeDesignEngine.acknowledgeGate('connectorCrossSection');

    const qc = restoration(id).qc!;
    const gate = qc.gates.find((g) => g.gate === 'connectorCrossSection')!;
    expect(gate.passed).toBe(false);
    expect(gate.acknowledged).toBe(true);
    expect(qc.passed).toBe(true);
    expect(historyNames()).toEqual([...historyBefore, 'bridge-qc-ack']);
    expect(useBridgeStore.getState().error).toBeNull();
  });
});

describe('bridgeDesign — defense at both call sites: sync validation errors are VISIBLE', () => {
  it('runQc: a BridgeStageOrderError lands in the visible error state', async () => {
    const id = setupBridgeCase();
    bridgeDesignEngine.start(id, geometry());

    await expect(bridgeDesignEngine.runQc()).rejects.toThrow(BridgeStageOrderError);

    const state = useBridgeStore.getState();
    expect(state.error).toContain('BridgeStageOrderError');
    expect(state.errorStage).toBe('qc');
    expect(state.busyStage).toBeNull();
  });

  it('acknowledgeGate: a BridgeStageOrderError lands in the visible error state', async () => {
    const id = await runFullWorkflow({ runQc: false });
    expect(restoration(id).qc).toBeNull();

    await expect(bridgeDesignEngine.acknowledgeGate('watertight')).rejects.toThrow(BridgeStageOrderError);

    const state = useBridgeStore.getState();
    expect(state.error).toContain('BridgeStageOrderError');
    expect(state.errorStage).toBe('qc');
    expect(state.busyStage).toBeNull();
  });
});

describe('bridgeDesign — honestly NON-reconstructable persistence fails VISIBLY (i18n key)', () => {
  it('a missing bridge-pontic journal op → BridgeSessionRestoreError + the i18n error key', async () => {
    const id = await runFullWorkflow({ runQc: false });

    reload(id, (saved) => ({ ...saved, history: saved.history.filter((o) => o.name !== 'bridge-pontic') }));

    await expect(bridgeDesignEngine.runQc()).rejects.toThrow(BridgeSessionRestoreError);
    const state = useBridgeStore.getState();
    expect(state.error).toContain('BridgeSessionRestoreError');
    expect(state.errorStage).toBe('qc');
    expect(state.errorKey).toBe('bridge.errorSessionRestore');
    expect(state.errorDetail).toBeTruthy();
    expect(state.busyStage).toBeNull();
  });

  it('a drifted journaled connector decision (hash mismatch on re-run) fails visibly', async () => {
    const id = await runFullWorkflow({ runQc: false });

    reload(id, (saved) => ({
      ...saved,
      history: saved.history.map((o) =>
        o.name === 'bridge-connectors'
          ? {
              ...o,
              params: {
                ...o.params,
                connectors: (o.params.connectors as { label: string; semiAxisMm: number; minAreaMm2: number; targetMm2: number }[]).map((c) => ({ ...c, semiAxisMm: 1.2 })),
              },
            }
          : o,
      ),
    }));

    await expect(bridgeDesignEngine.runQc()).rejects.toThrow(BridgeSessionRestoreError);
    const state = useBridgeStore.getState();
    expect(state.errorKey).toBe('bridge.errorSessionRestore');
    expect(state.error).toContain('BridgeSessionRestoreError');
    // No QC report was written for a design we could not faithfully restore.
    expect(restoration(id).qc).toBeNull();
  });
});
