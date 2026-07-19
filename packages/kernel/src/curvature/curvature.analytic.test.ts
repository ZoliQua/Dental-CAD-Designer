// packages/kernel/src/curvature/curvature.analytic.test.ts
//
// Analytic golden cases for `computeCurvature` — per this task's brief and
// the project's "tests first, analytic first" Global Constraint
// (docs/plans/phase-2-kernel-core.md): sphere, cylinder, torus closed-form
// curvatures, each checked against a TOLERANCE DERIVED from the fixture's
// own tessellation parameters (not hand-tuned to make the test pass).
//
// ## Tolerance derivation (shared by every case below)
//
// `computeCurvature`'s `@errorBound` (curvature.ts) states the estimator is
// second-order accurate: for local vertex spacing subtending angle `theta`
// (as seen from the relevant curvature center) at a point of curvature
// radius `r`, the error is `O(theta^2 / r)` for H and `O(theta^2 / r^2)`
// for K. `curvatureToleranceH`/`curvatureToleranceK` below apply that
// SAME formula, with a single constant `TOLERANCE_CONSTANT`, to every case
// (sphere/cylinder/torus) uniformly — chosen generously (not tuned).
//
// Measured (not cited): a one-off script ran `computeCurvature` over each
// EXACT fixture/parameter combination used below (sphere r=5 at
// subdivisions 2/3/4; the capped-cylinder tube region r=3; the torus
// R=5,r=2 outer+inner rings), took the max observed
// `|H_computed - H_analytic|` / `|K_computed - K_analytic|` over every
// vertex this file checks, and divided by that same case's `theta^2/r` (H)
// or `theta^2/r^2` (K) — i.e. exactly the ratio `TOLERANCE_CONSTANT` must
// exceed. Measured max-error ratios per case:
//   sphere (subdiv 2/3/4): ratioH ~1.2e-3 / 1.1e-3 / 3.2e-4, ratioK ~0.27 / 0.29 / 0.30
//   cylinder tube region:  ratioH ~1.7e-12 (near machine precision — K truly 0),  ratioK ~2.8e-12
//   torus outer+inner:     ratioH ~3.4e-2,  ratioK ~7.0e-2
// Worst case overall: ratioH = 3.4e-2 (torus), ratioK = 3.0e-1 (sphere,
// subdiv=4) — both COMFORTABLY below 1: `TOLERANCE_CONSTANT = 1` holds with
// ~29x margin on H and ~3.4x margin on K, while still being a single,
// uniform, principled constant — not a per-case fudge factor (mirrors this
// repo's own "generous, not tuned" margin convention, e.g.
// test/golden/golden.test.ts's documented `* 3` margin). Reproduce by
// computing `computeCurvature(fixture)`, diffing against the analytic H/K
// used in the `it(...)` blocks below, and dividing by `theta^2/r`
// (H) or `theta^2/r^2` (K) using each case's own `theta`/`r` as defined
// in that case's own describe block.
import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '../intake/index.ts';
import { icosphereMesh, torusMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { computeCurvature } from './curvature.ts';
import { cappedCylinderMesh } from './curvature.test-fixtures.ts';

const TOLERANCE_CONSTANT = 1;

function curvatureToleranceH(theta: number, r: number): number {
  return (TOLERANCE_CONSTANT * theta * theta) / r;
}

function curvatureToleranceK(theta: number, r: number): number {
  return (TOLERANCE_CONSTANT * theta * theta) / (r * r);
}

describe('computeCurvature — sphere r=5 (analytic H=1/r, K=1/r^2)', () => {
  const radius = 5;
  // Icosphere subdivision angle, same derivation as
  // scripts/generate-fixtures.ts's `icosphereToleranceFraction`:
  // acos(1/sqrt(5)) is the angle (at the sphere's center) subtended by an
  // icosahedron edge; each subdivision roughly halves it (edge midpoints
  // project radially, halving arc length per level).
  for (const subdivisions of [2, 3, 4]) {
    const theta = Math.acos(1 / Math.sqrt(5)) / 2 ** subdivisions;
    const toleranceH = curvatureToleranceH(theta, radius);
    const toleranceK = curvatureToleranceK(theta, radius);

    it(`subdivisions=${subdivisions}: every interior vertex has H within ${toleranceH.toExponential(2)} of 1/${radius}, K within ${toleranceK.toExponential(2)} of 1/${radius}^2`, () => {
      const mesh = icosphereMesh(radius, subdivisions);
      const result = computeCurvature(mesh);
      const expectedH = 1 / radius;
      const expectedK = 1 / (radius * radius);
      let interiorCount = 0;
      for (let v = 0; v < mesh.positions.length / 3; v++) {
        if (result.isBoundary[v]) continue;
        interiorCount++;
        expect(Math.abs(result.H[v]! - expectedH)).toBeLessThan(toleranceH);
        expect(Math.abs(result.K[v]! - expectedK)).toBeLessThan(toleranceK);
        // Principal curvatures on a sphere: k1 == k2 == H (umbilic point) —
        // same tolerance as H itself (empirically the clamped discriminant
        // is exactly 0 at every tested subdivision here, so k1/k2's error
        // is identically H's error; bounding by the same derived toleranceH
        // rather than a separate ad hoc precision keeps this non-tuned).
        expect(Math.abs(result.k1[v]! - expectedH)).toBeLessThan(toleranceH);
        expect(Math.abs(result.k2[v]! - expectedH)).toBeLessThan(toleranceH);
      }
      expect(interiorCount).toBeGreaterThan(0); // sanity: the loop actually ran
    });
  }
});

describe('computeCurvature — cylinder r=3 (analytic H=1/(2r)=1/6, K=0, tube region away from caps)', () => {
  const radius = 3;
  const height = 8;
  const segments = 64;
  const heightSegments = 8;

  it('is a watertight, positive-volume solid (fixture self-check before trusting curvature)', () => {
    const mesh = cappedCylinderMesh(radius, height, segments, heightSegments);
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.signedVolumeMm3).not.toBeNull();
    const analyticVolume = Math.PI * radius * radius * height;
    expect(Math.abs(stats.signedVolumeMm3! - analyticVolume) / analyticVolume).toBeLessThan(0.01);
  });

  it('tube-region rings (away from both caps) match H=1/6, K=0 within the derived tolerance', () => {
    const mesh = cappedCylinderMesh(radius, height, segments, heightSegments);
    const result = computeCurvature(mesh);
    const theta = (2 * Math.PI) / segments; // angular spacing around the tube's circumference
    const toleranceH = curvatureToleranceH(theta, radius);
    // K's analytic value is exactly 0 (a ruled direction contributes no
    // curvature) — curvatureToleranceK's `1/r^2` scaling still applies as
    // the ABSOLUTE tolerance around that zero (same order-theta^2
    // discretization error, just with no nonzero analytic value to take a
    // "relative" tolerance against).
    const toleranceK = curvatureToleranceK(theta, radius);

    // Rings 2..heightSegments-2 sit strictly inside the "away from caps"
    // band: ring indices 0 and heightSegments ARE the cap rings; rings 1
    // and heightSegments-1 have a one-ring neighbor that touches a cap
    // vertex (see curvature.test-fixtures.ts's module doc).
    let checked = 0;
    for (let r = 2; r <= heightSegments - 2; r++) {
      for (let s = 0; s < segments; s++) {
        const v = r * segments + s;
        expect(result.isBoundary[v]).toBe(0); // capped cylinder is closed — nothing should be flagged
        expect(Math.abs(result.H[v]! - 1 / 6)).toBeLessThan(toleranceH);
        expect(Math.abs(result.K[v]! - 0)).toBeLessThan(toleranceK);
        checked++;
      }
    }
    expect(checked).toBe((heightSegments - 3) * segments); // sanity: the loop actually ran over the expected band
  });
});

