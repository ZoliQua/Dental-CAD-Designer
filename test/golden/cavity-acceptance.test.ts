// test/golden/cavity-acceptance.test.ts
//
// Phase 5 Task 10 — THE PHASE GATE: the complete-pipeline inlay AND onlay
// acceptance harness + full journal reproducibility. Assembles the fixed-order
// cavity stages (onlay: cuspCoverage → inner → patch → contact → shell → qc;
// inlay: the same without cuspCoverage) into one recorded journal and proves
// record → replay → BIT-IDENTICAL stage hashes (CLAUDE.md invariants 2/3 — the
// hardest determinism bar: SDF/MC offset + Hermite patch + per-box Newton + weld
// + WASM gates all deterministic through the whole chain). GENUINELY COUPLED
// (the P4-T12b lesson): the patch that is contact-adapted is the patch that is
// shelled; the extended outline the cuspCoverage stage selects IS the outline the
// fit/patch/shell are all built on. See scripts/cavity-journal-lib.ts.
//
// ## The honest acceptance framing (the T7/T9 carry-flag — LOUD)
//
//   - The INLAY meets PLAN §3 "seating clean": 0 mm³, empty intersection.
//   - The ONLAY's report.passed=true RESTS ON THE ACKNOWLEDGED seating (~0.06 mm³
//     bounded + localized T7 junction artifact — the seating gate is passed=false
//     + acknowledged=true, threshold NEVER weakened). This suite asserts EXACTLY
//     that state and the bounded+localized guards ride along (the T7 fix reused).
//
// ## Parts
//
//   1. INLAY ACCEPTANCE (always runs) — the full assembled chain; every gate
//      passes; margin fit ≤10 µm; seam < 5°; seating clean 0 mm³; shallow-cavity
//      variant → thickness BLOCKS. Every number MEASURED + REPORTED.
//   2. ONLAY ACCEPTANCE (always runs) — the full assembled chain; every gate
//      passes OR is acknowledged; the acknowledged seating asserted EXACTLY
//      (passed=false + acknowledged=true + report.passed=true + bounded+localized);
//      region-scoped cuspCoverage with onlay minimums; thin-coverage → BLOCKS.
//   3. JOURNAL REPRODUCIBILITY (always runs) — record → replay → bit-identical
//      stage hashes for BOTH chains; byte-pinned (KERNEL_VERSION + manifold-3d
//      guarded); two-record determinism.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KERNEL_VERSION } from '@dqcad/kernel';
import {
  assembleCavity,
  analyzeSeatingInterference,
  recordCavityJournal,
  replayCavityJournal,
  resetCavityCaches,
  stageId,
  ACK_MAX_INTERFERENCE_MM3,
  JUNCTION_BAND,
  JUNCTION_BAND_MIN_FRACTION,
  type AssembledCavity,
  type RecordedCavityJournal,
} from '../../scripts/cavity-journal-lib.ts';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';

const µm = (mm: number): string => `${(mm * 1000).toFixed(3)} µm`;

