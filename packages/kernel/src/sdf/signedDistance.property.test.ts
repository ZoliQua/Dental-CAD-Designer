// packages/kernel/src/sdf/signedDistance.property.test.ts
//
// Property-based tests (fast-check) for `signedClosestPoint`'s SIGN, per
// this task's brief: "pseudonormal property test vs brute force (seeded
// random watertight meshes ... queries BIASED to edge/vertex proximity —
// the whole point of pseudonormals)".
//
// Two complementary checks:
//
// 1. A brute-force, ray-parity "inside mesh" oracle (cast a ray from the
//    query point in a FIXED, generic direction; odd triangle-crossing count
//    = inside) — a classical, well-established point-in-solid test that is
//    COMPLETELY INDEPENDENT of the pseudonormal-classification method this
//    module implements (no face/edge/vertex normal lookup at all), checked
//    against `signedClosestPoint`'s sign for RANDOM query points across
//    several watertight fixtures (reusing halfedge/halfedge.test-fixtures.ts's
//    seeded manifold-mesh generators, per this task's brief).
// 2. EXPLICITLY CONSTRUCTED queries whose closest feature is provably a
//    VERTEX or an EDGE (not left to chance — per this task's guardrail:
//    "construct them, don't hope random sampling hits them"), built by
//    perturbing a known vertex/edge position a tiny distance along its own
//    precomputed pseudonormal. For a CONVEX fixture (octahedron, cube,
//    icosahedron — NOT the torus, which is not convex), convexity
//    guarantees the perturbed point's true closest surface feature remains
//    that same vertex/edge for small enough perturbations, so this is a
//    provable construction, not a hopeful one — verified by asserting
//    `classifyBarycentricFeature` on the actual result.
//
// `tetrahedronMesh` (halfedge/halfedge.test-fixtures.ts) is deliberately NOT
// used here: this file's FIXTURES array intentionally sticks to the four
// shapes already covering the convex-vs-non-convex split (octahedron, cube,
// icosahedron: convex; torus: non-convex) — the tetrahedron would only
// duplicate the convex case. Historical note: this fixture's winding used to
// be CW-from-outside despite its doc comment claiming otherwise (a pre-
// existing bug, fixed in this task's Fix batch — see halfedge/
// halfedge.test-fixtures.ts's updated `tetrahedronMesh` doc and
// sdf/pseudonormals.test.ts's dedicated regression test for it); that bug is
// unrelated to why it's absent from FIXTURES here. Every fixture used below
// was verified (this task's report) to have POSITIVE signed volume, i.e.
// genuinely CCW-from-outside, which `signedClosestPoint`'s sign convention
// requires.
//
// Seeded (not fast-check's auto-random seed) — same convention as
// bvh.property.test.ts / curvature.property.test.ts.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import { rayTriangleIntersect } from '../bvh/geometry.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { cubeMesh, icosahedronMesh, octahedronMesh, torusMesh } from '../halfedge/halfedge.test-fixtures.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { computePseudonormals, type Pseudonormals } from './pseudonormals.ts';
import { classifyBarycentricFeature, signedClosestPoint } from './signedDistance.ts';

const PROPERTY_SEED = 20260712;
const NUM_RUNS = 200;

// Fixed, deliberately non-axis-aligned, non-symmetric ray direction — chosen
// to avoid grazing shared edges/vertices of the (highly symmetric) synthetic
// fixtures below, which would break the ray-parity oracle's odd/even
// counting (see bvh/geometry.ts's BARYCENTRIC_EPSILON doc: a ray landing
// EXACTLY on a shared edge is reported as a hit by both incident triangles).
const RAY_DIR: Vec3 = normalize([0.5136382745, 0.3719284561, 0.7738201943]);

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function triangleVerts(mesh: IndexedMesh, t: number): [Vec3, Vec3, Vec3] {
  const i0 = mesh.indices[t * 3]!;
  const i1 = mesh.indices[t * 3 + 1]!;
  const i2 = mesh.indices[t * 3 + 2]!;
  const p = mesh.positions;
  return [
    [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!],
    [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!],
    [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!],
  ];
}

/** Brute-force, ray-parity "is `point` inside `mesh`" oracle — completely
 * independent of pseudonormal classification (see this file's module doc).
 * `mesh` must be watertight (a closed surface — every fixture here is). */
function rayParityInside(mesh: IndexedMesh, point: Vec3): boolean {
  const triangleCount = mesh.indices.length / 3;
  let crossings = 0;
  for (let t = 0; t < triangleCount; t++) {
    const [a, b, c] = triangleVerts(mesh, t);
    const hit = rayTriangleIntersect(point, RAY_DIR, a, b, c);
    if (hit && hit.t > 1e-9) crossings++;
  }
  return crossings % 2 === 1;
}

