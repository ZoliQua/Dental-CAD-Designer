// packages/kernel/src/intersect/selfIntersect.test.ts
//
// ANALYTIC tests for the whole-mesh self-intersection scan. No fixtures —
// hand-built cubes, grids, and crossing-triangle meshes with closed-form
// answers. Proves: a clean solid PASSES (0 pairs); a mesh whose faces pass
// through each other FAILS (≥1 pair, with the right locus); topological
// adjacency (shared edges/vertices, incl. coplanar neighbours) is NOT a false
// positive; degenerate triangles are counted and skipped, never guessed;
// determinism (two runs identical).
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { findSelfIntersections } from './selfIntersect.ts';

function mesh(positions: number[], triangles: number[]): IndexedMesh {
  return { positions: new Float64Array(positions), indices: Uint32Array.from(triangles) };
}

// A welded unit cube: 8 shared vertices, 12 triangles. Every face-pair either
// shares a vertex (adjacent) or is a separated parallel pair — so a correct
// scan reports 0 self-intersections.
function unitCube(): IndexedMesh {
  const positions = [
    0,
    0,
    0, // 0
    1,
    0,
    0, // 1
    1,
    1,
    0, // 2
    0,
    1,
    0, // 3
    0,
    0,
    1, // 4
    1,
    0,
    1, // 5
    1,
    1,
    1, // 6
    0,
    1,
    1, // 7
  ];
  const triangles = [
    0,
    1,
    2,
    0,
    2,
    3, // bottom
    4,
    5,
    6,
    4,
    6,
    7, // top
    0,
    1,
    5,
    0,
    5,
    4, // front
    3,
    2,
    6,
    3,
    6,
    7, // back
    0,
    3,
    7,
    0,
    7,
    4, // left
    1,
    2,
    6,
    1,
    6,
    5, // right
  ];
  return mesh(positions, triangles);
}

// A flat, welded, coplanar grid of `n`×`n` quads (2n² triangles) — every
// interior triangle shares edges/vertices with its neighbours; no two
// non-adjacent cells overlap. Exercises the adjacency exclusion in the
// coplanar path specifically.
function flatGrid(n: number): IndexedMesh {
  const positions: number[] = [];
  const idx = (i: number, j: number): number => i * (n + 1) + j;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      positions.push(i, j, 0);
    }
  }
  const triangles: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      triangles.push(idx(i, j), idx(i + 1, j), idx(i + 1, j + 1));
      triangles.push(idx(i, j), idx(i + 1, j + 1), idx(i, j + 1));
    }
  }
  return mesh(positions, triangles);
}

describe('findSelfIntersections — clean meshes PASS', () => {
  it('a welded unit cube has 0 self-intersections (adjacency + separated pairs)', () => {
    const result = findSelfIntersections(unitCube());
    expect(result.intersectingPairCount).toBe(0);
    expect(result.firstLocus).toBeNull();
    expect(result.degenerateTrianglesSkipped).toBe(0);
    expect(result.triangleCount).toBe(12);
  });

  it('a coplanar grid of shared-edge triangles has 0 self-intersections (no false positives)', () => {
    const result = findSelfIntersections(flatGrid(6)); // 72 triangles, all coplanar
    expect(result.intersectingPairCount).toBe(0);
    expect(result.firstLocus).toBeNull();
  });

  it('a single triangle cannot self-intersect', () => {
    const result = findSelfIntersections(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]));
    expect(result.intersectingPairCount).toBe(0);
    expect(result.candidatePairsTested).toBe(0);
  });
});

describe('findSelfIntersections — genuinely self-intersecting meshes FAIL', () => {
  it('two non-adjacent triangles that pass through each other are reported (locus)', () => {
    // Triangle 0 in z=0; triangle 1 pierces its interior. No shared vertices ⇒
    // not adjacency-excluded ⇒ a genuine self-intersection.
    const result = findSelfIntersections(
      mesh(
        [
          0,
          0,
          0,
          2,
          0,
          0,
          0,
          2,
          0, // tri 0 (verts 0,1,2)
          0.25,
          0.25,
          -1,
          0.25,
          0.25,
          1,
          1.25,
          0.25,
          0, // tri 1 (verts 3,4,5)
        ],
        [0, 1, 2, 3, 4, 5],
      ),
    );
    expect(result.intersectingPairCount).toBe(1);
    expect(result.firstLocus).toEqual({ triangleA: 0, triangleB: 1 });
  });

  it('a cube with an extra face driven THROUGH its interior is caught (proxy-blind defect)', () => {
    // Start from the clean cube, then append a large triangle that slices
    // through the cube's interior using its OWN 3 new vertices (so it shares
    // no index with any cube face ⇒ genuine geometric self-intersection that a
    // manifold-topology check would not necessarily reject).
    const cube = unitCube();
    const positions = Array.from(cube.positions);
    const base = positions.length / 3; // = 8
    positions.push(-1, 0.5, 0.5, 2, 0.5, 0.5, 0.5, 2, 0.5); // a slab through x∈[-1,2] at y≈0.5
    const triangles = Array.from(cube.indices);
    triangles.push(base, base + 1, base + 2);
    const result = findSelfIntersections(mesh(positions, triangles));
    expect(result.intersectingPairCount).toBeGreaterThan(0);
    expect(result.firstLocus).not.toBeNull();
  });
});

describe('findSelfIntersections — degenerate handling (counted, not guessed)', () => {
  it('counts and skips a degenerate (collinear) triangle without throwing', () => {
    // A clean triangle + a zero-area collinear triangle sharing no vertices.
    const result = findSelfIntersections(
      mesh(
        [
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          1,
          0, // tri 0 — clean
          5,
          5,
          5,
          6,
          5,
          5,
          7,
          5,
          5, // tri 1 — collinear (degenerate)
        ],
        [0, 1, 2, 3, 4, 5],
      ),
    );
    expect(result.degenerateTrianglesSkipped).toBe(1);
    expect(result.intersectingPairCount).toBe(0);
  });
});

describe('findSelfIntersections — determinism + BVH reuse', () => {
  it('two runs over the same mesh produce identical results', () => {
    const m = flatGrid(5);
    const a = findSelfIntersections(m);
    const b = findSelfIntersections(m);
    expect(a).toEqual(b);
  });

  it('accepts a pre-built BVH and rejects a mismatched one', () => {
    const m = unitCube();
    const bvh = buildBvh(m);
    expect(findSelfIntersections(m, { bvh }).intersectingPairCount).toBe(0);
    const other = buildBvh(flatGrid(2)); // different triangle count
    expect(() => findSelfIntersections(m, { bvh: other })).toThrow(/triangleCount/);
  });

  it('rejects a mesh whose index count is not a multiple of 3', () => {
    const bad: IndexedMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0]),
      indices: Uint32Array.from([0, 1]),
    };
    expect(() => findSelfIntersections(bad)).toThrow(/multiple of 3/);
  });
});
