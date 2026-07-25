// packages/kernel/src/offset/innerSurfaceOffset.test.ts
//
// FAST, fixture-free unit + property tests for the two-zone inner-surface
// offset's PURE pieces (the gap field, smoothstep, point-to-loop distance,
// the blend-zone Lipschitz factor, and the parameter guards). The heavy
// SDF -> marching-cubes analytic golden on the shoulder-prep die lives in
// innerSurfaceOffset.analytic.test.ts (its own file, so it can carry a
// generous timeout without slowing this fast lane).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import {
  BlendWidthTooNarrowError,
  blendZoneLipschitz,
  distanceToClosedPolyline,
  innerSurfaceOffsetRoi,
  smoothstep,
  twoZoneGapField,
  type InnerSurfaceGapParams,
} from './innerSurfaceOffset.ts';
import { PitchTooSmallError } from './marchingCubes.ts';
import { EmptyOffsetResultError } from './offsetMesh.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';

const PROPERTY_SEED = 20260716;

// Standard-zirconia gaps (packages/clinical-profiles/standard-zirconia.json)
// — written literally here because packages/kernel must not depend on
// packages/clinical-profiles (layer rule); the pipeline stage test asserts
// these flow through from the real profile.
const GAP: InnerSurfaceGapParams = {
  marginalGapMm: 0.02,
  cementGapMm: 0.05,
  spacerStartMm: 0.8,
  blendWidthMm: 0.3,
};

describe('smoothstep — C1 Hermite ramp', () => {
  it('clamps outside [0,1] and hits the endpoints', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12);
  });

  it('is monotone non-decreasing on [0,1] (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(smoothstep(hi)).toBeGreaterThanOrEqual(smoothstep(lo) - 1e-15);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });

  it('has ZERO derivative at both ends (the C1-join property) — finite-difference check', () => {
    const eps = 1e-6;
    const dLeft = (smoothstep(eps) - smoothstep(0)) / eps;
    const dRight = (smoothstep(1) - smoothstep(1 - eps)) / eps;
    expect(Math.abs(dLeft)).toBeLessThan(1e-4);
    expect(Math.abs(dRight)).toBeLessThan(1e-4);
  });
});

describe('twoZoneGapField — marginal below, cement above, C1 blend across the spacer line', () => {
  const half = GAP.blendWidthMm / 2;
  it('is exactly marginalGapMm below the blend and cementGapMm above it', () => {
    expect(twoZoneGapField(0, GAP)).toBeCloseTo(GAP.marginalGapMm, 12);
    expect(twoZoneGapField(GAP.spacerStartMm - half - 0.01, GAP)).toBeCloseTo(GAP.marginalGapMm, 12);
    expect(twoZoneGapField(GAP.spacerStartMm + half + 0.01, GAP)).toBeCloseTo(GAP.cementGapMm, 12);
    expect(twoZoneGapField(2.0, GAP)).toBeCloseTo(GAP.cementGapMm, 12);
  });

  it('equals the midpoint gap exactly at the spacer line (smoothstep(0.5) = 0.5)', () => {
    const mid = (GAP.marginalGapMm + GAP.cementGapMm) / 2;
    expect(twoZoneGapField(GAP.spacerStartMm, GAP)).toBeCloseTo(mid, 12);
  });

  it('is monotone non-decreasing in h and stays within [marginalGapMm, cementGapMm] (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const gLo = twoZoneGapField(lo, GAP);
          const gHi = twoZoneGapField(hi, GAP);
          expect(gHi).toBeGreaterThanOrEqual(gLo - 1e-15);
          expect(gLo).toBeGreaterThanOrEqual(GAP.marginalGapMm - 1e-15);
          expect(gHi).toBeLessThanOrEqual(GAP.cementGapMm + 1e-15);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });

  it('is C1 across the whole ramp (finite-difference derivative is continuous — no step)', () => {
    const eps = 1e-6;
    const deriv = (h: number): number => (twoZoneGapField(h + eps, GAP) - twoZoneGapField(h - eps, GAP)) / (2 * eps);
    // Sample the derivative densely across the blend; adjacent samples must
    // not jump (a C0-only ramp would show a step at the joins).
    let maxJump = 0;
    let prev = deriv(0.3);
    for (let h = 0.31; h <= 1.3; h += 0.01) {
      const d = deriv(h);
      maxJump = Math.max(maxJump, Math.abs(d - prev));
      prev = d;
    }
    // A C0-only ramp would show a single derivative JUMP of the full
    // gap'-magnitude 1.5*dGap/blendWidth = 0.15 at a join. The C1 ramp's
    // finite-difference of gap' only ever changes by gap'' * step ~= 2.0 *
    // 0.01 = 0.02 between adjacent samples — no jump anywhere near 0.15.
    expect(maxJump).toBeLessThan(0.05);
  });
});

