// packages/kernel/src/bvh/bvh.property.test.ts
//
// Property-based tests (fast-check) per this task's brief: "BVH property
// tests vs brute force (fast-check, random small meshes: closestPoint/
// raycast equal brute-force within 1e-12)". The "brute force" oracle here
// scans every triangle directly with the same underlying primitives
// (closestPointOnTriangle / rayTriangleIntersect) the BVH traversal itself
// calls at each leaf, applying the identical deterministic tie-break rule
// (lowest triangle index wins on an exact distance/`t` tie) — this isolates
// what the property is actually meant to prove: that `buildBvh` +
// `closestPoint`/`raycast`'s branch-and-bound PRUNING never discards the
// true global answer, not a re-implementation of the geometry itself.
//
// Seeded explicitly (not fast-check's auto-random seed) — see
// packages/kernel/src/intake/weld.property.test.ts's identical rationale
// (docs/plans/phase-1-import-viewer.md's determinism constraint / CI
// reproducibility).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from './build.ts';
import { closestPoint } from './closestPoint.ts';
import { closestPointOnTriangle, distanceSquared, rayTriangleIntersect, type Vec3 } from './geometry.ts';
import { raycast } from './raycast.ts';

const PROPERTY_SEED = 20260712;
const NUM_RUNS = 300;

// `fc.double({min,max})` samples across every representable double in
// range, INCLUDING subnormal-magnitude values (down to ~5e-324) astronomically
// smaller than the ~20-unit scale of the rest of the coordinate — not a
// realistic input for mm-scale dental geometry (nothing in this kernel's
// domain mixes a ~20mm coordinate with a ~1e-300mm one in the same point),
// and at that scale two independently-valid floating-point formulations
// (Möller-Trumbore's determinant solve vs. the AABB slab test's per-axis
// arithmetic) can legitimately disagree by less than the smallest
// representable double itself — not a correctness bug in either, just two
// different roundings of "so close to the boundary it doesn't matter".
// Snapping anything below this threshold to exactly 0 keeps the generator's
// intent (small/zero values ARE worth testing — e.g. the analytic tests
// exercise exact-zero coordinates) while staying in the realistic magnitude
// band this BVH is actually built to handle.
const MIN_MEANINGFUL_MAGNITUDE = 1e-9;
const coord = fc
  .double({ min: -20, max: 20, noNaN: true, noDefaultInfinity: true })
  .map((v) => (Math.abs(v) < MIN_MEANINGFUL_MAGNITUDE ? 0 : v));
const vec3 = fc.tuple(coord, coord, coord) as fc.Arbitrary<Vec3>;
/** A "triangle" here is 9 flat coordinates (3 vertices) — no constraint that
 * it's non-degenerate: closestPointOnTriangle/rayTriangleIntersect must both
 * behave sanely (not NaN/throw) on degenerate input too (see geometry.ts's
 * module doc), so leaving degenerate triangles in the generator is
 * deliberate, not an oversight. */
const triangleArb = fc.tuple(coord, coord, coord, coord, coord, coord, coord, coord, coord);
const meshArb = fc.array(triangleArb, { minLength: 1, maxLength: 50 });

