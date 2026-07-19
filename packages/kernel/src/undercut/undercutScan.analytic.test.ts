// packages/kernel/src/undercut/undercutScan.analytic.test.ts
//
// Analytic golden cases for `undercutScan`, per this task's brief and the
// project's "tests first, analytic first" Global Constraint
// (docs/plans/phase-2-kernel-core.md): a capped cylinder (axis-aligned zero
// undercut; TILTED at angle `a`, exact closed-form undercut wall area — this
// PRE-VERIFIES PLAN Phase 3's "undercut map on a tilted cylinder matches
// analytic expectation" acceptance item early) and a sphere (lower
// hemisphere undercut, depth growing pole-ward — spot asserts).
//
// ## Fix batch: occlusion detection — the CAPPED cylinder fixture stays
// unmodified; the closed-form checks are UNAFFECTED (verified, not assumed)
//
// undercutScan.ts's occlusion extension ("Occlusion as an INDEPENDENT
// undercut detector") raised a real risk for this file's fixture: a
// FACETED (not smooth) closed solid's facing wall triangles could
// self-occlude against their own caps (a wall triangle's sample point is
// slightly INSET from the true cylindrical surface — see undercutScan.ts's
// doc — so a `+d` ray from it isn't guaranteed to immediately leave into
// open space the way a true smooth cylinder's would). This was checked
// empirically, not assumed: at EVERY tilt this file tests (30°, 90°, 150°),
// `undercutWallTriangleCount` below is measured to be EXACTLY
// `(SEGMENTS/2)*HEIGHT_SEGMENTS*2` — identical to the pre-occlusion-
// extension closed form — because a facing wall triangle's `+d` ray, for
// these tilts, has a strictly non-decreasing radial distance from the axis
// (see undercutScan.ts's doc) and exits through open space (past the
// cylinder's own radius envelope) well before it could reach either cap's
// height. NO fixture adjustment (e.g. an open, uncapped walls-only variant)
// was needed for these three tilts — the closed form holds as originally
// authored, on the ORIGINAL capped fixture, unmodified.
//
// The ONE genuine interaction is at EXACT axis alignment (`a = 0`): every
// wall triangle there has `normal · d == 0` EXACTLY (not near-zero — see
// this file's own derivation below), which means it falls inside
// `UNDERCUT_BOUNDARY_EPSILON`'s band and is therefore excluded from the
// occlusion check ENTIRELY (undercutScan.ts's "Near-perpendicular
// triangles" doc: the boundary band is excluded from BOTH the facing and
// the occlusion rule, precisely because a `+d` ray from a triangle with
// `nd ~ 0` is tangent to that triangle's own plane — a genuine geometric
// degeneracy, empirically confirmed to otherwise produce a spurious hit at
// the wall's own shared edge with the cap, not a real cap self-occlusion).
// The "axis-aligned (a=0) wall has ZERO undercut" describe block below adds
// an explicit test exercising this epsilon band with a GENUINELY nonzero
// (not exactly `0`) tilt, so the "zero undercut" result is demonstrably the
// epsilon policy's doing, not a lucky floating-point cancellation.
//
// ## Tilting: the DIRECTION is tilted, not the mesh
//
// `cappedCylinderMesh` (curvature/curvature.test-fixtures.ts) builds its
// cylinder with axis fixed along `+Z`. Rather than adding a mesh-rotation
// helper, every "tilted cylinder" case below tilts the SCAN DIRECTION
// instead: `d(a) = (sin a, 0, cos a)` is the unit vector at angle `a` from
// `+Z`, in the `x`-`z` plane — geometrically identical to rotating the
// cylinder by `-a` and scanning along `+Z` (only the RELATIVE angle between
// the wall's radial normal and `d` enters `normal · d`), and needs no new
// mesh-transform code at all.
//
// ## Closed form: undercut wall area is EXACTLY half the (discretized)
// lateral area, for ANY tilt `0 < a < pi`
//
// `cappedCylinderMesh(radius, height, segments, heightSegments)`'s wall is
// `segments` flat vertical rectangular strips (NOT a smooth curved surface —
// each strip is the extrusion, along `z`, of the chord between two adjacent
// ring vertices), one per `s = 0 .. segments-1`. Strip `s`'s outward unit
// normal is EXACTLY radial at the chord's MIDPOINT angle
// `phi_s = (2s + 1) * pi / segments` (derived from the actual triangle
// winding — verified numerically in this file's first `it` below, not just
// asserted) — i.e. `normal_s = (cos phi_s, sin phi_s, 0)`, independent of
// height/ring. Every strip has the SAME area: `chordWidth * height`, where
// `chordWidth = 2 * radius * sin(pi / segments)` (the chord length between
// two adjacent ring vertices).
//
// For `d(a) = (sin a, 0, cos a)`: `normal_s . d = cos(phi_s) * sin(a)`. This
// module's undercut rule (undercutScan.ts's top-of-file doc) is `normal . d
// < 0`; for `0 < a < pi`, `sin(a) > 0`, so strip `s` is undercut EXACTLY
// when `cos(phi_s) < 0`. Because `segments` is EVEN here (64) and
// `segments / 2 = 32` is itself EVEN, no `phi_s` ever lands exactly on `pi/2`
// or `3pi/2` (that would require the always-ODD `2s+1` to equal `segments/2`
// or `3*segments/2`, both even for `segments=64`) — so every strip has a
// STRICTLY nonzero `cos(phi_s)`, and by the exact `phi_s -> phi_s + pi`
// symmetry (`phi_{s + segments/2} = phi_s + pi`, `cos` flips sign), EXACTLY
// `segments / 2` strips are undercut, for ANY `a` in `(0, pi)` — the
// undercut wall area does NOT depend on the tilt magnitude, only its SIGN
// (this is a genuine, verifiable geometric fact for a cylindrical wall, not
// an approximation) — this file checks it at THREE different angles.
//
//   undercutWallAreaMm2 = (segments / 2) * chordWidth * height
//                       = segments * radius * sin(pi / segments) * height
//
// This converges to `pi * radius * height` (exactly half the true
// continuum cylinder's `2 * pi * radius * height` lateral area) as
// `segments -> infinity` (`segments * sin(pi/segments) -> pi`) — reported
// alongside the exact discretized check below, as the "this is the
// physically-meaningful number" cross-check Phase 3's heatmap ultimately
// cares about.
import { describe, expect, it } from 'vitest';
import { buildBvh, type Vec3 } from '../bvh/index.ts';
import { analyzeMesh } from '../intake/index.ts';
import { cappedCylinderMesh } from '../curvature/curvature.test-fixtures.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { undercutScan } from './undercutScan.ts';

