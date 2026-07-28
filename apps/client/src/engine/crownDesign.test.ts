// apps/client/src/engine/crownDesign.test.ts
//
// Node-lane unit tests for the crown-design CONTROLLER (Phase 4 Task 10),
// driven through a deterministic FAKE pool (injected via `__setPoolForTests`)
// so order enforcement, coalesced journaling, stage-hash updates and HONEST
// failure surfacing are all exercised without spinning up real Web Workers
// (the real 5-stage pipeline is proven in ui/CrownDesignPanel.dom.test.tsx's
// browser lane). Mirrors state/axisStore.test.ts's node-lane + the browser
// lane split.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeshStats } from './repair';
import { caseStore } from './caseStore';
import { createRestoration } from './restorations';
import { crownDesignEngine, CrownNoSessionError, CrownStageOrderError, type RunnablePool } from './crownDesign';
import { builtinLibraryTooth, boxMesh, marginCircleVecs } from './crownGeometry';
import { canRunStage } from './crownWorkflow';
import { useCrownStore } from '../state/crownStore';

const STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-2, -2, 0], max: [2, 2, 3] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};
const REPORT = { weldEpsilonMm: 1e-6, steps: [] };

/** A tiny valid indexed mesh (one tetra) the fake stage jobs hand back — the
 * geometry is irrelevant to the controller's bookkeeping. `tag` perturbs a
 * coordinate so different stages' meshes hash distinctly. */
function tetra(tag: number): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: Float64Array.from([tag, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
  };
}

interface FakeCall {
  job: string;
  payload: unknown;
}

class FakePool {
  calls: FakeCall[] = [];
  private hashCounter = 0;
  failShell = false;

  readonly run: RunnablePool['run'] = (async (job: string, payload: unknown): Promise<unknown> => {
    this.calls.push({ job, payload });
    switch (job) {
      case 'buildBvh':
        return {};
      case 'hashMesh':
        this.hashCounter += 1;
        return { contentHash: `hash-${this.hashCounter}` };
      case 'innerSurface':
        return { ...tetra(2), stats: STATS, errorBoundMm: 0.005, flatZoneErrorBoundMm: 0.005, patchTriangleCount: 4, skirtTriangleCount: 2, marginVertexCount: 64, marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3, pitchMm: 0.1 };
      case 'placeAnatomy':
        return { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], ...tetra(3), originMm: [0, 0, 0], mesialDistal: [1, 0, 0], buccoLingual: [0, 1, 0], occlusoGingival: [0, 0, 1], scaleMesialDistal: 1.1, scaleBuccoLingual: 1.0, scaleOcclusoGingival: 0.9, nativeMesialDistalWidthMm: 2, nativeOcclusoGingivalHeightMm: 4, targetMesialDistalWidthMm: 2.2, targetOcclusoGingivalHeightMm: 3.6, usedProximalGap: true, antagonistUsed: true, occlusoGingivalReoriented: false };
      case 'morphAnatomy':
      case 'resolveMorph': {
        const strengths = (payload as { strengths?: { antagonist?: number } }).strengths;
        const antStrength = strengths?.antagonist ?? 1;
        return {
          ...tetra(4),
          contacts: [
            { kind: 'antagonist', strength: antStrength, targetPenetrationMm: 0, achievedSignedDistanceMm: -0.01 * antStrength, contactResidualMm: 0.001, regionMinSignedDistanceMm: -0.02, regionMeanSignedDistanceMm: -0.01, regionRmsSignedDistanceMm: 0.01, facingVertexCount: 10, regionResidualMm: 0.001, clampBound: false },
          ],
          maxContactResidualMm: 0.001,
          errorBoundMm: 0.002,
          clampedContacts: [],
          marginSealMaxDeviationMm: 0.003,
          marginSealAtFinishLineMm: 0.001,
          marginSealBetweenPinsMm: 0.002,
          controlPointCount: 12,
          heatmaps: [{ kind: 'antagonist', distances: Float64Array.from([0.1, 0.2, 0.3, 0.4]), min: 0, max: 1, mean: 0.5, rms: 0.5 }],
        };
      }
      case 'constructShell':
        if (this.failShell) {
          const err = new Error('manifold boolean produced a non-manifold result');
          err.name = 'NonManifoldInputError';
          throw err;
        }
        return { ...tetra(5), watertight: true, componentCount: 1, seamTriangleCount: 8, outerRimVertexCount: 64, innerRimVertexCount: 64, volumeMm3: 12.5, minWallThicknessMm: 0.6, minOcclusalWallThicknessMm: 0.7, minAxialWallThicknessMm: 0.6, thicknessSampleSpacingMm: 0.2, errorBoundMm: 0.01, autoThickenApplied: false, autoThickenDisplacedVertexCount: 0, autoThickenClampedVertexCount: 0, autoThickenMaxAppliedMm: 0, thicknessHeatmap: Float64Array.from([0.5, 0.6, 0.7, 0.8]) };
      case 'applySculptStroke':
        return { ...tetra(6), watertight: true, componentCount: 1, movedVertexCount: 5, peakDisplacementMm: 0.08, clampedStrokeCount: 0, lockedVertexCount: 3, sculptableVertexCount: 20 };
      case 'runQc': {
        const acknowledged = ((payload as { acknowledgedGates?: string[] }).acknowledgedGates ?? []);
        const gates = [
          { gate: 'watertight', passed: true, acknowledged: false, value: null, threshold: null, unit: null, message: 'ok' },
          { gate: 'minWallThickness', passed: false, acknowledged: acknowledged.includes('minWallThickness'), value: 0.4, threshold: 0.5, unit: 'mm', message: 'thin' },
        ];
        const passed = gates.every((g) => g.passed || g.acknowledged);
        return { report: { gates, passed, kernelVersion: '0.0.0', profileVersion: 'test', journalHash: 'jh' } };
      }
      default:
        throw new Error(`FakePool: unexpected job ${job}`);
    }
  }) as RunnablePool['run'];
}

