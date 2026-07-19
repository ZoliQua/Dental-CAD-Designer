// packages/kernel/src/curvature/normals.test.ts
//
// Unit tests for normals.ts's `computeVertexNormals` — used ONLY to fix
// mean curvature's sign (curvature.ts), so these tests check DIRECTION
// (unit length, correct sign/axis on simple analytic shapes), not any
// curvature-specific behavior.
import { describe, expect, it } from 'vitest';
import { buildHalfedge } from '../halfedge/build.ts';
import { icosphereMesh, openGridPatchMesh, octahedronMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { computeVertexNormals } from './normals.ts';

describe('computeVertexNormals', () => {
  it('a flat patch (all triangles coplanar, CCW-from-+Z) gets unit +Z everywhere', () => {
    const mesh = openGridPatchMesh(3, 3); // lies in the z=0 plane, CCW winding
    const hm = buildHalfedge(mesh);
    const normals = computeVertexNormals(hm, mesh);
    for (let v = 0; v < hm.vertexCount; v++) {
      expect(normals[v * 3]!).toBeCloseTo(0, 10);
      expect(normals[v * 3 + 1]!).toBeCloseTo(0, 10);
      expect(normals[v * 3 + 2]!).toBeCloseTo(1, 10);
    }
  });

  it('octahedron vertices get the exact axis-aligned outward normal', () => {
    // octahedronMesh(radius): vertex 0 is (radius,0,0) — by symmetry, its
    // 4 incident face normals average to exactly +X.
    const mesh = octahedronMesh(2);
    const hm = buildHalfedge(mesh);
    const normals = computeVertexNormals(hm, mesh);
    expect(normals[0]!).toBeCloseTo(1, 10);
    expect(normals[1]!).toBeCloseTo(0, 10);
    expect(normals[2]!).toBeCloseTo(0, 10);
  });

  it('every normal on a sphere is unit length and points radially outward', () => {
    const radius = 5;
    const mesh = icosphereMesh(radius, 2);
    const hm = buildHalfedge(mesh);
    const normals = computeVertexNormals(hm, mesh);
    for (let v = 0; v < hm.vertexCount; v++) {
      const nx = normals[v * 3]!;
      const ny = normals[v * 3 + 1]!;
      const nz = normals[v * 3 + 2]!;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 10);
      const px = mesh.positions[v * 3]!;
      const py = mesh.positions[v * 3 + 1]!;
      const pz = mesh.positions[v * 3 + 2]!;
      const radial = Math.hypot(px, py, pz);
      const dot = (nx * px + ny * py + nz * pz) / radial;
      expect(dot).toBeGreaterThan(0.99); // near-perfectly radial on a fine sphere tessellation
    }
  });
});
