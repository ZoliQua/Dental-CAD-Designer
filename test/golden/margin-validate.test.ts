// test/golden/margin-validate.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`) —
// Phase 3 Task 6's REAL-MESH companion to packages/kernel/src/margin/
// validate.test.ts (which covers the same acceptance/unit cases against the
// fast, non-LFS `shoulderPrepMesh` fixture). This file needs the real
// arch-case-01 upperjaw STL (Git LFS), so it lives in the `golden` project
// per this repo's established real-fixture convention — NOT because
// anything here pins a golden HASH.
//
// ## Why NO golden hash entry (deliberate, per this task's brief)
//
// Every other file in test-fixtures/golden/ pins a specific numeric/byte
// result so an unnoticed kernel regression is caught by a hash mismatch.
// `validateMarginLine`'s OWN correctness is already fully covered by
// validate.test.ts's analytic assertions (self-intersecting: true/false,
// onSurface, degenerate, smoothness — all exact boolean/structural
// expectations, not fuzzy numeric tolerances) — pinning a report's exact
// hash here would only encode "whatever proposeMarginLoop happened to
// output for this seed on this exact mesh", which is ALREADY pinned
// separately by kernel-ops.json's own `proposeMargin` entry (Phase 3
// Task 4) and would need its own bump+changelog discipline for a change
// that has NOTHING to do with validation logic (e.g. a future margin-ridge
// tuning change would force an unrelated "golden bump" here too). This file
// instead asserts STRUCTURAL invariants (zero findings on the known-clean
// proposal; findings present/absent in the seeded-bad cases) — the same
// kind of assertion validate.test.ts already makes, just against the real
// mesh instead of the analytic one.
import { describe, expect, it } from 'vitest';
import {
  buildHalfedge,
  buildBvh,
  computeCurvature,
  snapToSurface,
  proposeMarginLoop,
  toMarginLine,
  validateMarginLine,
  classifyMarginValidation,
  MARGIN_SELF_INTERSECTION_TOLERANCE_MM,
  MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV,
  type IndexedMesh,
  type MarginLineLike,
  type MarginAnchorLike,
} from '@dqcad/kernel';
import { loadUpperjawMesh } from './upperjaw-mesh.ts';

/** SAME fixed seed as scripts/kernel-ops-lib.ts's pinned `proposeMargin`
 * golden entry ("real anterior shoulder-prep margin ridge vertex") — reusing
 * it here (rather than an independent seed) is deliberate: this is
 * literally "the golden tooth-11 proposal" this task's brief refers to
 * ("CRITICAL: the auto-proposed real margin must validate CLEAN"), so this
 * test validates the EXACT SAME anchor set kernel-ops.json already pins
 * (261 anchors — see that file's `proposeMargin.meta.anchorCount`), not a
 * fresh, unrelated one. */
const MARGIN_SEED_AMBIENT: readonly [number, number, number] = [6.675659656524658, -17.737689971923828, 10.945829391479492];

function buildRealMargin(): { mesh: IndexedMesh; bvh: ReturnType<typeof buildBvh>; margin: MarginLineLike } {
  const mesh = loadUpperjawMesh();
  const hm = buildHalfedge(mesh);
  const curvature = computeCurvature(mesh, hm);
  const bvh = buildBvh(mesh);
  const seed = snapToSurface(mesh, bvh, MARGIN_SEED_AMBIENT);
  const result = proposeMarginLoop(mesh, hm, curvature, seed);
  const margin = toMarginLine(mesh, result.anchors, result.closed);
  return { mesh, bvh, margin };
}

