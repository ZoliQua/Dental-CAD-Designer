// packages/kernel/src/repair/fillSmallHoles.test.ts
import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '../intake/analyze.ts';
import { buildEdgeMap } from '../intake/topology.ts';
import { icosphereMesh } from '../boolean/manifold.test-fixtures.ts';
import { removeTriangleNeighborhood } from './repair.test-fixtures.ts';
import { fillSmallHoles } from './fillSmallHoles.ts';
import type { IndexedMesh } from '../mesh/types.ts';

const SPHERE_RADIUS = 5;
// Subdivision 4 (5120 triangles), not Phase 1's 3 (1280 triangles): at
// subdivision 3 the icosphere's OWN natural facet-to-facet faceting angle
// (adjacent, undamaged triangles) already reaches ~5.75 deg / ~5.0 deg mean
// (measured directly — see this task's report) — indistinguishable from, or
// worse than, the < 5 deg seam-continuity target this file asserts below,
// making that assertion meaningless at that resolution. At subdivision 4
// the natural faceting drops to ~2.9 deg max / ~2.5 deg mean, leaving
// headroom to actually demonstrate the curvature-continuity solve beats
// plain faceting rather than being masked by it.
const SPHERE_SUBDIVISIONS = 4;
const SEED_TRIANGLE = 42; // an arbitrary interior face, away from the icosahedron's 12 original vertices

/** Target seam-continuity threshold this task's brief asks for (PLAN Phase
 * 5's blend language) — see the "curvature-continuous seam quality"
 * describe block below, which MEASURES the actual max and asserts against
 * this bound (never assumes it). */
const SEAM_DIHEDRAL_DEG_THRESHOLD = 5;

type Vec3 = readonly [number, number, number];

function triangleNormal(mesh: IndexedMesh, triangle: number): Vec3 {
  const base = triangle * 3;
  const ia = mesh.indices[base]!;
  const ib = mesh.indices[base + 1]!;
  const ic = mesh.indices[base + 2]!;
  const a: Vec3 = [mesh.positions[ia * 3]!, mesh.positions[ia * 3 + 1]!, mesh.positions[ia * 3 + 2]!];
  const b: Vec3 = [mesh.positions[ib * 3]!, mesh.positions[ib * 3 + 1]!, mesh.positions[ib * 3 + 2]!];
  const c: Vec3 = [mesh.positions[ic * 3]!, mesh.positions[ic * 3 + 1]!, mesh.positions[ic * 3 + 2]!];
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]);
  return len === 0 ? [0, 0, 0] : [n[0] / len, n[1] / len, n[2] / len];
}

function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return (Math.acos(dot) * 180) / Math.PI;
}

/**
 * Max dihedral-angle deviation (degrees, `0` = perfectly co-planar) across
 * every SEAM edge — an original boundary-loop edge of `holed`, now shared
 * by exactly one PRE-EXISTING outside triangle (unchanged index/position,
 * `< originalTriangleCount`) and exactly one NEW patch triangle
 * (`>= originalTriangleCount`, per fillSmallHoles.ts's "every original loop
 * edge belongs to exactly one ear-clip triangle" construction) in `filled`.
 * This is exactly the interface the curvature-continuity solve targets —
 * see fillSmallHoles.ts's `@approximation` doc.
 */
function maxSeamDihedralDeg(holed: IndexedMesh, filled: IndexedMesh): number {
  const boundaryEdges: Array<[number, number]> = [];
  for (const entry of buildEdgeMap(holed).values()) {
    if (entry.incidences.length === 1) boundaryEdges.push([entry.a, entry.b]);
  }
  expect(boundaryEdges.length).toBeGreaterThan(0);

  const originalTriangleCount = holed.indices.length / 3;
  const filledTriangleCount = filled.indices.length / 3;

  function triangleHasEdge(triangle: number, a: number, b: number): boolean {
    const base = triangle * 3;
    const corners = [filled.indices[base]!, filled.indices[base + 1]!, filled.indices[base + 2]!];
    return corners.includes(a) && corners.includes(b);
  }

  let maxDeg = 0;
  for (const [a, b] of boundaryEdges) {
    let outside = -1;
    for (let t = 0; t < originalTriangleCount; t++) {
      if (triangleHasEdge(t, a, b)) {
        outside = t;
        break;
      }
    }
    let patch = -1;
    for (let t = originalTriangleCount; t < filledTriangleCount; t++) {
      if (triangleHasEdge(t, a, b)) {
        patch = t;
        break;
      }
    }
    expect(outside).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
    const deg = angleBetweenDeg(triangleNormal(holed, outside), triangleNormal(filled, patch));
    if (deg > maxDeg) maxDeg = deg;
  }
  return maxDeg;
}

