// test/golden/margin-acceptance.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`) —
// Phase 3 Task 8: THE phase acceptance measurement. Runs
// `scripts/margin-acceptance.ts`'s `runMarginAcceptance()` (the shared
// harness, imported — not reimplemented, same "single source of truth"
// convention `test/golden/kernel-ops.test.ts` follows for
// `computeKernelOpsSnapshot`) against the real, committed arch-case-01
// references and asserts on the result.
//
// ## Runtime lane: default golden (not env-gated)
//
// Measured wall-clock total for the full harness (intake + halfedge + BVH +
// curvature over the real ~250k-triangle upperjaw, computed once, plus 4
// `proposeMarginLoop` attempts and the full deviation-metric sweep for the
// 3 that close): ~4.4s on this task's development machine — comfortably
// under the brief's own "<10s -> default golden lane" threshold (see this
// task's report for the exact measured number). No `RUN_*` env gate; this
// test runs on every `npm test`/`npm run test:golden`, same as
// `test/golden/margin-validate.test.ts`'s existing single `proposeMarginLoop`
// call against the same real mesh.
//
// ## Why this test does NOT assert `overallPasses === true` (deliberate)
//
// CLAUDE.md: "Never weaken a gate threshold to make a test pass." The
// MEASURED result on this real case, honestly reported (see this task's
// report, `.superpowers/sdd/p3-task-8-report.md`, for the full analysis) is
// that 0 of the 3 closeable teeth meet the phase's <=100µm-mean-over-best-
// 90%-of-length criterion — NOT because of a fixable kernel/tuning defect
// (this task DID find and fix one real one — `MARGIN_MIN_RIDGE_COMPONENT_SIZE`,
// `docs/CHANGELOG-kernel.md` 0.5.0 — restoring tooth 21 to the closeable
// set), but because large fractions of the DENTIST'S OWN hand-traced
// reference lines (measured: 49-89% of each reference's own points,
// depending on tooth) sit on real-scan terrain that is not a concave
// curvature ridge at all (`k2` at/above the qualification threshold, in
// several spots measurably CONVEX) — a genuine, real-case signal
// limitation (collapsed-gingiva-obscured stretches, per the tracer's own
// disclosure) that a purely curvature-following walker cannot, by
// construction, ever trace (it can only ever walk qualifying ridge
// vertices). Asserting `overallPasses === true` here would misrepresent
// that honest, structurally-explained result. Instead, this file PINS the
// current measured pass/fail OUTCOME (`passingTeethCount`, per-tooth
// `passesAcceptance`) as an explicit, reviewable fact — exactly like a
// golden hash pins a numeric fact — so a genuine future improvement (a
// better scalar field, a smoothing/interpolation strategy across
// low-signal stretches, more/better real fixtures, ...) requires a
// deliberate, reviewed update here, not a silent pass. Full per-tooth
// numbers are asserted with generous sanity-range bounds (not tight
// hash-style pins — this is real floating-point geometry, not a
// bit-identical hash target) and logged in full for CI visibility.
import { describe, expect, it } from 'vitest';
import {
  runMarginAcceptance,
  ACCEPTANCE_THRESHOLD_MM,
  ACCEPTANCE_LENGTH_FRACTION,
  ACCEPTANCE_MIN_PASSING_TEETH,
  ARC_LENGTH_STEP_MM,
  REFERENCE_TEETH,
  EXPECTED_NON_CLOSING_TEETH,
} from '../../scripts/margin-acceptance.ts';

