// packages/kernel/src/curvature/mixedArea.test.ts
//
// Unit + property tests for mixedArea.ts's Meyer-et-al. mixed Voronoi area
// — per this task's guardrails, the obtuse-triangle "T/2, T/4" fallback is
// THE classic bug source for a from-scratch implementation, so this file
// exercises the non-obtuse closed form, EVERY obtuse-at-each-corner branch,
// and (fast-check) an area-partition property test across randomly shaped
// triangles and full closed meshes.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildHalfedge } from '../halfedge/build.ts';
import { cubeMesh, icosphereMesh, octahedronMesh, tetrahedronMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { computeMixedVoronoiAreas, triangleVoronoiAreas } from './mixedArea.ts';

const PROPERTY_SEED = 20260712;
const NUM_RUNS = 300;

function triangleArea(a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return Math.hypot(cx, cy, cz) / 2;
}

describe('triangleVoronoiAreas', () => {
  it('splits an equilateral triangle into exact thirds', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [1, 0, 0];
    const c: [number, number, number] = [0.5, Math.sqrt(3) / 2, 0];
    const area = triangleArea(a, b, c);
    const [aa, ab, ac] = triangleVoronoiAreas(a, b, c);
    expect(aa).toBeCloseTo(area / 3, 12);
    expect(ab).toBeCloseTo(area / 3, 12);
    expect(ac).toBeCloseTo(area / 3, 12);
  });

  it('splits a right (non-obtuse) triangle via the closed form, summing to the true area', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [3, 0, 0];
    const c: [number, number, number] = [0, 4, 0];
    const area = triangleArea(a, b, c); // = 6
    const [aa, ab, ac] = triangleVoronoiAreas(a, b, c);
    expect(aa + ab + ac).toBeCloseTo(area, 10);
    expect(aa).toBeGreaterThan(0);
    expect(ab).toBeGreaterThan(0);
    expect(ac).toBeGreaterThan(0);
  });

  it('an obtuse angle AT a (120deg) routes T/2 to a, T/4 to b and c', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [1, 0, 0];
    const c: [number, number, number] = [-0.5, 3, 0]; // angle at a is obtuse
    const area = triangleArea(a, b, c);
    const [aa, ab, ac] = triangleVoronoiAreas(a, b, c);
    expect(aa).toBeCloseTo(area / 2, 12);
    expect(ab).toBeCloseTo(area / 4, 12);
    expect(ac).toBeCloseTo(area / 4, 12);
    expect(aa + ab + ac).toBeCloseTo(area, 10);
  });

  it('an obtuse angle AT b routes T/2 to b, T/4 to a and c', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [5, 0.5, 0]; // barely above the a-c line -> obtuse at b
    const c: [number, number, number] = [10, 0, 0];
    const area = triangleArea(a, b, c);
    const [aa, ab, ac] = triangleVoronoiAreas(a, b, c);
    expect(ab).toBeCloseTo(area / 2, 12);
    expect(aa).toBeCloseTo(area / 4, 12);
    expect(ac).toBeCloseTo(area / 4, 12);
  });

  it('an obtuse angle AT c routes T/2 to c, T/4 to a and b', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [10, 0, 0];
    const c: [number, number, number] = [1, 1, 0]; // angle at c is obtuse
    const area = triangleArea(a, b, c);
    const [aa, ab, ac] = triangleVoronoiAreas(a, b, c);
    expect(ac).toBeCloseTo(area / 2, 12);
    expect(aa).toBeCloseTo(area / 4, 12);
    expect(ab).toBeCloseTo(area / 4, 12);
  });

  it('is [0,0,0] for a degenerate (zero-area) triangle', () => {
    expect(triangleVoronoiAreas([0, 0, 0], [1, 0, 0], [2, 0, 0])).toEqual([0, 0, 0]);
  });

  // Property: for ANY triangle (obtuse or not, any shape), the 3-way split
  // sums exactly to the triangle's true area, and every entry is
  // non-negative — the two invariants this task's brief calls out
  // ("property-test area partition").
  it('property: always sums to the triangle area and is always non-negative', () => {
    const pointArb = fc.tuple(
      fc.double({ min: -50, max: 50, noNaN: true }),
      fc.double({ min: -50, max: 50, noNaN: true }),
      fc.double({ min: -50, max: 50, noNaN: true }),
    );
    fc.assert(
      fc.property(pointArb, pointArb, pointArb, (a, b, c) => {
        const area = triangleArea(a, b, c);
        if (area < 1e-6) return; // skip near-degenerate triangles (unit-tested above explicitly)
        const [aa, ab, ac] = triangleVoronoiAreas(a, b, c);
        expect(aa).toBeGreaterThanOrEqual(0);
        expect(ab).toBeGreaterThanOrEqual(0);
        expect(ac).toBeGreaterThanOrEqual(0);
        expect(aa + ab + ac).toBeCloseTo(area, 6);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('computeMixedVoronoiAreas', () => {
  it.each([
    ['tetrahedron', tetrahedronMesh(2)],
    ['cube', cubeMesh(1.5)],
    ['octahedron', octahedronMesh(3)],
    ['icosphere(r=5,subdiv=2)', icosphereMesh(5, 2)],
  ] as const)('%s: sum of per-vertex mixed areas equals the mesh total surface area', (_name, mesh) => {
    const hm = buildHalfedge(mesh);
    const areas = computeMixedVoronoiAreas(hm, mesh);
    let sumMixed = 0;
    for (let v = 0; v < areas.length; v++) sumMixed += areas[v]!;

    let totalArea = 0;
    for (let f = 0; f < hm.faceCount; f++) {
      const ia = mesh.indices[f * 3]!;
      const ib = mesh.indices[f * 3 + 1]!;
      const ic = mesh.indices[f * 3 + 2]!;
      totalArea += triangleArea(
        [mesh.positions[ia * 3]!, mesh.positions[ia * 3 + 1]!, mesh.positions[ia * 3 + 2]!],
        [mesh.positions[ib * 3]!, mesh.positions[ib * 3 + 1]!, mesh.positions[ib * 3 + 2]!],
        [mesh.positions[ic * 3]!, mesh.positions[ic * 3 + 1]!, mesh.positions[ic * 3 + 2]!],
      );
    }
    expect(sumMixed).toBeCloseTo(totalArea, 8);
  });

  it('every entry is non-negative, even on a mesh with obtuse triangles (tetrahedron)', () => {
    const mesh = tetrahedronMesh(1);
    const hm = buildHalfedge(mesh);
    const areas = computeMixedVoronoiAreas(hm, mesh);
    for (let v = 0; v < areas.length; v++) expect(areas[v]!).toBeGreaterThanOrEqual(0);
  });

  it('determinism: hash-identical across repeated runs', () => {
    const mesh = icosphereMesh(5, 2);
    const hm = buildHalfedge(mesh);
    const a = computeMixedVoronoiAreas(hm, mesh);
    const b = computeMixedVoronoiAreas(hm, mesh);
    const hashOf = (arr: Float64Array) => createHash('sha256').update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)).digest('hex');
    expect(hashOf(a)).toBe(hashOf(b));
  });
});
