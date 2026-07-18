// packages/kernel/src/sdf/pseudonormals.test.ts
//
// Direct, hand-computable checks for `computePseudonormals`: known face
// normals on an axis-aligned cube, known angle-weighted vertex normals on a
// regular tetrahedron (every corner angle identical by symmetry, so the
// weighted sum reduces to an unweighted average — easy to verify by hand),
// and the `NonWatertightMeshError` rejection this task's brief requires.
// signedDistance.analytic.test.ts / signedDistance.property.test.ts cover
// the actual SIGN behavior these pseudonormals feed into.
import { describe, expect, it } from 'vitest';
import { openGridPatchMesh, tetrahedronMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { computePseudonormals, NonWatertightMeshError } from './pseudonormals.ts';

function unitCubeMesh(): IndexedMesh {
  const positions = new Float64Array(
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ].flat(),
  );
  const indices = Uint32Array.from(
    [
      [0, 2, 1],
      [0, 3, 2], // bottom (-z)
      [4, 5, 6],
      [4, 6, 7], // top (+z)
      [0, 1, 5],
      [0, 5, 4], // front (-y)
      [1, 2, 6],
      [1, 6, 5], // right (+x)
      [2, 3, 7],
      [2, 7, 6], // back (+y)
      [0, 4, 7],
      [0, 7, 3], // left (-x)
    ].flat(),
  );
  return { positions, indices };
}

describe('computePseudonormals — unit cube (axis-aligned faces)', () => {
  it('every face normal is a unit axis vector, outward-pointing', () => {
    const mesh = unitCubeMesh();
    const pn = computePseudonormals(mesh);
    expect(pn.faceCount).toBe(12);
    for (let f = 0; f < pn.faceCount; f++) {
      const n: Vec3 = [pn.faceNormals[f * 3]!, pn.faceNormals[f * 3 + 1]!, pn.faceNormals[f * 3 + 2]!];
      const len = Math.hypot(n[0], n[1], n[2]);
      expect(len).toBeCloseTo(1, 12);
      // Exactly one component should be +-1, the other two exactly 0 (axis-aligned face).
      const nonZero = n.filter((c) => Math.abs(c) > 1e-9);
      expect(nonZero.length).toBe(1);
      expect(Math.abs(nonZero[0]!)).toBeCloseTo(1, 12);
    }
  });

  it('a corner vertex pseudonormal points diagonally outward (equal-magnitude components, unit length)', () => {
    // Vertex 6 = (1,1,1): three incident faces (+x, +y, +z), each contributing
    // a 90deg corner angle (pi/2) with a face normal along a different axis —
    // by symmetry the angle-weighted sum is (pi/2, pi/2, pi/2) before
    // normalizing, i.e. direction (1,1,1)/sqrt(3).
    const mesh = unitCubeMesh();
    const pn = computePseudonormals(mesh);
    const v = 6;
    const n: Vec3 = [pn.vertexNormals[v * 3]!, pn.vertexNormals[v * 3 + 1]!, pn.vertexNormals[v * 3 + 2]!];
    const expected = 1 / Math.sqrt(3);
    expect(n[0]).toBeCloseTo(expected, 10);
    expect(n[1]).toBeCloseTo(expected, 10);
    expect(n[2]).toBeCloseTo(expected, 10);
  });

  it('an edge pseudonormal (shared by two axis-aligned faces) bisects the two face normals', () => {
    const mesh = unitCubeMesh();
    const pn = computePseudonormals(mesh);
    // Triangle 0 = (v0, v2, v1) = ((0,0,0), (1,1,0), (1,0,0)): bottom face,
    // normal (0,0,-1). Its local halfedge k=1 runs corner1 -> corner2, i.e.
    // v2 -> v1 = (1,1,0) -> (1,0,0) — the cube edge at x=1,z=0, shared with
    // triangle 6 = (v1, v2, v6), the right face (+x, normal (1,0,0)) (twin
    // halfedge: triangle 6's local k=0, v1 -> v2). Expected averaged-then-
    // normalized edge normal: (1,0,-1)/sqrt(2).
    const he = 0 * 3 + 1;
    const n: Vec3 = [pn.edgeNormals[he * 3]!, pn.edgeNormals[he * 3 + 1]!, pn.edgeNormals[he * 3 + 2]!];
    const inv = 1 / Math.sqrt(2);
    expect(n[0]).toBeCloseTo(inv, 10);
    expect(n[1]).toBeCloseTo(0, 10);
    expect(n[2]).toBeCloseTo(-inv, 10);
  });
});

describe('computePseudonormals — angle-weighted vertex normal on a regular tetrahedron', () => {
  it('tetrahedronMesh is genuinely CCW-from-outside (positive signed volume) — the fixture-winding bug this task\'s Fix batch retired', () => {
    // `tetrahedronMesh`'s doc (halfedge/halfedge.test-fixtures.ts) claims
    // "CCW-from-outside"; this used to be FALSE (signedVolumeMm3 was
    // negative — see that fixture's updated doc for the history) until this
    // task's Fix batch flipped its winding. Assert the invariant directly so
    // a future regression here fails loudly instead of silently reintroducing
    // the old bug.
    const mesh = tetrahedronMesh(2);
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.signedVolumeMm3).not.toBeNull();
    expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
  });

  it('every vertex normal is unit length and points OUTWARD, radially (parallel to, same direction as, the vertex\'s own position vector)', () => {
    // Now that `tetrahedronMesh` is confirmed genuinely CCW-from-outside
    // (previous test), the vertex pseudonormal must point in the SAME
    // direction as the vertex's own radial position vector (dot ~= +1), not
    // merely be co-linear with it (`|dot| ~= 1`, which would also accept the
    // inward-pointing case the old, mis-wound fixture silently produced).
    const mesh = tetrahedronMesh(2);
    const pn = computePseudonormals(mesh);
    expect(pn.vertexCount).toBe(4);
    for (let v = 0; v < pn.vertexCount; v++) {
      const n: Vec3 = [pn.vertexNormals[v * 3]!, pn.vertexNormals[v * 3 + 1]!, pn.vertexNormals[v * 3 + 2]!];
      const len = Math.hypot(n[0], n[1], n[2]);
      expect(len).toBeCloseTo(1, 10);
      const p: Vec3 = [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
      const pLen = Math.hypot(p[0], p[1], p[2]);
      const dot = (n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / pLen;
      expect(dot).toBeCloseTo(1, 6); // cosine(angle between n and p) ~= +1 (outward, not merely co-linear)
    }
  });
});

describe('computePseudonormals — watertight rejection', () => {
  it('throws NonWatertightMeshError for an open mesh (boundary edges)', () => {
    const mesh = openGridPatchMesh(2, 2);
    expect(() => computePseudonormals(mesh)).toThrow(NonWatertightMeshError);
  });

  it('the thrown error carries the analyzeMesh stats that triggered it', () => {
    const mesh = openGridPatchMesh(1, 1);
    try {
      computePseudonormals(mesh);
      expect.unreachable('expected NonWatertightMeshError');
    } catch (error) {
      expect(error).toBeInstanceOf(NonWatertightMeshError);
      const err = error as NonWatertightMeshError;
      expect(err.stats.watertight).toBe(false);
      expect(err.stats.boundaryEdgeCount).toBeGreaterThan(0);
    }
  });
});
