// packages/kernel/src/axis/suggestInsertionAxis.analytic.test.ts
//
// Analytic golden cases for `suggestInsertionAxis` — this task's brief:
// "analytic: tilted-cylinder acceptance re-cited (existing P2 test) + axis
// SUGGESTION on the tilted cylinder returns the cylinder axis within
// angular tolerance (derive); prep-die: suggested axis within tolerance of
// the die's construction axis; sphere (no undercut anywhere): any axis
// scores equal -> deterministic tie-break".
//
// ## Fixture choice: a cone FRUSTUM (this file's `coneFrustumMesh`), not a
// right cylinder, for the "recover a known non-trivial axis" cases
//
// PLAN Phase 3's acceptance item ("undercut map on a tilted cylinder
// matches analytic expectation") is about the UNDERCUT SCAN PRIMITIVE
// itself, already pre-verified in Phase 2 Task 9
// (undercut/undercutScan.analytic.test.ts, cited directly below — this
// file re-asserts one of its closed-form facts, it does not re-derive the
// whole suite). THIS module's job is the axis-suggestion SEARCH — a right
// cylinder's wall is a poor fixture for THAT: undercutScan.analytic.test.ts
// itself documents that a faceted cylinder wall's undercut AREA is
// (surprisingly) roughly HALF the lateral area for ANY nonzero tilt
// (a discretization artifact of a smooth surface's continuously-varying
// normal being approximated by flat facets — see that file's "Closed form"
// doc), which makes undercut AREA alone a poor (step-function-like,
// magnitude-insensitive) signal to search against near the true optimum. A
// cone FRUSTUM's wall has no such degeneracy: every wall triangle's
// outward normal has the SAME comfortably-nonzero dot product with the true
// axis (`sin` of the frustum's half-angle) at exact alignment — see
// `axis.test-fixtures.ts`'s `coneFrustumMesh` doc for the full derivation —
// giving a well-posed local basin around the true axis, which is exactly
// what a coarse->fine SEARCH needs to be meaningfully tested against.
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/index.ts';
import { buildHalfedge } from '../halfedge/index.ts';
import { snapToSurface } from '../geodesic/surfacePoint.ts';
import { undercutScan } from '../undercut/undercutScan.ts';
import { cappedCylinderMesh } from '../curvature/curvature.test-fixtures.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { coneFrustumMesh, concatMeshes } from './axis.test-fixtures.ts';
import { extractMarginRegion, unionRegions } from './roi.ts';
import { fibonacciHemisphereDirections } from './hemisphere.ts';
import {
  suggestInsertionAxis,
  suggestInsertionAxisForRegions,
  AXIS_COARSE_SAMPLE_COUNT,
  AXIS_REFINE_SAMPLE_COUNT,
  defaultRefineCapAngleRad,
} from './suggestInsertionAxis.ts';

type Vec3 = readonly [number, number, number];

function angleBetweenRad(a: Vec3, b: Vec3): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const lenA = Math.hypot(a[0], a[1], a[2]);
  const lenB = Math.hypot(b[0], b[1], b[2]);
  const cos = Math.min(1, Math.max(-1, dot / (lenA * lenB)));
  return Math.acos(cos);
}

/** Derived worst-case angular resolution of the REFINE sweep: a polar cap
 * of angular radius `capAngleRad` has solid angle `2*pi*(1-cos(capAngleRad))`
 * (exact spherical-cap formula); `refineCount` equal-area samples inside it
 * each "own" `capSolidAngle / refineCount` steradians, which — treating that
 * per-sample patch as a small flat disc (`area ~ pi*r^2`) — gives a
 * characteristic per-sample angular spacing `r = sqrt(capSolidAngle /
 * (refineCount * pi))`. The worst-case distance from the TRUE continuous
 * optimum to the nearest sampled point is bounded by roughly this same
 * order of magnitude (same style of derivation as
 * `defaultRefineCapAngleRad`'s own doc). A `safetyFactor` (documented at
 * each call site) accounts for this being a characteristic/average-spacing
 * estimate, not a tight worst-case proof.
 */
