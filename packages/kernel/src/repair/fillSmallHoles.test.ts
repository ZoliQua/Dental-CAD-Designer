// packages/kernel/src/repair/fillSmallHoles.test.ts
import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '../intake/analyze.ts';
import { icosphereMesh } from '../boolean/manifold.test-fixtures.ts';
import { removeTriangleNeighborhood } from './repair.test-fixtures.ts';
import { fillSmallHoles } from './fillSmallHoles.ts';

const SPHERE_RADIUS = 5;
const SPHERE_SUBDIVISIONS = 3;
const SEED_TRIANGLE = 42; // an arbitrary interior face, away from the icosahedron's 12 original vertices

describe('fillSmallHoles — sphere with N deleted triangles', () => {
  it('restores watertightness and stays within 0.5% of the original mesh volume', () => {
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

    const filledStats = analyzeMesh(filled);
    expect(filledStats.watertight).toBe(true);
    expect(filledStats.boundaryEdgeCount).toBe(0);
    expect(filledStats.componentCount).toBe(1);

    const originalVolume = originalStats.signedVolumeMm3!;
    const filledVolume = filledStats.signedVolumeMm3!;
    const relativeError = Math.abs(filledVolume - originalVolume) / originalVolume;
    expect(relativeError).toBeLessThan(0.005);
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
