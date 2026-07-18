// packages/kernel/src/halfedge/halfedge.test-fixtures.ts
//
// TEST-ONLY mesh fixtures for the halfedge/ test suite (mirrors
// repair/repair.test-fixtures.ts's / boolean/manifold.test-fixtures.ts's
// convention — not exported from packages/kernel/src/index.ts). Every
// builder here produces a mesh that is manifold BY CONSTRUCTION (no
// non-manifold edges, no bowtie vertices) so `buildHalfedge` always
// succeeds on its output — these are the "seeded manifold-mesh generator"
// this task's brief asks for (item 7: "property (build->assertValidTopology
// on random manifold meshes from a seeded generator; one-ring completeness
// vs brute-force adjacency)").
//
// No `Math.random`/`Date.now` anywhere below — every shape is closed-form
// over its integer/float PARAMETERS (subdivision count, segment counts,
// grid size), matching this project's determinism invariant (CLAUDE.md #2)
// and scripts/generate-fixtures.ts's identical convention for its
// icosphere/torus builders (duplicated here rather than imported — that
// script lives outside any package boundary packages/kernel is allowed to
// depend on; see this repo's established precedent for TEST-ONLY fixture
// duplication across package boundaries, e.g. repair.test-fixtures.ts's
// `unitCubeMesh` doc).

import type { IndexedMesh } from '../mesh/types.ts';

type Vec3 = readonly [number, number, number];

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len === 0 ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

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

/** Regular tetrahedron (4 vertices / 4 triangles), CCW-from-outside
 * (verified: `analyzeMesh(tetrahedronMesh()).signedVolumeMm3 > 0` —
 * `intake/analyze.test.ts` and `sdf/pseudonormals.test.ts` both assert this
 * directly). Genus 0, closed, every vertex valence 3.
 *
 * FIXED (this task's Fix batch, item 3b): this winding was previously CW-
 * from-outside (`signedVolumeMm3 < 0`) despite this same doc comment already
 * claiming "CCW-from-outside" — a pre-existing inaccuracy that never
 * surfaced because every consumer at the time only cared about per-edge
 * topological consistency (buildHalfedge) or unsigned quantities (mixed
 * Voronoi areas, geodesic path length), never the mesh's global winding
 * sign. `sdf/pseudonormals.test.ts` and `sdf/signedDistance.property.test.ts`
 * both carried explicit workarounds/exclusions for the old bug — see their
 * own doc comments for what changed once this was fixed. Consumers audited
 * for silent compensation when this was fixed: `sdf/pseudonormals.test.ts`
 * (updated to assert the now-correct outward sign, not just colinearity),
 * `sdf/signedDistance.property.test.ts` (stale "NOT used here" comment
 * updated to reflect the fix — the fixture is still not added to that
 * file's FIXTURES array, out of scope for this fix), `geodesic/
 * geodesicPath.test.ts`, `curvature/mixedArea.test.ts`, and `halfedge/
 * halfedge.property.test.ts` (all three winding-independent — barycentric/
 * topology/unsigned-area consumers only — no changes needed). */
export function tetrahedronMesh(radius = 1): IndexedMesh {
  const raw: Vec3[] = [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ];
  const positions = raw.map((p) => scale(normalize(p), radius));
  const triangles: [number, number, number][] = [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ];
  return meshFromLists(positions, triangles);
}

/** Unit-radius regular octahedron (6 vertices / 8 triangles), CCW-from-
 * outside. Genus 0, closed, every vertex valence 4. */
export function octahedronMesh(radius = 1): IndexedMesh {
  const positions: Vec3[] = [
    [radius, 0, 0],
    [-radius, 0, 0],
    [0, radius, 0],
    [0, -radius, 0],
    [0, 0, radius],
    [0, 0, -radius],
  ];
  const triangles: [number, number, number][] = [
    [0, 2, 4],
    [2, 1, 4],
    [1, 3, 4],
    [3, 0, 4],
    [2, 0, 5],
    [1, 2, 5],
    [3, 1, 5],
    [0, 3, 5],
  ];
  return meshFromLists(positions, triangles);
}

/** Axis-aligned unit cube (8 vertices / 12 triangles), CCW-from-outside —
 * same construction as repair/repair.test-fixtures.ts's `unitCubeMesh`,
 * duplicated (not imported — TEST-ONLY files intentionally don't share
 * across sibling test-fixture modules, matching that file's own doc).
 * Genus 0, closed, every vertex valence 3. */