function derivedRefineAngularToleranceRad(capAngleRad: number, refineCount: number, safetyFactor: number): number {
  const capSolidAngle = 2 * Math.PI * (1 - Math.cos(capAngleRad));
  const perSampleSpacing = Math.sqrt(capSolidAngle / (refineCount * Math.PI));
  return safetyFactor * perSampleSpacing;
}

describe('suggestInsertionAxis — tilted cylinder (P2 Task 9 citation)', () => {
  it('re-asserts the tilted-cylinder closed form (undercut/undercutScan.analytic.test.ts): exactly half the wall strips are undercut for a tilt strictly between 0 and pi', () => {
    // Full derivation/analytic proof lives in
    // undercut/undercutScan.analytic.test.ts — this is a citation/smoke
    // re-assertion, not a re-derivation, per this file's module doc.
    const radius = 4;
    const height = 10;
    const segments = 64;
    const heightSegments = 4;
    const mesh = cappedCylinderMesh(radius, height, segments, heightSegments);
    const bvh = buildBvh(mesh);
    const tiltRad = (30 * Math.PI) / 180;
    const d: Vec3 = [Math.sin(tiltRad), 0, Math.cos(tiltRad)];
    const result = undercutScan(mesh, bvh, d);
    const undercutWallTriangleCount = (() => {
      let count = 0;
      const triangleCount = mesh.indices.length / 3;
      const wallTriangleCount = segments * heightSegments * 2;
      for (let t = 0; t < wallTriangleCount && t < triangleCount; t++) {
        if (result.undercut[t] === 1) count++;
      }
      return count;
    })();
    expect(undercutWallTriangleCount).toBe((segments / 2) * heightSegments * 2);
  });
});

describe('suggestInsertionAxis — cone frustum (prep-die-like construction axis)', () => {
  it('recovers the frustum\'s true construction axis ([0,0,1]) within a derived angular tolerance', () => {
    const frustum = coneFrustumMesh(4, 2.5, 9, 64, 12);
    const bvh = buildBvh(frustum.mesh);
    const hm = buildHalfedge(frustum.mesh);

    // Margin loop seeded MID-WALL (z=3, wall radius there = 3.5 — this
    // fixture's own `r(z) = bottomRadius - (bottomRadius-topRadius)*z/height`)
    // — NOT at the bottom ring (z=0): this fixture (unlike a real prep die)
    // is fully CAPPED at both ends, and the bottom cap's own outward normal
    // is a uniform, LARGE-area `(0,0,-1)` — deriving the hemisphere pole
    // from a region that reaches into it would badly skew
    // `deriveHemispherePole`'s area-weighted average away from the true
    // wall-only answer (verified: an earlier draft of this test seeded
    // exactly at the bottom ring and measured a ~91 degree error for
    // exactly this reason). Seeding + a 2mm region radius mid-wall (>1.5mm
    // of wall, mirroring `sqrt` slant-distance, from either cap along the
    // wall) keeps the ROI purely within the wall band, matching what a
    // REAL prep-die's margin ROI would look like (the tooth continues past
    // the margin into the gingiva/root — there is no synthetic "floor" —
    // this fixture's caps are purely a closed-mesh construction convenience,
    // not anatomy).
    const seeds = [];
    const seedCount = 32;
    const seedZ = 3;
    const seedRadius = 4 - (4 - 2.5) * (seedZ / 9);
    for (let i = 0; i < seedCount; i++) {
      const theta = (2 * Math.PI * i) / seedCount;
      const ambient: Vec3 = [seedRadius * Math.cos(theta), seedRadius * Math.sin(theta), seedZ];
      seeds.push(snapToSurface(frustum.mesh, bvh, ambient));
    }
    const region = extractMarginRegion(frustum.mesh, hm, seeds, 2.0);
    expect(region.triangleIndices.length).toBeGreaterThan(0);

    const trueAxis: Vec3 = [0, 0, 1];
    const result = suggestInsertionAxis(frustum.mesh, bvh, region);

    const measuredAngleDeg = (angleBetweenRad(result.best.direction, trueAxis) * 180) / Math.PI;
    console.log(
      `[axis] cone-frustum: best direction angular error = ${measuredAngleDeg.toFixed(3)} deg, ` +
        `scoreMm3=${result.best.scoreMm3.toExponential(3)}, undercutTriangleCount=${result.best.undercutTriangleCount}`,
    );

    const capAngleRad = defaultRefineCapAngleRad(AXIS_COARSE_SAMPLE_COUNT);
    // Safety factor 4x the characteristic per-sample spacing: this fixture's
    // objective basin is well-posed (see this file's module doc) but the
    // derivation itself is a characteristic-spacing estimate, not a tight
    // worst-case bound — see `derivedRefineAngularToleranceRad`'s doc.
    const toleranceRad = derivedRefineAngularToleranceRad(capAngleRad, AXIS_REFINE_SAMPLE_COUNT, 4);
    expect(angleBetweenRad(result.best.direction, trueAxis)).toBeLessThan(toleranceRad);
    expect(result.best).toBe(result.ranked[0]); // best is provably ranked[0] — see suggestInsertionAxis.ts's doc
  });

  it('is deterministic: two calls with identical inputs produce a bit-identical result', () => {
    const frustum = coneFrustumMesh(4, 2.5, 9, 32, 12);
    const bvh = buildBvh(frustum.mesh);
    const hm = buildHalfedge(frustum.mesh);
    const seeds = [];
    for (let i = 0; i < 16; i++) {
      const theta = (2 * Math.PI * i) / 16;
      seeds.push(snapToSurface(frustum.mesh, bvh, [4 * Math.cos(theta), 4 * Math.sin(theta), 0]));
    }
    const region = extractMarginRegion(frustum.mesh, hm, seeds, 3.5);
    const a = suggestInsertionAxis(frustum.mesh, bvh, region);
    const b = suggestInsertionAxis(frustum.mesh, bvh, region);
    expect(a.best).toEqual(b.best);
    expect(a.ranked).toEqual(b.ranked);
    expect(a.poleUsed).toEqual(b.poleUsed);
  });
});