describe('validateMarginLine — real fixture (arch-case-01 upperjaw)', () => {
  it('CRITICAL: the golden auto-proposed margin (the SAME 261-anchor proposal kernel-ops.json pins) validates CLEAN — zero findings', () => {
    const { mesh, bvh, margin } = buildRealMargin();
    expect(margin.anchors.length).toBe(261); // sanity-pin against kernel-ops.json's own recorded anchorCount

    const t0 = performance.now();
    const report = validateMarginLine(mesh, bvh, margin);
    const elapsedMs = performance.now() - t0;
    console.log(`validateMarginLine on the real 261-anchor arch-case-01 margin: ${elapsedMs.toFixed(3)}ms`);

    expect(report.closed).toBe(true);
    expect(report.selfIntersecting).toBe(false);
    expect(report.selfIntersections).toEqual([]);
    expect(report.onSurface).toBe(true);
    expect(report.offSurfacePoints).toEqual([]);
    expect(report.smoothnessWarnings).toEqual([]);
    expect(report.degenerate).toBe(false);
    expect(classifyMarginValidation(report)).toEqual({ hardFailureKinds: [], hasWarnings: false, blocked: false });

    // Perf target (this task's brief): validator should be fast enough for
    // a LIVE editor badge (<50ms target). Asserted here with generous CI
    // noisy-neighbor headroom (10x) — the measured number above is what
    // this task's report cites; see apps/client/src/engine/marginEditor.ts
    // for the fire-and-forget (non-blocking) UI wiring this measurement
    // justifies WITHOUT an additional debounce.
    expect(elapsedMs).toBeLessThan(500);

    // T6 review item 4 — smoothness HEADROOM (against silent erosion of the
    // margin, not just its pass/fail outcome): `validateMarginLine`'s
    // report only ever surfaces points that already CLEAR
    // `MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV` (80mm^-1) as
    // `smoothnessWarnings` — `zero findings` above proves this golden
    // proposal's OWN measured max curvature is somewhere under 80, but not
    // HOW FAR under. Passing `smoothnessCurvatureThresholdMmInv: 0`
    // (`ValidateMarginLineOptions`) makes every validated point report its
    // own curvature as a "warning" (the SAME computation,
    // `computeSmoothnessWarnings`, just with the outlier cutoff floored to
    // zero) — a legitimate, already-parameterized way to recover the raw
    // max without any production code change. this task's report measured
    // this golden proposal's own max at 44.8mm^-1 (MARGIN_SMOOTHNESS_
    // CURVATURE_THRESHOLD_MM_INV's own derivation comment) — asserting
    // `< threshold x 0.7` (56mm^-1) pins ~1.8x documented slack UNDER the
    // measured value AND ~1.25x under the production threshold itself, so
    // a future ridge-walk regression that quietly erodes smoothness (but
    // not enough to trip the 80 threshold outright) fails HERE first,
    // loudly, instead of silently eating the threshold's own safety
    // margin.
    const allCurvaturesReport = validateMarginLine(mesh, bvh, margin, { smoothnessCurvatureThresholdMmInv: 0 });
    const maxCurvatureMmInv = Math.max(...allCurvaturesReport.smoothnessWarnings.map((w) => w.curvatureMmInv));
    console.log(`validateMarginLine real-margin max discrete curvature: ${maxCurvatureMmInv.toFixed(3)}mm^-1 (threshold ${MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV}mm^-1)`);
    expect(maxCurvatureMmInv).toBeLessThan(MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV * 0.7);
  });

  it('ACCEPTANCE: a figure-eight reordering of a subset of the SAME real, on-surface anchors is rejected — selfIntersecting: true, with locations', () => {
    const { mesh, bvh, margin } = buildRealMargin();
    // Take 12 evenly-spaced anchors from the real, clean 261-anchor
    // proposal (still genuine on-surface points — only the ORDER is
    // corrupted, per this task's brief: "figure-eight anchor sets ... on
    // arch-case-01 (real mesh)"), reordered by visiting alternating
    // "opposite" ring positions — same construction as
    // packages/kernel/src/margin/validate.test.ts's
    // `figureEightRingMargin`.
    const count = 12;
    const step = Math.floor(margin.anchors.length / count);
    const picked: MarginAnchorLike[] = Array.from({ length: count }, (_, i) => margin.anchors[i * step]!);
    const half = count / 2;
    const order: number[] = [];
    for (let i = 0; i < half; i++) {
      order.push(i);
      order.push(i + half);
    }
    const figureEight: MarginLineLike = { anchors: order.map((i) => picked[i]!), closed: true };

    const report = validateMarginLine(mesh, bvh, figureEight);
    expect(report.selfIntersecting).toBe(true);
    expect(report.selfIntersections.length).toBeGreaterThan(0);
    for (const hit of report.selfIntersections) {
      expect(hit.distanceMm).toBeLessThanOrEqual(MARGIN_SELF_INTERSECTION_TOLERANCE_MM);
    }
    const classification = classifyMarginValidation(report);
    expect(classification.blocked).toBe(true);
    expect(classification.hardFailureKinds).toContain('selfIntersecting');
  });
});
