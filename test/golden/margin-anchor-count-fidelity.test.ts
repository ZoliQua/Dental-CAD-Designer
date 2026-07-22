// test/golden/margin-anchor-count-fidelity.test.ts
//
// Vitest project `golden` — Phase 3 editor-enhancement task 1's REQUIRED
// measurement: "measure the fidelity cost of 30 vs 261 anchors on the real
// tooth-11 golden case: resampled-polyline deviation between the two
// variants REPORTED — if thinning anchors materially degrades the dense
// curve (>50µm), say so and cap the default slider suggestion accordingly".
// Uses the SAME real fixture + SAME fixed seed as test/golden/
// margin-validate.test.ts (that file's own doc: "this is literally 'the
// golden tooth-11 proposal'" — the exact seed scripts/kernel-ops-lib.ts
// pins for the `proposeMargin` golden entry, 261 anchors at kernel
// defaults).
//
// ## Method
//
// Propose the DENSE (kernel-default, 261-anchor) variant, then several
// SPARSER (`targetAnchorCount`) variants from the SAME seed. For each
// variant, build the FULL geodesic-chained resampled polyline (the same
// "every anchor is a draggable handle, every between-anchor segment is an
// EXACT geodesic re-derived fresh from the mesh" construction apps/client/
// src/engine/marginEditor.ts's own module doc describes for the LIVE
// editor — i.e. exactly what the app actually displays/persists, not
// merely the raw anchor points). "Fidelity cost" is measured as the
// point-to-polyline distance from every sample of the SPARSER resampled
// curve to the DENSE resampled curve (which stands in for "the true
// on-surface curve" — already dense enough, per marginRidge.ts's own module
// doc, "already dense enough that consecutive geodesic segments read as a
// smooth curve visually").
//
// ## RESULT (measured on this real, clinically-challenging fixture — see
// this file's own test below for the exact numbers logged every run)
//
// target=20: mean 71.05um, max 266.45um
// target=30: mean 67.56um, max 272.93um
// target=40: mean 54.63um, max 288.89um
// target=50: mean 40.89um, max 222.80um
//
// Every one of 20/30/40 EXCEEDS this task's own 50µm mean-deviation
// guardrail; only 50 crosses under it. Per the brief's own explicit
// instruction ("if thinning anchors materially degrades the dense curve
// (>50µm), say so and cap the default slider suggestion accordingly"), the
// dentist's own literal "suggest 30" comfort figure is NOT used as the
// panel's default here — `engine/marginEditor.ts`'s
// `MARGIN_PROPOSAL_ANCHOR_COUNT_DEFAULT` is 50, not 30, specifically
// because of this measurement (see that constant's own doc for the full
// cross-reference). The SLIDER RANGE itself still spans the brief's full
// 20-200 (the dentist can freely choose 30 or lower if they judge that
// tradeoff acceptable for a given case) — only the DEFAULT starting
// position changes. This is the same "honest, measured, real-case-driven
// adjustment" discipline this repo's own Task 8/8b margin-acceptance work
// already established (never silently pick a flattering number).
import { describe, expect, it } from 'vitest';
import {
  buildHalfedge,
  buildBvh,
  computeCurvature,
  snapToSurface,
  proposeMarginLoop,
  geodesicPath,
  evaluateSurfacePoint,
  type IndexedMesh,
  type SurfacePoint,
  type Vec3,
} from '@dqcad/kernel';
import { loadUpperjawMesh } from './upperjaw-mesh.ts';

// scripts/kernel-ops-lib.ts's own pinned golden seed (Phase 3 Task 4) — see
// this file's module doc.
const MARGIN_SEED_AMBIENT: Vec3 = [6.675659656524658, -17.737689971923828, 10.945829391479492];

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Builds the FULL geodesic-chained resampled polyline for a closed anchor
 * loop — mirrors apps/client/src/engine/marginEditor.ts's
 * `geodesicSegmentsForClosedLoop` construction exactly (every consecutive
 * anchor pair, wrapping, joined by an EXACT `geodesicPath` call), flattened
 * into one ordered ambient-point array (closing segment included). */
function resampledPolyline(mesh: IndexedMesh, hm: ReturnType<typeof buildHalfedge>, anchors: readonly SurfacePoint[]): Vec3[] {
  const points: Vec3[] = [];
  const n = anchors.length;
  for (let i = 0; i < n; i++) {
    const a = anchors[i]!;
    const b = anchors[(i + 1) % n]!;
    const segment = geodesicPath(mesh, hm, a, b);
    for (const sp of segment.points) points.push(evaluateSurfacePoint(mesh, sp));
  }
  return points;
}

function pointToSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const abLenSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = abLenSq === 0 ? 0 : Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / abLenSq));
  const closest: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  return dist3(p, closest);
}

/** Point-to-CLOSED-POLYLINE distance (nearest point on any of `polyline`'s
 * segments, including the closing segment) — brute force (O(polyline
 * length) per query point), acceptable at this test's scale (a few hundred
 * points against a few hundred). */
function pointToClosedPolylineDistance(p: Vec3, polyline: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i < polyline.length; i++) {
    const a = polyline[i]!;
    const b = polyline[(i + 1) % polyline.length]!;
    const d = pointToSegmentDistance(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

interface FidelityMeasurement {
  target: number;
  actualAnchorCount: number;
  meanDeviationMm: number;
  maxDeviationMm: number;
}

function measureFidelity(
  mesh: IndexedMesh,
  hm: ReturnType<typeof buildHalfedge>,
  curvature: ReturnType<typeof computeCurvature>,
  seed: SurfacePoint,
  densePolyline: readonly Vec3[],
  target: number,
): FidelityMeasurement {
  const sparse = proposeMarginLoop(mesh, hm, curvature, seed, { targetAnchorCount: target });
  if (!sparse.closed) throw new Error(`proposeMarginLoop unexpectedly failed to close at targetAnchorCount=${target}`);
  const sparsePolyline = resampledPolyline(mesh, hm, sparse.anchors);
  let maxDeviationMm = 0;
  let sumDeviationMm = 0;
  for (const p of sparsePolyline) {
    const d = pointToClosedPolylineDistance(p, densePolyline);
    maxDeviationMm = Math.max(maxDeviationMm, d);
    sumDeviationMm += d;
  }
  return {
    target,
    actualAnchorCount: sparse.anchors.length,
    meanDeviationMm: sumDeviationMm / sparsePolyline.length,
    maxDeviationMm,
  };
}

describe('margin anchor-count fidelity — real golden tooth-11 proposal (Phase 3 editor-enhancement task 1)', () => {
  it('measures resampled-polyline deviation across the slider range (20/30/40/50) vs. the dense 261-anchor curve', () => {
    const mesh = loadUpperjawMesh();
    const hm = buildHalfedge(mesh);
    const curvature = computeCurvature(mesh, hm);
    const bvh = buildBvh(mesh);
    const seed = snapToSurface(mesh, bvh, MARGIN_SEED_AMBIENT);

    const dense = proposeMarginLoop(mesh, hm, curvature, seed); // kernel default — byte-identical to the golden
    expect(dense.closed).toBe(true);
    expect(dense.anchors.length).toBe(261); // pins this test's own premise against the committed golden (kernel-ops.json)
    const densePolyline = resampledPolyline(mesh, hm, dense.anchors);

    const measurements = [20, 30, 40, 50].map((target) => measureFidelity(mesh, hm, curvature, seed, densePolyline, target));
    for (const m of measurements) {
      console.log(
        `[anchor-count fidelity] target=${m.target} actual=${m.actualAnchorCount} ` +
          `mean=${(m.meanDeviationMm * 1000).toFixed(2)}um max=${(m.maxDeviationMm * 1000).toFixed(2)}um`,
      );
      expect(m.maxDeviationMm).toBeLessThan(2); // mm — generous sanity bound, not a tight pin
      expect(m.meanDeviationMm).toBeLessThan(0.5); // mm
    }

    // PHASE-ACCEPTANCE-STYLE PIN (mirrors margin-acceptance.test.ts's own
    // "pin the measured outcome, don't force a flattering pass" discipline):
    // 20/30/40 all measurably exceed this task's own 50µm mean-deviation
    // guardrail on this real, challenging fixture; only 50 crosses under it.
    // This is WHY `MARGIN_PROPOSAL_ANCHOR_COUNT_DEFAULT` (engine/
    // marginEditor.ts) is 50, not the dentist's own literal "suggest 30" —
    // see this file's module doc.
    const byTarget = new Map(measurements.map((m) => [m.target, m]));
    expect(byTarget.get(20)!.meanDeviationMm * 1000).toBeGreaterThan(50);
    expect(byTarget.get(30)!.meanDeviationMm * 1000).toBeGreaterThan(50);
    expect(byTarget.get(40)!.meanDeviationMm * 1000).toBeGreaterThan(50);
    expect(byTarget.get(50)!.meanDeviationMm * 1000).toBeLessThan(50);
  });
});