describe('computeCurvature — torus R=5,r=2 (K sign split outer/inner, spot values at extremal rings)', () => {
  const majorRadius = 5;
  const minorRadius = 2;
  const majorSegments = 48;
  const minorSegments = 24; // even, so phi=0 (outer) and phi=pi (inner) both land exactly on a vertex ring

  // Analytic principal curvatures of a torus parameterized by minor angle
  // phi (phi=0: outermost point of the tube; phi=pi: innermost point):
  //   k1 = 1/minorRadius                                (constant)
  //   k2 = cos(phi) / (majorRadius + minorRadius*cos(phi))
  //   H = (k1 + k2) / 2, K = k1 * k2
  const outerH = (1 / minorRadius + 1 / (majorRadius + minorRadius)) / 2;
  const outerK = 1 / (minorRadius * (majorRadius + minorRadius));
  const innerH = (1 / minorRadius - 1 / (majorRadius - minorRadius)) / 2;
  const innerK = -1 / (minorRadius * (majorRadius - minorRadius));

  // Minor-direction angular spacing dominates the local discretization error
  // here (majorSegments=48 samples the much larger major circle far more
  // finely than minorSegments=24 samples the tube cross-section) — same
  // `theta^2/r` family as the sphere/cylinder cases, with `r` the tube's own
  // radius (the curvature scale the minor-direction sampling resolves).
  const theta = (2 * Math.PI) / minorSegments;
  const toleranceH = curvatureToleranceH(theta, minorRadius);
  const toleranceK = curvatureToleranceK(theta, minorRadius);

  it('outer equator ring (phi=0): K is POSITIVE, matches the analytic spot value', () => {
    const mesh = torusMesh(majorRadius, minorRadius, majorSegments, minorSegments);
    const result = computeCurvature(mesh);
    for (let i = 0; i < majorSegments; i++) {
      const v = i * minorSegments + 0;
      expect(result.isBoundary[v]).toBe(0);
      expect(result.K[v]!).toBeGreaterThan(0);
      expect(Math.abs(result.H[v]! - outerH)).toBeLessThan(toleranceH);
      expect(Math.abs(result.K[v]! - outerK)).toBeLessThan(toleranceK);
    }
  });

  it('inner equator ring (phi=pi): K is NEGATIVE, matches the analytic spot value', () => {
    const mesh = torusMesh(majorRadius, minorRadius, majorSegments, minorSegments);
    const result = computeCurvature(mesh);
    for (let i = 0; i < majorSegments; i++) {
      const v = i * minorSegments + minorSegments / 2;
      expect(result.isBoundary[v]).toBe(0);
      expect(result.K[v]!).toBeLessThan(0);
      expect(Math.abs(result.H[v]! - innerH)).toBeLessThan(toleranceH);
      expect(Math.abs(result.K[v]! - innerK)).toBeLessThan(toleranceK);
    }
  });
});