describe('margin acceptance — arch-case-01 (Phase 3 Task 8, phase acceptance measurement)', () => {
  const report = runMarginAcceptance();

  it('acceptance rule constants match the phase criterion (PLAN.md / phase-3-margin-axis.md, verbatim)', () => {
    expect(ACCEPTANCE_THRESHOLD_MM).toBe(0.1); // 100 um
    expect(ACCEPTANCE_LENGTH_FRACTION).toBe(0.9); // 90% of length
    expect(ACCEPTANCE_MIN_PASSING_TEETH).toBe(3); // >= 3 of 4 real preps
    expect(report.acceptanceThresholdMm).toBe(ACCEPTANCE_THRESHOLD_MM);
    expect(report.acceptanceLengthFraction).toBe(ACCEPTANCE_LENGTH_FRACTION);
    expect(report.acceptanceMinPassingTeeth).toBe(ACCEPTANCE_MIN_PASSING_TEETH);
    expect(report.arcLengthStepMm).toBe(ARC_LENGTH_STEP_MM);
  });

  it('measures all 4 committed references, against the correct real mesh', () => {
    expect(report.meshContentHash).toHaveLength(64); // hex sha256 — throws inside runMarginAcceptance on mismatch already
    expect(report.teeth.map((t) => t.tooth)).toEqual([...REFERENCE_TEETH]);
  });

  it('tooth 11 is the one documented non-closing candidate (genuine interproximal scan-coverage gap — Task 4/diagnose-margin-gap.ts) — every other tooth closes', () => {
    const nonClosing = report.teeth.filter((t) => !t.closed).map((t) => t.tooth);
    expect(nonClosing).toEqual([...EXPECTED_NON_CLOSING_TEETH]);
    expect(report.measuredTeethCount).toBe(4 - EXPECTED_NON_CLOSING_TEETH.length);

    const tooth11 = report.teeth.find((t) => t.tooth === 11)!;
    expect(tooth11.closed).toBe(false);
    expect(tooth11.nonClosureReason).toBe('NoClosureError');
    expect(tooth11.nonClosureDetail).toBeDefined();
    expect(tooth11.nonClosureDetail!.closureDeviationMm).toBeGreaterThan(0.15); // > closureToleranceMm — genuinely didn't close, not a near-miss
  });

  it('every measured tooth reports a complete, sane set of metrics', () => {
    for (const t of report.teeth) {
      if (!t.closed) continue;
      expect(t.proposalAnchorCount).toBeGreaterThan(3);
      expect(t.sampleCount).toBeGreaterThan(500); // ~25-30mm loop / 20um step
      expect(t.proposalPerimeterMm).toBeGreaterThan(15);
      expect(t.proposalPerimeterMm).toBeLessThan(35); // Task 4's own anatomical sanity band
      expect(t.referencePerimeterMm).toBeGreaterThan(15);
      expect(t.referencePerimeterMm).toBeLessThan(35); // margin-references.test.ts's own band
      expect(Number.isFinite(t.fullLengthMeanDeviationMm)).toBe(true);
      expect(Number.isFinite(t.bestNinetyPercentMeanDeviationMm)).toBe(true);
      expect(Number.isFinite(t.maxDeviationMm)).toBe(true);
      // Sanity invariant: excluding the worst ~10% of length can only ever
      // LOWER (or match) the mean — never raise it.
      expect(t.bestNinetyPercentMeanDeviationMm!).toBeLessThanOrEqual(t.fullLengthMeanDeviationMm! + 1e-9);
      expect(t.maxDeviationMm!).toBeGreaterThanOrEqual(t.fullLengthMeanDeviationMm!);
      expect(t.fractionOfLengthWithin100umMm).toBeGreaterThanOrEqual(0);
      expect(t.fractionOfLengthWithin100umMm).toBeLessThanOrEqual(1);
      expect(t.bestNinetyPercentLengthFraction).toBeGreaterThanOrEqual(ACCEPTANCE_LENGTH_FRACTION - 0.01);
    }
  });

  it('logs the full per-tooth evidence table (CI-visible; see .superpowers/sdd/p3-task-8-report.md for the narrative analysis)', () => {
    console.log(`[margin-acceptance] KERNEL_VERSION ${report.kernelVersion}, mesh ${report.meshContentHash}`);
    for (const t of report.teeth) {
      if (!t.closed) {
        console.log(`[margin-acceptance] tooth ${t.tooth}: NON-CLOSING (${t.nonClosureReason}) — excluded.`);
        continue;
      }
      console.log(
        `[margin-acceptance] tooth ${t.tooth}: anchors=${t.proposalAnchorCount} samples=${t.sampleCount} ` +
          `proposalPerimeterMm=${t.proposalPerimeterMm!.toFixed(3)} referencePerimeterMm=${t.referencePerimeterMm!.toFixed(3)} ` +
          `fullMeanUm=${(t.fullLengthMeanDeviationMm! * 1000).toFixed(1)} best90MeanUm=${(t.bestNinetyPercentMeanDeviationMm! * 1000).toFixed(1)} ` +
          `fracWithin100umPct=${(t.fractionOfLengthWithin100umMm! * 100).toFixed(1)} maxUm=${(t.maxDeviationMm! * 1000).toFixed(1)} ` +
          `passes=${t.passesAcceptance} worstClusterCount=${t.worstClusters?.length ?? 0}`,
      );
    }
    console.log(`[margin-acceptance] VERDICT: ${report.passingTeethCount}/${report.measuredTeethCount} measured teeth pass (need >= ${report.acceptanceMinPassingTeeth} of 4).`);
    expect(report.teeth.length).toBe(4); // the log above always runs for all 4
  });

  // ---------------------------------------------------------------------
  // PHASE ACCEPTANCE — pins the CURRENT, HONESTLY MEASURED outcome (see
  // this file's module doc for why this is not `expect(overallPasses).toBe(true)`).
  // Ranges (not tight pins): real Float64 geometry against a real,
  // hand-traced reference is not expected to be bit-identical across a
  // deliberate future re-trace/re-scan; these bounds are wide enough to
  // absorb ordinary re-measurement noise while still catching any
  // meaningfully different outcome (e.g. a future fix that actually closes
  // the gap, or a regression that widens it further).
  // ---------------------------------------------------------------------
  it('PHASE ACCEPTANCE (current honest state): 0 of 3 measured teeth pass — BLOCKED, not weakened (see report)', () => {
    expect(report.passingTeethCount).toBe(0);
    expect(report.overallPasses).toBe(false);

    const byTooth = new Map(report.teeth.filter((t) => t.closed).map((t) => [t.tooth, t]));

    const t12 = byTooth.get(12)!;
    expect(t12.passesAcceptance).toBe(false);
    expect(t12.bestNinetyPercentMeanDeviationMm!).toBeGreaterThan(0.2);
    expect(t12.bestNinetyPercentMeanDeviationMm!).toBeLessThan(0.5);

    const t21 = byTooth.get(21)!;
    expect(t21.passesAcceptance).toBe(false);
    expect(t21.bestNinetyPercentMeanDeviationMm!).toBeGreaterThan(0.1);
    expect(t21.bestNinetyPercentMeanDeviationMm!).toBeLessThan(0.3);

    const t22 = byTooth.get(22)!;
    expect(t22.passesAcceptance).toBe(false);
    expect(t22.bestNinetyPercentMeanDeviationMm!).toBeGreaterThan(0.4);
    expect(t22.bestNinetyPercentMeanDeviationMm!).toBeLessThan(0.8);
  });
});
