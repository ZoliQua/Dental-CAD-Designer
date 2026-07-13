// packages/kernel/src/curvature/curvature.test-fixtures.ts
//
// TEST-ONLY mesh fixtures for the curvature/ test suite — mirrors
// halfedge/halfedge.test-fixtures.ts's convention (not exported from
// packages/kernel/src/index.ts). `icosphereMesh`/`torusMesh`/
// `openGridPatchMesh` are reused directly from that sibling file (same
// package — see repair/fillSmallHoles.test.ts's identical cross-submodule
// test-fixture import for established precedent) rather than duplicated;
// this file adds only the ONE analytic shape halfedge's fixtures don't
// already have: a CAPPED cylinder (halfedge's own needs never required
// caps, so its `torusMesh`/`icosphereMesh` are closed by construction, but a
// plain cylinder tube is not — curvature.analytic.test.ts needs a closed,
// watertight solid so `buildHalfedge` sees no boundary at all, while still
// being able to pick "tube region, away from the caps" vertices whose
// one-ring never touches a cap).
//
// No `Math.random`/`Date.now` anywhere below — closed-form over integer/
// float parameters, matching this project's determinism invariant.

import type { IndexedMesh } from '../mesh/types.ts';

type Vec3 = readonly [number, number, number];

function meshFromLists(positions: readonly Vec3[], triangles: readonly (readonly [number, number, number])[]): IndexedMesh {
  const flatPositions = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => flatPositions.set(p, i * 3));
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  return { positions: flatPositions, indices };
}

/**
 * A CAPPED cylinder (axis along Z, centered at the origin): `heightSegments
 * + 1` rings of `segments` vertices each (uniformly spaced along both the
 * circumference and the height), plus one center vertex per flat end cap —
 * closed and watertight (genus 0, no boundary), unlike halfedge's own
 * fixtures. CCW-from-outside winding (verified by
 * curvature.analytic.test.ts's own `analyzeMesh` watertight/positive-volume
 * self-check before any curvature assertion is trusted).
 *
 * The TUBE region — rings strictly between the two end caps, excluding the
 * cap rings themselves AND their immediate neighbor rings (whose one-ring
 * touches a cap vertex) — locally looks exactly like an INFINITE cylinder
 * (translation-invariant along Z, so every ring's local geometry is
 * identical): analytic principal curvatures there are `k1 = 1/radius`
 * (around the circumference) and `k2 = 0` (straight along the axis), so
 * `H = 1/(2*radius)`, `K = 0` — see curvature.analytic.test.ts's cylinder
 * case (this task's brief: "cylinder r=3 (capped fixture exists; test the
 * tube region away from caps)"). Requires `segments >= 3` and
 * `heightSegments >= 6` (so at least one ring sits strictly inside the
 * "away from caps" band every caller here uses, rings `2..heightSegments-2`).
 */
export function cappedCylinderMesh(radius: number, height: number, segments: number, heightSegments: number): IndexedMesh {
  const halfHeight = height / 2;
  const positions: Vec3[] = [];
  const ringIndex = (ring: number, seg: number): number => ring * segments + seg;
  for (let r = 0; r <= heightSegments; r++) {
    const z = -halfHeight + (height * r) / heightSegments;
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      positions.push([radius * Math.cos(theta), radius * Math.sin(theta), z]);
    }
  }
  const bottomCenterIndex = positions.length;
  positions.push([0, 0, -halfHeight]);
  const topCenterIndex = positions.length;
  positions.push([0, 0, halfHeight]);

  const triangles: [number, number, number][] = [];
  for (let r = 0; r < heightSegments; r++) {
    for (let s = 0; s < segments; s++) {
      const sNext = (s + 1) % segments;
      const a = ringIndex(r, s);
      const b = ringIndex(r, sNext);
      const c = ringIndex(r + 1, sNext);
      const d = ringIndex(r + 1, s);
      triangles.push([a, b, c]);
      triangles.push([a, c, d]);
    }
  }
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    triangles.push([bottomCenterIndex, ringIndex(0, sNext), ringIndex(0, s)]);
  }
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    triangles.push([topCenterIndex, ringIndex(heightSegments, s), ringIndex(heightSegments, sNext)]);
  }
  return meshFromLists(positions, triangles);
}
