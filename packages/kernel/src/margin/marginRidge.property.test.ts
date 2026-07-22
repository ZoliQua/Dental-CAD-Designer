// packages/kernel/src/margin/marginRidge.property.test.ts
//
// Property-based invariants for `proposeMarginLoop` (CLAUDE.md: "tests
// first: property-based (fast-check) + analytic golden case"), over
// `shoulderPrepMesh` seeds sampled at varying azimuth/height on the taper
// wall — the analytic acceptance NUMBERS live in marginRidge.analytic.test.ts;
// this file checks structural invariants that must hold for EVERY seed in
// range, not just the hand-picked ones.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildHalfedge, computeCurvature, buildBvh, snapToSurface, evaluateSurfacePoint } from '@dqcad/kernel';
import { proposeMarginLoop } from './marginRidge.ts';
import { shoulderPrepMesh } from './marginRidge.test-fixtures.ts';

describe('proposeMarginLoop — property invariants (shoulderPrepMesh)', () => {
  const fixture = shoulderPrepMesh();
  const hm = buildHalfedge(fixture.mesh);
  const curv = computeCurvature(fixture.mesh, hm);
  const bvh = buildBvh(fixture.mesh);
  const topRadiusMm = 2;
  const totalHeightMm = 8;

  function seedAt(azimuthRad: number, heightAboveMarginMm: number) {
    const seedZ = fixture.marginHeightMm + heightAboveMarginMm;
    const seedR =
      fixture.marginRadiusMm +
      ((topRadiusMm - fixture.marginRadiusMm) * (seedZ - fixture.marginHeightMm)) / (totalHeightMm - fixture.marginHeightMm);
    return snapToSurface(fixture.mesh, bvh, [seedR * Math.cos(azimuthRad), seedR * Math.sin(azimuthRad), seedZ]);
  }

  it('for any seed on the taper wall (any azimuth, moderate height above the margin): closes, anchors on the analytic circle, confidence in [0,1]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0.3, max: 3, noNaN: true }),
        (azimuth, heightAboveMargin) => {
          const seed = seedAt(azimuth, heightAboveMargin);
          const result = proposeMarginLoop(fixture.mesh, hm, curv, seed);
          expect(result.closed).toBe(true);
          expect(result.anchors.length).toBeGreaterThanOrEqual(3);
          expect(Number.isFinite(result.closureDeviationMm)).toBe(true);
          for (const c of result.segmentConfidence) {
            expect(Number.isFinite(c)).toBe(true);
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(1);
          }
          for (const a of result.anchors) {
            const p = evaluateSurfacePoint(fixture.mesh, a);
            const r = Math.hypot(p[0], p[1]);
            const dev = Math.hypot(r - fixture.marginRadiusMm, p[2] - fixture.marginHeightMm);
            expect(dev).toBeLessThanOrEqual(1e-6);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