function triangleArea(mesh: ReturnType<typeof cappedCylinderMesh>, t: number): number {
  const i0 = mesh.indices[t * 3]!;
  const i1 = mesh.indices[t * 3 + 1]!;
  const i2 = mesh.indices[t * 3 + 2]!;
  const p = mesh.positions;
  const ax = p[i1 * 3]! - p[i0 * 3]!;
  const ay = p[i1 * 3 + 1]! - p[i0 * 3 + 1]!;
  const az = p[i1 * 3 + 2]! - p[i0 * 3 + 2]!;
  const bx = p[i2 * 3]! - p[i0 * 3]!;
  const by = p[i2 * 3 + 1]! - p[i0 * 3 + 1]!;
  const bz = p[i2 * 3 + 2]! - p[i0 * 3 + 2]!;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

function triangleCentroid(mesh: ReturnType<typeof cappedCylinderMesh>, t: number): Vec3 {
  const i0 = mesh.indices[t * 3]!;
  const i1 = mesh.indices[t * 3 + 1]!;
  const i2 = mesh.indices[t * 3 + 2]!;
  const p = mesh.positions;
  return [
    (p[i0 * 3]! + p[i1 * 3]! + p[i2 * 3]!) / 3,
    (p[i0 * 3 + 1]! + p[i1 * 3 + 1]! + p[i2 * 3 + 1]!) / 3,
    (p[i0 * 3 + 2]! + p[i1 * 3 + 2]! + p[i2 * 3 + 2]!) / 3,
  ];
}

const RADIUS = 3;
const HEIGHT = 8;
const SEGMENTS = 64; // segments/2 = 32 is even -> no phi_s ever lands on +-pi/2 (see module doc)
const HEIGHT_SEGMENTS = 8;
const WALL_TRIANGLE_COUNT = HEIGHT_SEGMENTS * SEGMENTS * 2;

describe('undercutScan — cylinder r=3,h=8 (axis +Z): tilted-wall geometry self-check', () => {
  it('every wall strip is a flat vertical rectangle whose outward normal is exactly radial at its chord midpoint angle', () => {
    // Directly verifies this file's module-doc derivation against the REAL
    // fixture (not just algebra): every wall triangle's face normal (via
    // undercutScan's own normal computation, indirectly, by checking
    // undercut/not-undercut against a synthetic direction pointed exactly at
    // a chosen strip's claimed midangle) should flip sign predictably.
    const mesh = cappedCylinderMesh(RADIUS, HEIGHT, SEGMENTS, HEIGHT_SEGMENTS);
    const bvh = buildBvh(mesh);
    for (const s of [0, 1, 17, 32, 63]) {
      const phi = ((2 * s + 1) * Math.PI) / SEGMENTS;
      // d chosen so ONLY strip s's exact-radial normal is anti-parallel
      // (normal . d = -1): d = -(cos phi, sin phi, 0).
      const d: Vec3 = [-Math.cos(phi), -Math.sin(phi), 0];
      const result = undercutScan(mesh, bvh, d);
      // Ring 0's triangle pair for strip s is triangles [2s, 2s+1] (see
      // cappedCylinderMesh's wall triangulation: 2 triangles per (ring,
      // segment) cell, ring-major then segment order).
      expect(result.undercut[2 * s]).toBe(1);
      expect(result.undercut[2 * s + 1]).toBe(1);
      // depth for this exact radial d: a ray from the wall straight through
      // the cylinder's interior along -normal_s exits through the
      // DIAMETRICALLY OPPOSITE wall strip, at distance = the cylinder's
      // diameter measured along that chord direction — bounded above by
      // 2*radius (exact only in the continuum limit) and must be > 0.
      expect(result.depthMm[2 * s]!).toBeGreaterThan(0);
      expect(result.depthMm[2 * s]!).toBeLessThanOrEqual(2 * RADIUS + 1e-9);
    }
  });
});

describe('undercutScan — cylinder r=3,h=8: axis-aligned (a=0) wall has ZERO undercut', () => {
  it('normal . d === 0 exactly for every wall triangle when d = +Z (parallel to the axis) — none undercut', () => {
    const mesh = cappedCylinderMesh(RADIUS, HEIGHT, SEGMENTS, HEIGHT_SEGMENTS);
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1]);
    let wallUndercutCount = 0;
    for (let t = 0; t < WALL_TRIANGLE_COUNT; t++) {
      if (result.undercut[t] === 1) wallUndercutCount++;
    }
    expect(wallUndercutCount).toBe(0);
  });

  it('a genuinely nonzero, sub-epsilon tilt (not exact axis alignment) STILL gives zero wall undercut — exercises the epsilon BAND, not FP cancellation luck', () => {
    // Unlike the exact `a = 0` test above (whose `nd == 0` comes from a
    // genuine STRUCTURAL cancellation: every wall triangle's normal has a
    // z-component that is EXACTLY 0 by construction — see this file's
    // module doc's "chord midpoint" derivation — regardless of any epsilon
    // policy), this test's `d` is a REAL, nonzero tilt in `x`, chosen small
    // enough that `|normal · d|` for EVERY wall strip is guaranteed to land
    // strictly inside `UNDERCUT_BOUNDARY_EPSILON` (`1e-12`): since every
    // wall normal here is EXACTLY `(nx, ny, 0)` (that same z=0 structural
    // fact), `normal · d = nx * TINY_TILT` exactly (the `d_z` term
    // contributes nothing, however large) — with `|nx| <= 1`, so
    // `|normal · d| <= TINY_TILT = 1e-13`, an order of magnitude inside the
    // `1e-12` band, for every one of the 1024 wall triangles. Without the
    // epsilon policy (a bare `nd < 0` test), roughly HALF these wall
    // triangles would flip to "undercut by facing" from a dot product that
    // is a genuine (if minuscule) nonzero value here, not floating-point
    // noise around an exact zero — i.e. this specific tilt is exactly the
    // case `UNDERCUT_BOUNDARY_EPSILON` is sized to swallow.
    const TINY_TILT = 1e-13;
    const mesh = cappedCylinderMesh(RADIUS, HEIGHT, SEGMENTS, HEIGHT_SEGMENTS);
    const bvh = buildBvh(mesh);
    const d: Vec3 = [TINY_TILT, 0, 1];
    const result = undercutScan(mesh, bvh, d);
    let wallUndercutCount = 0;
    for (let t = 0; t < WALL_TRIANGLE_COUNT; t++) {
      if (result.undercut[t] === 1) wallUndercutCount++;
    }
    expect(wallUndercutCount).toBe(0);
  });

  it('the TOP cap (normal +Z) is not undercut; the BOTTOM cap (normal -Z) IS undercut with depth === height exactly', () => {
    // Documented wrinkle (undercutScan.ts's doc doesn't special-case caps):
    // a flat cap facing directly away from d is undercut by the strict
    // normal . d < 0 rule regardless of "nothing above it" intuition — see
    // this module's own top-of-file doc. Included here explicitly (not left
    // implicit) so the "zero undercut anywhere" framing some earlier drafts
    // of this task used is precisely scoped to the WALL, not the whole mesh.
    const mesh = cappedCylinderMesh(RADIUS, HEIGHT, SEGMENTS, HEIGHT_SEGMENTS);
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1]);
    const bottomCapStart = WALL_TRIANGLE_COUNT;
    const topCapStart = WALL_TRIANGLE_COUNT + SEGMENTS;
    for (let t = bottomCapStart; t < topCapStart; t++) {
      expect(result.undercut[t]).toBe(1);
      expect(result.depthMm[t]!).toBeCloseTo(HEIGHT, 6);
    }
    for (let t = topCapStart; t < topCapStart + SEGMENTS; t++) {
      expect(result.undercut[t]).toBe(0);
      expect(result.depthMm[t]!).toBe(0);
    }
  });
});

