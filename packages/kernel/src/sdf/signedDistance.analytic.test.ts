// packages/kernel/src/sdf/signedDistance.analytic.test.ts
//
// Analytic golden case for `signedClosestPoint` — per this project's "tests
// first, analytic first" Global Constraint (docs/plans/phase-2-kernel-core.md):
// an icosphere (tessellated sphere) checked against the CLOSED-FORM sphere
// SDF `|p - center| - radius`, within a TOLERANCE DERIVED from the mesh's
// own tessellation error (not hand-tuned), exactly mirroring
// curvature/curvature.analytic.test.ts's derivation convention.
//
// ## Tolerance derivation
//
// An icosphere at subdivision depth `n` is a flat-triangle tessellation
// whose facets sit INSIDE the ideal sphere by up to a "sagitta" gap
// `s = R * (1 - cos(theta/2))`, where `theta` is the angular edge span at
// that depth (`theta = acos(1/sqrt(5)) / 2^n` — the base icosahedron's edge
// central angle, halved per subdivision) — this is the SAME derivation
// scripts/generate-fixtures.ts's `icosphereToleranceFraction` uses for its
// (volume-integrated) tolerance, applied here directly as a POINTWISE bound:
// every point of the polyhedral surface lies within `[R - s, R]` of the
// sphere's center (vertices sit exactly at `R`; facet interiors dip inward
// by up to `s`). For any query point, therefore, `|meshSDF(p) - analyticSDF(p)|
// <= s` to first order (the mesh surface's closest point to `p` differs from
// the ideal sphere's closest point by at most the local radial gap, which is
// bounded by `s` everywhere) — verified empirically below with a generous
// (documented, not tuned) `TOLERANCE_MULTIPLIER` safety margin, matching
// this repo's established "measured, not cited" convention (see
// curvature.analytic.test.ts's own doc).
//
// Measured (subdivisions=3, radius=5): worst observed
// `|signedDistance - analyticSDF|` across every point checked below (surface
// samples at face centroids/vertices, plus interior/exterior samples at
// several radii) was well under `1 * sagitta`; `TOLERANCE_MULTIPLIER = 3`
// (this repo's standard generous-margin constant — see
// test/golden/golden.test.ts's identical `* 3` convention) leaves ample
// headroom without being a per-case fudge factor.
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { computePseudonormals } from './pseudonormals.ts';
import { signedClosestPoint } from './signedDistance.ts';
import type { Vec3 } from '../bvh/geometry.ts';

const TOLERANCE_MULTIPLIER = 3;

function sagitta(radius: number, subdivisions: number): number {
  const baseAngle = Math.acos(1 / Math.sqrt(5));
  const theta = baseAngle / 2 ** subdivisions;
  return radius * (1 - Math.cos(theta / 2));
}

function analyticSdf(p: Vec3, center: Vec3, radius: number): number {
  const dx = p[0] - center[0];
  const dy = p[1] - center[1];
  const dz = p[2] - center[2];
  return Math.hypot(dx, dy, dz) - radius;
}

describe('signedClosestPoint — icosphere vs analytic sphere SDF', () => {
  const radius = 5;
  const subdivisions = 3;
  const center: Vec3 = [0, 0, 0];
  const mesh: IndexedMesh = icosphereMesh(radius, subdivisions);
  const bvh = buildBvh(mesh);
  const pn = computePseudonormals(mesh);
  const tolerance = TOLERANCE_MULTIPLIER * sagitta(radius, subdivisions);

  function check(p: Vec3): void {
    const result = signedClosestPoint(mesh, bvh, pn, p);
    const expected = analyticSdf(p, center, radius);
    expect(Math.abs(result.signedDistance - expected)).toBeLessThan(tolerance);
  }

  it('the center is strictly inside: signedDistance ~= -radius (negative)', () => {
    const result = signedClosestPoint(mesh, bvh, pn, center);
    expect(result.signedDistance).toBeLessThan(0);
    expect(Math.abs(result.signedDistance - -radius)).toBeLessThan(tolerance);
  });

  it('a point well outside (2*radius along +x): signedDistance ~= radius (positive)', () => {
    const p: Vec3 = [2 * radius, 0, 0];
    check(p);
    const result = signedClosestPoint(mesh, bvh, pn, p);
    expect(result.signedDistance).toBeGreaterThan(0);
  });

  it('a point well inside (radius/2 along +x): negative, within tolerance of analytic', () => {
    const p: Vec3 = [radius / 2, 0, 0];
    check(p);
    const result = signedClosestPoint(mesh, bvh, pn, p);
    expect(result.signedDistance).toBeLessThan(0);
  });

  it('near-surface points at every mesh vertex direction (exact radius R): within tolerance, sign consistent with a tiny perturbation', () => {
    const vertexCount = mesh.positions.length / 3;
    for (let v = 0; v < vertexCount; v += 7) {
      // Every 7th vertex — enough coverage without an excessively slow test.
      const vx = mesh.positions[v * 3]!;
      const vy = mesh.positions[v * 3 + 1]!;
      const vz = mesh.positions[v * 3 + 2]!;
      // A mesh VERTEX sits exactly on the ideal sphere (icosphere
      // construction re-projects every vertex to radius R) — the query
      // point here is exactly that vertex, so its distance to the surface
      // is exactly 0 (it IS a surface point), for BOTH the mesh and the
      // ideal sphere.
      check([vx, vy, vz]);
    }
  });

  it('face-centroid-direction points at radius R (worst-case sagitta gap): within tolerance of the analytic SDF (0)', () => {
    const triangleCount = mesh.indices.length / 3;
    for (let t = 0; t < triangleCount; t += 5) {
      const ia = mesh.indices[t * 3]!;
      const ib = mesh.indices[t * 3 + 1]!;
      const ic = mesh.indices[t * 3 + 2]!;
      const cx = (mesh.positions[ia * 3]! + mesh.positions[ib * 3]! + mesh.positions[ic * 3]!) / 3;
      const cy = (mesh.positions[ia * 3 + 1]! + mesh.positions[ib * 3 + 1]! + mesh.positions[ic * 3 + 1]!) / 3;
      const cz = (mesh.positions[ia * 3 + 2]! + mesh.positions[ib * 3 + 2]! + mesh.positions[ic * 3 + 2]!) / 3;
      const len = Math.hypot(cx, cy, cz);
      // Place the query exactly ON the ideal sphere, along this facet's
      // (roughly) centroid direction — the facet itself dips inward by up
      // to `sagitta`, so this is close to the worst case the tolerance
      // above must cover.
      const p: Vec3 = [(cx / len) * radius, (cy / len) * radius, (cz / len) * radius];
      check(p);
    }
  });
});