function meshFromTriangles(triangles: ReadonlyArray<readonly number[]>): IndexedMesh {
  const positions = new Float64Array(triangles.length * 9);
  triangles.forEach((triangle, t) => positions.set(triangle, t * 9));
  const indices = new Uint32Array(triangles.length * 3);
  for (let t = 0; t < triangles.length; t++) {
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
  }
  return { positions, indices };
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

function bruteClosestPoint(mesh: IndexedMesh, point: Vec3) {
  const triangleCount = mesh.indices.length / 3;
  let bestDistSq = Infinity;
  let bestIndex = -1;
  let bestPoint: Vec3 = [0, 0, 0];
  for (let t = 0; t < triangleCount; t++) {
    const [a, b, c] = triangleVerts(mesh, t);
    const { point: cp } = closestPointOnTriangle(point, a, b, c);
    const distSq = distanceSquared(point, cp);
    if (distSq < bestDistSq || (distSq === bestDistSq && t < bestIndex)) {
      bestDistSq = distSq;
      bestIndex = t;
      bestPoint = cp;
    }
  }
  return { distance: Math.sqrt(bestDistSq), triangleIndex: bestIndex, point: bestPoint };
}

function bruteRaycast(mesh: IndexedMesh, origin: Vec3, direction: Vec3) {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  const unit: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  const triangleCount = mesh.indices.length / 3;
  let bestT = Infinity;
  let bestIndex = -1;
  for (let t = 0; t < triangleCount; t++) {
    const [a, b, c] = triangleVerts(mesh, t);
    const hit = rayTriangleIntersect(origin, unit, a, b, c);
    if (!hit) continue;
    if (hit.t < bestT || (hit.t === bestT && t < bestIndex)) {
      bestT = hit.t;
      bestIndex = t;
    }
  }
  return bestIndex === -1 ? null : { distance: bestT, triangleIndex: bestIndex };
}

describe('BVH closestPoint vs brute force', () => {
  it('agrees with a brute-force scan (distance within 1e-12, exact triangle index)', () => {
    fc.assert(
      fc.property(meshArb, vec3, (triangles, point) => {
        const mesh = meshFromTriangles(triangles);
        const bvh = buildBvh(mesh);
        const expected = bruteClosestPoint(mesh, point);
        const actual = closestPoint(mesh, bvh, point);

        expect(actual.triangleIndex).toBe(expected.triangleIndex);
        expect(Math.abs(actual.distance - expected.distance)).toBeLessThanOrEqual(1e-12);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('BVH raycast vs brute force', () => {
  it('agrees with a brute-force scan (hit/miss, distance within 1e-12, exact triangle index)', () => {
    fc.assert(
      fc.property(
        meshArb,
        vec3,
        vec3.filter((d) => Math.hypot(d[0], d[1], d[2]) > 1e-6),
        (triangles, origin, direction) => {
          const mesh = meshFromTriangles(triangles);
          const bvh = buildBvh(mesh);
          const expected = bruteRaycast(mesh, origin, direction);
          const actual = raycast(mesh, bvh, origin, direction);

          if (expected === null) {
            expect(actual).toBeNull();
            return;
          }
          expect(actual).not.toBeNull();
          expect(actual!.triangleIndex).toBe(expected.triangleIndex);
          expect(Math.abs(actual!.distance - expected.distance)).toBeLessThanOrEqual(1e-12);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('BVH determinism', () => {
  it('building the same mesh twice produces byte-identical BVH structure', () => {
    fc.assert(
      fc.property(meshArb, (triangles) => {
        const mesh = meshFromTriangles(triangles);
        const first = buildBvh(mesh);
        const second = buildBvh(mesh);

        expect(Array.from(second.triangleIndices)).toEqual(Array.from(first.triangleIndices));
        expect(Array.from(second.nodeLeft)).toEqual(Array.from(first.nodeLeft));
        expect(Array.from(second.nodeRight)).toEqual(Array.from(first.nodeRight));
        expect(Array.from(second.nodeBoundsMin)).toEqual(Array.from(first.nodeBoundsMin));
        expect(Array.from(second.nodeBoundsMax)).toEqual(Array.from(first.nodeBoundsMax));
        expect(second.rootNode).toBe(first.rootNode);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it('repeated queries against the same BVH return identical results (no traversal-order nondeterminism)', () => {
    fc.assert(
      fc.property(meshArb, vec3, (triangles, point) => {
        const mesh = meshFromTriangles(triangles);
        const bvh = buildBvh(mesh);
        const first = closestPoint(mesh, bvh, point);
        const second = closestPoint(mesh, bvh, point);
        expect(second).toEqual(first);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});