describe('fillSmallHoles — sphere with N deleted triangles', () => {
  it('restores watertightness and stays within 0.3% of the original mesh volume', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const originalStats = analyzeMesh(sphere);
    expect(originalStats.watertight).toBe(true);
    expect(originalStats.signedVolumeMm3).not.toBeNull();

    const holed = removeTriangleNeighborhood(sphere, SEED_TRIANGLE);
    const holedStats = analyzeMesh(holed);
    expect(holedStats.watertight).toBe(false);
    expect(holedStats.boundaryEdgeCount).toBeGreaterThan(0);

    const { mesh: filled, report } = fillSmallHoles(holed);
    expect(report.loopsFound).toBe(1);
    expect(report.loopsFilled).toBe(1);
    expect(report.loopsSkipped).toHaveLength(0);
    expect(report.newVertexCount).toBeGreaterThan(0);
    expect(report.newTriangleCount).toBeGreaterThan(0);
    expect(report.curvatureFallbackLoopCount).toBe(0); // the solve should succeed for this well-formed fixture

    const filledStats = analyzeMesh(filled);
    expect(filledStats.watertight).toBe(true);
    expect(filledStats.boundaryEdgeCount).toBe(0);
    expect(filledStats.componentCount).toBe(1);

    const originalVolume = originalStats.signedVolumeMm3!;
    const filledVolume = filledStats.signedVolumeMm3!;
    const relativeError = Math.abs(filledVolume - originalVolume) / originalVolume;
    expect(relativeError).toBeLessThan(0.003);
  });

  it('measures the seam dihedral-angle jump and asserts the documented < 5 degree bound (Phase 2 Task 11)', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const holed = removeTriangleNeighborhood(sphere, SEED_TRIANGLE);
    const { mesh: filled, report } = fillSmallHoles(holed);
    expect(report.loopsFilled).toBe(1);

    const measuredMaxDeg = maxSeamDihedralDeg(holed, filled);
    // Reported per this task's brief ("test measures + asserts + REPORTS
    // measured max").
    console.log(`[fillSmallHoles] measured max seam dihedral-angle jump: ${measuredMaxDeg.toFixed(3)} deg`);
    expect(measuredMaxDeg).toBeLessThan(SEAM_DIHEDRAL_DEG_THRESHOLD);
  });

  it('is idempotent: filling an already-watertight mesh is a no-op', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const holed = removeTriangleNeighborhood(sphere, SEED_TRIANGLE);
    const first = fillSmallHoles(holed);
    const second = fillSmallHoles(first.mesh);

    expect(second.report.loopsFound).toBe(0);
    expect(second.report.loopsFilled).toBe(0);
    expect(Array.from(second.mesh.positions)).toEqual(Array.from(first.mesh.positions));
    expect(Array.from(second.mesh.indices)).toEqual(Array.from(first.mesh.indices));
  });

  it('is deterministic: two independent calls on the same input produce byte-identical output', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const holed = removeTriangleNeighborhood(sphere, SEED_TRIANGLE);
    const a = fillSmallHoles(holed);
    const b = fillSmallHoles(holed);

    expect(Array.from(a.mesh.positions)).toEqual(Array.from(b.mesh.positions));
    expect(Array.from(a.mesh.indices)).toEqual(Array.from(b.mesh.indices));
    expect(a.report).toEqual(b.report);
  });

  it('refuses (skips) a hole exceeding maxBoundaryEdges, leaving the mesh unchanged', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const holed = removeTriangleNeighborhood(sphere, SEED_TRIANGLE);
    const holedStats = analyzeMesh(holed);

    const { mesh: result, report } = fillSmallHoles(holed, { maxBoundaryEdges: 3 });

    expect(report.loopsFound).toBe(1);
    expect(report.loopsFilled).toBe(0);
    expect(report.loopsSkipped).toHaveLength(1);
    expect(report.loopsSkipped[0]!.reason).toBe('tooManyEdges');
    expect(Array.from(result.positions)).toEqual(Array.from(holed.positions));
    expect(Array.from(result.indices)).toEqual(Array.from(holed.indices));
    expect(analyzeMesh(result).boundaryEdgeCount).toBe(holedStats.boundaryEdgeCount);
  });

  it('refuses (skips) a hole exceeding maxAreaMm2', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const holed = removeTriangleNeighborhood(sphere, SEED_TRIANGLE);

    const { report } = fillSmallHoles(holed, { maxAreaMm2: 1e-9 });

    expect(report.loopsFilled).toBe(0);
    expect(report.loopsSkipped).toHaveLength(1);
    expect(report.loopsSkipped[0]!.reason).toBe('tooLargeArea');
  });

  it('a fully watertight mesh has nothing to fill', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const { mesh: result, report } = fillSmallHoles(sphere);
    expect(report.loopsFound).toBe(0);
    expect(Array.from(result.positions)).toEqual(Array.from(sphere.positions));
    expect(Array.from(result.indices)).toEqual(Array.from(sphere.indices));
  });
});