export function cubeMesh(halfExtent = 0.5): IndexedMesh {
  const e = halfExtent;
  const positions: Vec3[] = [
    [-e, -e, -e],
    [e, -e, -e],
    [e, e, -e],
    [-e, e, -e],
    [-e, -e, e],
    [e, -e, e],
    [e, e, e],
    [-e, e, e],
  ];
  const triangles: [number, number, number][] = [
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
  ];
  return meshFromLists(positions, triangles);
}

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

/** Regular icosahedron (12 vertices / 20 triangles), CCW-from-outside.
 * Genus 0, closed, every vertex valence 5 — `buildIcosphere`'s base case
 * (subdivisions 0). */
export function icosahedronMesh(radius = 1): IndexedMesh {
  const raw: Vec3[] = [
    [-1, GOLDEN_RATIO, 0],
    [1, GOLDEN_RATIO, 0],
    [-1, -GOLDEN_RATIO, 0],
    [1, -GOLDEN_RATIO, 0],
    [0, -1, GOLDEN_RATIO],
    [0, 1, GOLDEN_RATIO],
    [0, -1, -GOLDEN_RATIO],
    [0, 1, -GOLDEN_RATIO],
    [GOLDEN_RATIO, 0, -1],
    [GOLDEN_RATIO, 0, 1],
    [-GOLDEN_RATIO, 0, -1],
    [-GOLDEN_RATIO, 0, 1],
  ];
  const positions = raw.map((p) => scale(normalize(p), radius));
  const triangles: [number, number, number][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  return meshFromLists(positions, triangles);
}

/** Icosphere: `icosahedronMesh` subdivided `subdivisions` times (each
 * subdivision splits every triangle into 4 by edge midpoints, projected
 * back onto the sphere) — the standard analytic-sphere tessellation this
 * project's golden fixtures use (scripts/generate-fixtures.ts's
 * `buildIcosphere`, same algorithm, duplicated per this file's top-of-file
 * doc). Genus 0, closed, all vertices valence 5 or 6. */
export function icosphereMesh(radius: number, subdivisions: number): IndexedMesh {
  let base = icosahedronMesh(1);
  for (let s = 0; s < subdivisions; s++) base = subdivideIcosphere(base);
  const positions = new Float64Array(base.positions.length);
  for (let i = 0; i < base.positions.length / 3; i++) {
    const p: Vec3 = [
      base.positions[i * 3]!,
      base.positions[i * 3 + 1]!,
      base.positions[i * 3 + 2]!,
    ];
    const scaled = scale(normalize(p), radius);
    positions.set(scaled, i * 3);
  }
  return { positions, indices: base.indices };
}

function subdivideIcosphere(mesh: IndexedMesh): IndexedMesh {
  const triangleCount = mesh.indices.length / 3;
  const vertexCount = mesh.positions.length / 3;
  const positions: number[] = Array.from(mesh.positions);
  const midpointCache = new Map<number, number>();

  function midpoint(a: number, b: number): number {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * (vertexCount + triangleCount) + hi; // injective for this local, throwaway use
    const cached = midpointCache.get(key);
    if (cached !== undefined) return cached;
    const mx = (positions[lo * 3]! + positions[hi * 3]!) / 2;
    const my = (positions[lo * 3 + 1]! + positions[hi * 3 + 1]!) / 2;
    const mz = (positions[lo * 3 + 2]! + positions[hi * 3 + 2]!) / 2;
    const newIndex = positions.length / 3;
    positions.push(mx, my, mz);
    midpointCache.set(key, newIndex);
    return newIndex;
  }

  const triangles: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const a = mesh.indices[t * 3]!;
    const b = mesh.indices[t * 3 + 1]!;
    const c = mesh.indices[t * 3 + 2]!;
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    triangles.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
  }

  return { positions: Float64Array.from(positions), indices: Uint32Array.from(triangles) };
}

/**
 * Torus (genus 1, closed): `majorSegments` rings around the major circle
 * (radius `majorRadius`), each a `minorSegments`-gon tube cross-section
 * (radius `minorRadius`) — both directions wrap (closed), so this always
 * has zero boundary. Requires `majorSegments >= 3 && minorSegments >= 3`
 * (fewer degenerates the tube/ring into a lower-dimensional shape).
 */
