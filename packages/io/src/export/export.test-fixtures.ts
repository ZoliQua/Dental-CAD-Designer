// packages/io/src/export/export.test-fixtures.ts
//
// Closed-form analytic solids shared by the export-layer tests (validate /
// exportStlBinary / exportPlyBinary unit tests, the export round-trip
// property test, and the fuzz hookup). TEST-ONLY — not exported from the
// package index (same convention as packages/kernel's
// cavity.test-fixtures.ts). Every solid here has a hand-verifiable
// closed-form volume and a hand-verified outward CCW winding, so the tests
// built on them are analytic goldens, not fixture-mesh regressions.

import type { ExportableMesh } from './types.ts';

/**
 * Axis-aligned cube, side 2, centered at the origin (vertices at
 * (±1, ±1, ±1) — all exactly float32-representable, so STL's f32 narrowing
 * is the identity on it). 8 vertices, 12 triangles, outward CCW winding
 * (verified per-face by hand: right-hand rule over v0→v1→v2 points out of
 * the solid on every face). Closed-form volume: 8 mm³.
 */
export function unitCube2(): ExportableMesh {
  // prettier-ignore
  const positions = new Float64Array([
    -1, -1, -1, // 0
    +1, -1, -1, // 1
    +1, +1, -1, // 2
    -1, +1, -1, // 3
    -1, -1, +1, // 4
    +1, -1, +1, // 5
    +1, +1, +1, // 6
    -1, +1, +1, // 7
  ]);
  // prettier-ignore
  const indices = new Uint32Array([
    0, 3, 2,  0, 2, 1, // bottom (z=-1), outward normal (0,0,-1)
    4, 5, 6,  4, 6, 7, // top (z=+1), outward normal (0,0,+1)
    0, 1, 5,  0, 5, 4, // front (y=-1), outward normal (0,-1,0)
    1, 2, 6,  1, 6, 5, // right (x=+1), outward normal (+1,0,0)
    2, 3, 7,  2, 7, 6, // back (y=+1), outward normal (0,+1,0)
    3, 0, 4,  3, 4, 7, // left (x=-1), outward normal (-1,0,0)
  ]);
  return { positions, indices };
}

/** The outward unit facet normal of each `unitCube2()` triangle, in
 * triangle order — the closed-form ground truth the analytic STL byte
 * golden compares the written normal fields against. */
export const UNIT_CUBE2_FACET_NORMALS: readonly (readonly [number, number, number])[] = [
  [0, 0, -1],
  [0, 0, -1],
  [0, 0, 1],
  [0, 0, 1],
  [0, -1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 1, 0],
  [-1, 0, 0],
  [-1, 0, 0],
];

export const UNIT_CUBE2_VOLUME_MM3 = 8;

/**
 * The corner tetrahedron with vertices (0,0,0), (1,0,0), (0,1,0), (0,0,1)
 * — 4 vertices, 4 triangles, outward CCW winding (verified per-face by
 * hand). Closed-form volume: 1/6 mm³.
 */
export function cornerTetrahedron(): ExportableMesh {
  // prettier-ignore
  const positions = new Float64Array([
    0, 0, 0, // 0
    1, 0, 0, // 1
    0, 1, 0, // 2
    0, 0, 1, // 3
  ]);
  // prettier-ignore
  const indices = new Uint32Array([
    0, 2, 1, // z=0 face, outward normal (0,0,-1)
    0, 1, 3, // y=0 face, outward normal (0,-1,0)
    0, 3, 2, // x=0 face, outward normal (-1,0,0)
    1, 2, 3, // slanted face, outward normal (1,1,1)/sqrt(3)
  ]);
  return { positions, indices };
}

export const CORNER_TETRAHEDRON_VOLUME_MM3 = 1 / 6;

/** `mesh` with every triangle's winding reversed (v1/v2 swapped) — turns a
 * valid outward-oriented solid into an INWARD-oriented one (still
 * watertight, still consistently wound, volume negated). The falsifiable
 * "inward input is detected" case. */
export function windingReversed(mesh: ExportableMesh): ExportableMesh {
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    indices[t] = mesh.indices[t]!;
    indices[t + 1] = mesh.indices[t + 2]!;
    indices[t + 2] = mesh.indices[t + 1]!;
  }
  return { positions: mesh.positions.slice(), indices };
}

/** `mesh` with the LAST `dropCount` triangles removed — punches a hole in a
 * watertight solid, producing boundary edges. */
export function withTrianglesDropped(mesh: ExportableMesh, dropCount: number): ExportableMesh {
  return {
    positions: mesh.positions.slice(),
    indices: mesh.indices.slice(0, mesh.indices.length - dropCount * 3),
  };
}
