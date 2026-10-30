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
const EXPECTED_KERNEL_VERSION = '0.35.0';
const EXPECTED_MANIFOLD_VERSION = '3.5.1';
function installedManifoldVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, 'node_modules', 'manifold-3d', 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

// The byte-pinned per-stage output hashes of the assembled full-contour + framework
// bridge chains (each op's `outputHashes.join('|')`). NEW at Phase 6 Task 9 (the
// assembled bridge chain has no prior pin). The qc pins embed the QcReport JSON
// (kernelVersion + every gate message/value) — they move mechanically on a
// version-string bump, same as the crown/cavity-standin-qc pins. Change ONLY with a
// deliberate kernel/manifold version bump + changelog entry (CLAUDE.md testing
// expectations) — NEVER a silent regen.
//
// Changed at 0.35.0 (cross-platform determinism): the bridge fixture's rings and
// the kernel's transcendentals now use detMath (pure-IEEE fdlibm), so
// abutmentSurfaces, ponticInterface, connectors and framework moved (≤ 1 ulp per
// sin/cos/atan2/acos; the assembly, through manifold's union, is byte-identical).
// Old abutmentSurfaces 217b2b13…|d64954bd…, ponticInterface 33a62fdc…|64124f36…,
// connectors 87fdfd93…|d1d0100a…, fullContour framework c33569d4…, framework-chain
// framework 6d7932a3… (full values in git history). The new values are the same
// on darwin-arm64 and x64 — the old ones were not (Linux CI drifted).
const PINNED_STAGE_HASHES: Readonly<Record<string, string>> = {
  // --- full-contour chain ---
  'bridge-fullContour-abutmentSurfaces':
    '1e1565f6e650bf24b7c54ca7456abfd9e535ffd11b41561278f3c392cf9bfda2|781ac6db8a515739137d04dc7a05418f8a7e78978e0d413de29f9dd8b619f36f',
  'bridge-fullContour-ponticInterface':
    '635da922576298f1715f0f3ccff2497ca28eff9484ca9038a1b193de5f9a786b|3bbc98c2af73164e80a5cd108ccba1354c88206d6083a0497c13e409a8f5ab96',
  'bridge-fullContour-connectors':
    'd731e0767efed948ee7fd2c507b1ee017fee24808227ba0b1dc581c6af8ad6e3|76f56c82d81ff3e434fd322635d77d13e2c2b0e50aabb77453da86b21a6423ee',
  'bridge-fullContour-framework':
    'b2cfd81d09fefe8a384a7d16119175cfbadc2e537a2db25db0856b989838930a|635da922576298f1715f0f3ccff2497ca28eff9484ca9038a1b193de5f9a786b|e6d453318bdd249819495f8439042db79ad43c213206f4faeb60e5c1b9f9a56d',
  'bridge-fullContour-assembly': 'e90ab9ccdedcdbf34c508b4abf033940b5718b2aa2f74bd1741221bb801108cb',
  // Advanced 0.26.0 → 0.27.0 (Feature #4): DELIBERATE, message+version — the
  // selfIntersection gate is now a TRUE geometric tri-tri determination (was a
  // manifold-topology proxy), changing its message; the QcReport also embeds the
  // bumped kernelVersion. NOT a passed:true→false flip: this file's "EVERY QC
  // gate passes" assertions stay green for both modes (the scan finds 0
  // self-intersecting face pairs), and every geometry-stage pin above is
  // BYTE-IDENTICAL (verified: only the two -qc pins drifted in the 0.27.0 run).
  // Old hash: aa34ce1474e451ae1d22f2231737773e8c8bc902bf66a63be498a98b949706e9.
  // See CHANGELOG-kernel.md [0.27.0].
  // Advanced 0.27.0 → 0.28.0 (Phase 9 Task 3): MECHANICAL, metadata-only — the new
  // neighbour/extractNeighbourRegion op does not touch this chain; hashQcReport tracks
  // the embedded kernelVersion, every geometry stage pin above BYTE-IDENTICAL to
  // 0.27.0 (verified). Old hash: 67a9ea023389489b80cb5a2af34b1d6de3f6357d48e62ec778981379c46d413e. See docs/CHANGELOG-kernel.md's [0.28.0] entry.
  // Advanced 0.28.0 → 0.29.0 (Phase 9 Task 5): MECHANICAL, metadata-only — the new
  // bridge/ridgeCrest fit is not in this chain; hashQcReport tracks the embedded
  // kernelVersion, every geometry stage pin above BYTE-IDENTICAL to 0.28.0
  // (verified). Old hash: fd334638fc1521e55567934165d4aedf5f8b6760ef84ee3565b818aa00ea7000. See docs/CHANGELOG-kernel.md's [0.29.0] entry.
  // Advanced 0.29.0 → 0.30.0 (Phase 9 Task 6): MECHANICAL, metadata-only — the new
  // bridge/ponticUnit + connector auto-placement ops are not in this chain; hashQcReport
  // tracks the embedded kernelVersion, every geometry stage pin above BYTE-IDENTICAL to
  // 0.29.0 (verified: the whole golden suite passes at 0.29.0 with the old pins). Old hash: c50f65771a511d0d7edf5b87899ec6e0d78b11999296921fa2f4f4728afb5963. See docs/CHANGELOG-kernel.md's [0.30.0] entry.
  // Advanced 0.30.0 → 0.31.0 (Phase 9 Task 7): MECHANICAL, metadata-only — the
  // tri-tri predicate's coplanar fix changes no gate of this chain (its report had
  // no near-coplanar pair); every geometry stage pin above BYTE-IDENTICAL (verified: the
  // whole golden suite passes at 0.30.0 with the fix). Old hash: 08364b8cbaed7f54294acc22ef0235438ecbe00a5fc6986b8105c3dee496b748. See docs/CHANGELOG-kernel.md's [0.31.0] entry.
  // Advanced 0.31.0 → 0.32.0 (Phase 10 Task 1): MECHANICAL, metadata-only — the new
  // die/extractPrepDie op is not in this chain; hashQcReport tracks the embedded
  // kernelVersion, every geometry stage pin above BYTE-IDENTICAL (verified: the whole
  // golden suite passes at 0.31.0 with the new code). Old hash: 1853c3623766e1bea64783e753fa50d9e0184942821c7b1d08e8e63ea21d43d2. See docs/CHANGELOG-kernel.md's [0.32.0] entry.
  // Advanced 0.32.0 → 0.33.0 (Phase 10 Task 2): MECHANICAL, metadata-only — the die
  // passthrough, persistedMeshForm and the coverage check are not in this chain;
  // hashQcReport tracks the embedded kernelVersion, every geometry stage pin above
  // BYTE-IDENTICAL (verified: the whole golden suite passes at 0.32.0 with the new
  // code). Old hash: d0110a010d4adb7ca3a01e918b304b0623b76154b7d99d3d1399c2e8e0f6ebb2. See docs/CHANGELOG-kernel.md's [0.33.0] entry.
  // Advanced 0.33.0 → 0.34.0 (Phase 10 Task 4): MECHANICAL, metadata-only — the cervical
  // fit and the ring trim are not in this chain; hashQcReport tracks the embedded
  // kernelVersion, every geometry stage pin above BYTE-IDENTICAL (verified: the whole
  // golden suite passes at 0.33.0 with the new code). Old hash: 300309b51f9d94ff4c66eebe0adc0c203a01067fc998c48f835a3a74d80de24d. See docs/CHANGELOG-kernel.md's [0.34.0] entry.
  // Advanced 0.34.0 → 0.35.0 (cross-platform determinism): NUMERIC — the chain's
  // transcendentals (the fixture's ring sin/cos, the kernel's atan2/acos) now go
  // through detMath (pure-IEEE fdlibm) instead of Math.*, ≤ 1 ulp per call; the
  // hashes are now the same on darwin-arm64 and x64 (verified under both).
  // Old hash: 9b770eaec9a4163032daccb99f92d80a061850d24eb84fc35d7fea2fd2ad8eda. See docs/CHANGELOG-kernel.md's [0.35.0] entry.
  'bridge-fullContour-qc': '38817a0ee5b3a08cc368e1e010f9227edaf433fc05b7107d223c0ba8bbf0e62a',
  // --- framework chain (bridge.framework outputs the cut-back unit hashes) ---
  'bridge-framework-abutmentSurfaces':
    '1e1565f6e650bf24b7c54ca7456abfd9e535ffd11b41561278f3c392cf9bfda2|781ac6db8a515739137d04dc7a05418f8a7e78978e0d413de29f9dd8b619f36f',
  'bridge-framework-ponticInterface':
    '635da922576298f1715f0f3ccff2497ca28eff9484ca9038a1b193de5f9a786b|3bbc98c2af73164e80a5cd108ccba1354c88206d6083a0497c13e409a8f5ab96',
  'bridge-framework-connectors':
    'd731e0767efed948ee7fd2c507b1ee017fee24808227ba0b1dc581c6af8ad6e3|76f56c82d81ff3e434fd322635d77d13e2c2b0e50aabb77453da86b21a6423ee',
  'bridge-framework-framework':
    '40b7d0ebd760926fef36c60a03720f22467a46988412b992a51c343c959a3dc8|d97b259dec72587be24c5a664968e995e774282bad97efe922b6d6f7666b6bc7|3b76167d6a71ba19c8d84f0d492b4cc81567463c0207730d5543c584f8b63dba',
  'bridge-framework-assembly': '77a8988146b20582b507cbdedaccde425bce95d3bd67f9d2670e232c1777dde6',
  // Advanced 0.26.0 → 0.27.0 (Feature #4): DELIBERATE, message+version (as
  // bridge-fullContour-qc above). Old hash:
  // 3b316a3785d0ed76e18b45561ac2ae11fd65b56086ccceef52997d0f83faea61. See
  // CHANGELOG-kernel.md [0.27.0].
  // Advanced 0.27.0 → 0.28.0 (Phase 9 Task 3): MECHANICAL, metadata-only — the new
  // neighbour/extractNeighbourRegion op does not touch this chain; hashQcReport tracks
  // the embedded kernelVersion, every geometry stage pin above BYTE-IDENTICAL to
  // 0.27.0 (verified). Old hash: 02a748f9adeae37bbb668db7802368f94eece324baa61eb1079c31780138df10. See docs/CHANGELOG-kernel.md's [0.28.0] entry.
  // Advanced 0.28.0 → 0.29.0 (Phase 9 Task 5): MECHANICAL, metadata-only — the new
  // bridge/ridgeCrest fit is not in this chain; hashQcReport tracks the embedded
  // kernelVersion, every geometry stage pin above BYTE-IDENTICAL to 0.28.0
  // (verified). Old hash: c38239c267b1d580eeb055b4bd02c45517d081f6f84d3a57db4485d758f74686. See docs/CHANGELOG-kernel.md's [0.29.0] entry.
  // Advanced 0.29.0 → 0.30.0 (Phase 9 Task 6): MECHANICAL, metadata-only — the new
  // bridge/ponticUnit + connector auto-placement ops are not in this chain; hashQcReport
  // tracks the embedded kernelVersion, every geometry stage pin above BYTE-IDENTICAL to
  // 0.29.0 (verified: the whole golden suite passes at 0.29.0 with the old pins). Old hash: 345bf02dd1b869da7849798e91901be5a91ed5d7eab76c964ee87e1fb1d9d9d1. See docs/CHANGELOG-kernel.md's [0.30.0] entry.
  // Advanced 0.30.0 → 0.31.0 (Phase 9 Task 7): MECHANICAL, metadata-only — the
  // tri-tri predicate's coplanar fix changes no gate of this chain (its report had
  // no near-coplanar pair); every geometry stage pin above BYTE-IDENTICAL (verified: the
  // whole golden suite passes at 0.30.0 with the fix). Old hash: 4f924c29bb01469c3f2e27ed1849d03692ad31ec7a5e8d7bd0a241de0257629e. See docs/CHANGELOG-kernel.md's [0.31.0] entry.
  // Advanced 0.31.0 → 0.32.0 (Phase 10 Task 1): MECHANICAL, metadata-only — the new
  // die/extractPrepDie op is not in this chain; hashQcReport tracks the embedded
  // kernelVersion, every geometry stage pin above BYTE-IDENTICAL (verified: the whole
  // golden suite passes at 0.31.0 with the new code). Old hash: 4b6dbd0149ef14317d7d39ac8df151b70ad39b10babcbdf13886d850b3a6425a. See docs/CHANGELOG-kernel.md's [0.32.0] entry.
  // Advanced 0.32.0 → 0.33.0 (Phase 10 Task 2): MECHANICAL, metadata-only — the die
  // passthrough, persistedMeshForm and the coverage check are not in this chain;
  // hashQcReport tracks the embedded kernelVersion, every geometry stage pin above
  // BYTE-IDENTICAL (verified: the whole golden suite passes at 0.32.0 with the new
  // code). Old hash: 8b3b980216277b37eb9871d42588d310972505cd577b3271b00f661b22124506. See docs/CHANGELOG-kernel.md's [0.33.0] entry.
  // Advanced 0.33.0 → 0.34.0 (Phase 10 Task 4): MECHANICAL, metadata-only — the cervical
  // fit and the ring trim are not in this chain; hashQcReport tracks the embedded
  // kernelVersion, every geometry stage pin above BYTE-IDENTICAL (verified: the whole
  // golden suite passes at 0.33.0 with the new code). Old hash: e039b039fae0ff68cabfab16113a4fec0f479c2d2fc53025c6666fcbac039475. See docs/CHANGELOG-kernel.md's [0.34.0] entry.
  // Advanced 0.34.0 → 0.35.0 (cross-platform determinism): NUMERIC — the chain's
  // transcendentals (the fixture's ring sin/cos, the kernel's atan2/acos) now go
  // through detMath (pure-IEEE fdlibm) instead of Math.*, ≤ 1 ulp per call; the
  // hashes are now the same on darwin-arm64 and x64 (verified under both).
  // Old hash: 1a0bc8a648bcde8c04f3cc622a157c9524e3b668585107f572d55af529a058c3. See docs/CHANGELOG-kernel.md's [0.35.0] entry.
  'bridge-framework-qc': '4ba64eefca9ae43da50b4e50f776d7905e7f52b2685fa3b361aa7a18d862f047',
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
    console.log(
      `[BRIDGE ACCEPT ${tag}] ${g.gate}: passed=${g.passed} value=${g.value} threshold=${g.threshold} | ${g.message}`,
    );
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
      expect(bridge.measured.perUnitMinWallMm[label]!).toBeGreaterThanOrEqual(
        bridge.measured.minWallThresholdMm,
      );
    }
    expect(bridge.measured.minWallThresholdMm).toBe(0.5);
    expect(bridge.measured.maxAppliedCutbackMm).toBe(0); // no cutback in full-contour
  });

  it('connector area ≥ the posterior target; pontic relief ≤ 20 µm; seating clean', () => {
    expect(bridge.measured.connectorMinAreaMm2).toBeGreaterThanOrEqual(
      bridge.measured.connectorThresholdMm2,
    );
    expect(bridge.measured.connectorThresholdMm2).toBe(9);
    expect(bridge.measured.ponticReliefMm).toBeLessThanOrEqual(0.02);
    expect(bridge.measured.seatingValueMm3).toBeLessThanOrEqual(
      bridge.measured.seatingThresholdMm3,
    );
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
    console.log(
      `[BRIDGE BLOCK #1] 5 mm² connector → ${g.passed ? 'PASS' : 'BLOCK'}: value=${g.value?.toFixed(4)} mm² (target ${g.threshold}) | report.passed=${block.qcReport.passed}`,
    );
    expect(block.measured.connectorMinAreaMm2).toBeLessThan(9);
    expect(g.passed).toBe(false);
    expect(block.qcReport.passed).toBe(false);
  }, 300_000);

  it('a mis-configured pontic relief (built 1.0 mm, judged vs 2.0 mm) BLOCKS ponticRelief', () => {
    const bad = measureStyleRelief('hygienic', 1.0);
    console.log(
      `[BRIDGE BLOCK #2] mis-configured relief → maxAbs=${µm(bad.maxAbsDeviationMm)} (≫ 20 µm)`,
    );
    expect(bad.maxAbsDeviationMm).toBeGreaterThan(0.02);
    const gate = ponticReliefGate({
      maxAbsDeviationMm: bad.maxAbsDeviationMm,
      style: 'hygienic',
      configuredReliefMm: 2.0,
    });
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
      console.log(
        `[BRIDGE RELIEF ${style}] configured=${m.configuredMm} mm → measured maxAbs=${µm(m.maxAbsDeviationMm)} (min ${µm(m.minDeviationMm)} / mean ${µm(m.meanDeviationMm)}); errorBound ${µm(m.errorBoundMm)}`,
      );
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
      for (const op of recorded.operations)
        console.log(`[BRIDGE JOURNAL ${mode}] ${op.id} ${op.name} → ${op.outputHashes.join('|')}`);
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
        const report = failures
          .map((f) => `  - ${f.stage}: expected ${f.expectedHash}, got ${f.actualHash}`)
          .join('\n');
        throw new Error(
          `bridge ${mode} journal replay: ${failures.length} stage(s) failed to reproduce (a determinism leak — find + fix, do not loosen):\n${report}`,
        );
      }
      expect(failures).toHaveLength(0);
    }, 300_000);

    it('the recorded stage hashes match the byte-pinned golden (KERNEL_VERSION + manifold-3d guarded)', () => {
      expect(
        KERNEL_VERSION,
        'KERNEL_VERSION bumped → revisit the byte-pinned bridge-acceptance stage hashes',
      ).toBe(EXPECTED_KERNEL_VERSION);
      expect(
        installedManifoldVersion(),
        'manifold-3d bumped → the WASM-dependent assembly/qc stage hashes may change (deliberate golden update + changelog)',
      ).toBe(EXPECTED_MANIFOLD_VERSION);
      for (const op of recorded.operations) {
        expect(
          op.outputHashes.join('|'),
          `stage ${op.id} drifted from its byte-pinned golden`,
        ).toBe(PINNED_STAGE_HASHES[op.id]);
      }
    });

    it('the assembled chain is itself deterministic (two records → identical hashes)', async () => {
      resetBridgeCaches();
      const again = await recordBridgeJournal(mode as BridgeMode);
      expect(again.operations.map((op) => op.outputHashes.join('|'))).toEqual(
        recorded.operations.map((op) => op.outputHashes.join('|')),
      );
    }, 300_000);
  });
}

// Referenced so the stageId helper stays exercised (the ids above mirror it).
it('bridge stage ids follow the bridge-<mode>-<stage> convention', () => {
  expect(bridgeStageId('fullContour', 'assembly')).toBe('bridge-fullContour-assembly');
  expect(bridgeStageId('framework', 'qc')).toBe('bridge-framework-qc');
});
