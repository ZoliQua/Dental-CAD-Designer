// packages/kernel/src/geodesic/unfold.test.ts
//
// Unit tests for `sequentialUnfold`'s hinge-unfold rule, hand-verified
// against two small, exactly-computable fixtures:
//  1. A flat 2-triangle quad — the hinge-unfold of an already-coplanar strip
//     must reproduce the mesh's TRUE flat 2D coordinates exactly (backs this
//     task's "planar mesh -> exact straight line" acceptance case).
//  2. A "folded tent" — two congruent triangles sharing an edge, folded to a
//     right dihedral angle — where the unfolded 2D layout is hand-derivable
//     via the law of cosines (see this file's comments).
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { sequentialUnfold } from './unfold.ts';

function mesh(positions: readonly (readonly [number, number, number])[], indices: readonly number[]): IndexedMesh {
  const flat = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => flat.set(p, i * 3));
  return { positions: flat, indices: Uint32Array.from(indices) };
}

describe('sequentialUnfold — flat quad reproduces exact 2D coordinates', () => {
  it('two coplanar triangles unfold to their true flat positions (up to floating point)', () => {
    // v0=(0,0,0) v1=(1,0,0) v2=(1,1,0) v3=(0,1,0); triangle0=[0,1,2], triangle1=[0,2,3].
    const m = mesh(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      [0, 1, 2, 0, 2, 3],
    );
    const result = sequentialUnfold(m, [0, 1]);
    const [p0, p1, p2] = result.face2D[0]!;
    expect(p0.x).toBeCloseTo(0, 12);
    expect(p0.y).toBeCloseTo(0, 12);
    expect(p1.x).toBeCloseTo(1, 12);
    expect(p1.y).toBeCloseTo(0, 12);
    expect(p2.x).toBeCloseTo(1, 12);
    expect(p2.y).toBeCloseTo(1, 12);

    const [q0, q2, q3] = result.face2D[1]!;
    expect(q0.x).toBeCloseTo(0, 12);
    expect(q0.y).toBeCloseTo(0, 12);
    expect(q2.x).toBeCloseTo(1, 12);
    expect(q2.y).toBeCloseTo(1, 12);
    expect(q3.x).toBeCloseTo(0, 12);
    expect(q3.y).toBeCloseTo(1, 12);
  });
});

describe('sequentialUnfold — folded tent (hand-derivable via law of cosines)', () => {
  it('two congruent triangles sharing a fold edge unfold flat on OPPOSITE sides of that edge', () => {
    // Fold edge v0=(0,0,0) -> v1=(0,0,1), length 1. Apex v2 in the x<0 half
    // plane (triangle A), apex v3 in the y<0 half plane (triangle B),
    // BOTH at distance sqrt(1.25) from both v0 and v1 (congruent triangles).
    const v0: [number, number, number] = [0, 0, 0];
    const v1: [number, number, number] = [0, 0, 1];
    const v2: [number, number, number] = [-1, 0, 0.5];
    const v3: [number, number, number] = [0, -1, 0.5];
    const m = mesh([v0, v1, v2, v3], [0, 1, 2, 1, 0, 3]);
    const result = sequentialUnfold(m, [0, 1]);

    const [p0, p1, p2] = result.face2D[0]!;
    expect(p0).toEqual({ x: 0, y: 0 });
    expect(p1.x).toBeCloseTo(1, 12);
    expect(p1.y).toBeCloseTo(0, 12);
    expect(p2.x).toBeCloseTo(0.5, 10);
    expect(p2.y).toBeCloseTo(1, 10);

    const [q1, q0, q3] = result.face2D[1]!;
    expect(q1.x).toBeCloseTo(1, 12);
    expect(q1.y).toBeCloseTo(0, 12);
    expect(q0.x).toBeCloseTo(0, 12);
    expect(q0.y).toBeCloseTo(0, 12);
    // Congruent triangle, folded — unfolds to the MIRROR position across the
    // shared edge (y flips sign), not the same side as face0's apex.
    expect(q3.x).toBeCloseTo(0.5, 10);
    expect(q3.y).toBeCloseTo(-1, 10);
  });
});