describe('suggestInsertionAxis — sphere patch (no undercut anywhere -> deterministic tie-break)', () => {
  it('every candidate ties at score 0, and the winner is deterministically the pole-nearest coarse candidate', () => {
    const radius = 20;
    const mesh = icosphereMesh(radius, 3);
    const bvh = buildBvh(mesh);
    const hm = buildHalfedge(mesh);
    // A small cap near the north pole — small enough (relative to the
    // sphere's own radius) that it reads as nearly flat, and the ROI's own
    // default (area-weighted-normal) hemisphere pole ends up pointing
    // almost exactly at [0,0,1] — see roi.test.ts's own
    // `regionAreaWeightedNormalSum` test for the same fixture shape.
    const seed = snapToSurface(mesh, bvh, [0, 0, radius]);
    const region = extractMarginRegion(mesh, hm, [seed], 2);
    expect(region.triangleIndices.length).toBeGreaterThan(0);

    const result = suggestInsertionAxis(mesh, bvh, region);

    // The WINNER genuinely ties at zero (no candidate can ever score BELOW
    // zero — the objective is a sum of non-negative area*depth terms — so a
    // zero-scoring first candidate can never be displaced): this is what
    // makes the tie-break rule (not the objective) responsible for the
    // winner. NOTE: this does NOT extend to every one of the ~48 evaluated
    // candidates — the COARSE sweep spans the FULL 90-degree hemisphere
    // around `pole`, and a direction near that hemisphere's edge is nearly
    // TANGENT to this (slightly curved, non-perfectly-flat) patch; a
    // near-tangent ray can graze past the patch's own slight curvature and
    // clip the sphere's far side, or a patch triangle right at the edge of
    // the small cap can have a slightly negative dot product with such a
    // grazing direction — both are genuine (small-probability-of-hitting,
    // but real when they do) geometric facts about a CURVED surface's
    // patch, not a bug; only directions close to `pole` are guaranteed
    // clean. Measured below for visibility, not asserted as "always zero".
    const nearPoleTieCount = result.ranked.filter((c) => c.scoreMm3 === 0).length;
    console.log(`[axis] sphere patch: ${nearPoleTieCount}/${result.ranked.length} candidates tie at score 0`);
    expect(result.best.scoreMm3).toBe(0);
    expect(result.best.undercutTriangleCount).toBe(0);

    // The documented tie-break: best === ranked[0] === the FIRST-GENERATED
    // (coarse index 0, pole-nearest) candidate — independently recomputed
    // here via the same hemisphere function this module calls internally.
    const expectedFirst = fibonacciHemisphereDirections(AXIS_COARSE_SAMPLE_COUNT, result.poleUsed)[0]!;
    expect(result.best).toBe(result.ranked[0]);
    expect(result.best.direction).toEqual(expectedFirst);
  });
});

