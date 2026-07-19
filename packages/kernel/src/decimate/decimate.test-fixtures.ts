// packages/kernel/src/decimate/decimate.test-fixtures.ts
//
// TEST-ONLY mesh fixtures for the decimate/ test suite (not exported from
// packages/kernel/src/index.ts) — mirrors halfedge/halfedge.test-fixtures.ts's
// convention. `icosphereMesh`/`openGridPatchMesh` (this task's analytic/
// boundary-preservation tests) are reused directly from that sibling file,
// same cross-submodule import precedent curvature.test-fixtures.ts and
// repair/fillSmallHoles.test.ts already establish.
//
// This file adds the ONE fixture no existing generator provides: a small,
// CLOSED, manifold mesh where collapsing a specific edge — despite every
// individual edge having degree <= 2 everywhere (so `buildHalfedge` accepts
// the mesh outright) — would PINCH the surface into a non-manifold result.
// This is exactly the shape decimate.ts's "link condition" (linkCondition.ts)
// exists to reject; see this task's guardrail: "test with a fixture where
// naive (link-condition-free) collapse would pinch."
import type { IndexedMesh } from '../mesh/types.ts';

type Vec3 = readonly [number, number, number];

function meshFromLists(
  positions: readonly Vec3[],
  triangles: readonly (readonly [number, number, number])[],
): IndexedMesh {
  const flatPositions = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => flatPositions.set(p, i * 3));
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  return { positions: flatPositions, indices };
}

/**
 * A tetrahedron `A,B,C,D` whose base face `BCD` has been subdivided into a
 * 3-triangle fan through a new center vertex `M` (so `B` and `D`, and `C`
 * and `D`, are each ALSO directly connected via an edge — `BD`/`CD` — that
 * does not pass through any triangle containing edge `BC`). 5 vertices, 6
 * triangles, closed/watertight, every edge degree exactly 2 with consistent
 * (opposite-direction) winding across each edge's two triangles — i.e. a
 * perfectly valid `buildHalfedge` input, no non-manifold EDGE anywhere.
 *
 * Collapsing edge `(B, C)` (apex triangles `ABC`/`apex A` and `MCB`/`apex
 * M`, so `link(edge BC) = {A, M}`) would nonetheless PINCH the mesh: `D` is
 * an extra common neighbor of both `B` (via edge `BD`, triangles
 * `ADB`/`MBD`) and `C` (via edge `CD`, triangles `ACD`/`MDC`) that is NOT
 * one of `(B,C)`'s own apex vertices — so `link(B) ∩ link(C) = {A, D, M} !=
 * {A, M} = link(edge BC)`, the link condition's defining failure case (see
 * linkCondition.ts's module doc). Merging `B` and `C` would give `D` two
 * edges to the same (merged) vertex — a non-manifold double edge.
 *
 * Exact winding verified by hand (see this task's own working notes / PR
 * description) and re-verified by every test that calls `buildHalfedge` on
 * this fixture — a winding mistake would surface immediately as a thrown
 * `NonManifoldEdgeError`, not a silently-wrong test.
 */
export function pinchFixtureMesh(): IndexedMesh {
  const A: Vec3 = [0, 0, 2];
  const B: Vec3 = [1, 0, 0];
  const C: Vec3 = [-0.5, 0.8660254037844386, 0];
  const D: Vec3 = [-0.5, -0.8660254037844386, 0];
  const M: Vec3 = [0, 0, -0.6];
  const positions = [A, B, C, D, M] as const;
  const [a, b, c, d, m] = [0, 1, 2, 3, 4] as const;
  const triangles: [number, number, number][] = [
    [a, b, c], // ABC
    [a, c, d], // ACD
    [a, d, b], // ADB
    [m, b, d], // MBD
    [m, d, c], // MDC
    [m, c, b], // MCB
  ];
  return meshFromLists(positions, triangles);
}