export function torusMesh(
  majorRadius: number,
  minorRadius: number,
  majorSegments: number,
  minorSegments: number,
): IndexedMesh {
  const positions: Vec3[] = [];
  for (let i = 0; i < majorSegments; i++) {
    const theta = (2 * Math.PI * i) / majorSegments;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    for (let j = 0; j < minorSegments; j++) {
      const phi = (2 * Math.PI * j) / minorSegments;
      const r = majorRadius + minorRadius * Math.cos(phi);
      positions.push([r * cosT, r * sinT, minorRadius * Math.sin(phi)]);
    }
  }
  const triangles: [number, number, number][] = [];
  const idx = (i: number, j: number): number =>
    (i % majorSegments) * minorSegments + (j % minorSegments);
  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < minorSegments; j++) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const c = idx(i + 1, j + 1);
      const d = idx(i, j + 1);
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  return meshFromLists(positions, triangles);
}

/**
 * A flat, OPEN rectangular grid patch (`rows x cols` quads, each split into
 * 2 triangles) — no wrap in either direction, so this always has exactly
 * one boundary loop (the outer perimeter). The standard "open patch" shape
 * this task's brief's boundary-loop test needs. Requires `rows >= 1 &&
 * cols >= 1`.
 */
export function openGridPatchMesh(rows: number, cols: number, cellSize = 1): IndexedMesh {
  const positions: Vec3[] = [];
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      positions.push([j * cellSize, i * cellSize, 0]);
    }
  }
  const idx = (i: number, j: number): number => i * (cols + 1) + j;
  const triangles: [number, number, number][] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = idx(i, j);
      const b = idx(i, j + 1);
      const c = idx(i + 1, j + 1);
      const d = idx(i + 1, j);
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  return meshFromLists(positions, triangles);
}

/**
 * An "L-bracket": an L-shaped hexagonal footprint (in the xy-plane)
 * extruded along z from `0` to `scale` — a closed, watertight, CCW-from-
 * outside prism with exactly ONE reflex (concave, interior dihedral angle
 * `270°`) vertical edge and its two reflex-adjacent vertices. Added for
 * this task's Fix batch item 1: every other closed fixture in this file
 * (tetrahedron/cube/octahedron/icosahedron/icosphere/torus — the torus is
 * non-convex in the sense of not being star-shaped from its center, but has
 * no REFLEX EDGE in the angle-weighted-pseudonormal sense: every edge of a
 * torus tessellation is still only mildly non-planar, never a true concave
 * crease) has no genuinely reflex feature to exercise pseudonormal
 * disambiguation against; this fixture exists specifically to give
 * `sdf/signedDistance.reflex.test.ts` one.
 *
 * Footprint (CCW when viewed from `+z`, vertex indices `0..5`), the
 * standard "L" shape (a `2x2` square with its `1x1` top-right quadrant
 * notched out):
 * ```
 *   5 (0,2) ---- 4 (1,2)
 *     |            |
 *     |            3 (1,1) ---- 2 (2,1)
 *     |                           |
 *   0 (0,0) ------------------- 1 (2,0)
 * ```
 * Vertex `3 = (1,1)` is the REFLEX corner (interior angle `270°` — verified
 * by this file's own construction, not asserted at runtime here: the
 * cross-product turn at `3` between edge `2->3` and edge `3->4` is negative
 * for this CCW-wound polygon, the standard reflex-vertex test). The prism's
 * REFLEX EDGE is the vertical segment from bottom vertex `3` (`(1,1,0)`,
 * mesh index `3`) to top vertex `3` (`(1,1,scale)`, mesh index `9` — top
 * layer is offset by `6`, the footprint's vertex count) — the two walls
 * meeting there (the `x=1` wall and the `y=1` wall, both facing INTO the
 * notch) have outward face normals `(1,0,0)` and `(0,1,0)` respectively, so
 * this reflex edge's angle-weighted pseudonormal is `normalize((1,1,0))`,
 * pointing diagonally into the (empty, exterior) notch — see
 * `sdf/signedDistance.reflex.test.ts` for the geometric derivation of where
 * this edge is the PROVABLY nearest surface feature (the solid-interior
 * octant `x < 1 && y < 1` near the edge) and its use of that fact.
 *
 * 12 vertices (6 bottom + 6 top), 20 triangles (4 top-cap fan + 4
 * bottom-cap fan, reversed winding + 12 side-wall triangles, 2 per
 * footprint edge) — `signedVolumeMm3 = 3 * scale^3` (footprint area `3 *
 * scale^2` times height `scale`), verified positive (genuinely CCW-from-
 * outside) in `sdf/signedDistance.reflex.test.ts` via `analyzeMesh`, per
 * this task's brief's explicit requirement. Requires `scale > 0`.
 */