describe('suggestInsertionAxisForRegions — bridge two-abutment fixture', () => {
  it('finds a common axis close to both abutments\' shared true axis, and reports per-abutment stats at it', () => {
    const die1 = coneFrustumMesh(4, 2.5, 9, 48, 12, [0, 0, 0]);
    const die2 = coneFrustumMesh(4, 2.5, 9, 48, 12, [30, 0, 0]); // well separated — disjoint regions
    const combinedMesh = concatMeshes(die1.mesh, die2.mesh);
    const bvh = buildBvh(combinedMesh);
    const hm = buildHalfedge(combinedMesh);
    const die1TriangleCount = die1.mesh.indices.length / 3;

    // Mid-wall seeding — see the cone-frustum test's doc above for why (this
    // fixture's caps would otherwise skew the derived hemisphere pole).
    const seedZ = 3;
    const seedRadius = 4 - (4 - 2.5) * (seedZ / 9);
    function midWallSeeds(center: Vec3) {
      const seeds = [];
      for (let i = 0; i < 24; i++) {
        const theta = (2 * Math.PI * i) / 24;
        const ambient: Vec3 = [center[0] + seedRadius * Math.cos(theta), center[1] + seedRadius * Math.sin(theta), center[2] + seedZ];
        seeds.push(snapToSurface(combinedMesh, bvh, ambient));
      }
      return seeds;
    }

    const region1 = extractMarginRegion(combinedMesh, hm, midWallSeeds([0, 0, 0]), 2.0);
    const region2 = extractMarginRegion(combinedMesh, hm, midWallSeeds([30, 0, 0]), 2.0);
    expect(region1.triangleIndices.length).toBeGreaterThan(0);
    expect(region2.triangleIndices.length).toBeGreaterThan(0);
    // Sanity: the two regions really are disjoint (well-separated dies).
    const set1 = new Set(region1.triangleIndices);
    for (const t of region2.triangleIndices) expect(set1.has(t)).toBe(false);
    // Sanity: region1 only ever touches die1's own triangle-index range.
    for (const t of region1.triangleIndices) expect(t).toBeLessThan(die1TriangleCount);
    for (const t of region2.triangleIndices) expect(t).toBeGreaterThanOrEqual(die1TriangleCount);

    const { common, perRegion } = suggestInsertionAxisForRegions(combinedMesh, bvh, [region1, region2]);
    expect(perRegion.length).toBe(2);

    const trueAxis: Vec3 = [0, 0, 1];
    const measuredAngleDeg = (angleBetweenRad(common.best.direction, trueAxis) * 180) / Math.PI;
    console.log(
      `[axis] bridge: common axis angular error = ${measuredAngleDeg.toFixed(3)} deg; ` +
        `perAbutment scoreMm3=[${perRegion.map((c) => c.scoreMm3.toExponential(2)).join(', ')}]`,
    );

    const capAngleRad = defaultRefineCapAngleRad(AXIS_COARSE_SAMPLE_COUNT);
    const toleranceRad = derivedRefineAngularToleranceRad(capAngleRad, AXIS_REFINE_SAMPLE_COUNT, 4);
    expect(angleBetweenRad(common.best.direction, trueAxis)).toBeLessThan(toleranceRad);

    // union region used for search really is the union of the two.
    const expectedUnion = unionRegions([region1, region2]);
    expect(Array.from(expectedUnion.triangleIndices).length).toBe(
      region1.triangleIndices.length + region2.triangleIndices.length,
    );
  });
});