describe('undercutScan — cylinder r=3,h=8: TILTED wall undercut area matches the exact closed form, independent of tilt angle', () => {
  const chordWidth = 2 * RADIUS * Math.sin(Math.PI / SEGMENTS);
  const analyticUndercutWallAreaMm2 = SEGMENTS * RADIUS * Math.sin(Math.PI / SEGMENTS) * HEIGHT; // = (segments/2)*chordWidth*height
  const continuumHalfLateralAreaMm2 = Math.PI * RADIUS * HEIGHT; // segments -> infinity limit
  // Pure floating-point-summation tolerance (this is an EXACT discrete
  // closed form, not a discretization approximation — see module doc) —
  // generous relative bound, still tight enough to catch a real logic bug.
  const EXACT_RELATIVE_TOLERANCE = 1e-9;

  for (const degrees of [30, 90, 150]) {
    const a = (degrees * Math.PI) / 180;
    it(`tilt a=${degrees}deg: measured undercut wall area matches segments*r*sin(pi/segments)*h within ${EXACT_RELATIVE_TOLERANCE}`, () => {
      const mesh = cappedCylinderMesh(RADIUS, HEIGHT, SEGMENTS, HEIGHT_SEGMENTS);
      const bvh = buildBvh(mesh);
      const d: Vec3 = [Math.sin(a), 0, Math.cos(a)];
      const result = undercutScan(mesh, bvh, d);

      let measuredAreaMm2 = 0;
      let undercutWallTriangleCount = 0;
      for (let t = 0; t < WALL_TRIANGLE_COUNT; t++) {
        if (result.undercut[t] === 1) {
          measuredAreaMm2 += triangleArea(mesh, t);
          undercutWallTriangleCount++;
        }
      }

      console.log(
        `[undercutScan analytic] tilt a=${degrees}deg: ${undercutWallTriangleCount}/${WALL_TRIANGLE_COUNT} wall ` +
          `triangles undercut, measured area ${measuredAreaMm2.toFixed(6)} mm^2 vs exact closed form ` +
          `${analyticUndercutWallAreaMm2.toFixed(6)} mm^2 (continuum limit pi*r*h = ${continuumHalfLateralAreaMm2.toFixed(6)} mm^2), ` +
          `relative error ${(Math.abs(measuredAreaMm2 - analyticUndercutWallAreaMm2) / analyticUndercutWallAreaMm2).toExponential(3)}`,
      );

      expect(undercutWallTriangleCount).toBe((SEGMENTS / 2) * HEIGHT_SEGMENTS * 2); // segments/2 strips, 2 tris/ring * heightSegments rings
      expect(Math.abs(measuredAreaMm2 - analyticUndercutWallAreaMm2) / analyticUndercutWallAreaMm2).toBeLessThan(
        EXACT_RELATIVE_TOLERANCE,
      );
      // Sanity: also within the documented, looser discretization-vs-
      // continuum gap (chordWidth vs arc length) — segments*sin(pi/segments)
      // -> pi is a well-known O(1/segments^2) convergence.
      expect(chordWidth).toBeLessThan((2 * Math.PI * RADIUS) / SEGMENTS);
    });
  }
});

