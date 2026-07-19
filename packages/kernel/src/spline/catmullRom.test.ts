// packages/kernel/src/spline/catmullRom.test.ts
//
// Phase 2 Task 5, deliverable 1 + deliverable 5's ambient-space analytic
// cases: pure spline math, no mesh/BVH (see catmullRom.ts's module doc for
// why centripetal Catmull-Rom/Barry-Goldman was chosen).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import {
  affectedSpanIndices,
  centripetalKnots,
  evaluateSpan,
  fitCatmullRomSpline,
  spanRole,
  validateControlPoints,
} from './catmullRom.ts';

// ---------------------------------------------------------------------------
// spanRole / affectedSpanIndices — directed "classic off-by-one" tests
// (this task's guardrails call this out explicitly for closed-spline wrap
// indexing).
// ---------------------------------------------------------------------------

describe('spanRole — wrap/reflection indexing', () => {
  it('closed: span 0 wraps to the LAST control point for its "before" role slot, not undefined/index -1', () => {
    const points: Vec3[] = [
      [0, 0, 0], // A
      [1, 0, 0], // B
      [1, 1, 0], // C
      [0, 1, 0], // D
    ];
    const role0 = spanRole(points, 0, true);
    expect(role0).toEqual([points[3], points[0], points[1], points[2]]); // [D, A, B, C]

    // Last span (3) wraps its "after" role slot back to control point 0.
    const role3 = spanRole(points, 3, true);
    expect(role3).toEqual([points[2], points[3], points[0], points[1]]); // [C, D, A, B]
  });

  it('open: span 0 reflects a phantom point BEFORE the start (not a repeated P0)', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [5, 0, 0],
    ];
    const role0 = spanRole(points, 0, false);
    // Reflection: 2*P0 - P1 = 2*[0,0,0] - [2,0,0] = [-2,0,0].
    expect(role0[0]).toEqual([-2, 0, 0]);
    expect(role0[1]).toEqual(points[0]);
    expect(role0[2]).toEqual(points[1]);
    expect(role0[3]).toEqual(points[2]);
  });

  it('open: last span reflects a phantom point AFTER the end', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [5, 0, 0],
    ];
    const role1 = spanRole(points, 1, false); // last span (n=3 -> spans 0,1)
    // Reflection: 2*P2 - P1 = 2*[5,0,0] - [2,0,0] = [8,0,0].
    expect(role1[3]).toEqual([8, 0, 0]);
    expect(role1[0]).toEqual(points[0]);
    expect(role1[1]).toEqual(points[1]);
    expect(role1[2]).toEqual(points[2]);
  });
});