let fake: FakePool;
let restorationId: string;

function setup(): string {
  caseStore.registerImportedMesh({
    contentHash: 'die',
    name: 'die.stl',
    format: 'stl',
    positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
    stats: STATS,
    report: REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('die', 'prepDie');
  const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: node.id });
  caseStore.updateRestoration(
    { ...restoration, marginLines: { 11: { anchors: [], closed: true, resampledPoints: marginCircleVecs(0, 0, 1.2, 0.5, 64) } } },
    { id: 'm', name: 'margin-edit', params: {}, inputHashes: [], outputHashes: [], kernelVersion: 'test', timestamp: new Date().toISOString() },
  );
  return restoration.id;
}

function anatomyInput() {
  return {
    library: builtinLibraryTooth(1.2, 0.5, 4, 1.0, 24),
    antagonist: boxMesh([-1, -1, 5], [1, 1, 6]),
  };
}

function currentRestoration() {
  return caseStore.getDocument().restorations.find((r) => r.id === restorationId)!;
}

function opsNamed(name: string): number {
  return caseStore.getDocument().history.filter((o) => o.name === name).length;
}

beforeEach(() => {
  caseStore.resetForTests();
  crownDesignEngine.resetForTests();
  fake = new FakePool();
  crownDesignEngine.__setPoolForTests(fake);
  restorationId = setup();
});

afterEach(() => {
  crownDesignEngine.resetForTests();
  caseStore.resetForTests();
});

describe('crownDesign controller — order enforcement', () => {
  it('start() throws without a target scan', () => {
    const r = createRestoration({ type: 'crown', teeth: [21], targetNodeId: null });
    expect(() => crownDesignEngine.start(r.id)).toThrow(CrownStageOrderError);
  });

  it('refuses to place anatomy before the inner surface', async () => {
    crownDesignEngine.start(restorationId);
    await expect(crownDesignEngine.placeAnatomy(anatomyInput())).rejects.toBeInstanceOf(CrownStageOrderError);
  });

  it('refuses to construct the shell before morph', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await expect(crownDesignEngine.constructShell()).rejects.toBeInstanceOf(CrownStageOrderError);
  });

  it('refuses QC before the shell', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await crownDesignEngine.runMorph();
    await expect(crownDesignEngine.runQc()).rejects.toBeInstanceOf(CrownStageOrderError);
  });
});

