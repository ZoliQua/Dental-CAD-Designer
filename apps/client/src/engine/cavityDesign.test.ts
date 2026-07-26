// apps/client/src/engine/cavityDesign.test.ts
//
// Node-lane unit tests for the inlay/onlay (cavity) design CONTROLLER (Phase 5
// Task 8), driven through a deterministic FAKE pool (injected via
// `__setPoolForTests`) so order enforcement, coalesced journaling, stage-hash
// updates, the invalidation cascade, ACKNOWLEDGE journaling and HONEST failure
// surfacing are all exercised without real Web Workers (the real coupled
// pipeline is proven in ui/CavityDesignPanel.dom.test.tsx's browser lane).
// Mirrors engine/crownDesign.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeshStats } from './repair';
import { caseStore } from './caseStore';
import { createRestoration } from './restorations';
import { cavityDesignEngine, CavityNoSessionError, CavityStageOrderError, NonCavityRestorationError, type RunnablePool } from './cavityDesign';
import { marginCircleVecs } from './crownGeometry';
import { canRunCavityStage } from './cavityWorkflow';
import { useCavityStore } from '../state/cavityStore';
import type { RestorationType } from '@dqcad/shared-types';

const STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-5, -5, 0], max: [5, 5, 8] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};
const REPORT = { weldEpsilonMm: 1e-6, steps: [] };

