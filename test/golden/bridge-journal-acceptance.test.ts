// test/golden/bridge-journal-acceptance.test.ts
//
// Phase 6 Task 9 — THE PHASE GATE: the complete-bridge acceptance harness + full
// journal reproducibility for BOTH mode chains. Assembles the fixed-order bridge
// stages (abutment surfaces → pontic + interface → connectors → framework →
// assembly → qc) into one recorded journal and proves record → replay →
// BIT-IDENTICAL stage hashes (CLAUDE.md invariants 2/3 — the hardest determinism
// bar: analytic intaglios + the analytic pontic base + the ruled lofts + the
// pure-Float64 framework cutback + the WASM union + the 11-gate QC all
// deterministic through the whole chain). GENUINELY COUPLED (the P4-T12b lesson):
// the abutment intaglios the QC re-measures are inside the unit solids the
// assembly fused; the cut-back unit surfaces the framework thickness gate measures
// ARE the ones assembled; the connectors area-gated ARE the ones assembled; the
// pontic base whose relief is measured IS the base recorded. See
// scripts/bridge-journal-lib.ts.
//
// ## Parts
//   1. FULL-CONTOUR ACCEPTANCE (always runs) — the assembled 3-unit posterior
//      bridge is ONE watertight solid; every gate passes; per-abutment margin fit
//      ≤10µm (before/after REPORTED); seating clean; connector area ≥ target;
//      pontic relief ≤20µm. Every number MEASURED + REPORTED.
//   2. FRAMEWORK ACCEPTANCE (always runs) — the same, framework mode: the units
//      are genuinely cut back (veneering space applied), the thickness gate uses
//      the framework minimum, all gates pass.
//   3. FALSIFIABLE BLOCKS — a 5 mm² posterior connector → connectorCrossSection
//      BLOCKS; a mis-configured pontic relief → ponticRelief BLOCKS (gates NOT
//      weakened).
//   4. RELIEF ±20µm PER STYLE — hygienic / ridgeLap / ovate measured in the chain.
//   5. JOURNAL REPRODUCIBILITY — record → replay → bit-identical stage hashes for
//      BOTH chains; byte-pinned (KERNEL_VERSION + manifold-3d guarded); two-record
//      determinism.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KERNEL_VERSION } from '@dqcad/kernel';
import { ponticReliefGate } from '@dqcad/cad-pipeline';
import {
  assembleBridgeCase,
  measureStyleRelief,
  recordBridgeJournal,
  replayBridgeJournal,
  resetBridgeCaches,
  bridgeStageId,
  type AssembledBridge,
  type BridgeMode,
  type RecordedBridgeJournal,
} from '../../scripts/bridge-journal-lib.ts';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';

const µm = (mm: number): string => `${(mm * 1000).toFixed(3)} µm`;