describe('distanceToClosedPolyline — exact point-to-loop Euclidean distance', () => {
  it('is 0 exactly on a loop vertex and on a loop edge midpoint', () => {
    const loop: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ];
    expect(distanceToClosedPolyline([0, 0, 0], loop)).toBe(0);
    expect(distanceToClosedPolyline([1, 0, 0], loop)).toBe(0); // edge midpoint
    expect(distanceToClosedPolyline([0, 1, 0], loop)).toBe(0); // closing edge
  });

  it('matches the analytic distance for a point above a unit square (perpendicular + edge cases)', () => {
    const loop: Vec3[] = [
      [-1, -1, 0],
      [1, -1, 0],
      [1, 1, 0],
      [-1, 1, 0],
    ];
    // Directly above the centre: nearest is any edge midpoint at distance 1
    // horizontally + z.
    expect(distanceToClosedPolyline([0, 0, 0.5], loop)).toBeCloseTo(Math.hypot(1, 0.5), 12);
    // Above a corner: nearest is that corner.
    expect(distanceToClosedPolyline([1, 1, 0.5], loop)).toBeCloseTo(0.5, 12);
  });

  it('handles a degenerate (zero-length) segment without dividing by zero', () => {
    // A loop with two coincident consecutive points — the degenerate segment
    // reduces to its point; nearest is the [1,0,0] vertex.
    const loop: Vec3[] = [
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
    ];
    expect(distanceToClosedPolyline([5, 0, 0], loop)).toBeCloseTo(4, 12);
    expect(Number.isFinite(distanceToClosedPolyline([0, 3, 0], loop))).toBe(true);
  });

  it('for a circle loop, a point on the axis at height z is sqrt(r^2 + z^2) from the loop (analytic)', () => {
    const r = 1.2;
    const n = 720;
    const loop: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n;
      loop.push([r * Math.cos(th), r * Math.sin(th), 0]);
    }
    const z = 0.5;
    // On-axis point: distance is to the nearest CHORD (segment), which
    // bulges toward the axis by the polygon sagitta r*(1-cos(pi/n)) ~= 1.1e-5
    // at n=720 — so the measured value is sqrt(r^2+z^2) minus ~1e-5, matching
    // the polygon approximation (precision 4 == 5e-5 tolerance covers it),
    // and is always slightly LESS than the true-circle distance.
    const analytic = Math.hypot(r, z);
    const measured = distanceToClosedPolyline([0, 0, z], loop);
    expect(measured).toBeCloseTo(analytic, 4);
    expect(measured).toBeLessThanOrEqual(analytic);
  });
});

describe('blendZoneLipschitz + BlendWidthTooNarrowError', () => {
  it('computes Lgap = 1.5 * dGap / blendWidth', () => {
    expect(blendZoneLipschitz(GAP)).toBeCloseTo((1.5 * 0.03) / 0.3, 12); // 0.15
  });

  it('rejects a blend so narrow that Lgap >= 1 (offset @errorBound would diverge)', async () => {
    const mesh = icosphereMesh(1, 1);
    const narrow = { ...GAP, blendWidthMm: 1.5 * 0.03 }; // exactly Lgap = 1 -> rejected (<=)
    await expect(
      innerSurfaceOffsetRoi(mesh, {
        ...narrow,
        pitchMm: 0.1,
        marginLoop: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        roiBboxMm: { min: [-1, -1, -1], max: [1, 1, 1] },
      }),
    ).rejects.toThrow(BlendWidthTooNarrowError);
  });
});

describe('innerSurfaceOffsetRoi — parameter guards (before any heavy work)', () => {
  const mesh = icosphereMesh(1, 1);
  const baseParams = {
    ...GAP,
    marginLoop: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ] as Vec3[],
    roiBboxMm: { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 },
  };

  it('rejects invalid pitchMm', async () => {
    await expect(innerSurfaceOffsetRoi(mesh, { ...baseParams, pitchMm: 0 })).rejects.toThrow(TypeError);
    await expect(innerSurfaceOffsetRoi(mesh, { ...baseParams, pitchMm: Number.NaN })).rejects.toThrow(TypeError);
    await expect(innerSurfaceOffsetRoi(mesh, { ...baseParams, pitchMm: 1e-6 })).rejects.toThrow(PitchTooSmallError);
  });

  it('rejects negative/NaN gaps and non-positive spacer/blend', async () => {
    await expect(innerSurfaceOffsetRoi(mesh, { ...baseParams, pitchMm: 0.1, marginalGapMm: -0.01 })).rejects.toThrow(
      TypeError,
    );
    await expect(innerSurfaceOffsetRoi(mesh, { ...baseParams, pitchMm: 0.1, cementGapMm: Number.NaN })).rejects.toThrow(
      TypeError,
    );
    await expect(innerSurfaceOffsetRoi(mesh, { ...baseParams, pitchMm: 0.1, spacerStartMm: 0 })).rejects.toThrow(
      TypeError,
    );
    await expect(innerSurfaceOffsetRoi(mesh, { ...baseParams, pitchMm: 0.1, blendWidthMm: 0 })).rejects.toThrow(
      TypeError,
    );
  });

  it('rejects a degenerate margin loop (< 2 points)', async () => {
    await expect(
      innerSurfaceOffsetRoi(mesh, { ...baseParams, pitchMm: 0.1, marginLoop: [[0, 0, 0]] }),
    ).rejects.toThrow(TypeError);
  });

  it('throws EmptyOffsetResultError when the ROI never reaches the prep surface (honest, not a silent empty mesh)', async () => {
    await expect(
      innerSurfaceOffsetRoi(mesh, {
        ...baseParams,
        pitchMm: 0.1,
        roiBboxMm: { min: [10, 10, 10], max: [11, 11, 11] },
      }),
    ).rejects.toThrow(EmptyOffsetResultError);
  });
});
