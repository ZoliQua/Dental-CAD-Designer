// packages/kernel/src/axis/roi.test.ts
//
// Unit tests for extractMarginRegion / unionRegions / regionTriangleAreasMm2
// / regionAreaWeightedNormalSum (this task's brief: "ROI extraction unit
// tests — region correctness on fixtures").
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from '../bvh/index.ts';
import { buildHalfedge } from '../halfedge/index.ts';
import { snapToSurface } from '../geodesic/surfacePoint.ts';
import { openGridPatchMesh, icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import {
  extractMarginRegion,
  unionRegions,
  regionTriangleAreasMm2,
  regionAreaWeightedNormalSum,
} from './roi.ts';

function triangleCountOf(mesh: IndexedMesh): number {
  return mesh.indices.length / 3;
}

describe('extractMarginRegion', () => {
  it('an empty seed list returns an empty region', () => {
    const mesh = openGridPatchMesh(10, 10, 1);
    const hm = buildHalfedge(mesh);
    const region = extractMarginRegion(mesh, hm, [], 5);
    expect(region.triangleIndices.length).toBe(0);
  });

  it('rejects a non-positive radius', () => {
    const mesh = openGridPatchMesh(4, 4, 1);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const seed = snapToSurface(mesh, bvh, [0, 0, 0]);
    expect(() => extractMarginRegion(mesh, hm, [seed], 0)).toThrow(RangeError);
    expect(() => extractMarginRegion(mesh, hm, [seed], -1)).toThrow(RangeError);
  });

  it('a larger radius always yields a SUPERSET of a smaller radius\'s region (monotone growth)', () => {
    // A 20x20 unit-cell grid (flat, in the XY plane) — graph distance along
    // its edges is a safe (if not perfectly tight) proxy for straight-line
    // distance here, good enough to exercise monotone growth without
    // depending on the exact conservative-bound magnitude.
    const mesh = openGridPatchMesh(20, 20, 1);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const seed = snapToSurface(mesh, bvh, [10, 10, 0]); // roughly centered
    const small = extractMarginRegion(mesh, hm, [seed], 2);
    const large = extractMarginRegion(mesh, hm, [seed], 6);
    expect(small.triangleIndices.length).toBeGreaterThan(0);
    expect(large.triangleIndices.length).toBeGreaterThan(small.triangleIndices.length);
    const largeSet = new Set(large.triangleIndices);
    for (const t of small.triangleIndices) {
      expect(largeSet.has(t)).toBe(true);
    }
    // A radius covering the whole patch reaches every triangle.
    const whole = extractMarginRegion(mesh, hm, [seed], 100);
    expect(whole.triangleIndices.length).toBe(triangleCountOf(mesh));
  });

  it('is a multi-source expansion: a region seeded from BOTH ends of a line is the union of what each end alone would reach (for a radius short of the two balls merging)', () => {
    const mesh = openGridPatchMesh(4, 30, 1); // long, thin strip (rows=4 -> y in [0,4], cols=30 -> x in [0,30]) — deliberately shaped for two well-separated seeds
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const seedA = snapToSurface(mesh, bvh, [1, 2, 0]);
    const seedB = snapToSurface(mesh, bvh, [28, 2, 0]);
    const radius = 3; // well short of the ~27-unit gap between the two seeds — the two balls never merge
    const regionA = extractMarginRegion(mesh, hm, [seedA], radius);
    const regionB = extractMarginRegion(mesh, hm, [seedB], radius);
    const both = extractMarginRegion(mesh, hm, [seedA, seedB], radius);
    const unioned = unionRegions([regionA, regionB]);
    expect(Array.from(both.triangleIndices)).toEqual(Array.from(unioned.triangleIndices));
    // Sanity: the two independent balls are genuinely disjoint (radius chosen well short of the gap).
    const setA = new Set(regionA.triangleIndices);
    for (const t of regionB.triangleIndices) {
      expect(setA.has(t)).toBe(false);
    }
  });

  it('triangle inclusion is INCLUSIVE (any-vertex-in-radius): a triangle with ONE vertex inside the radius is included even though its other two vertices sit outside it', () => {
    // 10x10 unit-cell grid, seeded exactly at vertex (5,5). idx(i,j) =
    // i*11+j (openGridPatchMesh's own layout). Straight axis-aligned graph
    // distance between grid vertices equals cellSize * step-count exactly
    // (each row/column step is a real mesh edge — the shortest possible),
    // so vertex (5,7) is EXACTLY 2 units from the seed and (5,8) EXACTLY 3.
    const mesh = openGridPatchMesh(10, 10, 1);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const seed = snapToSurface(mesh, bvh, [5, 5, 0]);
    const radius = 2.5;
    const region = extractMarginRegion(mesh, hm, [seed], radius);
    const included = new Set(region.triangleIndices);

    // Cell (i=5, j=7)'s first triangle: vertices idx(5,7), idx(5,8), idx(6,8)
    // — idx(5,7) is within radius (distance 2), idx(5,8)/idx(6,8) are not
    // (distance >= 3) — this triangle must still be INCLUDED.
    const cols = 10;
    const idx = (i: number, j: number): number => i * (cols + 1) + j;
    const nearFarTriangle = 2 * (5 * cols + 7);
    const [a, b, c] = [mesh.indices[nearFarTriangle * 3]!, mesh.indices[nearFarTriangle * 3 + 1]!, mesh.indices[nearFarTriangle * 3 + 2]!];
    expect([a, b, c]).toEqual([idx(5, 7), idx(5, 8), idx(6, 8)]); // sanity: this IS the triangle this test thinks it is
    expect(included.has(nearFarTriangle)).toBe(true);

    // Cell (i=8, j=8)'s first triangle: every vertex is far from the seed
    // (straight-line AND diagonal-shortcut graph distance both exceed the
    // radius: 3 diagonal hops = 3*sqrt(2) ~= 4.24mm) — must be EXCLUDED.
    const farTriangle = 2 * (8 * cols + 8);
    expect(included.has(farTriangle)).toBe(false);
  });
});

describe('unionRegions', () => {
  it('de-duplicates and sorts ascending', () => {
    const a = { triangleIndices: Uint32Array.from([5, 1, 3]) };
    const b = { triangleIndices: Uint32Array.from([3, 2]) };
    const union = unionRegions([a, b]);
    expect(Array.from(union.triangleIndices)).toEqual([1, 2, 3, 5]);
  });

  it('an empty list of regions unions to an empty region', () => {
    expect(unionRegions([]).triangleIndices.length).toBe(0);
  });
});

describe('regionTriangleAreasMm2', () => {
  it('sums to the full mesh area for a region covering every triangle of a flat unit-cell grid', () => {
    const mesh = openGridPatchMesh(5, 5, 1); // 5x5 cells, 1mm each -> 25 mm^2 total
    const region = { triangleIndices: Uint32Array.from({ length: triangleCountOf(mesh) }, (_, i) => i) };
    const areas = regionTriangleAreasMm2(mesh, region);
    expect(areas.length).toBe(region.triangleIndices.length);
    const total = areas.reduce((s, a) => s + a, 0);
    expect(total).toBeCloseTo(25, 9);
  });

  it('is aligned 1:1 with region.triangleIndices, not mesh-triangle-indexed', () => {
    const mesh = openGridPatchMesh(5, 5, 1);
    const region = { triangleIndices: Uint32Array.from([3, 7, 11]) };
    const areas = regionTriangleAreasMm2(mesh, region);
    expect(areas.length).toBe(3);
    for (const a of areas) expect(a).toBeGreaterThan(0);
  });
});

describe('regionAreaWeightedNormalSum', () => {
  it('is exactly the zero vector for a symmetric closed sphere (every direction\'s contribution cancels)', () => {
    const mesh = icosphereMesh(5, 2);
    const region = { triangleIndices: Uint32Array.from({ length: triangleCountOf(mesh) }, (_, i) => i) };
    const sum = regionAreaWeightedNormalSum(mesh, region);
    // A closed, watertight surface's area-weighted normal integral is
    // EXACTLY zero (divergence theorem: integral of the outward normal over
    // a closed surface is zero) — up to Float64 rounding, verified tightly.
    expect(Math.hypot(sum[0], sum[1], sum[2])).toBeLessThan(1e-9);
  });

  it('points toward a small patch\'s own outward direction (a north-pole cap on a sphere sums toward +Z)', () => {
    const mesh = icosphereMesh(5, 3);
    const bvh = buildBvh(mesh);
    const hm = buildHalfedge(mesh);
    const seed = snapToSurface(mesh, bvh, [0, 0, 5]);
    const region = extractMarginRegion(mesh, hm, [seed], 1.5);
    const sum = regionAreaWeightedNormalSum(mesh, region);
    const len = Math.hypot(sum[0], sum[1], sum[2]);
    expect(len).toBeGreaterThan(0);
    const unit = [sum[0] / len, sum[1] / len, sum[2] / len];
    expect(unit[2]).toBeGreaterThan(0.99); // overwhelmingly +Z for a small cap centered at the north pole
  });
});
