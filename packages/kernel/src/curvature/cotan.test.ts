// packages/kernel/src/curvature/cotan.test.ts
//
// Unit tests for cotan.ts: `cotangentAtVertex` against known closed-form
// angles, and `computeCotanWeights`' boundary/interior/symmetry behavior —
// this is the function Task 11's thin-plate solve will reuse (see cotan.ts's
// module doc), so it gets its own dedicated, separately-verifiable test file
// per this task's brief ("export as a documented, separately-testable
// function").
import { describe, expect, it } from 'vitest';
import { buildHalfedge } from '../halfedge/build.ts';
import { octahedronMesh, openGridPatchMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { cotangentAtVertex, cotangentOpposite, computeCotanWeights } from './cotan.ts';

describe('cotangentAtVertex', () => {
  it('is 0 for a right angle (cot(90deg) = 0)', () => {
    // p=(0,0,0), q=(1,0,0), r=(0,1,0): angle q-p-r is exactly 90deg.
    expect(cotangentAtVertex([0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 12);
  });

  it('is 1 for a 45deg angle', () => {
    // p=(0,0,0), q=(1,0,0), r=(1,1,0): angle q-p-r is 45deg, cot(45deg) = 1.
    expect(cotangentAtVertex([0, 0, 0], [1, 0, 0], [1, 1, 0])).toBeCloseTo(1, 12);
  });

  it('is 1/sqrt(3) for a 60deg angle (equilateral triangle corner)', () => {
    const p: [number, number, number] = [0, 0, 0];
    const q: [number, number, number] = [1, 0, 0];
    const r: [number, number, number] = [0.5, Math.sqrt(3) / 2, 0];
    expect(cotangentAtVertex(p, q, r)).toBeCloseTo(1 / Math.sqrt(3), 12);
  });

  it('is negative for an obtuse angle (120deg)', () => {
    const p: [number, number, number] = [0, 0, 0];
    const q: [number, number, number] = [1, 0, 0];
    const r: [number, number, number] = [-0.5, Math.sqrt(3) / 2, 0];
    expect(cotangentAtVertex(p, q, r)).toBeCloseTo(-1 / Math.sqrt(3), 12);
  });

  it('degenerates to 0 (not NaN/Infinity) for a zero-area (collinear) triangle', () => {
    expect(cotangentAtVertex([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBe(0);
    expect(cotangentAtVertex([0, 0, 0], [1, 0, 0], [1, 0, 0])).toBe(0); // repeated vertex
  });
});

describe('cotangentOpposite', () => {
  it('reads the correct opposite-corner angle off a HalfedgeMesh', () => {
    // A single right triangle (0,0,0)-(1,0,0)-(0,1,0): the right angle is
    // at vertex 0 (edges to vertex1=(1,0,0) and vertex2=(0,1,0) are
    // perpendicular). Halfedge 1 (this fixed-grouping face's 2nd corner)
    // goes 1->2, whose opposite corner is vertex 0 — so
    // cotangentOpposite(he=1) must be 0. (Halfedge 0, by contrast, goes
    // 0->1 with opposite corner vertex2, a 45deg angle — cot(45deg) = 1,
    // not 0.)
    const mesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const hm = buildHalfedge(mesh);
    expect(cotangentOpposite(hm, mesh, 1)).toBeCloseTo(0, 12);
    expect(cotangentOpposite(hm, mesh, 0)).toBeCloseTo(1, 12);
  });
});

describe('computeCotanWeights', () => {
  it('a boundary edge gets exactly its single triangle-side cotangent (halved)', () => {
    // openGridPatchMesh(1,1): a single quad (2 triangles), every edge is a
    // boundary edge except the shared diagonal.
    const mesh = openGridPatchMesh(1, 1);
    const hm = buildHalfedge(mesh);
    const weights = computeCotanWeights(hm, mesh);
    for (let he = 0; he < hm.halfedgeCount; he++) {
      if (hm.twin[he] !== -1) continue;
      const expected = 0.5 * cotangentOpposite(hm, mesh, he);
      expect(weights[he]).toBeCloseTo(expected, 12);
    }
  });

  it('is symmetric: weights[he] === weights[twin[he]] for every interior edge', () => {
    const mesh = octahedronMesh(1);
    const hm = buildHalfedge(mesh);
    const weights = computeCotanWeights(hm, mesh);
    for (let he = 0; he < hm.halfedgeCount; he++) {
      const twin = hm.twin[he]!;
      if (twin === -1) continue;
      expect(weights[he]).toBe(weights[twin]!);
    }
  });

  it('an interior edge weight equals the average of both sides’ opposite cotangents', () => {
    const mesh = octahedronMesh(1);
    const hm = buildHalfedge(mesh);
    const weights = computeCotanWeights(hm, mesh);
    for (let he = 0; he < hm.halfedgeCount; he++) {
      const twin = hm.twin[he]!;
      if (twin === -1) continue;
      const expected = 0.5 * (cotangentOpposite(hm, mesh, he) + cotangentOpposite(hm, mesh, twin));
      expect(weights[he]).toBeCloseTo(expected, 12);
    }
  });
});