function meshRadius(mesh: IndexedMesh): number {
  let maxR = 0;
  const n = mesh.positions.length / 3;
  for (let v = 0; v < n; v++) {
    const r = Math.hypot(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!);
    if (r > maxR) maxR = r;
  }
  return maxR;
}

interface Fixture {
  name: string;
  mesh: IndexedMesh;
  convex: boolean;
}

const FIXTURES: Fixture[] = [
  { name: 'octahedron', mesh: octahedronMesh(2), convex: true },
  { name: 'cube', mesh: cubeMesh(1.5), convex: true },
  { name: 'icosahedron', mesh: icosahedronMesh(2), convex: true },
  { name: 'torus', mesh: torusMesh(3, 1, 10, 6), convex: false },
];

describe('signedClosestPoint — sign vs brute-force ray-parity oracle (random queries)', () => {
  for (const { name, mesh } of FIXTURES) {
    const bvh = buildBvh(mesh);
    const pn = computePseudonormals(mesh);
    const radius = meshRadius(mesh) * 1.8;
    const coord = fc.double({ min: -radius, max: radius, noNaN: true, noDefaultInfinity: true });

    it(`${name}: sign matches ray-parity oracle (points not exactly on the surface)`, () => {
      fc.assert(
        fc.property(coord, coord, coord, (x, y, z) => {
          const p: Vec3 = [x, y, z];
          const result = signedClosestPoint(mesh, bvh, pn, p);
          if (result.distance < 1e-6) return; // on/at-the-surface ties: sign is ~0, not meaningfully "inside"/"outside".
          const inside = rayParityInside(mesh, p);
          const actualInside = result.signedDistance < 0;
          expect(actualInside).toBe(inside);
        }),
        { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
      );
    });
  }
});

/**
 * Perturbs `base` OUTWARD by `eps` along `normal` (`base`'s own precomputed
 * pseudonormal) and asserts (a) the closest-feature classification is what
 * the caller expects (`vertex` or `edge` — the "construct them, don't hope
 * random sampling hits them" part of this task's guardrail) and (b) the sign
 * matches the independent ray-parity oracle (must be OUTSIDE).
 *
 * Only the OUTWARD direction is used for the feature-kind assertion: for a
 * CONVEX vertex/edge, moving epsilon along its own outward pseudonormal
 * provably keeps that SAME feature nearest (the outward pseudonormal, by
 * construction, lies within the feature's outward normal cone). The
 * opposite (inward) direction does NOT have this property — moving from a
 * convex vertex straight inward lands measurably CLOSER to an adjacent FACE
 * than to the vertex itself (a convex corner's interior "corridor" narrows
 * faster along the diagonal than perpendicular to each adjacent face — e.g.
 * for a cube corner at (1,1,1), moving inward by eps along (1,1,1)/sqrt(3)
 * lands eps/sqrt(3) from each adjacent face's plane but eps from the vertex,
 * so the face wins). Inward-direction sign coverage instead comes from
 * `checkInwardSignOnly` below (no feature-kind assertion) plus the
 * random-query ray-parity property test above.
 */
function checkOutwardBiasedFeature(
  mesh: IndexedMesh,
  bvh: ReturnType<typeof buildBvh>,
  pn: Pseudonormals,
  base: Vec3,
  normal: Vec3,
  eps: number,
  expectedKinds: readonly ('vertex' | 'edge')[],
): void {
  const p: Vec3 = [base[0] + normal[0] * eps, base[1] + normal[1] * eps, base[2] + normal[2] * eps];
  const result = signedClosestPoint(mesh, bvh, pn, p);
  const feature = classifyBarycentricFeature(result.barycentric);
  expect(expectedKinds).toContain(feature.kind);
  const inside = rayParityInside(mesh, p);
  expect(inside).toBe(false); // outward perturbation from a convex feature must be outside.
  expect(result.signedDistance).toBeGreaterThan(0);
}

/** Perturbs `base` INWARD by `eps` along `normal` (see
 * `checkOutwardBiasedFeature`'s doc for why the closest feature is NOT
 * asserted here) and checks only that the sign is INSIDE, per the
 * independent ray-parity oracle. */
function checkInwardSignOnly(
  mesh: IndexedMesh,
  bvh: ReturnType<typeof buildBvh>,
  pn: Pseudonormals,
  base: Vec3,
  normal: Vec3,
  eps: number,
): void {
  const p: Vec3 = [base[0] - normal[0] * eps, base[1] - normal[1] * eps, base[2] - normal[2] * eps];
  const result = signedClosestPoint(mesh, bvh, pn, p);
  const inside = rayParityInside(mesh, p);
  expect(inside).toBe(true);
  expect(result.signedDistance).toBeLessThan(0);
}

describe('signedClosestPoint — explicitly constructed vertex/edge-closest queries (convex fixtures)', () => {
  const EPS = 1e-4;

  for (const { name, mesh, convex } of FIXTURES) {
    if (!convex) continue; // torus: perturbing along a vertex/edge normal is not guaranteed to keep that feature closest (non-convex).
    const bvh = buildBvh(mesh);
    const pn = computePseudonormals(mesh);
    const hm = buildHalfedge(mesh);

    it(`${name}: every vertex, perturbed eps outward along its own pseudonormal, is a vertex/edge-classified, outside, correct-sign query (inward: sign-only)`, () => {
      const vertexCount = mesh.positions.length / 3;
      for (let v = 0; v < vertexCount; v++) {
        const base: Vec3 = [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
        const normal: Vec3 = [pn.vertexNormals[v * 3]!, pn.vertexNormals[v * 3 + 1]!, pn.vertexNormals[v * 3 + 2]!];
        if (Math.hypot(normal[0], normal[1], normal[2]) === 0) continue; // degenerate (defense in depth only — not expected on these fixtures).
        checkOutwardBiasedFeature(mesh, bvh, pn, base, normal, EPS, ['vertex', 'edge']);
        checkInwardSignOnly(mesh, bvh, pn, base, normal, EPS);
      }
    });

    it(`${name}: every edge midpoint, perturbed eps outward along its own edge pseudonormal, is an edge/vertex-classified, outside, correct-sign query (inward: sign-only)`, () => {
      for (let he = 0; he < hm.halfedgeCount; he++) {
        const twin = hm.twin[he]!;
        if (twin !== -1 && he > twin) continue; // visit each undirected edge once.
        const vFrom = hm.vertex[he]!;
        const vTo = hm.vertex[hm.next[he]!]!;
        const p0: Vec3 = [mesh.positions[vFrom * 3]!, mesh.positions[vFrom * 3 + 1]!, mesh.positions[vFrom * 3 + 2]!];
        const p1: Vec3 = [mesh.positions[vTo * 3]!, mesh.positions[vTo * 3 + 1]!, mesh.positions[vTo * 3 + 2]!];
        const mid: Vec3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
        const normal: Vec3 = [pn.edgeNormals[he * 3]!, pn.edgeNormals[he * 3 + 1]!, pn.edgeNormals[he * 3 + 2]!];
        if (Math.hypot(normal[0], normal[1], normal[2]) === 0) continue;
        checkOutwardBiasedFeature(mesh, bvh, pn, mid, normal, EPS, ['edge', 'vertex']);
        checkInwardSignOnly(mesh, bvh, pn, mid, normal, EPS);
      }
    });
  }
});

describe('signedClosestPoint — determinism', () => {
  function hashResult(x: number, y: number, z: number, signedDistance: number, triangleIndex: number): string {
    const hash = createHash('sha256');
    hash.update(`${x},${y},${z},${signedDistance},${triangleIndex}`);
    return hash.digest('hex');
  }

  it('repeated identical queries against the same precomputed pseudonormals return byte-identical results', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXTURES.map((f) => f.mesh)),
        fc.double({ min: -6, max: 6, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -6, max: 6, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -6, max: 6, noNaN: true, noDefaultInfinity: true }),
        (mesh, x, y, z) => {
          const bvh = buildBvh(mesh);
          const pn = computePseudonormals(mesh);
          const p: Vec3 = [x, y, z];
          const first = signedClosestPoint(mesh, bvh, pn, p);
          const second = signedClosestPoint(mesh, bvh, pn, p);
          expect(second).toEqual(first);
          const h1 = hashResult(p[0], p[1], p[2], first.signedDistance, first.triangleIndex);
          const h2 = hashResult(p[0], p[1], p[2], second.signedDistance, second.triangleIndex);
          expect(h2).toBe(h1);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it('computePseudonormals is deterministic (same mesh -> byte-identical arrays)', () => {
    for (const { mesh } of FIXTURES) {
      const first = computePseudonormals(mesh);
      const second = computePseudonormals(mesh);
      expect(Array.from(second.faceNormals)).toEqual(Array.from(first.faceNormals));
      expect(Array.from(second.vertexNormals)).toEqual(Array.from(first.vertexNormals));
      expect(Array.from(second.edgeNormals)).toEqual(Array.from(first.edgeNormals));
    }
  });
});
