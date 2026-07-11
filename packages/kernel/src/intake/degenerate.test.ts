// packages/kernel/src/intake/degenerate.test.ts
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { checkDegenerateTriangle, dropDegenerateTriangles } from './degenerate.ts';

function triangleMesh(positions: number[], triangles: number[][]): IndexedMesh {
  return { positions: new Float64Array(positions), indices: Uint32Array.from(triangles.flat()) };
}

describe('checkDegenerateTriangle', () => {
  it('flags a triangle with a repeated vertex index as degenerate + duplicateIndex', () => {
    const mesh = triangleMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 1]]);
    const check = checkDegenerateTriangle(mesh, 0);
    expect(check.degenerate).toBe(true);
    expect(check.duplicateIndex).toBe(true);
  });

  it('flags a distinct-index but zero-area (collinear) triangle as degenerate, not duplicateIndex', () => {
    // 3 distinct, collinear points on the x axis: zero cross product despite distinct indices.
    const mesh = triangleMesh([0, 0, 0, 1, 0, 0, 2, 0, 0], [[0, 1, 2]]);
    const check = checkDegenerateTriangle(mesh, 0);
    expect(check.degenerate).toBe(true);
    expect(check.duplicateIndex).toBe(false);
  });

  it('does not flag a real (non-degenerate) triangle', () => {
    const mesh = triangleMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 2]]);
    const check = checkDegenerateTriangle(mesh, 0);
    expect(check.degenerate).toBe(false);
  });
});

describe('dropDegenerateTriangles', () => {
  it('removes both zero-area and duplicate-index triangles, keeping real ones, with correct stats', () => {
    const mesh = triangleMesh(
      [
        0, 0, 0, // 0
        1, 0, 0, // 1
        0, 1, 0, // 2
        2, 0, 0, // 3 (collinear with 0,1 on x axis)
      ],
      [
        [0, 1, 2], // real
        [0, 1, 1], // duplicate-index
        [0, 1, 3], // zero-area, distinct indices (collinear)
      ],
    );

    const result = dropDegenerateTriangles(mesh);

    expect(result.triangleCountBefore).toBe(3);
    expect(result.triangleCountAfter).toBe(1);
    expect(result.degenerateCount).toBe(2);
    expect(result.duplicateIndexCount).toBe(1);
    expect(Array.from(result.mesh.indices)).toEqual([0, 1, 2]);
  });

  it('reuses the same positions buffer reference (no gratuitous copy) since vertices are never touched', () => {
    const mesh = triangleMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 2]]);
    const result = dropDegenerateTriangles(mesh);
    expect(result.mesh.positions).toBe(mesh.positions);
  });

  it('never mutates the input indices buffer', () => {
    const mesh = triangleMesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0], [[0, 1, 2], [0, 1, 1]]);
    const originalIndices = Uint32Array.from(mesh.indices);
    dropDegenerateTriangles(mesh);
    expect(Array.from(mesh.indices)).toEqual(Array.from(originalIndices));
  });

  it('handles an already-clean mesh (no degenerates) as a no-op on triangle count', () => {
    const mesh = triangleMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 2]]);
    const result = dropDegenerateTriangles(mesh);
    expect(result.triangleCountAfter).toBe(result.triangleCountBefore);
    expect(result.degenerateCount).toBe(0);
  });
});
