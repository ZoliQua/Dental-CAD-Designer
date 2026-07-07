// packages/kernel/src/bvh/bvh.analytic.test.ts
//
// Analytic (closed-form) BVH test cases, per this task's brief: "analytic —
// distances on the synthetic sphere (point at 2r from center -> distance r
// within 1e-9)".
//
// A triangulated sphere is only exactly distance-r from its center AT its
// vertices — everywhere else on a real triangle mesh the surface is a chord
// strictly inside the true sphere, so testing "distance == r" to 1e-9
// against an arbitrary point on a fine sphere mesh would really be testing
// mesh-discretization error, not this module's arithmetic. Instead this
// picks a point along the exact ray from the origin through one mesh
// VERTEX, extended beyond it by another `r` — i.e. literally the brief's
// "point at 2r from center" for a vertex on a radius-r sphere.
//
// This is provably exact, not just "close for a fine-enough mesh": for a
// convex polytope inscribed in a sphere of radius r (every vertex exactly
// on the sphere) and a vertex V on it, V uniquely MAXIMIZES the dot product
// with direction V/|V| over every point of the polytope (Cauchy-Schwarz:
// X . V <= |X||V| = r^2 for any X on the sphere, equality iff X = V; the
// same bound then extends to every convex combination of vertices, i.e. the
// whole solid hull, hence its boundary too). Consequently, for any point
// P = V + t*(V/|V|), t > 0, V is the UNIQUE closest point on the polytope's
// entire surface to P (see the algebraic expansion in this file's git
// history / PR description for the full derivation) — this is an exact
// geometric fact, not a numerical approximation, so the octahedron below
// (the simplest such polytope: 6 vertices exactly on the sphere, 8 faces)
// is sufficient; a denser sphere mesh would prove nothing extra about
// THIS module's correctness.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from './build.ts';
import { closestPoint } from './closestPoint.ts';
import { raycast } from './raycast.ts';
import type { Vec3 } from './geometry.ts';

const RADIUS_MM = 5;

/** Axis-aligned octahedron of radius `RADIUS_MM` — 6 vertices exactly on the
 * sphere, 8 triangular faces (one per octant). Winding is not
 * outward-consistent (irrelevant here: neither closestPoint nor raycast in
 * this package back-face-culls — see geometry.ts's rayTriangleIntersect
 * doc), just fixed and known so face indices are addressable by octant
 * sign. */
function octahedronMesh(): { mesh: IndexedMesh; faceIndex: (sx: 1 | -1, sy: 1 | -1, sz: 1 | -1) => number } {
  const positions = new Float64Array([
    RADIUS_MM, 0, 0, // 0: +x
    -RADIUS_MM, 0, 0, // 1: -x
    0, RADIUS_MM, 0, // 2: +y
    0, -RADIUS_MM, 0, // 3: -y
    0, 0, RADIUS_MM, // 4: +z
    0, 0, -RADIUS_MM, // 5: -z
  ]);

  const octants: ReadonlyArray<[1 | -1, 1 | -1, 1 | -1]> = [
    [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
    [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
  ];
  const indices = new Uint32Array(octants.length * 3);
  const faceOf = new Map<string, number>();
  octants.forEach(([sx, sy, sz], face) => {
    const xVert = sx === 1 ? 0 : 1;
    const yVert = sy === 1 ? 2 : 3;
    const zVert = sz === 1 ? 4 : 5;
    indices[face * 3] = xVert;
    indices[face * 3 + 1] = yVert;
    indices[face * 3 + 2] = zVert;
    faceOf.set(`${sx},${sy},${sz}`, face);
  });

  return {
    mesh: { positions, indices },
    faceIndex: (sx, sy, sz) => faceOf.get(`${sx},${sy},${sz}`)!,
  };
}

describe('closestPoint — analytic sphere (octahedron), point at 2r from center', () => {
  it('finds the pole vertex exactly, distance r, for every one of the 6 vertices', () => {
    const { mesh } = octahedronMesh();
    const bvh = buildBvh(mesh);
    const vertexCount = mesh.positions.length / 3;

    for (let v = 0; v < vertexCount; v++) {
      const vertex: Vec3 = [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
      const length = Math.hypot(vertex[0], vertex[1], vertex[2]);
      expect(length).toBeCloseTo(RADIUS_MM, 12); // sanity: this really is a radius-r vertex

      const direction: Vec3 = [vertex[0] / length, vertex[1] / length, vertex[2] / length];
      const queryPoint: Vec3 = [
        vertex[0] + direction[0] * RADIUS_MM,
        vertex[1] + direction[1] * RADIUS_MM,
        vertex[2] + direction[2] * RADIUS_MM,
      ]; // == 2 * vertex == distance 2r from the origin/center

      const result = closestPoint(mesh, bvh, queryPoint);
      expect(Math.abs(result.distance - RADIUS_MM)).toBeLessThanOrEqual(1e-9);
      expect(result.point[0]).toBeCloseTo(vertex[0], 9);
      expect(result.point[1]).toBeCloseTo(vertex[1], 9);
      expect(result.point[2]).toBeCloseTo(vertex[2], 9);
    }
  });
});

describe('raycast — exact plane intersection at a face centroid', () => {
  it('hits the (+x,+y,+z) face exactly at its centroid, at the expected distance', () => {
    const { mesh, faceIndex } = octahedronMesh();
    const bvh = buildBvh(mesh);
    const expectedFace = faceIndex(1, 1, 1);

    // Face (+x,+y,+z) has vertices (r,0,0),(0,r,0),(0,0,r), lying on the
    // plane x+y+z=r with outward unit normal n=(1,1,1)/sqrt(3); its
    // centroid is (r/3,r/3,r/3) by definition. A ray FROM `centroid + D*n`
    // pointed straight back along `-n` reaches the plane — and therefore
    // the triangle, since a triangle's centroid is always inside it —
    // exactly at the centroid, after traveling exactly distance `D`: this
    // is elementary analytic geometry, not an approximation.
    const inv_sqrt3 = 1 / Math.sqrt(3);
    const n: Vec3 = [inv_sqrt3, inv_sqrt3, inv_sqrt3];
    const centroid: Vec3 = [RADIUS_MM / 3, RADIUS_MM / 3, RADIUS_MM / 3];
    const D = 12; // arbitrary distance strictly outside the mesh (bbox radius is RADIUS_MM)

    const origin: Vec3 = [centroid[0] + n[0] * D, centroid[1] + n[1] * D, centroid[2] + n[2] * D];
    const direction: Vec3 = [-n[0], -n[1], -n[2]];

    const hit = raycast(mesh, bvh, origin, direction);
    expect(hit).not.toBeNull();
    expect(hit!.triangleIndex).toBe(expectedFace);
    expect(Math.abs(hit!.distance - D)).toBeLessThanOrEqual(1e-9);
    expect(hit!.point[0]).toBeCloseTo(centroid[0], 9);
    expect(hit!.point[1]).toBeCloseTo(centroid[1], 9);
    expect(hit!.point[2]).toBeCloseTo(centroid[2], 9);
  });

  it('misses entirely when aimed away from the mesh', () => {
    const { mesh } = octahedronMesh();
    const bvh = buildBvh(mesh);
    const hit = raycast(mesh, bvh, [100, 100, 100], [1, 0, 0]);
    expect(hit).toBeNull();
  });
});