// ---------------------------------------------------------------------------
// Version guard — the byte-pinned stage hashes below are valid ONLY for this
// kernel + this manifold-3d WASM version. A bump to either is a DELIBERATE
// golden change (bump + changelog), never a silent regen (the WASM boolean is
// manifoldVersion-guarded, the crown-acceptance precedent).
// ---------------------------------------------------------------------------
const EXPECTED_KERNEL_VERSION = '0.26.0';
const EXPECTED_MANIFOLD_VERSION = '3.5.1';
function installedManifoldVersion(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'manifold-3d', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

// The byte-pinned stage-output hashes of the assembled inlay + onlay chains.
// Change ONLY with a deliberate kernel/manifold version bump + changelog entry
// (CLAUDE.md testing expectations). NEW at Phase 5 Task 10 (the assembled cavity
// chain has no prior pin). The qc pins embed the QcReport JSON (kernelVersion +
// every gate message/value) — they move mechanically on a version-string bump,
// same as the crown-standin-qc pin.
const PINNED_STAGE_HASHES: Readonly<Record<string, string>> = {
  // --- inlay chain ---
  'cavity-inlay-innerSurface': '711d676286fc4036e9033c826967b9fa692d2b3a59191757f3b97257eb1f0988',
  'cavity-inlay-occlusalPatch': '33b0f565b104599879d3092f7de416f0d991375d9d74d318a6f60efaf9f3bd52',
  'cavity-inlay-proximalContact': '09ee8088b75c0ecc918c412d9a197aa156ddebec6d842fe3ac567b05328db401',
  'cavity-inlay-shell': '1d81e21d9892acd607015724e5ed0476a614408a1fb032cd0473a9901af91861',
  // Advanced 0.21.0 → 0.22.0 (Phase 6 Task 2): MECHANICAL, metadata-only churn —
  // the QcReport embeds kernelVersion, so hashQcReport tracks the version bump
  // while every geometry pin above is BYTE-IDENTICAL to 0.21.0 (verified). The
  // bridge op does not touch the cavity chain. See CHANGELOG-kernel.md [0.22.0].
  // Advanced 0.24.0 → 0.25.0 (Phase 6 Task 5): MECHANICAL, metadata-only (the new
  // bridge/frameworkCutback op does not touch the cavity chain; kernelVersion in the
  // QcReport, geometry byte-identical to 0.24.0). See CHANGELOG-kernel.md [0.25.0].
  // Advanced 0.25.0 → 0.26.0 (Phase 6 Task 6): MECHANICAL, metadata-only (the new
  // bridge/bridgeAssembly union op does not touch the cavity chain; kernelVersion in
  // the QcReport, geometry byte-identical to 0.25.0). See CHANGELOG-kernel.md [0.26.0].
  //
  // Advanced (code-review-fixes): DELIBERATE, MESSAGE-ONLY — NO KERNEL_VERSION bump
  // (the change is a cad-pipeline gate-message hardening, not kernel numeric output;
  // test-fixtures/golden/kernel-ops.json is untouched, KERNEL_VERSION stays 0.26.0).
  // `hashQcReport` = sha256(JSON.stringify(report)) embeds every gate MESSAGE. The
  // cavity `minWallThickness` gate now appends the UNGATED-THIN-FLOOR disclosure
  // (cad-pipeline review MEDIUM): a wide cavosurface exclusion band (1.3 mm inlay /
  // 1.8 mm onlay) excludes a sub-minimum feather, which is now surfaced un-missably
  // ("WARNING: the excluded band contains a wall as thin as … NOT gated here …"). The
  // five geometry pins above are BYTE-IDENTICAL (verified this run — proof it is a
  // message-only diff, no numeric drift); every gate's passed/value/threshold is
  // unchanged. Same in-test pin-advance discipline as the crown-standin-qc Task-8
  // message hardening. See the fix-cadpipeline report.
  'cavity-inlay-qc': 'b800cfd29b54859f04b09c3c2aa0623eceb9bcc818e119659da8443d589afa51',
  // --- onlay chain (incl. cuspCoverage.select) ---
  // NOTE: the cuspCoverage pin is BIT-IDENTICAL to the kernel op's committed
  // extended-outline golden (cuspCoverage.test.ts's sha at 0.21.0) — a strong
  // cross-check that the harness selects exactly the same extended outline.
  'cavity-onlay-cuspCoverage': 'c0f4ad5e37be55ac948c80fc9b30fe9f4ce81da7e81ec73653565f294de81734',
  'cavity-onlay-innerSurface': '2f538423f5c5cd428861965a68038b2847d5de5db22645b8563ccb9dd138c8c3',
  'cavity-onlay-occlusalPatch': '579ee8361396e0cfcd72ba9d194278c1d353dbb6f9c59a3cb5a38302e30fb62c',
  'cavity-onlay-proximalContact': '4b0151794b4c4387b734820436a709adb43d7cdade36d407e20bea111c7d5fdf',
  'cavity-onlay-shell': 'cd9bc9e37841493a502ae367dc62fcc1a9b3a8e72d5471f6116e12c0c65595ce',
  // Advanced 0.21.0 → 0.22.0 (Phase 6 Task 2): MECHANICAL, metadata-only (as
  // cavity-inlay-qc above — kernelVersion in the QcReport; geometry byte-identical).
  // Advanced 0.24.0 → 0.25.0 (Phase 6 Task 5): MECHANICAL, metadata-only (as
  // cavity-inlay-qc above). See CHANGELOG-kernel.md [0.25.0].
  // Advanced 0.25.0 → 0.26.0 (Phase 6 Task 6): MECHANICAL, metadata-only (as
  // cavity-inlay-qc above). See CHANGELOG-kernel.md [0.26.0].
  // Advanced (code-review-fixes): DELIBERATE, MESSAGE-ONLY — the ungated-thin-floor
  // disclosure on the cavity minWallThickness gate (as cavity-inlay-qc above; NO
  // KERNEL_VERSION bump, geometry byte-identical this run). See the fix report.
  'cavity-onlay-qc': '85f0c2b310c77bf15f7e2dd7153054c01328bc7cb7e131b12f43903366c8f9ec',
};

const INLAY_GATE_ORDER = ['watertight', 'manifold', 'selfIntersection', 'minWallThickness', 'marginFit', 'seamDihedral', 'seating', 'contact'];
const ONLAY_GATE_ORDER = ['watertight', 'manifold', 'selfIntersection', 'minWallThickness', 'cuspCoverageThickness', 'marginFit', 'seamDihedral', 'seating', 'contact'];

// ===========================================================================
// 1. INLAY ACCEPTANCE — the full assembled chain (MUST pass; seating CLEAN)
// ===========================================================================
describe('cavity acceptance — INLAY (full assembled chain: all gates pass; seating clean 0 mm³)', () => {
  let inlay: AssembledCavity;
  let elapsedMs: number;

  beforeAll(async () => {
    resetCavityCaches();
    const t0 = performance.now();
    inlay = await assembleCavity('inlay');
    elapsedMs = performance.now() - t0;
    for (const g of inlay.qcReport.gates) {
      console.log(`[CAVITY ACCEPT inlay] ${g.gate}: passed=${g.passed} value=${g.value} threshold=${g.threshold} ${g.unit ?? ''} | ${g.message}`);
    }
    console.log(
      `[CAVITY ACCEPT inlay] margin-fit=${µm(inlay.measured.marginFitMm)} | seam=${inlay.measured.seamDihedralDeg.toFixed(4)}° | ` +
        `seating=${inlay.measured.seatingValueMm3.toExponential(3)} mm³ (≤${inlay.measured.seatingThresholdMm3.toExponential(1)}) | ` +
        `min-wall=${inlay.measured.minWallThicknessMm.toFixed(4)} mm (≥${inlay.measured.minWallThresholdMm}) | ` +
        `max-contact-residual=${µm(inlay.measured.maxContactResidualMm)} clamp=${inlay.measured.contactClampWarning} | ` +
        `shell tris=${inlay.measured.shellTriCount} watertight=${inlay.measured.shellWatertight} | full-chain runtime=${(elapsedMs / 1000).toFixed(2)} s`,
    );
  }, 300_000);

  it('runs all stages producing content-addressed outputs, in gate order', () => {
    expect(inlay.fit.meshContentHash).toBeTruthy();
    expect(inlay.patch.meshContentHash).toBeTruthy();
    expect(inlay.contact.meshContentHash).toBeTruthy();
    expect(inlay.shell.meshContentHash).toBeTruthy();
    expect(inlay.cuspCoverage).toBeNull(); // no cusp coverage on an inlay
    expect(inlay.qcReport.gates.map((g) => g.gate)).toEqual(INLAY_GATE_ORDER);
    expect(inlay.qcReport.kernelVersion).toBe(KERNEL_VERSION);
  });

  it('EVERY QC gate passes and the report is passed=true', () => {
    for (const g of inlay.qcReport.gates) expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
    expect(inlay.qcReport.passed).toBe(true);
    expect(inlay.measured.shellWatertight).toBe(true);
  });

  it('margin fit ≤ 10 µm on the cavity outline (MEASURED in the assembled chain)', () => {
    expect(inlay.measured.marginFitMm).toBeLessThanOrEqual(0.010);
  });

  it('seam dihedral < 5° (G1 continuity, survived proximal adaptation)', () => {
    expect(inlay.measured.seamDihedralDeg).toBeLessThan(5);
    // The seam G1 survived the proximal contact adaptation (before ≈ after).
    expect(inlay.measured.seamDihedralAfterDeg).toBeLessThan(5);
  });

  it('seating is CLEAN — 0 mm³ empty intersection ≤ interference tolerance (the PLAN §3 element, met by the INLAY)', () => {
    expect(inlay.measured.seatingValueMm3).toBeLessThanOrEqual(inlay.measured.seatingThresholdMm3);
    expect(inlay.measured.seatingValueMm3).toBeLessThan(1e-6);
    expect(inlay.measured.seatingPassed).toBe(true);
    expect(inlay.measured.seatingAcknowledged).toBe(false); // NOT acknowledged — genuinely clean
  });

  it('min wall ≥ the INLAY minimum (1.0 mm); contact converged (no clamp)', () => {
    expect(inlay.measured.minWallThicknessMm).toBeGreaterThanOrEqual(inlay.measured.minWallThresholdMm);
    expect(inlay.measured.minWallThresholdMm).toBe(1.0);
    expect(inlay.measured.contactClampWarning).toBe(false);
    expect(inlay.qcReport.gates.find((g) => g.gate === 'contact')!.passed).toBe(true);
  });
});

describe('cavity acceptance — deliberately-SHALLOW inlay BLOCKS on thickness (gate NOT weakened)', () => {
  it('the min-wall gate FAILS with the inlay minimum and the report is blocked', async () => {
    resetCavityCaches();
    const shallow = await assembleCavity('inlay-shallow');
    const thick = shallow.qcReport.gates.find((g) => g.gate === 'minWallThickness')!;
    console.log(`[CAVITY ACCEPT inlay-shallow] minWallThickness passed=${thick.passed} value=${µm(thick.value as number)} (min ${thick.threshold} mm) | report.passed=${shallow.qcReport.passed}`);
    expect(thick.threshold).toBe(1.0);
    expect(thick.passed).toBe(false);
    expect(shallow.measured.minWallThicknessMm).toBeLessThan(1.0);
    expect(shallow.qcReport.passed).toBe(false);
  }, 300_000);
});

// ===========================================================================
// 2. ONLAY ACCEPTANCE — the full assembled chain (seating ACKNOWLEDGED, not clean)
// ===========================================================================
describe('cavity acceptance — ONLAY (full assembled chain: all gates pass OR acknowledged)', () => {
  let onlay: AssembledCavity;
  let elapsedMs: number;

  beforeAll(async () => {
    resetCavityCaches();
    const t0 = performance.now();
    onlay = await assembleCavity('onlay');
    elapsedMs = performance.now() - t0;
    for (const g of onlay.qcReport.gates) {
      console.log(`[CAVITY ACCEPT onlay] ${g.gate}: passed=${g.passed} acknowledged=${g.acknowledged ?? false} value=${g.value} threshold=${g.threshold} | ${g.message}`);
    }
    console.log(
      `[CAVITY ACCEPT onlay] margin-fit=${µm(onlay.measured.marginFitMm)} | seam=${onlay.measured.seamDihedralDeg.toFixed(4)}° | ` +
        `seating(ACK)=${onlay.measured.seatingValueMm3.toExponential(3)} mm³ | coverage=${µm(onlay.measured.cuspCoverageThicknessMm ?? 0)} (≥${onlay.measured.cuspCoverageThresholdMm}) | ` +
        `body-min-wall=${onlay.measured.minWallThicknessMm.toFixed(4)} mm | extended-outline==fixture=${onlay.measured.extendedOutlineMatchesFixture} | ` +
        `shell tris=${onlay.measured.shellTriCount} | full-chain runtime=${(elapsedMs / 1000).toFixed(2)} s`,
    );
  }, 300_000);

  it('the cuspCoverage.select op ran and its EXTENDED outline == the fixture onlay outline (the coupled T7 crux)', () => {
    expect(onlay.cuspCoverage).not.toBeNull();
    expect(onlay.cuspCoverage!.operationName).toBe('cuspCoverage.select');
    expect(onlay.measured.extendedOutlineMatchesFixture).toBe(true);
  });

  it('runs the onlay gate set (region-scoped cuspCoverage included, in order)', () => {
    expect(onlay.qcReport.gates.map((g) => g.gate)).toEqual(ONLAY_GATE_ORDER);
    expect(onlay.qcReport.kernelVersion).toBe(KERNEL_VERSION);
  });

  it('every gate passes with onlay minimums EXCEPT seating, which is ACKNOWLEDGED (passed=false + acknowledged=true)', () => {
    for (const g of onlay.qcReport.gates) {
      if (g.gate === 'seating') {
        // NOT weakened: the gate still MEASURES + FAILS; report.passed rests on the acknowledgment.
        expect(g.passed, 'seating measured pass/fail is unweakened').toBe(false);
        expect(g.acknowledged, 'seating is acknowledged with a journaled warning').toBe(true);
      } else {
        expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
      }
    }
    // report.passed is true iff every gate passed OR is acknowledged (invariant 4).
    expect(onlay.qcReport.passed).toBe(true);
    expect(onlay.measured.seatingPassed).toBe(false);
    expect(onlay.measured.seatingAcknowledged).toBe(true);
  });

  it('body min-wall ≥ onlay minimum (1.0 mm); covered cusp ≥ cusp-coverage minimum (1.5 mm)', () => {
    expect(onlay.measured.minWallThresholdMm).toBe(1.0);
    expect(onlay.measured.minWallThicknessMm).toBeGreaterThanOrEqual(1.0);
    expect(onlay.measured.cuspCoverageThresholdMm).toBe(1.5);
    expect(onlay.measured.cuspCoverageThicknessMm as number).toBeGreaterThanOrEqual(1.5);
    expect(onlay.measured.cuspCoveragePassed).toBe(true);
  });

  it('margin fit ≤ 10 µm on the extended outline; seam < 5° on the extended seam', () => {
    expect(onlay.measured.marginFitMm).toBeLessThanOrEqual(0.010);
    expect(onlay.measured.seamDihedralDeg).toBeLessThan(5);
    expect(onlay.measured.seamDihedralAfterDeg).toBeLessThan(5);
  });

  it('the ACKNOWLEDGED seating interference is BOUNDED and LOCALIZED at the known junction artifact', async () => {
    const a = await analyzeSeatingInterference(onlay.shellMesh, onlay.toothMesh);
    console.log(
      `[CAVITY ACCEPT onlay ACK SCOPE] interference=${a.volumeMm3.toExponential(3)} mm³ (ceiling ${ACK_MAX_INTERFERENCE_MM3}) verts=${a.vertexCount} ` +
        `inBand=${(a.inBandFraction * 100).toFixed(1)}% centroid=[${a.centroid.map((v) => v.toFixed(2)).join(',')}]`,
    );
    // (a) BOUNDED — comfortably below the ceiling (~50x below a gross over-seat)...
    expect(a.volumeMm3).toBeLessThan(ACK_MAX_INTERFERENCE_MM3);
    // ...and present (if the artifact ever disappears, RETIRE the acknowledgment).
    expect(a.volumeMm3).toBeGreaterThan(0);
    // (b) LOCALIZED — ≥90% of intersection verts in the junction band; centroid inside it.
    expect(a.inBandFraction).toBeGreaterThanOrEqual(JUNCTION_BAND_MIN_FRACTION);
    expect(a.centroid[1]).toBeGreaterThanOrEqual(JUNCTION_BAND.yMin);
    expect(a.centroid[1]).toBeLessThanOrEqual(JUNCTION_BAND.yMax);
    expect(a.centroid[2]).toBeGreaterThanOrEqual(JUNCTION_BAND.zMin);
    expect(a.centroid[2]).toBeLessThanOrEqual(JUNCTION_BAND.zMax);
  }, 300_000);
});

describe('cavity acceptance — thin-coverage ONLAY BLOCKS on the region-scoped gate (falsifiable, gate NOT weakened)', () => {
  it('a barely-reduced cusp fails cuspCoverage while the body still passes', async () => {
    resetCavityCaches();
    const thin = await assembleCavity('onlay-thin');
    const cov = thin.qcReport.gates.find((g) => g.gate === 'cuspCoverageThickness')!;
    const body = thin.qcReport.gates.find((g) => g.gate === 'minWallThickness')!;
    console.log(`[CAVITY ACCEPT onlay-thin] coverage=${µm(cov.value as number)} (min ${(cov.threshold as number) * 1000}µm passed=${cov.passed}); body=${µm(body.value as number)} passed=${body.passed} | report.passed=${thin.qcReport.passed}`);
    expect(cov.threshold).toBe(1.5);
    expect(cov.passed).toBe(false);
    expect(cov.value as number).toBeLessThan(1.5);
    expect(body.passed).toBe(true); // the block is coverage-specific
    expect(thin.qcReport.passed).toBe(false);
  }, 300_000);
});

// ===========================================================================
// 3. JOURNAL REPRODUCIBILITY — record → replay → bit-identical (the phase-gate crux)
// ===========================================================================
for (const restorationType of ['inlay', 'onlay'] as const) {
  describe(`cavity journal reproducibility — ${restorationType}: record → replay → bit-identical stage hashes`, () => {
    let recorded: RecordedCavityJournal;

    beforeAll(async () => {
      resetCavityCaches();
      recorded = await recordCavityJournal(restorationType);
      for (const op of recorded.operations) console.log(`[CAVITY JOURNAL ${restorationType}] ${op.id} ${op.name} → ${op.outputHashes[0]}`);
    }, 300_000);

    it('records one content-addressed Operation per stage', () => {
      const expectedNames =
        restorationType === 'onlay'
          ? ['cuspCoverage.select', 'cavityInnerSurface.build', 'cavityOcclusalPatch.build', 'cavityProximalContact.adapt', 'cavityShell.construct', 'qc.run']
          : ['cavityInnerSurface.build', 'cavityOcclusalPatch.build', 'cavityProximalContact.adapt', 'cavityShell.construct', 'qc.run'];
      expect(recorded.operations.map((op) => op.name)).toEqual(expectedNames);
      for (const op of recorded.operations) {
        expect(op.outputHashes).toHaveLength(1);
        expect(op.outputHashes[0]).toMatch(/^[0-9a-f]{64}$/);
        expect(op.kernelVersion).toBe(KERNEL_VERSION);
      }
    });

    it('replaying the journal FRESH reproduces EVERY stage hash bit-identically', async () => {
      resetCavityCaches();
      const failures = await replayCavityJournal(recorded);
      if (failures.length > 0) {
        const report = failures.map((f) => `  - ${f.stage}: expected ${f.expectedHash}, got ${f.actualHash}`).join('\n');
        throw new Error(`cavity ${restorationType} journal replay: ${failures.length} stage(s) failed to reproduce (a determinism leak — find + fix, do not loosen):\n${report}`);
      }
      expect(failures).toHaveLength(0);
    }, 300_000);

    it('the recorded stage hashes match the byte-pinned golden (KERNEL_VERSION + manifold-3d guarded)', () => {
      expect(KERNEL_VERSION, 'KERNEL_VERSION bumped → revisit the byte-pinned cavity-acceptance stage hashes').toBe(EXPECTED_KERNEL_VERSION);
      expect(installedManifoldVersion(), 'manifold-3d bumped → the WASM-dependent shell/qc stage hashes may change (deliberate golden update + changelog)').toBe(EXPECTED_MANIFOLD_VERSION);
      for (const op of recorded.operations) {
        expect(op.outputHashes[0], `stage ${op.id} drifted from its byte-pinned golden`).toBe(PINNED_STAGE_HASHES[op.id]);
      }
    });

    it('the assembled chain is itself deterministic (two records → identical hashes)', async () => {
      resetCavityCaches();
      const again = await recordCavityJournal(restorationType);
      expect(again.operations.map((op) => op.outputHashes[0])).toEqual(recorded.operations.map((op) => op.outputHashes[0]));
    }, 300_000);
  });
}

// Referenced so the stageId helper stays exercised by this suite (the ids above
// mirror it exactly; a drift would surface here).
it('stage ids follow the cavity-<type>-<stage> convention', () => {
  expect(stageId('inlay', 'shell')).toBe('cavity-inlay-shell');
  expect(stageId('onlay', 'cuspCoverage')).toBe('cavity-onlay-cuspCoverage');
});