describe('crownDesign controller — happy path + stage hashes', () => {
  async function runToShell(): Promise<void> {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await crownDesignEngine.runMorph();
    await crownDesignEngine.constructShell();
  }

  it('writes each stage hash into Restoration.stages in order', async () => {
    crownDesignEngine.start(restorationId);
    expect(currentRestoration().stages).toEqual({});

    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    expect(currentRestoration().stages.innerSurface).toBeTypeOf('string');

    await crownDesignEngine.placeAnatomy(anatomyInput());
    expect(currentRestoration().stages.anatomyPlacement).toBeTypeOf('string');

    await crownDesignEngine.runMorph();
    expect(currentRestoration().stages.morphState).toBeTypeOf('string');

    await crownDesignEngine.constructShell();
    expect(currentRestoration().stages.finalMesh).toBeTypeOf('string');
  });

  it('runs QC and stores the QcReport on the restoration', async () => {
    await runToShell();
    await crownDesignEngine.runQc();
    const qc = currentRestoration().qc;
    expect(qc).not.toBeNull();
    expect(qc?.gates.length).toBe(2);
    expect(qc?.passed).toBe(false); // minWallThickness fails, unacknowledged
    expect(useCrownStore.getState().qc?.passed).toBe(false);
  });

  it('acknowledging a failing gate flips overall passed and journals it', async () => {
    await runToShell();
    await crownDesignEngine.runQc();
    await crownDesignEngine.acknowledgeGate('minWallThickness');
    const qc = currentRestoration().qc!;
    expect(qc.passed).toBe(true);
    expect(qc.gates.find((g) => g.gate === 'minWallThickness')?.acknowledged).toBe(true);
    expect(opsNamed('crown-qc-ack')).toBe(1);
  });
});

describe('crownDesign controller — coalesced journaling', () => {
  it('journals exactly one op per completed stage', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await crownDesignEngine.runMorph();
    await crownDesignEngine.constructShell();
    expect(opsNamed('crown-inner-surface')).toBe(1);
    expect(opsNamed('crown-anatomy')).toBe(1);
    expect(opsNamed('crown-morph')).toBe(1); // initial morph
    expect(opsNamed('crown-shell')).toBe(1);
  });

  it('a LIVE strength preview journals nothing; the commit journals exactly one', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await crownDesignEngine.runMorph();
    const afterInitialMorph = opsNamed('crown-morph');

    // Drag: several live re-solves, zero journal entries.
    await crownDesignEngine.previewMorphStrengths({ proximalMesial: 1, proximalDistal: 1, antagonist: 0.8 });
    await crownDesignEngine.previewMorphStrengths({ proximalMesial: 1, proximalDistal: 1, antagonist: 0.6 });
    expect(opsNamed('crown-morph')).toBe(afterInitialMorph);

    // Release/commit: exactly one more coalesced op.
    await crownDesignEngine.commitMorphStrengths({ proximalMesial: 1, proximalDistal: 1, antagonist: 0.6 });
    expect(opsNamed('crown-morph')).toBe(afterInitialMorph + 1);
  });

  it('each sculpt stroke is one coalesced op that re-writes finalMesh', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await crownDesignEngine.runMorph();
    await crownDesignEngine.constructShell();
    const shellHash1 = currentRestoration().stages.finalMesh;

    await crownDesignEngine.applySculptStroke({ center: [0, 0, 3], radiusMm: 0.5, strength: 0.1, brush: 'add' });
    await crownDesignEngine.applySculptStroke({ center: [0, 0, 3], radiusMm: 0.5, strength: 0.1, brush: 'smooth' });
    expect(opsNamed('crown-sculpt')).toBe(2);
    expect(currentRestoration().stages.finalMesh).not.toBe(shellHash1); // re-written
  });
});