describe('affectedSpanIndices — locality (this task\'s brief, deliverable 3)', () => {
  it('open, 6 control points (5 spans): hand-worked window per control point', () => {
    const n = 6;
    const expected: Record<number, number[]> = {
      0: [0, 1],
      1: [0, 1, 2],
      2: [0, 1, 2, 3],
      3: [1, 2, 3, 4],
      4: [2, 3, 4],
      5: [3, 4],
    };
    for (const [k, exp] of Object.entries(expected)) {
      expect(affectedSpanIndices(n, false, Number(k))).toEqual(exp);
    }
  });

  it('closed, 6 control points (6 spans): hand-worked wrapped window per control point', () => {
    const n = 6;
    const expected: Record<number, number[]> = {
      0: [0, 1, 4, 5],
      1: [0, 1, 2, 5],
      2: [0, 1, 2, 3],
      3: [1, 2, 3, 4],
      4: [2, 3, 4, 5],
      5: [0, 3, 4, 5],
    };
    for (const [k, exp] of Object.entries(expected)) {
      expect(affectedSpanIndices(n, true, Number(k))).toEqual(exp);
    }
  });

  it('every affected span index is within the valid span range', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 12 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 11 }),
        (n, closed, kRaw) => {
          const k = kRaw % n;
          const spanCount = closed ? n : n - 1;
          const affected = affectedSpanIndices(n, closed, k);
          for (const i of affected) {
            expect(i).toBeGreaterThanOrEqual(0);
            expect(i).toBeLessThan(spanCount);
          }
          // no duplicates, sorted
          expect(affected).toEqual([...new Set(affected)].sort((a, b) => a - b));
          expect(affected.length).toBeGreaterThan(0);
          expect(affected.length).toBeLessThanOrEqual(4);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// evaluateSpan — exact endpoints (Barry-Goldman algebraic property).
// ---------------------------------------------------------------------------

describe('evaluateSpan', () => {
  it('u === t1 returns role[1] exactly; u === t2 returns role[2] exactly', () => {
    const role: readonly [Vec3, Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [1, 2, 0],
      [4, 1, 0],
      [6, 3, 0],
    ];
    const knots = centripetalKnots(role);
    expect(evaluateSpan(role, knots, knots[1])).toEqual(role[1]);
    expect(evaluateSpan(role, knots, knots[2])).toEqual(role[2]);
  });
});

// ---------------------------------------------------------------------------
// validateControlPoints
// ---------------------------------------------------------------------------

describe('validateControlPoints', () => {
  it('throws for too few points (open needs >= 2, closed needs >= 3)', () => {
    expect(() => validateControlPoints([[0, 0, 0]], false)).toThrow(RangeError);
    expect(() =>
      validateControlPoints(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        true,
      ),
    ).toThrow(RangeError);
  });

  it('throws for a non-finite point', () => {
    expect(() =>
      validateControlPoints(
        [
          [0, 0, 0],
          [NaN, 0, 0],
        ],
        false,
      ),
    ).toThrow(RangeError);
  });

  it('throws for near-duplicate consecutive control points', () => {
    expect(() =>
      validateControlPoints(
        [
          [0, 0, 0],
          [1e-9, 0, 0],
          [5, 0, 0],
        ],
        false,
      ),
    ).toThrow(RangeError);
  });

  it('closed near-duplicate check wraps (last vs first)', () => {
    expect(() =>
      validateControlPoints(
        [
          [0, 0, 0],
          [5, 0, 0],
          [1e-9, 0, 0],
        ],
        true,
      ),
    ).toThrow(RangeError);
  });

  it('accepts well-separated finite points', () => {
    expect(() =>
      validateControlPoints(
        [
          [0, 0, 0],
          [5, 0, 0],
          [5, 5, 0],
        ],
        true,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Analytic: planar square -> spline stays planar at MACHINE PRECISION (this
// task's brief, deliverable 5). Every Barry-Goldman step is an affine (lerp)
// combination of the 4 role points (catmullRom.ts's top doc) — an affine
// combination of points that all share Z=0 has Z=0 EXACTLY (to double
// rounding, no accumulated geometric approximation error), which is exactly
// what this test measures.
// ---------------------------------------------------------------------------

describe('fitCatmullRomSpline — ACCEPTANCE: planar square stays planar (machine precision)', () => {
  it('closed square in the Z=0 plane: every resampled point has |Z| at double-rounding noise', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ];
    const result = fitCatmullRomSpline(points, true, 2); // 2 points/mm
    let maxAbsZ = 0;
    for (const span of result.spans) {
      for (const p of span.points) {
        maxAbsZ = Math.max(maxAbsZ, Math.abs(p[2]));
      }
    }
    // Machine-precision bound: a handful of ULPs relative to the 10mm-scale
    // coordinates involved (6 lerps, each introducing <= 1 rounding step) —
    // 1e-12 is many orders of magnitude looser than the actual ~1e-15 noise,
    // while still being a meaningfully tight "machine precision" assertion.
    expect(maxAbsZ).toBeLessThan(1e-12);
  });

  it('open zig-zag polyline all at Z=3: every resampled point has Z === 3 at double-rounding noise', () => {
    const points: Vec3[] = [
      [0, 0, 3],
      [1, 4, 3],
      [3, 1, 3],
      [6, 5, 3],
      [8, 0, 3],
    ];
    const result = fitCatmullRomSpline(points, false, 1);
    let maxAbsDeviation = 0;
    for (const span of result.spans) {
      for (const p of span.points) {
        maxAbsDeviation = Math.max(maxAbsDeviation, Math.abs(p[2] - 3));
      }
    }
    expect(maxAbsDeviation).toBeLessThan(1e-12);
  });
});

// ---------------------------------------------------------------------------
// Analytic: control points on a circle (standing in for "a great circle of
// the sphere" at the pure ambient-math layer — surfaceSpline.test.ts covers
// the mesh-projected version on an actual icosphere) -> closed spline stays
// within a documented tolerance of that circle (this task's brief,
// deliverable 5: "radius deviation asserted").
//
// ## Tolerance derivation
//
// Catmull-Rom (any cubic-Hermite-family interpolant) reproducing a smooth
// curve from N samples has local truncation error of order O(kappa * h^4)
// for a curve of curvature `kappa` sampled at arc-length spacing `h` —
// standard cubic-interpolant truncation-error order (see e.g. de Boor, "A
// Practical Guide to Splines"; this is the SAME order natural cubic splines
// achieve for a C4 function, and Catmull-Rom's finite-difference-estimated
// tangents match the true derivative's leading Taylor terms closely enough
// to share that order, even though the exact constant differs from a
// globally-solved natural spline). For N evenly-spaced points around a
// circle of radius r, h = 2*pi*r/N and kappa = 1/r, so the expected radial
// deviation is O(r * (2*pi/N)^4) for a small, curve-family-dependent
// constant. Per this project's established convention (geodesicPath.
// analytic.test.ts's identical structure: cite the theoretical ORDER, then
// MEASURE the actual constant rather than derive it symbolically), this
// test measures the actual max radial deviation for N=24 (a clinically
// representative closed margin-line control-point count: >= 24 points at
// ~1.3mm spacing already exceeds the 20-40mm circumference range this
// task's guardrails cite) and asserts a bound with a generous measured
// margin — not the bare theoretical order, which only pins down how the
// bound should SCALE with N/r, not its concrete value for this specific
// alpha=0.5 Barry-Goldman implementation.
// ---------------------------------------------------------------------------

describe('fitCatmullRomSpline — ACCEPTANCE: closed spline through points on a circle stays within tolerance of it', () => {
  it('N=24 evenly-spaced points on a r=5mm circle: max radial deviation is small (measured + documented bound)', () => {
    const r = 5;
    const n = 24;
    const points: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const theta = (2 * Math.PI * i) / n;
      points.push([r * Math.cos(theta), r * Math.sin(theta), 0]);
    }
    const result = fitCatmullRomSpline(points, true, 4); // 4 points/mm — dense oversample of each ~1.3mm span
    let maxRadialDeviation = 0;
    for (const span of result.spans) {
      for (const p of span.points) {
        const radius = Math.hypot(p[0], p[1], p[2]);
        maxRadialDeviation = Math.max(maxRadialDeviation, Math.abs(radius - r));
      }
    }
    // Theoretical order (this describe block's doc): O(r*(2*pi/N)^4) =
    // O(5 * 0.2618^4) = O(5 * 0.0047) = O(0.0235mm) ceiling. MEASURED
    // (reproduce via this test): 0.000505mm — about 46x tighter than the
    // theoretical order-of-magnitude ceiling (expected: that ceiling is a
    // loose upper bound on the ERROR ORDER, not a tight prediction of this
    // specific alpha=0.5 Barry-Goldman implementation's actual constant).
    // BOUND below is set at ~4x the measured value — comfortable margin
    // against fixture/seed changes, still far tighter than the theoretical
    // ceiling, matching this project's "measured, not just theoretical"
    // convention (geodesicPath.analytic.test.ts's identical approach).
    console.log(`[catmullRom circle acceptance] N=${n} r=${r}mm: max radial deviation = ${maxRadialDeviation.toFixed(6)}mm`);
    expect(maxRadialDeviation).toBeLessThan(0.002);
  });
});

// ---------------------------------------------------------------------------
// Property: resampling density convergence (this task's brief, deliverable
// 5). Refining density does NOT strictly monotonically increase the
// resampled polyline's total length at every step — the resampling scheme
// picks an ENTIRELY new evenly-spaced point set per density, not a strict
// superset/refinement of the coarser set's points, so the simple triangle-
// inequality "adding an inscribed vertex never shortens a polygon" argument
// does not directly transfer between two DIFFERENT resamplings (this task's
// guardrail explicitly warns about this). Instead: as density increases the
// measured length must get and STAY close to a fine-reference length, within
// a documented allowance (not a strict per-step monotonic decrease).
// ---------------------------------------------------------------------------

describe('fitCatmullRomSpline — property: resampling density convergence', () => {
  it('increasing points-per-mm density converges the resampled arc length toward a fine-reference value', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [3, 5, 1],
      [7, 2, -2],
      [10, 8, 0],
      [14, 3, 3],
    ];
    const densities = [0.5, 1, 2, 4, 8, 16];
    const REFERENCE_DENSITY = 64;
    const reference = fitCatmullRomSpline(points, false, REFERENCE_DENSITY).totalLength;

    const deviations = densities.map((d) => Math.abs(fitCatmullRomSpline(points, false, d).totalLength - reference));

    // Documented allowance: a coarser density's deviation from the fine
    // reference may occasionally be UNDERCUT by a slightly-less-coarse
    // density that happens to land its evenly-spaced samples in a
    // marginally less favorable configuration (numerical, not systematic) —
    // ALLOWANCE_FACTOR permits a later (finer) density's deviation to be up
    // to this fraction LARGER than an earlier (coarser) one's while still
    // counting as "converging", rather than requiring strict monotonic
    // decrease at every single step.
    const ALLOWANCE_FACTOR = 1.5;
    for (let i = 1; i < deviations.length; i++) {
      expect(deviations[i]!).toBeLessThan(deviations[i - 1]! * ALLOWANCE_FACTOR + 1e-9);
    }
    // The coarsest and finest measured densities must show REAL convergence
    // (not just "within allowance of each other" trivially): the finest
    // non-reference density's deviation must be much smaller than the
    // coarsest's.
    expect(deviations[deviations.length - 1]!).toBeLessThan(deviations[0]! * 0.25);
    console.log(`[catmullRom density convergence] deviations from reference (density=${REFERENCE_DENSITY}): ` + densities.map((d, i) => `${d}/mm=${deviations[i]!.toFixed(5)}mm`).join(', '));
  });
});

// ---------------------------------------------------------------------------
// Closed-curve seam continuity — C1 verified NUMERICALLY (this task's
// brief). Finite-difference tangent approaching the seam control point
// (index 0, where the LAST span's end meets the FIRST span's start) from
// both directions; the angle between them must be small (documented
// threshold).
// ---------------------------------------------------------------------------

describe('fitCatmullRomSpline — closed-curve seam continuity (C1, numeric)', () => {
  it('angle between the incoming and outgoing tangent at the seam is small', () => {
    // Deliberately NON-uniform spacing (unequal consecutive distances) —
    // the case a uniform-parametrization Catmull-Rom would NOT handle
    // consistently, and the case this module's centripetal Barry-Goldman
    // construction is specifically claimed (catmullRom.ts's top doc) to
    // still get right.
    const points: Vec3[] = [
      [0, 0, 0],
      [4, 1, 0],
      [5, 5, 1],
      [1, 6, 2],
      [-2, 3, 1],
    ];
    const n = points.length;
    const seamIndex = 0;
    const lastSpanIndex = n - 1; // wraps back to control point 0
    const firstSpanIndex = 0;

    const lastRole = spanRole(points, lastSpanIndex, true);
    const lastKnots = centripetalKnots(lastRole);
    const firstRole = spanRole(points, firstSpanIndex, true);
    const firstKnots = centripetalKnots(firstRole);

    // Central finite-difference tangent, symmetric in REAL parameter units
    // around each span's own end/start knot (t2 for the incoming span, t1
    // for the outgoing span) — both should be evaluating "the same physical
    // point" P(seam) with a consistent local velocity if the construction is
    // truly C1 there.
    const h = 1e-6;
    const incoming = finiteDifferenceTangent((u) => evaluateSpan(lastRole, lastKnots, u), lastKnots[2], h, lastKnots[1], lastKnots[2]);
    const outgoing = finiteDifferenceTangent((u) => evaluateSpan(firstRole, firstKnots, u), firstKnots[1], h, firstKnots[1], firstKnots[2]);

    const angle = angleBetween(incoming, outgoing);
    console.log(`[catmullRom C1 seam] angle between incoming/outgoing tangent at seam = ${((angle * 180) / Math.PI).toFixed(4)} deg`);
    // Documented threshold: a genuine C1 construction should measure at
    // finite-difference noise level (h=1e-6 central difference has O(h^2)
    // truncation error, ~1e-12 relative, dwarfed by any REAL discontinuity,
    // which would show up as an O(1) angle, not a small fraction of a
    // degree). MEASURED (reproduce via this test): ~0.0001 degrees — the
    // 0.01deg bound below still leaves ~100x margin above that measured
    // noise floor while being tight enough to actually catch a regression
    // (e.g. reverting to the non-equivalent Hermite-tangent shortcut this
    // module's top doc describes trying and rejecting, which is only G1 —
    // that would fail this bound by many orders of magnitude, not barely).
    expect(angle).toBeLessThan((0.01 * Math.PI) / 180); // < 0.01 degrees
    void seamIndex;
  });
});

function finiteDifferenceTangent(eval_: (u: number) => Vec3, at: number, h: number, lo: number, hi: number): Vec3 {
  // Clamp the finite-difference offsets to stay within [lo, hi] (Barry-
  // Goldman is only defined for u in the span's own real-knot range) —
  // falls back to a one-sided difference at either extreme, which `at ===
  // hi` (incoming tangent) / `at === lo` (outgoing tangent) always hit.
  const uMinus = Math.max(lo, at - h);
  const uPlus = Math.min(hi, at + h);
  const a = eval_(uMinus);
  const b = eval_(uPlus);
  const dt = uPlus - uMinus;
  return [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt, (b[2] - a[2]) / dt];
}

function angleBetween(a: Vec3, b: Vec3): number {
  const lenA = Math.hypot(a[0], a[1], a[2]);
  const lenB = Math.hypot(b[0], b[1], b[2]);
  const cos = Math.min(1, Math.max(-1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (lenA * lenB)));
  return Math.acos(cos);
}

// ---------------------------------------------------------------------------
// Determinism + NaN-freedom (property, fast-check — seeded).
// ---------------------------------------------------------------------------

/** Points on a per-index-jittered circle/spiral, seeded only by `count` and
 * a small integer `seedOffset` (fast-check arbitrary, so still varies across
 * generated cases) — guarantees consecutive separation well above
 * `MIN_CONTROL_POINT_SEPARATION_MM` without a pairwise-distance rejection
 * filter (which shrinks poorly / can exhaust attempts for multi-point
 * arrays). */
function separatedPointsArb(minCount: number, maxCount: number): fc.Arbitrary<Vec3[]> {
  return fc.tuple(fc.integer({ min: minCount, max: maxCount }), fc.integer({ min: 0, max: 1000 })).map(([count, seedOffset]) => {
    const points: Vec3[] = [];
    for (let i = 0; i < count; i++) {
      const theta = (2 * Math.PI * i) / count + seedOffset * 0.017;
      const radius = 5 + ((i + seedOffset) % 3); // small per-index jitter, still well-separated
      points.push([radius * Math.cos(theta), radius * Math.sin(theta), i * 0.3]);
    }
    return points;
  });
}

describe('fitCatmullRomSpline — property: NaN-free + deterministic', () => {
  it('never produces NaN/Infinity, and repeat calls are bit-identical', () => {
    fc.assert(
      fc.property(separatedPointsArb(2, 10), fc.boolean(), fc.double({ min: 0.1, max: 5, noNaN: true }), (points, closedRaw, density) => {
        const closed = closedRaw && points.length >= 3;
        const a = fitCatmullRomSpline(points, closed, density);
        const b = fitCatmullRomSpline(points, closed, density);
        for (const span of a.spans) {
          for (const p of span.points) {
            expect(Number.isFinite(p[0])).toBe(true);
            expect(Number.isFinite(p[1])).toBe(true);
            expect(Number.isFinite(p[2])).toBe(true);
          }
        }
        expect(b.totalLength).toBe(a.totalLength);
        expect(b.spans.length).toBe(a.spans.length);
        for (let i = 0; i < a.spans.length; i++) {
          expect(b.spans[i]!.points).toEqual(a.spans[i]!.points);
        }
      }),
    );
  });
});
