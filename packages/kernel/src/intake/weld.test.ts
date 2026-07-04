// packages/kernel/src/intake/weld.test.ts
//
// Analytic/unit tests for weldVertices: exact dedup counts on a
// hand-constructed triangle soup, epsilon boundary behavior, and buffer
// ownership (borrows input, never aliases output).
import { describe, expect, it } from 'vitest';
import type { TriangleSoup } from './types.ts';
import { MESH_WELD_EPSILON_MM, weldVertices } from './weld.ts';

const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

// Unit cube, 12 triangles, as an UNWELDED soup — every vertex is repeated
// verbatim across every triangle that touches it (the exact situation
// weldVertices exists to collapse). 8 distinct corner positions.
const CUBE_TRIANGLE_CORNER_INDICES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 1], [0, 3, 2], // bottom (-z)
  [4, 5, 6], [4, 6, 7], // top (+z)
  [0, 1, 5], [0, 5, 4], // front (-y)
  [1, 2, 6], [1, 6, 5], // right (+x)
  [2, 3, 7], [2, 7, 6], // back (+y)
  [0, 4, 7], [0, 7, 3], // left (-x)
];

function duplicatedCubeSoup(): TriangleSoup {
  const triangleCount = CUBE_TRIANGLE_CORNER_INDICES.length;
  const positions = new Float64Array(triangleCount * 9);
  CUBE_TRIANGLE_CORNER_INDICES.forEach((triangle, t) => {
    triangle.forEach((cornerIndex, corner) => {
      positions.set(CUBE_CORNERS[cornerIndex]!, t * 9 + corner * 3);
    });
  });
  return { positions, normals: null, triangleCount };
}

describe('weldVertices — duplicated-vertex soup welds to exact expected count', () => {
  it('collapses a 12-triangle, 36-raw-vertex cube soup to exactly 8 unique vertices', () => {
    const soup = duplicatedCubeSoup();
    const mesh = weldVertices(soup);

    expect(mesh.positions).toHaveLength(8 * 3);
    expect(mesh.indices).toHaveLength(12 * 3);

    // First-occurrence order: corner 0 is referenced first (triangle 0,
    // corner 0), so welded vertex 0 must be corner 0's position, etc.
    // Every corner appears as a "new" vertex in the order it is FIRST
    // referenced by CUBE_TRIANGLE_CORNER_INDICES.
    const expectedOrder = [0, 2, 1, 3, 4, 5, 6, 7]; // first-occurrence order of CUBE_CORNERS indices
    expectedOrder.forEach((cornerIndex, weldedIndex) => {
      expect(Array.from(mesh.positions.subarray(weldedIndex * 3, weldedIndex * 3 + 3))).toEqual(
        Array.from(CUBE_CORNERS[cornerIndex]!),
      );
    });
  });

  it('never mutates the input soup buffer and returns a disjoint output buffer', () => {
    const soup = duplicatedCubeSoup();
    const originalPositions = Float64Array.from(soup.positions);

    const mesh = weldVertices(soup);

    expect(Array.from(soup.positions)).toEqual(Array.from(originalPositions));
    expect(mesh.positions.buffer).not.toBe(soup.positions.buffer);
  });
});

describe('weldVertices — epsilon boundary behavior', () => {
  it('merges two vertices exactly at the epsilon distance (<=), does not merge just beyond it', () => {
    const epsilon = 1e-3;
    const within: TriangleSoup = {
      positions: new Float64Array([0, 0, 0, epsilon, 0, 0, 0, 1, 0]),
      normals: null,
      triangleCount: 1,
    };
    const beyond: TriangleSoup = {
      positions: new Float64Array([0, 0, 0, epsilon * 1.5, 0, 0, 0, 1, 0]),
      normals: null,
      triangleCount: 1,
    };

    expect(weldVertices(within, epsilon).positions).toHaveLength(2 * 3);
    expect(weldVertices(beyond, epsilon).positions).toHaveLength(3 * 3);
  });

  it('defaults to MESH_WELD_EPSILON_MM (1e-6 mm, PLAN.md §3) when no epsilon is passed', () => {
    expect(MESH_WELD_EPSILON_MM).toBe(1e-6);
    const soup: TriangleSoup = {
      positions: new Float64Array([0, 0, 0, 5e-7, 0, 0, 0, 1, 0]),
      normals: null,
      triangleCount: 1,
    };
    expect(weldVertices(soup).positions).toHaveLength(2 * 3);
  });

  it('rejects a non-positive epsilon', () => {
    const soup: TriangleSoup = { positions: new Float64Array(9), normals: null, triangleCount: 1 };
    expect(() => weldVertices(soup, 0)).toThrow(RangeError);
    expect(() => weldVertices(soup, -1)).toThrow(RangeError);
  });
});