// ---------------------------------------------------------------------------
// Version guard — the byte-pinned stage hashes below are valid ONLY for this
// kernel + this manifold-3d WASM version. A bump to either is a DELIBERATE golden
// change (bump + changelog), never a silent regen (the WASM union is
// manifoldVersion-guarded, the crown/cavity-acceptance precedent).
// ---------------------------------------------------------------------------
const EXPECTED_KERNEL_VERSION = '0.26.0';
const EXPECTED_MANIFOLD_VERSION = '3.5.1';
function installedManifoldVersion(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'manifold-3d', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

// The byte-pinned per-stage output hashes of the assembled full-contour + framework
// bridge chains (each op's `outputHashes.join('|')`). NEW at Phase 6 Task 9 (the
// assembled bridge chain has no prior pin). The qc pins embed the QcReport JSON
// (kernelVersion + every gate message/value) — they move mechanically on a
// version-string bump, same as the crown/cavity-standin-qc pins. Change ONLY with a
// deliberate kernel/manifold version bump + changelog entry (CLAUDE.md testing
// expectations) — NEVER a silent regen.
const PINNED_STAGE_HASHES: Readonly<Record<string, string>> = {
  // --- full-contour chain ---
  'bridge-fullContour-abutmentSurfaces': '217b2b13d6d41e657f9b652009a4efe1d3c285a6c4fa428b0030eb0c5070cc8c|d64954bd314424813eed60441adc74dce985310d225e5a9702499bc633f7261c',
  'bridge-fullContour-ponticInterface': '33a62fdc617b6a33c1b3e29547bad02af39874129864e7793ae4662cc11fe430|64124f36c092bf29f4734e1d048cdc161bae31bdebc2d3cb6b082e09eec0229a',
  'bridge-fullContour-connectors': '87fdfd93ad0a7ae8b458cf2464ce83001359ea945ed496867ef4c1af02faea4d|d1d0100a85ee171588af936fd69b51ec23c3d1519ea838ec93c38bbd0e693a77',
  'bridge-fullContour-framework': 'c33569d42f32dd2066ee979259b5486f754dd509f7f0cd6c309136779586e1ca|33a62fdc617b6a33c1b3e29547bad02af39874129864e7793ae4662cc11fe430|1924382f4133673a8bed9e244e3773974c2ec992af8ff3b249b248b07d672958',
  'bridge-fullContour-assembly': 'e90ab9ccdedcdbf34c508b4abf033940b5718b2aa2f74bd1741221bb801108cb',
  'bridge-fullContour-qc': 'aa34ce1474e451ae1d22f2231737773e8c8bc902bf66a63be498a98b949706e9',
  // --- framework chain (bridge.framework outputs the cut-back unit hashes) ---
  'bridge-framework-abutmentSurfaces': '217b2b13d6d41e657f9b652009a4efe1d3c285a6c4fa428b0030eb0c5070cc8c|d64954bd314424813eed60441adc74dce985310d225e5a9702499bc633f7261c',
  'bridge-framework-ponticInterface': '33a62fdc617b6a33c1b3e29547bad02af39874129864e7793ae4662cc11fe430|64124f36c092bf29f4734e1d048cdc161bae31bdebc2d3cb6b082e09eec0229a',
  'bridge-framework-connectors': '87fdfd93ad0a7ae8b458cf2464ce83001359ea945ed496867ef4c1af02faea4d|d1d0100a85ee171588af936fd69b51ec23c3d1519ea838ec93c38bbd0e693a77',
  'bridge-framework-framework': '6d7932a386428e8584b9599a7096d046b1ec78b675fdd071778724271ca1cd5e|7cfcb5def527d11d5234feaaa8ce84b3a3327072561e1bae5b2a5dd88091ba5a|3cac84e76abe26f4f3db514c13d1c10e55e92c4037041897fd64df7ae38016f0',
  'bridge-framework-assembly': '77a8988146b20582b507cbdedaccde425bce95d3bd67f9d2670e232c1777dde6',
  'bridge-framework-qc': '3b316a3785d0ed76e18b45561ac2ae11fd65b56086ccceef52997d0f83faea61',
};

const FULL_GATE_ORDER = [
  'watertight',
  'manifold',
  'selfIntersection',
  'minWallThickness:14',
  'minWallThickness:15',
  'minWallThickness:16',
  'connectorCrossSection',
  'marginFit:14',
  'marginFit:16',
  'ponticRelief',
  'seating',
];

function logTable(tag: string, bridge: AssembledBridge, elapsedMs: number): void {
  for (const g of bridge.qcReport.gates) {
    console.log(`[BRIDGE ACCEPT ${tag}] ${g.gate}: passed=${g.passed} value=${g.value} threshold=${g.threshold} | ${g.message}`);
  }
  const m = bridge.measured;
  console.log(
    `[BRIDGE ACCEPT ${tag}] watertight=${m.assembledWatertight} comps=${m.assembledComponentCount} tris=${m.assembledTriCount} cutback=${m.maxAppliedCutbackMm.toFixed(4)} mm | ` +
      `minWall={14:${µm(m.perUnitMinWallMm['14']!)},15:${µm(m.perUnitMinWallMm['15']!)},16:${µm(m.perUnitMinWallMm['16']!)}} (≥${m.minWallThresholdMm}) | ` +
      `marginFit:14 before=${µm(m.perAbutmentFitBeforeMm['14']!)}→after=${µm(m.perAbutmentFitAfterMm['14']!)} | marginFit:16 before=${µm(m.perAbutmentFitBeforeMm['16']!)}→after=${µm(m.perAbutmentFitAfterMm['16']!)} | ` +
      `connArea=${m.connectorMinAreaMm2.toFixed(4)} mm² (≥${m.connectorThresholdMm2}) | relief=${µm(m.ponticReliefMm)} (≤${µm(m.ponticReliefThresholdMm)}) | ` +
      `seating=${m.seatingValueMm3.toExponential(3)} mm³ (≤${m.seatingThresholdMm3.toExponential(1)}) | full-chain runtime=${(elapsedMs / 1000).toFixed(2)} s`,
  );
}

// ===========================================================================
// 1. FULL-CONTOUR ACCEPTANCE — the assembled 3-unit posterior bridge (MUST pass)
// ===========================================================================
describe('bridge acceptance — FULL-CONTOUR (assembled 3-unit posterior; every gate passes)', () => {
  let bridge: AssembledBridge;
  let elapsedMs: number;

  beforeAll(async () => {
    resetBridgeCaches();
    const t0 = performance.now();
    bridge = await assembleBridgeCase('full');
    elapsedMs = performance.now() - t0;
    logTable('full', bridge, elapsedMs);
  }, 300_000);

  it('assembles ONE watertight single-component solid', () => {
    expect(bridge.measured.assembledWatertight).toBe(true);
    expect(bridge.measured.assembledComponentCount).toBe(1);
  });

  it('runs the whole-bridge gate set in order (per-unit thickness, per-abutment margin fit)', () => {
    expect(bridge.qcReport.gates.map((g) => g.gate)).toEqual(FULL_GATE_ORDER);
    expect(bridge.qcReport.kernelVersion).toBe(KERNEL_VERSION);
    expect(bridge.qcReport.profileVersion).toBe('1.4.0');
  });

  it('EVERY QC gate passes and the report is passed=true', () => {
    for (const g of bridge.qcReport.gates) expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
    expect(bridge.qcReport.passed).toBe(true);
  });

  it('per-abutment margin fit ≤ 10 µm — SURVIVES the union (before/after MEASURED)', () => {
    for (const label of ['14', '16']) {
      expect(bridge.measured.perAbutmentFitBeforeMm[label]!).toBeLessThanOrEqual(0.01);
      expect(bridge.measured.perAbutmentFitAfterMm[label]!).toBeLessThanOrEqual(0.01);
    }
  });

  it('per-unit min wall ≥ the profile minimum (full-contour)', () => {
    for (const label of ['14', '15', '16']) {
      expect(bridge.measured.perUnitMinWallMm[label]!).toBeGreaterThanOrEqual(bridge.measured.minWallThresholdMm);
    }
    expect(bridge.measured.minWallThresholdMm).toBe(0.5);
    expect(bridge.measured.maxAppliedCutbackMm).toBe(0); // no cutback in full-contour
  });

  it('connector area ≥ the posterior target; pontic relief ≤ 20 µm; seating clean', () => {
    expect(bridge.measured.connectorMinAreaMm2).toBeGreaterThanOrEqual(bridge.measured.connectorThresholdMm2);
    expect(bridge.measured.connectorThresholdMm2).toBe(9);
    expect(bridge.measured.ponticReliefMm).toBeLessThanOrEqual(0.02);
    expect(bridge.measured.seatingValueMm3).toBeLessThanOrEqual(bridge.measured.seatingThresholdMm3);
    expect(bridge.measured.seatingValueMm3).toBeLessThan(1e-6);
  });
});

// ===========================================================================
// 2. FRAMEWORK ACCEPTANCE — genuinely cut-back units, mode-switched thresholds
// ===========================================================================
describe('bridge acceptance — FRAMEWORK (units cut back; mode-switched thickness gate; every gate passes)', () => {
  let bridge: AssembledBridge;
  let elapsedMs: number;

  beforeAll(async () => {
    resetBridgeCaches();
    const t0 = performance.now();
    bridge = await assembleBridgeCase('framework');
    elapsedMs = performance.now() - t0;
    logTable('framework', bridge, elapsedMs);
  }, 300_000);

  it('assembles ONE watertight single-component solid from the CUT-BACK units', () => {
    expect(bridge.measured.assembledWatertight).toBe(true);
    expect(bridge.measured.assembledComponentCount).toBe(1);
    // The veneering space was genuinely applied (the cut-back units were assembled).
    expect(bridge.measured.maxAppliedCutbackMm).toBeCloseTo(1.0, 6);
  });

  it('EVERY QC gate passes with the framework thickness minimum', () => {
    for (const g of bridge.qcReport.gates) expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
    expect(bridge.qcReport.passed).toBe(true);
    // The cut-back wall (≈ 1.0 mm) is genuinely thinner than the full-contour 2.0 mm
    // but ≥ the 0.5 mm framework minimum — the mode-switched gate measured the
    // CUT-BACK outer surface (not a full-contour stand-in).
    for (const label of ['14', '15', '16']) {
      expect(bridge.measured.perUnitMinWallMm[label]!).toBeGreaterThanOrEqual(0.5);
      expect(bridge.measured.perUnitMinWallMm[label]!).toBeLessThan(1.5);
    }
  });

  it('the fit surfaces survive the cutback + union — per-abutment margin fit ≤ 10 µm', () => {
    for (const label of ['14', '16']) {
      expect(bridge.measured.perAbutmentFitBeforeMm[label]!).toBeLessThanOrEqual(0.01);
      expect(bridge.measured.perAbutmentFitAfterMm[label]!).toBeLessThanOrEqual(0.01);
    }
  });
});

// ===========================================================================
// 3. FALSIFIABLE BLOCKS — 5 mm² connector + mis-configured relief (NOT weakened)
// ===========================================================================
describe('bridge acceptance — falsifiable blocks (gates NOT weakened)', () => {
  it('a 5 mm² posterior connector BLOCKS (connectorCrossSection), report blocked', async () => {
    resetBridgeCaches();
    const block = await assembleBridgeCase('connector5');
    const g = block.qcReport.gates.find((x) => x.gate === 'connectorCrossSection')!;
    console.log(`[BRIDGE BLOCK #1] 5 mm² connector → ${g.passed ? 'PASS' : 'BLOCK'}: value=${g.value?.toFixed(4)} mm² (target ${g.threshold}) | report.passed=${block.qcReport.passed}`);
    expect(block.measured.connectorMinAreaMm2).toBeLessThan(9);
    expect(g.passed).toBe(false);
    expect(block.qcReport.passed).toBe(false);
  }, 300_000);

  it('a mis-configured pontic relief (built 1.0 mm, judged vs 2.0 mm) BLOCKS ponticRelief', () => {
    const bad = measureStyleRelief('hygienic', 1.0);
    console.log(`[BRIDGE BLOCK #2] mis-configured relief → maxAbs=${µm(bad.maxAbsDeviationMm)} (≫ 20 µm)`);
    expect(bad.maxAbsDeviationMm).toBeGreaterThan(0.02);
    const gate = ponticReliefGate({ maxAbsDeviationMm: bad.maxAbsDeviationMm, style: 'hygienic', configuredReliefMm: 2.0 });
    expect(gate.passed).toBe(false);
  });
});

// ===========================================================================
// 4. RELIEF ±20µm PER STYLE — measured in the chain
// ===========================================================================
describe('bridge acceptance — pontic relief within ±20 µm per configured style', () => {
  for (const style of ['hygienic', 'ridgeLap', 'ovate'] as const) {
    it(`${style}: measured relief matches the configured value within ±20 µm`, () => {
      const m = measureStyleRelief(style);
      console.log(`[BRIDGE RELIEF ${style}] configured=${m.configuredMm} mm → measured maxAbs=${µm(m.maxAbsDeviationMm)} (min ${µm(m.minDeviationMm)} / mean ${µm(m.meanDeviationMm)}); errorBound ${µm(m.errorBoundMm)}`);
      expect(m.maxAbsDeviationMm).toBeLessThanOrEqual(0.02);
    });
  }
});

// ===========================================================================
// 5. JOURNAL REPRODUCIBILITY — record → replay → bit-identical (the phase-gate crux)
// ===========================================================================
for (const mode of ['fullContour', 'framework'] as const) {
  describe(`bridge journal reproducibility — ${mode}: record → replay → bit-identical stage hashes`, () => {
    let recorded: RecordedBridgeJournal;

    beforeAll(async () => {
      resetBridgeCaches();
      recorded = await recordBridgeJournal(mode as BridgeMode);
      for (const op of recorded.operations) console.log(`[BRIDGE JOURNAL ${mode}] ${op.id} ${op.name} → ${op.outputHashes.join('|')}`);
    }, 300_000);

    it('records one content-addressed Operation per stage (all 6)', () => {
      expect(recorded.operations.map((op) => op.name)).toEqual([
        'bridge.abutmentSurfaces',
        'bridge.ponticInterface',
        'bridge.connectors',
        'bridge.framework',
        'bridge.assembly',
        'qc.run',
      ]);
      for (const op of recorded.operations) {
        expect(op.outputHashes.length).toBeGreaterThanOrEqual(1);
        for (const h of op.outputHashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
        expect(op.kernelVersion).toBe(KERNEL_VERSION);
      }
    });

    it('replaying the journal FRESH reproduces EVERY stage hash bit-identically', async () => {
      resetBridgeCaches();
      const failures = await replayBridgeJournal(recorded);
      if (failures.length > 0) {
        const report = failures.map((f) => `  - ${f.stage}: expected ${f.expectedHash}, got ${f.actualHash}`).join('\n');
        throw new Error(`bridge ${mode} journal replay: ${failures.length} stage(s) failed to reproduce (a determinism leak — find + fix, do not loosen):\n${report}`);
      }
      expect(failures).toHaveLength(0);
    }, 300_000);

    it('the recorded stage hashes match the byte-pinned golden (KERNEL_VERSION + manifold-3d guarded)', () => {
      expect(KERNEL_VERSION, 'KERNEL_VERSION bumped → revisit the byte-pinned bridge-acceptance stage hashes').toBe(EXPECTED_KERNEL_VERSION);
      expect(installedManifoldVersion(), 'manifold-3d bumped → the WASM-dependent assembly/qc stage hashes may change (deliberate golden update + changelog)').toBe(EXPECTED_MANIFOLD_VERSION);
      for (const op of recorded.operations) {
        expect(op.outputHashes.join('|'), `stage ${op.id} drifted from its byte-pinned golden`).toBe(PINNED_STAGE_HASHES[op.id]);
      }
    });

    it('the assembled chain is itself deterministic (two records → identical hashes)', async () => {
      resetBridgeCaches();
      const again = await recordBridgeJournal(mode as BridgeMode);
      expect(again.operations.map((op) => op.outputHashes.join('|'))).toEqual(recorded.operations.map((op) => op.outputHashes.join('|')));
    }, 300_000);
  });
}

// Referenced so the stageId helper stays exercised (the ids above mirror it).
it('bridge stage ids follow the bridge-<mode>-<stage> convention', () => {
  expect(bridgeStageId('fullContour', 'assembly')).toBe('bridge-fullContour-assembly');
  expect(bridgeStageId('framework', 'qc')).toBe('bridge-framework-qc');
});
