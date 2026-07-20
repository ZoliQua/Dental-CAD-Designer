// packages/kernel/src/margin/validate.test.ts
//
// Phase 3 Task 6 acceptance + unit suite for `validateMarginLine` /
// `classifyMarginValidation` — see validate.ts's module doc for the method.
// Uses `shoulderPrepMesh` (marginRidge.test-fixtures.ts) as the FAST,
// non-LFS "prep die" fixture (this task's brief's "the standin prep die" —
// see marginRidge.test-fixtures.ts's own module doc for why THIS fixture,
// not the checked-in `standin-prep-die.stl`, is this repo's margin-scale
// analytic prep-die stand-in). The real arch-case-01 companion of this
// task's ACCEPTANCE assertion (self-intersection rejection on the real
// mesh, clean-golden-proposal validation, runtime measurement) lives in
// test/golden/margin-validate.test.ts (needs the LFS real-scan fixture).
import { describe, expect, it } from 'vitest';
import {
  buildBvh,
  buildHalfedge,
  computeCurvature,
  evaluateSurfacePoint,
  proposeMarginLoop,
  snapToSurface,
  surfacePointAtVertex,
  toMarginLine,
  type IndexedMesh,
} from '@dqcad/kernel';
import type { MarginLineLike, MarginAnchorLike } from '../spline/marginLine.ts';
import {
  validateMarginLine,
  classifyMarginValidation,
  MARGIN_SELF_INTERSECTION_TOLERANCE_MM,
  MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV,
} from './validate.ts';
import { shoulderPrepMesh } from './marginRidge.test-fixtures.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Builds a `MarginAnchorLike` at the P2 (margin) ring's angular index `s`
 * (`shoulderPrepMesh`'s exact, known-on-surface ring — see that fixture's
 * module doc, "Exact ring, not an approximation"). `ringVertexIndex` is the
 * ring's OWN base vertex index in the fixture's flat position layout
 * (`profile ring index * segments`) — the fixture is built with
 * `cornerRefinementMm: 0`, so `profile = [p0, p1, p2, p3]` and P2 is ring
 * index 2 (see `shoulderPrepMesh`'s module doc for the profile layout). */
function ringAnchor(mesh: IndexedMesh, hm: ReturnType<typeof buildHalfedge>, segments: number, s: number): MarginAnchorLike {
  const vertexIndex = 2 * segments + (((s % segments) + segments) % segments);
  const sp = surfacePointAtVertex(mesh, hm, vertexIndex);
  return { position: evaluateSurfacePoint(mesh, sp), triangleIndex: sp.triangleIndex, barycentric: sp.barycentric };
}

function buildFixture(segments = 128) {
  const { mesh, marginRadiusMm, marginHeightMm } = shoulderPrepMesh({ cornerRefinementMm: 0, segments });
  const hm = buildHalfedge(mesh);
  const bvh = buildBvh(mesh);
  return { mesh, hm, bvh, marginRadiusMm, marginHeightMm, segments };
}

/** A clean, non-self-intersecting closed loop of `count` evenly-spaced P2-
 * ring anchors, in natural angular order. */
function cleanRingMargin(mesh: IndexedMesh, hm: ReturnType<typeof buildHalfedge>, segments: number, count: number): MarginLineLike {
  const step = Math.floor(segments / count);
  const anchors = Array.from({ length: count }, (_, i) => ringAnchor(mesh, hm, segments, i * step));
  return { anchors, closed: true };
}

/** A deliberately self-intersecting "figure-eight" loop: the SAME `count`
 * evenly-spaced ring anchors as `cleanRingMargin`, reordered by visiting
 * alternating "opposite" ring positions (0, count/2, 1, count/2+1, 2, ...) —
 * a closed polyline that crosses itself repeatedly near the ring's center,
 * built entirely from real on-surface vertices (only the ORDER is
 * corrupted, per this task's brief: "figure-eight anchor sets"). `count`
 * must be even and >= 4. */
function figureEightRingMargin(mesh: IndexedMesh, hm: ReturnType<typeof buildHalfedge>, segments: number, count: number): MarginLineLike {
  if (count % 2 !== 0 || count < 4) {
    throw new RangeError('figureEightRingMargin: count must be even and >= 4');
  }
  const step = Math.floor(segments / count);
  const half = count / 2;
  const order: number[] = [];
  for (let i = 0; i < half; i++) {
    order.push(i);
    order.push(i + half);
  }
  const anchors = order.map((ringSlot) => ringAnchor(mesh, hm, segments, ringSlot * step));
  return { anchors, closed: true };
}

// ---------------------------------------------------------------------------
// ACCEPTANCE: seeded self-intersection rejection (standin prep die)
// ---------------------------------------------------------------------------

describe('validateMarginLine — ACCEPTANCE: seeded self-intersection rejection (standin prep die)', () => {
  it('a figure-eight anchor ordering on shoulderPrepMesh is reported selfIntersecting: true, with locations', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const margin = figureEightRingMargin(mesh, hm, segments, 8);
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.selfIntersecting).toBe(true);
    expect(report.selfIntersections.length).toBeGreaterThan(0);
    for (const hit of report.selfIntersections) {
      expect(hit.distanceMm).toBeLessThanOrEqual(MARGIN_SELF_INTERSECTION_TOLERANCE_MM);
      expect(Number.isFinite(hit.pointMm[0])).toBe(true);
    }
    const classification = classifyMarginValidation(report);
    expect(classification.blocked).toBe(true);
    expect(classification.hardFailureKinds).toContain('selfIntersecting');
  });

  it('the SAME anchors in natural (non-crossing) order report selfIntersecting: false — isolates the effect to ORDER, not the points themselves', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const margin = cleanRingMargin(mesh, hm, segments, 8);
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.selfIntersecting).toBe(false);
    expect(report.selfIntersections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Clean margins pass with zero findings
// ---------------------------------------------------------------------------

describe('validateMarginLine — clean margins pass with zero findings', () => {
  it('a hand-built clean closed ring margin has no findings at all', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const margin = cleanRingMargin(mesh, hm, segments, 16);
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.closed).toBe(true);
    expect(report.selfIntersecting).toBe(false);
    expect(report.onSurface).toBe(true);
    expect(report.maxSurfaceDeviationMm).toBeLessThan(1e-9);
    expect(report.smoothnessWarnings).toEqual([]);
    expect(report.degenerate).toBe(false);
    expect(classifyMarginValidation(report)).toEqual({ hardFailureKinds: [], hasWarnings: false, blocked: false });
  });

  it('the REAL proposeMarginLoop production output on shoulderPrepMesh also validates clean', () => {
    // Deliberately NOT `buildFixture()` here: this repo's own
    // `shoulderPrepMesh` doc records that `cornerRefinementMm: 0` (this
    // file's other tests' choice, for simple ring-index math) reads the
    // margin corner's k2 at only ~-0.28 mm^-1 — under the ridge-walk's
    // MARGIN_MIN_RIDGE_STRENGTH floor (-3), so `proposeMarginLoop` finds no
    // ridge at all. The DEFAULT `cornerRefinementMm` (0.05) is what brings a
    // real proposal's curvature up to a walkable magnitude — see that
    // fixture option's own doc.
    const { mesh, marginRadiusMm, marginHeightMm } = shoulderPrepMesh();
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const curvature = computeCurvature(mesh, hm);
    // Seed on the taper wall just above the margin — same construction as
    // marginRidge.analytic.test.ts's `taperSeed` (topRadiusMm=2,
    // totalHeightMm=8, heightAboveMarginMm=0.3): a point ON the taper wall,
    // close enough to the margin ridge to be within the walk's default
    // search radius.
    const topRadiusMm = 2;
    const totalHeightMm = 8;
    const heightAboveMarginMm = 0.3;
    const seedZ = marginHeightMm + heightAboveMarginMm;
    const seedR = marginRadiusMm + ((topRadiusMm - marginRadiusMm) * (seedZ - marginHeightMm)) / (totalHeightMm - marginHeightMm);
    const seed = snapToSurface(mesh, bvh, [seedR, 0, seedZ]);
    const result = proposeMarginLoop(mesh, hm, curvature, seed);
    const margin = toMarginLine(mesh, result.anchors, result.closed);
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.closed).toBe(true);
    expect(report.selfIntersecting).toBe(false);
    expect(report.onSurface).toBe(true);
    expect(report.smoothnessWarnings).toEqual([]);
    expect(report.degenerate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Open-margin detection
// ---------------------------------------------------------------------------

describe('validateMarginLine — open margin', () => {
  it('closed: false is reported and blocks confirm via classifyMarginValidation', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const margin: MarginLineLike = { ...cleanRingMargin(mesh, hm, segments, 16), closed: false };
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.closed).toBe(false);
    const classification = classifyMarginValidation(report);
    expect(classification.blocked).toBe(true);
    expect(classification.hardFailureKinds).toContain('open');
  });
});

// ---------------------------------------------------------------------------
// Off-surface (tampered point) detection
// ---------------------------------------------------------------------------

describe('validateMarginLine — off-surface detection', () => {
  it('a single anchor with a displaced `position` (triangleIndex/barycentric left untouched) is flagged off-surface', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const clean = cleanRingMargin(mesh, hm, segments, 12);
    const tamperedIndex = 3;
    // Displaced ALONG Z (not radially/tangentially in the X/Y plane): the
    // fixture's shelf (P1->P2) is a full FLAT ANNULUS at z=marginHeightMm
    // spanning every radius between marginRadiusMm and gingivalRadiusMm — a
    // purely horizontal displacement of a margin-ring point (r=marginRadiusMm)
    // by less than (gingivalRadiusMm - marginRadiusMm) can land back on that
    // SAME annulus (still on-surface, just at a different angle/radius) and
    // would not actually exercise this check. Z is never a constant-height
    // surface anywhere near the margin ring, so a Z displacement reliably
    // leaves the surface.
    const tampered: MarginAnchorLike = {
      ...clean.anchors[tamperedIndex]!,
      position: [clean.anchors[tamperedIndex]!.position[0], clean.anchors[tamperedIndex]!.position[1], clean.anchors[tamperedIndex]!.position[2] + 1.0],
    };
    const anchors = clean.anchors.map((a, i) => (i === tamperedIndex ? tampered : a));
    const margin: MarginLineLike = { anchors, closed: true };
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.onSurface).toBe(false);
    expect(report.offSurfacePoints.length).toBeGreaterThan(0);
    expect(report.offSurfacePoints.some((p) => p.index === tamperedIndex)).toBe(true);
    expect(report.maxSurfaceDeviationMm).toBeGreaterThan(0.05);
    const classification = classifyMarginValidation(report);
    expect(classification.blocked).toBe(true);
    expect(classification.hardFailureKinds).toContain('offSurface');
  });

  it('an UNTAMPERED clean margin has zero off-surface points (control case)', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const margin = cleanRingMargin(mesh, hm, segments, 12);
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.onSurface).toBe(true);
    expect(report.offSurfacePoints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Smoothness warnings
// ---------------------------------------------------------------------------

describe('validateMarginLine — smoothness warnings', () => {
  it('a deliberate zigzag (alternating near/far ring radii at fine angular spacing) triggers smoothness warnings', () => {
    const { mesh, marginRadiusMm, marginHeightMm } = buildFixture();
    const bvh = buildBvh(mesh);
    // Hand-built ambient zigzag: NOT ring-snapped (validateMarginLine reads
    // ambient positions directly — see its module doc) — alternates a small
    // radial offset every point at fine angular spacing, producing sharp
    // near-180-degree turns every other vertex. Points stay within the
    // fixture's own on-surface tolerance in the tangential sense but this
    // test only cares about SMOOTHNESS, not on-surface — snapped anchors are
    // not required here (this construction directly probes discrete-
    // curvature outlier detection on ambient positions, matching the
    // module's own point-selection convention: resampledPoints WOULD be
    // used if present, but raw `position`s are read all the same when they
    // aren't — see validate.ts's module doc).
    // count/amplitude MEASURED (this task's report / scratchpad probe): a
    // plain circle at ANY density here reads maxCurv ~= 1/marginRadiusMm =
    // 0.286 mm^-1 (curvature is density-independent for a smooth curve, as
    // expected) regardless of point count. `MARGIN_SMOOTHNESS_CURVATURE_
    // THRESHOLD_MM_INV` (80mm^-1) is calibrated against the REAL arch-
    // case-01 golden proposal's own measured noise ceiling (44.8mm^-1 at
    // ITS 0.02-0.4mm anchor spacing — see that constant's doc) — reaching
    // comfortably past 80 here therefore needs FINER spacing than that real
    // proposal's own: curvature = angle/spacing diverges as spacing shrinks
    // for a fixed alternating angle, so a fine, deliberately bad zigzag
    // (2000-point angular spacing, alternating +-0.02mm radial amplitude)
    // reads maxCurv ~= 93.6 mm^-1 here — comfortably above threshold.
    const count = 2000;
    const amplitudeMm = 0.02;
    const positions: [number, number, number][] = [];
    for (let i = 0; i < count; i++) {
      const theta = (2 * Math.PI * i) / count;
      const r = marginRadiusMm + (i % 2 === 0 ? 0 : amplitudeMm); // sharp in/out zigzag
      positions.push([r * Math.cos(theta), r * Math.sin(theta), marginHeightMm]);
    }
    const anchors: MarginAnchorLike[] = positions.map((position) => ({ position, triangleIndex: 0, barycentric: [1, 0, 0] }));
    const margin: MarginLineLike = { anchors, closed: true, resampledPoints: positions };
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.smoothnessWarnings.length).toBeGreaterThan(0);
    for (const w of report.smoothnessWarnings) {
      expect(w.curvatureMmInv).toBeGreaterThan(MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV);
    }
    expect(classifyMarginValidation(report).hasWarnings).toBe(true);
    // Smoothness is a WARNING, never a hard failure on its own.
    expect(classifyMarginValidation(report).hardFailureKinds).not.toContain('smoothness' as never);
  });

  it('a smooth ring (no zigzag) has zero smoothness warnings (control case)', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const margin = cleanRingMargin(mesh, hm, segments, 40);
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.smoothnessWarnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Degenerate
// ---------------------------------------------------------------------------

describe('validateMarginLine — degenerate', () => {
  it('too few anchors (< 3) is reported degenerate: tooFewAnchors', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const margin: MarginLineLike = { anchors: [ringAnchor(mesh, hm, segments, 0), ringAnchor(mesh, hm, segments, 10)], closed: true };
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.degenerate).toBe(true);
    expect(report.degenerateReasons).toContain('tooFewAnchors');
    expect(classifyMarginValidation(report).hardFailureKinds).toContain('degenerate');
  });

  it('all-coincident anchors (zero length) is reported degenerate: zeroLength', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const a = ringAnchor(mesh, hm, segments, 0);
    const margin: MarginLineLike = { anchors: [a, a, a, a], closed: true };
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.degenerate).toBe(true);
    expect(report.degenerateReasons).toContain('zeroLength');
  });

  it('a normal clean margin is NOT degenerate (control case)', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const margin = cleanRingMargin(mesh, hm, segments, 16);
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.degenerate).toBe(false);
    expect(report.degenerateReasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression: concatenated-segments `resampledPoints` (real production
// shape — every anchor boundary is a DUPLICATE point, see validate.ts's
// `validatedPoints` doc) must NOT spuriously trip smoothness/self-
// intersection findings.
// ---------------------------------------------------------------------------

describe('validateMarginLine — concatenated-segments resampledPoints (duplicate boundary points)', () => {
  it('a clean margin whose resampledPoints is built the way apps/client/src/engine/marginEditor.ts#flattenResampledPoints ACTUALLY builds it (segments concatenated, sharing an exact duplicate point at every anchor boundary) has zero findings', () => {
    const { mesh, hm, bvh, segments: segCount } = buildFixture();
    const clean = cleanRingMargin(mesh, hm, segCount, 12);
    // Mirror flattenResampledPoints EXACTLY: build one "segment" per
    // consecutive anchor pair as a short, smooth, on-surface polyline
    // (using the SAME ring, densified — real geodesic segments interpolate
    // MANY intermediate on-surface points, not just the 2 endpoints), each
    // segment's point array starting and ending at the shared anchor
    // position (the real "ENDPOINTS INCLUSIVE" contract), then concatenate
    // ALL of them — this reproduces the exact duplicate-at-every-boundary
    // shape a real committed margin's resampledPoints has.
    const anchors = clean.anchors;
    const n = anchors.length;
    const resampledPoints: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = anchors[i]!;
      const b = anchors[(i + 1) % n]!;
      const subSteps = 5;
      for (let s = 0; s <= subSteps; s++) {
        const w = s / subSteps;
        resampledPoints.push([a.position[0] + (b.position[0] - a.position[0]) * w, a.position[1] + (b.position[1] - a.position[1]) * w, a.position[2] + (b.position[2] - a.position[2]) * w]);
      }
      // The NEXT segment's first point duplicates THIS segment's last point
      // (both are exactly `b.position`) — exactly like flattenResampledPoints'
      // concatenation of real LiveMarginSegment arrays.
    }
    const margin: MarginLineLike = { anchors, closed: true, resampledPoints };
    const report = validateMarginLine(mesh, bvh, margin);
    expect(report.smoothnessWarnings).toEqual([]);
    expect(report.selfIntersecting).toBe(false);
    expect(report.degenerate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('validateMarginLine — determinism', () => {
  it('two calls against the same inputs produce byte-identical reports', () => {
    const { mesh, hm, bvh, segments } = buildFixture();
    const margin = figureEightRingMargin(mesh, hm, segments, 8);
    const a = validateMarginLine(mesh, bvh, margin);
    const b = validateMarginLine(mesh, bvh, margin);
    expect(a).toEqual(b);
  });
});