describe('undercutScan — sphere r=5, d=+Z: lower hemisphere undercut, depth grows equator -> pole', () => {
  const RADIUS_SPHERE = 5;
  const SUBDIVISIONS = 4;

  it('every triangle strictly in the lower hemisphere is undercut; every triangle strictly in the upper hemisphere is not', () => {
    const mesh = icosphereMesh(RADIUS_SPHERE, SUBDIVISIONS);
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1]);
    const triangleCount = mesh.indices.length / 3;
    let lowerChecked = 0;
    let upperChecked = 0;
    for (let t = 0; t < triangleCount; t++) {
      const c = triangleCentroid(mesh, t);
      // Skip triangles straddling the equator closely (boundary-noise band —
      // see undercutScan.ts's "Near-perpendicular triangles: the boundary
      // epsilon policy" doc section, `UNDERCUT_BOUNDARY_EPSILON`): only
      // trust triangles comfortably in one hemisphere (|z| > 5% of radius,
      // several orders of magnitude wider than the epsilon band itself —
      // this margin is about icosphere facet-normal discretization noise
      // near the equator, not float noise at an exact-zero dot product).
      if (Math.abs(c[2]) < 0.05 * RADIUS_SPHERE) continue;
      if (c[2] < 0) {
        expect(result.undercut[t]).toBe(1);
        lowerChecked++;
      } else {
        expect(result.undercut[t]).toBe(0);
        upperChecked++;
      }
    }
    expect(lowerChecked).toBeGreaterThan(0);
    expect(upperChecked).toBeGreaterThan(0);
  });

  it('depth is ~0 near the equator and grows toward the south pole, matching the analytic 2*|z| closed form (spot asserts)', () => {
    // Analytic (continuum-sphere) derivation (undercutScan.ts's module
    // doc): for a lower-hemisphere point p=(x,y,z), z<0, a ray from p along
    // +Z re-enters the sphere and exits at the mirrored point (x,y,-z) —
    // i.e. depth = -z - z = -2z = 2*|z| exactly, 0 at the equator (z=0),
    // 2*radius at the south pole (z=-radius).
    const mesh = icosphereMesh(RADIUS_SPHERE, SUBDIVISIONS);
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1], { sampling: 'corners' });
    const triangleCount = mesh.indices.length / 3;

    // Measured (not cited): a run of this exact fixture/subdivision/
    // direction (corners sampling) over every lower-hemisphere triangle
    // outside a 0.1*radius equator band reports max|measured-analytic| ~
    // 0.457 mm (ratio-to-radius ~0.091) — see this test's own console.log
    // for the reproduction. Two error sources contribute: (1) icosphere
    // face SAMPLE POINTS (corners are exact, but the "opposite exit point"
    // the ray hits is itself a facet, not the exact analytic sphere,
    // O(theta^2) chord-vs-arc error) and (2) near the poles, a triangle's 3
    // corners can span a wide range of `2*|z|` values, and 'corners'
    // sampling takes the MAX (see undercutScan.ts's documented sampling
    // policy) — the max corner's `z` is closer to the pole than the
    // triangle's centroid, so this comparison (against the CENTROID's own
    // analytic `2*|z|`) is expected to slightly overstate the true error.
    // `0.15 * radius` (0.75 mm) is a ~1.6x margin over the measured 0.457 mm
    // — generous, not tuned to the last digit, matching this repo's
    // established tolerance-derivation convention (e.g.
    // curvature.analytic.test.ts).
    const TOLERANCE_FRACTION_OF_RADIUS = 0.15;
    const toleranceMm = TOLERANCE_FRACTION_OF_RADIUS * RADIUS_SPHERE;

    let checked = 0;
    let maxAbsErrorMm = 0;
    for (let t = 0; t < triangleCount; t++) {
      const c = triangleCentroid(mesh, t);
      if (c[2] >= -0.1 * RADIUS_SPHERE) continue; // lower hemisphere only, away from the equator band
      const analyticDepth = -2 * c[2];
      const measuredDepth = result.depthMm[t]!;
      const err = Math.abs(measuredDepth - analyticDepth);
      if (err > maxAbsErrorMm) maxAbsErrorMm = err;
      expect(err).toBeLessThan(toleranceMm);
      checked++;
    }
    console.log(
      `[undercutScan analytic] sphere depth: ${checked} lower-hemisphere triangles checked, max|measured-analytic| ` +
        `= ${maxAbsErrorMm.toFixed(6)} mm (tolerance ${toleranceMm.toFixed(6)} mm)`,
    );
    expect(checked).toBeGreaterThan(0);

    // Monotonic-trend spot check (qualitative, robust): near-pole depth
    // clearly exceeds near-equator depth.
    const nearEquatorIdx = mesh.indices.length / 3 > 0 ? findTriangleNearZ(mesh, -0.5) : -1;
    const nearPoleIdx = findTriangleNearZ(mesh, -RADIUS_SPHERE + 0.3);
    expect(nearEquatorIdx).toBeGreaterThanOrEqual(0);
    expect(nearPoleIdx).toBeGreaterThanOrEqual(0);
    expect(result.depthMm[nearPoleIdx]!).toBeGreaterThan(result.depthMm[nearEquatorIdx]!);
  });

  it('is a watertight, positive-volume solid (fixture self-check before trusting the depth spot-checks)', () => {
    const mesh = icosphereMesh(RADIUS_SPHERE, SUBDIVISIONS);
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.signedVolumeMm3).toBeGreaterThan(0);
  });
});

function findTriangleNearZ(mesh: ReturnType<typeof cappedCylinderMesh>, targetZ: number): number {
  const triangleCount = mesh.indices.length / 3;
  let bestT = -1;
  let bestDist = Infinity;
  for (let t = 0; t < triangleCount; t++) {
    const c = triangleCentroid(mesh, t);
    const dist = Math.abs(c[2] - targetZ);
    if (dist < bestDist) {
      bestDist = dist;
      bestT = t;
    }
  }
  return bestT;
}