/** A tiny valid indexed mesh (one tetra) the fake stage jobs hand back. `tag`
 * perturbs a coordinate so different stages' meshes hash distinctly. */
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
  /** Which gate the fake QC report FAILS (for the acknowledge path). */
  failingGate: string | null = 'seating';

  readonly run: RunnablePool['run'] = (async (job: string, payload: unknown): Promise<unknown> => {
    this.calls.push({ job, payload });
    switch (job) {
      case 'buildBvh':
        return {};
      case 'hashMesh':
        this.hashCounter += 1;
        return { contentHash: `hash-${this.hashCounter}` };
      case 'cavityInnerSurface':
        return { ...tetra(2), stats: STATS, errorBoundMm: 0.006, flatZoneErrorBoundMm: 0.004, patchTriangleCount: 40, skirtTriangleCount: 12, marginVertexCount: 80, marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3, pitchMm: 0.06 };
      case 'cavityOcclusalPatch':
        return {
          ...tetra(3),
          stats: STATS,
          seamEdges: [{ a: [0, 0, 0], b: [1, 0, 0], segment: 0 }],
          freeEdges: [],
          proximalFaces: [
            { columnPoints: [[-5, -1, 6], [-5, 0, 6]], freeRunPoints: [[-5, -1, 6]] },
            { columnPoints: [[5, -1, 6], [5, 0, 6]], freeRunPoints: [[5, -1, 6]] },
          ],
          cavityTriangleIndices: Uint32Array.from([0, 1]),
          seamDihedralMaxDeg: 2.3,
          seamDihedralMeanDeg: 1.1,
          seamDihedralBoundDeg: 5,
          patchTriangleCount: 60,
          crossSegments: 8,
          seamSurroundingMaxAngleDeg: 30,
        };
      case 'cavityProximalContact':
        return {
          ...tetra(4),
          boxes: [
            { label: 'mesial', targetPenetrationMm: 0.02, initialSignedDistanceMm: 0.1, travelMm: 0.12, clampBound: false, approachDirection: [1, 0, 0], achievedSignedDistanceMm: -0.02, contactResidualMm: 0.001, faceMinSignedDistanceMm: -0.02, faceResidualMm: 0.002, movedVertexCount: 5 },
            { label: 'distal', targetPenetrationMm: 0.02, initialSignedDistanceMm: 0.1, travelMm: 0.12, clampBound: false, approachDirection: [-1, 0, 0], achievedSignedDistanceMm: -0.02, contactResidualMm: 0.001, faceMinSignedDistanceMm: -0.02, faceResidualMm: 0.002, movedVertexCount: 5 },
          ],
          clampedBoxes: [],
          errorBoundMm: 0.001,
          maxTravelMm: 0.5,
          seamAnchorBandMm: 0.2,
          seamDihedralMaxBeforeDeg: 2.3,
          seamDihedralMeanBeforeDeg: 1.1,
          seamDihedralMaxAfterDeg: 2.4,
          seamDihedralMeanAfterDeg: 1.2,
        };
      case 'cavityShell':
        if (this.failShell) {
          const err = new Error('inlay shell weld produced an open boundary');
          err.name = 'InlayShellOpenBoundaryError';
          throw err;
        }
        return { ...tetra(5), watertight: true, componentCount: 1, seamRingVertexCount: 80, fitTriangleCount: 40, patchTriangleCount: 60, volumeMm3: 22.5 };
      case 'runInlayQc': {
        const acknowledged = (payload as { acknowledgedGates?: string[] }).acknowledgedGates ?? [];
        const gates = [
          { gate: 'watertight', passed: true, acknowledged: false, value: null, threshold: null, unit: null, message: 'ok' },
          { gate: 'minWallThickness', passed: true, acknowledged: false, value: 1.2, threshold: 1.0, unit: 'mm', message: 'ok' },
          { gate: 'seamDihedral', passed: true, acknowledged: false, value: 2.4, threshold: 5, unit: 'deg', message: 'ok' },
          this.failingGate
            ? { gate: this.failingGate, passed: false, acknowledged: acknowledged.includes(this.failingGate), value: 0.0616, threshold: 1e-6, unit: 'mm3', message: 'onlay seating interference' }
            : { gate: 'seating', passed: true, acknowledged: false, value: 0, threshold: 1e-6, unit: 'mm3', message: 'ok' },
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

function setup(type: RestorationType = 'inlay'): string {
  caseStore.registerImportedMesh({
    contentHash: 'tooth',
    name: 'tooth.stl',
    format: 'stl',
    positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
    stats: STATS,
    report: REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('tooth', 'prepDie');
  const restoration = createRestoration({ type, teeth: [16], targetNodeId: node.id });
  // A cavity outline (MOD-like ring spanning ±5 in X so the synthetic neighbour
  // boxes land beyond it) as the restoration's confirmed margin line.
  const outline = marginCircleVecs(0, 0, 5, 6, 48);
  caseStore.updateRestoration(
    { ...restoration, marginLines: { 16: { anchors: [], closed: true, resampledPoints: outline } } },
    { id: 'm', name: 'margin-edit', params: {}, inputHashes: [], outputHashes: [], kernelVersion: 'test', timestamp: new Date().toISOString() },
  );
  return restoration.id;
}

function currentRestoration() {
  return caseStore.getDocument().restorations.find((r) => r.id === restorationId)!;
}
function opsNamed(name: string): number {
  return caseStore.getDocument().history.filter((o) => o.name === name).length;
}

beforeEach(() => {
  caseStore.resetForTests();
  cavityDesignEngine.resetForTests();
  fake = new FakePool();
  cavityDesignEngine.__setPoolForTests(fake);
  restorationId = setup();
});
afterEach(() => {
  cavityDesignEngine.resetForTests();
  caseStore.resetForTests();
});

async function runToShell(): Promise<void> {
  cavityDesignEngine.start(restorationId);
  await cavityDesignEngine.runFit({ pitchMm: 0.06 });
  await cavityDesignEngine.runPatch();
  await cavityDesignEngine.runContacts();
  await cavityDesignEngine.constructShell();
}

describe('cavityDesign controller — order enforcement', () => {
  it('start() throws for a non-cavity restoration type', () => {
    const r = createRestoration({ type: 'crown', teeth: [21], targetNodeId: null });
    expect(() => cavityDesignEngine.start(r.id)).toThrow(NonCavityRestorationError);
  });

  it('start() throws without a target scan / without an outline', () => {
    const noScan = createRestoration({ type: 'inlay', teeth: [26], targetNodeId: null });
    expect(() => cavityDesignEngine.start(noScan.id)).toThrow(CavityStageOrderError);
  });

  it('refuses patch before the fit surface, contacts before patch, shell before contacts, QC before shell', async () => {
    cavityDesignEngine.start(restorationId);
    await expect(cavityDesignEngine.runPatch()).rejects.toBeInstanceOf(CavityStageOrderError);
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    await expect(cavityDesignEngine.runContacts()).rejects.toBeInstanceOf(CavityStageOrderError);
    await cavityDesignEngine.runPatch();
    await expect(cavityDesignEngine.constructShell()).rejects.toBeInstanceOf(CavityStageOrderError);
    await cavityDesignEngine.runContacts();
    await expect(cavityDesignEngine.runQc()).rejects.toBeInstanceOf(CavityStageOrderError);
  });

  it('throws CavityNoSessionError when acting without a session', async () => {
    await expect(cavityDesignEngine.runFit()).rejects.toBeInstanceOf(CavityNoSessionError);
  });
});

describe('cavityDesign controller — happy path + stage hashes + coalesced journaling', () => {
  it('writes each stage hash into Restoration.stages in order', async () => {
    cavityDesignEngine.start(restorationId);
    expect(currentRestoration().stages).toEqual({});
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    expect(currentRestoration().stages.fitSurface).toBeTypeOf('string');
    await cavityDesignEngine.runPatch();
    expect(currentRestoration().stages.occlusalPatch).toBeTypeOf('string');
    await cavityDesignEngine.runContacts();
    expect(currentRestoration().stages.proximalContacts).toBeTypeOf('string');
    await cavityDesignEngine.constructShell();
    expect(currentRestoration().stages.finalMesh).toBeTypeOf('string');
  });

  it('journals exactly one op per completed stage', async () => {
    await runToShell();
    expect(opsNamed('inlay-fit-surface')).toBe(1);
    expect(opsNamed('inlay-occlusal-patch')).toBe(1);
    expect(opsNamed('inlay-proximal-contacts')).toBe(1);
    expect(opsNamed('inlay-shell')).toBe(1);
  });

  it('surfaces the seam-dihedral readout to the store (patch + contacts before/after)', async () => {
    cavityDesignEngine.start(restorationId);
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    await cavityDesignEngine.runPatch();
    expect(useCavityStore.getState().patch?.seamDihedralMaxDeg).toBe(2.3);
    await cavityDesignEngine.runContacts();
    const c = useCavityStore.getState().contacts!;
    expect(c.seamDihedralMaxBeforeDeg).toBe(2.3);
    expect(c.seamDihedralMaxAfterDeg).toBe(2.4);
    expect(c.boxes.map((b) => b.label).sort()).toEqual(['distal', 'mesial']);
  });

  it('runs QC and stores the QcReport; the seating gate can be ACKNOWLEDGED (journaled, invariant 4)', async () => {
    await runToShell();
    await cavityDesignEngine.runQc();
    // The INLAY QC payload carries the T6-derived 1.3 mm margin-exclusion band
    // (the type-branched cavityMarginExclusionMm — onlay uses 1.8, see the
    // ONLAY suite).
    const qcPayload = fake.calls.filter((c) => c.job === 'runInlayQc').pop()!.payload as { marginExclusionMm: number };
    expect(qcPayload.marginExclusionMm).toBe(1.3);
    let qc = currentRestoration().qc!;
    expect(qc.gates.map((g) => g.gate)).toContain('seamDihedral');
    expect(qc.passed).toBe(false); // seating fails, unacknowledged
    await cavityDesignEngine.acknowledgeGate('seating');
    qc = currentRestoration().qc!;
    expect(qc.passed).toBe(true);
    expect(qc.gates.find((g) => g.gate === 'seating')?.acknowledged).toBe(true);
    expect(opsNamed('inlay-qc-ack')).toBe(1);
    expect(opsNamed('inlay-qc')).toBe(1);
  });
});

describe('cavityDesign controller — invalidation cascade (stale QC can never display)', () => {
  async function runToQc(): Promise<void> {
    await runToShell();
    await cavityDesignEngine.runQc();
    await cavityDesignEngine.acknowledgeGate('seating'); // make it read PASSED
  }

  it('CRITICAL: re-running the fit surface after a PASSED QC clears patch/contacts/shell hashes AND qc', async () => {
    await runToQc();
    expect(currentRestoration().qc?.passed).toBe(true);
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    const r = currentRestoration();
    expect(r.stages.occlusalPatch).toBeUndefined();
    expect(r.stages.proximalContacts).toBeUndefined();
    expect(r.stages.finalMesh).toBeUndefined();
    expect(r.qc).toBeNull();
    expect(r.stages.fitSurface).toBeTypeOf('string'); // its own output stands
    expect(useCavityStore.getState().qc).toBeNull();
    // Downstream is order-blocked again.
    expect(canRunCavityStage('qc', r)).toBe(false);
  });

  it('re-running contacts invalidates the shell (finalMesh) AND qc', async () => {
    await runToQc();
    await cavityDesignEngine.runContacts();
    const r = currentRestoration();
    expect(r.stages.finalMesh).toBeUndefined();
    expect(r.qc).toBeNull();
    expect(r.stages.proximalContacts).toBeTypeOf('string');
  });
});

describe('cavityDesign controller — ONLAY cusp coverage', () => {
  beforeEach(() => {
    caseStore.resetForTests();
    cavityDesignEngine.resetForTests();
    fake = new FakePool();
    cavityDesignEngine.__setPoolForTests(fake);
    restorationId = setup('onlay');
  });

  it('an onlay REQUIRES cusp coverage before the shell; coverage journals one op', async () => {
    cavityDesignEngine.start(restorationId);
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    await cavityDesignEngine.runPatch();
    await cavityDesignEngine.runContacts();
    // Shell blocked until cusp coverage is selected (onlay-only stage).
    await expect(cavityDesignEngine.constructShell()).rejects.toBeInstanceOf(CavityStageOrderError);
    await cavityDesignEngine.selectCuspCoverage(cavityDesignEngine.defaultCoverageDivider());
    expect(currentRestoration().stages.cuspCoverage).toBeTypeOf('string');
    expect(opsNamed('inlay-cusp-coverage')).toBe(1);
    await cavityDesignEngine.constructShell();
    expect(currentRestoration().stages.finalMesh).toBeTypeOf('string');
    // The onlay QC payload carries the coverage divider (region-scoped gate).
    await cavityDesignEngine.runQc();
    const coveragePayload = fake.calls.filter((c) => c.job === 'runInlayQc').pop()!.payload as { coverage?: unknown };
    expect(coveragePayload.coverage).toBeDefined();
  });

  it('the ONLAY QC payload carries the T7-derived 1.8 mm margin-exclusion band (runQc AND the acknowledge re-run)', async () => {
    // Task 9 review fix: the band is BRANCHED on restoration type — a single
    // unconditional 1.3 previously applied to onlays too, narrower than the
    // T7-derived separator (below ~1.6 the wedge leaks into the coverage min).
    cavityDesignEngine.start(restorationId);
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    await cavityDesignEngine.runPatch();
    await cavityDesignEngine.runContacts();
    await cavityDesignEngine.selectCuspCoverage(cavityDesignEngine.defaultCoverageDivider());
    await cavityDesignEngine.constructShell();
    await cavityDesignEngine.runQc();
    const qcPayload = fake.calls.filter((c) => c.job === 'runInlayQc').pop()!.payload as { marginExclusionMm: number };
    expect(qcPayload.marginExclusionMm).toBe(1.8);
    // The acknowledge path rebuilds the payload — the band must survive it.
    await cavityDesignEngine.acknowledgeGate('seating');
    const ackPayload = fake.calls.filter((c) => c.job === 'runInlayQc').pop()!.payload as { marginExclusionMm: number; acknowledgedGates?: string[] };
    expect(ackPayload.marginExclusionMm).toBe(1.8);
    expect(ackPayload.acknowledgedGates).toContain('seating');
  });

  it('selecting coverage on an INLAY session throws (onlay-only stage)', async () => {
    // A fresh inlay session.
    caseStore.resetForTests();
    cavityDesignEngine.resetForTests();
    fake = new FakePool();
    cavityDesignEngine.__setPoolForTests(fake);
    const inlayId = setup('inlay');
    cavityDesignEngine.start(inlayId);
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    await cavityDesignEngine.runPatch();
    await cavityDesignEngine.runContacts();
    await expect(cavityDesignEngine.selectCuspCoverage(cavityDesignEngine.defaultCoverageDivider())).rejects.toBeInstanceOf(CavityStageOrderError);
  });
});

describe('cavityDesign controller — UI-only actions + session lifecycle', () => {
  it('setFitGhostVisible / clearError publish UI state without journaling', () => {
    cavityDesignEngine.start(restorationId);
    const before = caseStore.getDocument().history.length;
    cavityDesignEngine.setFitGhostVisible(false);
    cavityDesignEngine.clearError();
    expect(useCavityStore.getState().fitGhostVisible).toBe(false);
    expect(caseStore.getDocument().history.length).toBe(before); // no journal
  });

  it('clear() ends the session and resets the store', async () => {
    cavityDesignEngine.start(restorationId);
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    cavityDesignEngine.clear();
    expect(useCavityStore.getState().active).toBe(false);
    expect(useCavityStore.getState().fit).toBeNull();
  });

  it('defaultCoverageDivider derives a plane from the cavity outline', () => {
    cavityDesignEngine.start(restorationId);
    const d = cavityDesignEngine.defaultCoverageDivider();
    expect(d.normalMm).toEqual([0, -1, 0]);
    expect(Number.isFinite(d.pointMm[1])).toBe(true);
  });
});

describe('cavityDesign controller — HONEST failure surfacing', () => {
  it('a shell failure sets an error state and never writes finalMesh (QC stays blocked)', async () => {
    fake.failShell = true;
    cavityDesignEngine.start(restorationId);
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    await cavityDesignEngine.runPatch();
    await cavityDesignEngine.runContacts();
    await expect(cavityDesignEngine.constructShell()).rejects.toThrow();
    const store = useCavityStore.getState();
    expect(store.error).toMatch(/InlayShellOpenBoundaryError/);
    expect(store.errorStage).toBe('shell');
    expect(currentRestoration().stages.finalMesh).toBeUndefined();
    await expect(cavityDesignEngine.runQc()).rejects.toBeInstanceOf(CavityStageOrderError);
    expect(currentRestoration().qc).toBeNull();
  });
});