describe('crownDesign controller — session guards + UI-only actions', () => {
  it('throws CrownNoSessionError when acting without a session', async () => {
    await expect(crownDesignEngine.runInnerSurface()).rejects.toBeInstanceOf(CrownNoSessionError);
    await expect(crownDesignEngine.placeAnatomyAuto()).rejects.toBeInstanceOf(CrownNoSessionError);
  });

  it('previewMorphStrengths before a morph plan exists throws (order guard)', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await expect(
      crownDesignEngine.previewMorphStrengths({ proximalMesial: 1, proximalDistal: 1, antagonist: 0.5 }),
    ).rejects.toBeInstanceOf(CrownStageOrderError);
  });

  it('overlay/brush/strength setters publish UI state without journaling', () => {
    crownDesignEngine.start(restorationId);
    const before = caseStore.getDocument().history.length;
    crownDesignEngine.setInnerGhostVisible(false);
    crownDesignEngine.setContactHeatmapVisible(false);
    crownDesignEngine.setThicknessHeatmapVisible(false);
    crownDesignEngine.setBrush('smooth');
    crownDesignEngine.setBrushRadius(1.2);
    crownDesignEngine.setBrushStrength(0.25);
    crownDesignEngine.setOuterLock(false);
    crownDesignEngine.setStrength('antagonist', 0.4);
    crownDesignEngine.clearError();
    const s = useCrownStore.getState();
    expect(s.innerGhostVisible).toBe(false);
    expect(s.brush).toBe('smooth');
    expect(s.brushRadiusMm).toBe(1.2);
    expect(s.outerLock).toBe(false);
    expect(s.strengths.antagonist).toBe(0.4);
    expect(caseStore.getDocument().history.length).toBe(before); // no journal
  });

  it('exposes design render nodes (Float32, plus inner ghost) after stages run', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    const nodes = crownDesignEngine.getDesignRenderNodes();
    // main placed design + inner-surface ghost (ghost on by default).
    expect(nodes.length).toBe(2);
    expect(nodes[0]!.positions).toBeInstanceOf(Float32Array);
    expect(nodes.some((n) => n.opacity < 1)).toBe(true); // the ghost
  });

  it('a manual transform commit re-places the anatomy as one coalesced op (manual=true)', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomyAuto();
    expect(useCrownStore.getState().anatomy?.manual).toBe(false);
    await crownDesignEngine.commitAnatomyTransform({ translationMm: [0.1, 0, 0] });
    expect(useCrownStore.getState().anatomy?.manual).toBe(true);
    expect(opsNamed('crown-anatomy')).toBe(2); // auto + one manual commit
  });

  it('applies a thickness heatmap colour buffer to the shell design node', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await crownDesignEngine.runMorph();
    await crownDesignEngine.constructShell();
    const [main] = crownDesignEngine.getDesignRenderNodes();
    expect(main?.colors).toBeInstanceOf(Float32Array);
    // Turning the thickness overlay off drops the colours.
    crownDesignEngine.setThicknessHeatmapVisible(false);
    expect(crownDesignEngine.getDesignRenderNodes()[0]?.colors).toBeUndefined();
  });

  it('clear() ends the session and empties the design render nodes', async () => {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    crownDesignEngine.clear();
    expect(useCrownStore.getState().active).toBe(false);
    expect(crownDesignEngine.getDesignRenderNodes()).toEqual([]);
  });
});

describe('crownDesign controller — invalidation cascade (stale QC can never display)', () => {
  async function runToQc(): Promise<void> {
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await crownDesignEngine.runMorph();
    await crownDesignEngine.constructShell();
    await crownDesignEngine.runQc();
  }

  it('CRITICAL: a sculpt stroke after a PASSED QC clears qc (report can never go stale-but-shown)', async () => {
    await runToQc();
    // Acknowledge the one failing gate so the report reads PASSED.
    await crownDesignEngine.acknowledgeGate('minWallThickness');
    expect(currentRestoration().qc?.passed).toBe(true);
    const finalMeshBefore = currentRestoration().stages.finalMesh;

    await crownDesignEngine.applySculptStroke({ center: [0, 0, 3], radiusMm: 0.5, strength: 0.1, brush: 'add' });

    const r = currentRestoration();
    // The sculpt re-wrote finalMesh AND invalidated the (now stale) QcReport.
    expect(r.stages.finalMesh).not.toBe(finalMeshBefore);
    expect(r.qc).toBeNull();
    expect(useCrownStore.getState().qc).toBeNull();
  });

  it('a morph re-commit invalidates the shell (finalMesh) AND qc', async () => {
    await runToQc();
    expect(currentRestoration().stages.finalMesh).toBeTypeOf('string');
    expect(currentRestoration().qc).not.toBeNull();

    await crownDesignEngine.commitMorphStrengths({ proximalMesial: 1, proximalDistal: 1, antagonist: 0.5 });

    const r = currentRestoration();
    expect(r.stages.finalMesh).toBeUndefined(); // shell hash cleared
    expect(r.qc).toBeNull();
    // Shell + QC are order-blocked again until the shell is reconstructed.
    expect(canRunStage('qc', r)).toBe(false);
  });

  it('re-running the inner surface invalidates anatomy, morph, shell AND qc', async () => {
    await runToQc();
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    const r = currentRestoration();
    expect(r.stages.anatomyPlacement).toBeUndefined();
    expect(r.stages.morphState).toBeUndefined();
    expect(r.stages.finalMesh).toBeUndefined();
    expect(r.qc).toBeNull();
    expect(r.stages.innerSurface).toBeTypeOf('string'); // its own output stands
  });
});

