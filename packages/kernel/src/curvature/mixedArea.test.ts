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
    // 12 digits (~5e-13 absolute): each of aa/ab/ac is a handful of f64
    // flops (cross/dot/hypot/divide, O(1) terms, no accumulation loop) over
    // O(1)-magnitude inputs, so accumulated rounding is a few ULPs — ~1e-15
    // relative, i.e. ~1e-15 absolute here (area ~0.43) — 12 digits leaves
    // ~1000x headroom above that, not a tight/tuned bound.
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
    // 10 digits: summing 3 already-independently-rounded terms (aa+ab+ac)
    // adds one more rounding step on top of each term's own O(1)-flop
    // error (see the equilateral-triangle test above) — one digit looser
    // than the single-term 12-digit bound to cover that extra addition,
    // still many orders of magnitude above the actual ~1e-15 f64 noise.
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
    // Same 12/10-digit reasoning as the equilateral-triangle test above:
    // O(1) f64 flops per term (12 digits), one extra addition for the sum
    // (10 digits) — the obtuse T/2,T/4 branch is exact arithmetic (no
    // trig/sqrt beyond the shared `area` term), so no additional error
    // source versus the non-obtuse closed form.
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
    // 12 digits: same O(1)-flop-per-term reasoning as the obtuse-at-a case above.
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
    // 12 digits: same O(1)-flop-per-term reasoning as the obtuse-at-a case above.
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
        // 6 digits (looser than the fixed-triangle tests' 12/10): coordinates
        // here range over [-50,50] (vs. O(1) above) so `area` itself can be
        // orders of magnitude larger, and near-obtuse/near-degenerate random
        // shapes (filtered only below 1e-6, not away from ill-conditioning
        // generally) can amplify the same handful of f64 flops' rounding —
        // 6 digits absolute against an area that can reach ~1e4 keeps this a
        // RELATIVE bound of roughly 1e-10, still comfortably above the
        // ~1e-15-relative f64 noise floor, just not as tight as the
        // O(1)-magnitude fixed-triangle cases above.
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
    // 8 digits: unlike the single-triangle tests above, both `sumMixed` and
    // `totalArea` accumulate over EVERY face/vertex of the mesh (the
    // icosphere(subdiv=2) case alone has hundreds of faces) — summing N
    // independently-rounded f64 terms grows worst-case error ~O(N) ULPs
    // (random-sign rounding makes the realistic case closer to O(sqrt(N)));
    // 8 digits absolute against O(1)-to-O(100) magnitude areas comfortably
    // covers that N-term accumulation while still being far tighter than
    // the random-triangle property test's 6-digit bound above (this test's
    // mesh sizes/coordinate ranges are fixed and modest, not adversarial).
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