export function notchedBoxMesh(scale = 1): IndexedMesh {
  const footprint: readonly (readonly [number, number])[] = [
    [0, 0],
    [2, 0],
    [2, 1],
    [1, 1], // reflex corner
    [1, 2],
    [0, 2],
  ];
  const n = footprint.length;
  const bottom: Vec3[] = footprint.map(([x, y]) => [x * scale, y * scale, 0]);
  const top: Vec3[] = footprint.map(([x, y]) => [x * scale, y * scale, scale]);
  const positions: Vec3[] = [...bottom, ...top]; // bottom: indices 0..n-1, top: indices n..2n-1

  const triangles: [number, number, number][] = [];
  // Top cap (z = scale): fan from footprint vertex 0, CCW order preserved
  // -> outward +z normal (this file's `meshFromLists` winding convention).
  for (let i = 1; i < n - 1; i++) {
    triangles.push([n + 0, n + i, n + i + 1]);
  }
  // Bottom cap (z = 0): same fan, REVERSED -> outward -z normal.
  for (let i = 1; i < n - 1; i++) {
    triangles.push([0, i + 1, i]);
  }
  // Side walls: one quad (2 triangles) per footprint edge i -> i+1 (cyclic),
  // outward-facing by construction (verified via signedVolumeMm3 in the
  // consuming test, per this task's brief).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = i;
    const b1 = j;
    const t0 = n + i;
    const t1 = n + j;
    triangles.push([b0, b1, t1]);
    triangles.push([b0, t1, t0]);
  }

  return meshFromLists(positions, triangles);
}

/**
 * Two topologically INDEPENDENT open rectangular grid patches (see
 * `openGridPatchMesh`) combined into a single mesh — a closed-form fixture
 * for exercising `findBoundaryLoops` with exactly 2 boundary loops. (The
 * other standard way to get 2 boundary loops, an annulus/disk-with-a-hole,
 * needs ring/hole index math; two disjoint patches are topologically just as
 * valid a "2 independent boundary loops" case and are far simpler to make
 * exact — each patch's perimeter length is already known in closed form from
 * `openGridPatchMesh`'s own convention.) `buildHalfedge`/`findBoundaryLoops`
 * never consult vertex positions or connectivity between components, so
 * nothing about correctness depends on the two patches being disjoint in
 * space — they're translated apart along X purely so the fixture is sane to
 * look at if ever dumped/visualized. Requires both patches' `rows >= 1 &&
 * cols >= 1`.
 */
export function twoDisjointOpenPatchesMesh(
  rows1: number,
  cols1: number,
  rows2: number,
  cols2: number,
): IndexedMesh {
  const patch1 = openGridPatchMesh(rows1, cols1);
  const patch2 = openGridPatchMesh(rows2, cols2);
  const gapX = cols1 + 2; // clear of patch1's bounding box (X in [0, cols1])
  const vertexCount1 = patch1.positions.length / 3;
  const vertexCount2 = patch2.positions.length / 3;

  const positions = new Float64Array(patch1.positions.length + patch2.positions.length);
  positions.set(patch1.positions, 0);
  for (let i = 0; i < vertexCount2; i++) {
    positions[patch1.positions.length + i * 3] = patch2.positions[i * 3]! + gapX;
    positions[patch1.positions.length + i * 3 + 1] = patch2.positions[i * 3 + 1]!;
    positions[patch1.positions.length + i * 3 + 2] = patch2.positions[i * 3 + 2]!;
  }

  const indices = new Uint32Array(patch1.indices.length + patch2.indices.length);
  indices.set(patch1.indices, 0);
  for (let i = 0; i < patch2.indices.length; i++) {
    indices[patch1.indices.length + i] = patch2.indices[i]! + vertexCount1;
  }

  return { positions, indices };
}