describe('crownDesign controller — silent-failure defense at the QC call sites (P7-T1, the 19b sibling sweep)', () => {
  // The 19b shape: persisted stage hashes say "qc may run" (as after a page
  // reload) but the in-memory session has no shell — the pre-try session-shape
  // check used to throw its CrownStageOrderError BEFORE the try block, so the
  // click silently no-op'd. Both call sites must surface it VISIBLY.
  function persistStagesWithoutSession(qcReport: import('@dqcad/shared-types').QcReport | null): void {
    caseStore.updateRestoration(
      { ...currentRestoration(), stages: { ...currentRestoration().stages, finalMesh: 'persisted-shell-hash' }, qc: qcReport },
      { id: 'p', name: 'test-persist', params: {}, inputHashes: [], outputHashes: [], kernelVersion: 'test', timestamp: new Date().toISOString() },
    );
  }
  const minimalReport: import('@dqcad/shared-types').QcReport = {
    gates: [{ gate: 'minWallThickness', passed: false, acknowledged: false, value: 0.3, threshold: 0.5, unit: 'mm', message: 'thin' }],
    passed: false,
    kernelVersion: 'test',
    profileVersion: 'test',
    journalHash: 'persisted-shell-hash',
  };

  it('runQc: a CrownStageOrderError from the session-shape check lands in the visible error state', async () => {
    crownDesignEngine.start(restorationId);
    persistStagesWithoutSession(null);

    await expect(crownDesignEngine.runQc()).rejects.toThrow(CrownStageOrderError);

    const store = useCrownStore.getState();
    expect(store.error).toMatch(/CrownStageOrderError/);
    expect(store.errorStage).toBe('qc');
    expect(store.busyStage).toBeNull();
  });

  it('acknowledgeGate: a CrownStageOrderError from the session-shape check lands in the visible error state', async () => {
    crownDesignEngine.start(restorationId);
    persistStagesWithoutSession(minimalReport);

    await expect(crownDesignEngine.acknowledgeGate('minWallThickness')).rejects.toThrow(CrownStageOrderError);

    const store = useCrownStore.getState();
    expect(store.error).toMatch(/CrownStageOrderError/);
    expect(store.errorStage).toBe('qc');
    expect(store.busyStage).toBeNull();
  });

  // P7-T1 fix round (review finding 1): the same class at the MID-WORKFLOW
  // actions — post-reload the stage gates pass from persisted hashes while the
  // session fields are null; the panel's fire-and-forget run() wrapper swallows
  // the rejection, so a pre-try throw is a silent no-op.
  it('runMorph: a CrownStageOrderError from the session-shape check lands in the visible error state', async () => {
    crownDesignEngine.start(restorationId);
    caseStore.updateRestoration(
      { ...currentRestoration(), stages: { ...currentRestoration().stages, anatomyPlacement: 'persisted-anatomy-hash' } },
      { id: 'p2', name: 'test-persist', params: {}, inputHashes: [], outputHashes: [], kernelVersion: 'test', timestamp: new Date().toISOString() },
    );

    await expect(crownDesignEngine.runMorph()).rejects.toThrow(CrownStageOrderError);

    const store = useCrownStore.getState();
    expect(store.error).toMatch(/CrownStageOrderError/);
    expect(store.errorStage).toBe('morph');
    expect(store.busyStage).toBeNull();
  });

  it('constructShell: a CrownStageOrderError from the session-shape check lands in the visible error state', async () => {
    crownDesignEngine.start(restorationId);
    caseStore.updateRestoration(
      { ...currentRestoration(), stages: { ...currentRestoration().stages, morphState: 'persisted-morph-hash' } },
      { id: 'p3', name: 'test-persist', params: {}, inputHashes: [], outputHashes: [], kernelVersion: 'test', timestamp: new Date().toISOString() },
    );

    await expect(crownDesignEngine.constructShell()).rejects.toThrow(CrownStageOrderError);

    const store = useCrownStore.getState();
    expect(store.error).toMatch(/CrownStageOrderError/);
    expect(store.errorStage).toBe('shell');
    expect(store.busyStage).toBeNull();
  });
});

describe('crownDesign controller — HONEST failure surfacing', () => {
  it('a shell failure sets an error state and never writes finalMesh (QC stays blocked)', async () => {
    fake.failShell = true;
    crownDesignEngine.start(restorationId);
    await crownDesignEngine.runInnerSurface({ pitchMm: 0.1 });
    await crownDesignEngine.placeAnatomy(anatomyInput());
    await crownDesignEngine.runMorph();

    await expect(crownDesignEngine.constructShell()).rejects.toThrow();

    const store = useCrownStore.getState();
    // The honest error surface carries the failing error's CLASS NAME (the
    // shell's NonManifoldInputError), not just a generic message.
    expect(store.error).toMatch(/NonManifoldInputError/);
    expect(store.errorStage).toBe('shell');
    // The crown is NOT built — no finalMesh, and QC cannot run.
    expect(currentRestoration().stages.finalMesh).toBeUndefined();
    await expect(crownDesignEngine.runQc()).rejects.toBeInstanceOf(CrownStageOrderError);
    // No fake "passing" report was fabricated.
    expect(currentRestoration().qc).toBeNull();
  });
});
