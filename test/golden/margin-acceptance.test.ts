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
//
// ## Task 8b addendum — amended-criterion pins (PLAN.md, amended 2026-07-15)
//
// The controller decided (b) above: reframe Phase 3's acceptance to the
// ridge-VISIBLE portion of the margin (`scripts/margin-acceptance.ts`'s
// module doc, "Task 8b addendum") — the original full-length criterion
// moves to a future scan-visible fixture. All the ORIGINAL assertions above
// are UNCHANGED (still measuring the same, still-honest full-length
// result); the new block below pins the AMENDED (visible-stretch) verdict
// with the same "pin the measured outcome, don't force a pass" discipline.
//
// Measured (this task): the reframing genuinely helps — visible-stretch
// mean deviation is 20-46% lower than the full-length mean for every
// closing tooth (12: 379.9->304.9um, 21: 235.0->127.0um, 22:
// 648.4->337.4um) — but does NOT cross the 100um bar for any of the 3
// closing teeth. This was VERIFIED, not assumed (this task's brief
// explicitly warned not to assume a pass): a sensitivity check confirmed
// the visible stretches are numerous (5-19 per tooth) and short (each
// <=1.2mm), matching Task 8's own "spread across many separate arcs, not
// one absorbable interproximal spot" finding — i.e. this is the SAME
// structural limitation Task 8 already diagnosed (`marginRidge.ts`'s own
// module doc: a real `k2`-qualifying region is a WIDE 2D band, not a crisp
// curve — the walker's "strongest k2 in the band" heuristic doesn't always
// land exactly where the dentist's hand-trace does, even where a ridge
// signal genuinely exists), not a new bug. No `proposeMarginLoop` parameter
// retuning was found or applied for this measurement-only task
// (KERNEL_VERSION unchanged at 0.5.0) — see this task's own report for the
// full investigation.
//
// ## Runtime lane: still default golden (Task 8b changes nothing here)
//
// Task 8b's additions are O(reference sample count) per tooth (a handful of
// extra `snapToSurface` + barycentric `k2` lookups, no new mesh-scale
// passes) — negligible next to the existing intake/halfedge/BVH/curvature/
// `proposeMarginLoop` cost this file already pays. No runtime-lane change.
import { describe, expect, it } from 'vitest';
import {
  runMarginAcceptance,
  ACCEPTANCE_THRESHOLD_MM,
  ACCEPTANCE_LENGTH_FRACTION,
  ACCEPTANCE_MIN_PASSING_TEETH,
  ARC_LENGTH_STEP_MM,
  REFERENCE_TEETH,
  EXPECTED_NON_CLOSING_TEETH,
  VISIBLE_STRETCH_MIN_RUN_SAMPLES,
  AMENDED_ACCEPTANCE_ASSERTION_TEETH,
  AMENDED_ACCEPTANCE_MIN_PASSING_TEETH,
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

  // ---------------------------------------------------------------------
  // Task 8b — amended-criterion constants (PLAN.md, amended 2026-07-15).
  // ---------------------------------------------------------------------
  it('Task 8b amended-criterion constants match this task\'s brief', () => {
    expect(VISIBLE_STRETCH_MIN_RUN_SAMPLES).toBeGreaterThanOrEqual(2); // filters single-sample noise, not real short stretches
    expect(AMENDED_ACCEPTANCE_ASSERTION_TEETH).toEqual([12, 21, 22]); // the 3 closing teeth — tooth 11 is coverage-evidence-only
    expect(AMENDED_ACCEPTANCE_MIN_PASSING_TEETH).toBe(3); // >= 3 of 3 — zero slack
    expect(report.visibleStretchMinRunSamples).toBe(VISIBLE_STRETCH_MIN_RUN_SAMPLES);
    expect(report.amendedAcceptanceAssertionTeeth).toEqual([...AMENDED_ACCEPTANCE_ASSERTION_TEETH]);
    expect(report.amendedAcceptanceMinPassingTeeth).toBe(AMENDED_ACCEPTANCE_MIN_PASSING_TEETH);
  });

  it('Task 8b: every tooth (including non-closing tooth 11) reports visible-coverage evidence', () => {
    for (const t of report.teeth) {
      expect(t.referenceSampleCount).toBeGreaterThan(100);
      expect(t.rawVisibleFraction).toBeGreaterThanOrEqual(0);
      expect(t.rawVisibleFraction).toBeLessThanOrEqual(1);
      expect(t.visibleCoverageFraction).toBeGreaterThanOrEqual(0);
      expect(t.visibleCoverageFraction).toBeLessThanOrEqual(1);
      expect(t.visibleStretches.length).toBeGreaterThan(0);
      for (const stretch of t.visibleStretches) {
        expect(stretch.sampleCount).toBeGreaterThanOrEqual(VISIBLE_STRETCH_MIN_RUN_SAMPLES);
        // >= 0, not > 0: tooth 11's own reference (measured, real data —
        // test-fixtures/margins/arch-case-01/11.reference.json) has a
        // handful of literally-duplicate consecutive `resampledPoints`
        // (near-coincident hand-placed anchors in a tight interproximal
        // stretch), which legitimately produces a zero-arc-length visible
        // run there. Not a harness artifact — verified against the raw
        // fixture JSON.
        expect(stretch.lengthMm).toBeGreaterThanOrEqual(0);
      }
    }

    // Tooth 11 (non-closing): coverage-evidence-only, no deviation fields.
    const t11 = report.teeth.find((t) => t.tooth === 11)!;
    expect(t11.closed).toBe(false);
    expect(t11.visibleStretchMeanDeviationMm).toBeUndefined();
    expect(t11.passesAmendedAcceptance).toBeUndefined();
  });

  it(
    'Task 8b: logs the full amended-criterion evidence table (CI-visible)',
    () => {
      console.log(`[margin-acceptance][Task8b] visibleStretchMinRunSamples=${report.visibleStretchMinRunSamples}`);
      for (const t of report.teeth) {
        console.log(
          `[margin-acceptance][Task8b] tooth ${t.tooth}: rawVisibleFractionPct=${(t.rawVisibleFraction * 100).toFixed(1)} ` +
            `visibleCoverageFractionPct=${(t.visibleCoverageFraction * 100).toFixed(1)} visibleStretchCount=${t.visibleStretches.length} ` +
            `visibleStretchMeanUm=${t.visibleStretchMeanDeviationMm !== undefined ? (t.visibleStretchMeanDeviationMm * 1000).toFixed(1) : 'n/a'} ` +
            `visibleStretchMaxUm=${t.visibleStretchMaxDeviationMm !== undefined ? (t.visibleStretchMaxDeviationMm * 1000).toFixed(1) : 'n/a'} ` +
            `passesAmended=${t.passesAmendedAcceptance ?? 'n/a (non-closing / coverage-only)'}`,
        );
      }
      console.log(
        `[margin-acceptance][Task8b] AMENDED VERDICT: ${report.amendedPassingTeethCount}/${report.amendedAcceptanceAssertionTeeth.length} of teeth ` +
          `[${report.amendedAcceptanceAssertionTeeth.join(',')}] pass (need >= ${report.amendedAcceptanceMinPassingTeeth}) -- amendedOverallPasses=${report.amendedOverallPasses}.`,
      );
      expect(report.teeth.length).toBe(4); // the log above always runs for all 4
    },
  );

  // ---------------------------------------------------------------------
  // AMENDED-CRITERION ACCEPTANCE — pins the CURRENT, HONESTLY MEASURED
  // outcome under PLAN.md's amended (2026-07-15) criterion. Same discipline
  // as the ORIGINAL "PHASE ACCEPTANCE" test above: this is NOT
  // `expect(amendedOverallPasses).toBe(true)`. Measured: the visible-stretch
  // reframing is a REAL, substantial improvement over the full-length
  // metric for every closing tooth (see this file's module doc, "Task 8b
  // addendum" for the exact before/after numbers and why — the same
  // structural "wide qualifying band, not a crisp curve" limitation Task 8
  // already diagnosed, verified via a stretch-fragmentation sensitivity
  // check, not assumed) — but it does not cross the 100um bar for any of
  // the 3 closing teeth on this one real, clinically-challenging fixture.
  // ---------------------------------------------------------------------
  it('AMENDED ACCEPTANCE (current honest state): 0 of 3 closing teeth pass the visible-stretch criterion — still BLOCKED, not weakened', () => {
    expect(report.amendedPassingTeethCount).toBe(0);
    expect(report.amendedOverallPasses).toBe(false);

    const byTooth = new Map(report.teeth.filter((t) => t.closed).map((t) => [t.tooth, t]));

    const t12 = byTooth.get(12)!;
    expect(t12.passesAmendedAcceptance).toBe(false);
    expect(t12.visibleStretchMeanDeviationMm!).toBeGreaterThan(0.2);
    expect(t12.visibleStretchMeanDeviationMm!).toBeLessThan(0.4);
    // The reframing must never make the metric WORSE than the full-length
    // one — restricting to visible-only samples can only remove
    // (typically worse, obscured-stretch) samples from the full-length
    // pool.
    expect(t12.visibleStretchMeanDeviationMm!).toBeLessThanOrEqual(t12.fullLengthMeanDeviationMm! + 1e-9);

    const t21 = byTooth.get(21)!;
    expect(t21.passesAmendedAcceptance).toBe(false);
    expect(t21.visibleStretchMeanDeviationMm!).toBeGreaterThan(0.08);
    expect(t21.visibleStretchMeanDeviationMm!).toBeLessThan(0.2);
    expect(t21.visibleStretchMeanDeviationMm!).toBeLessThanOrEqual(t21.fullLengthMeanDeviationMm! + 1e-9);

    const t22 = byTooth.get(22)!;
    expect(t22.passesAmendedAcceptance).toBe(false);
    expect(t22.visibleStretchMeanDeviationMm!).toBeGreaterThan(0.2);
    expect(t22.visibleStretchMeanDeviationMm!).toBeLessThan(0.5);
    expect(t22.visibleStretchMeanDeviationMm!).toBeLessThanOrEqual(t22.fullLengthMeanDeviationMm! + 1e-9);
  });
});
