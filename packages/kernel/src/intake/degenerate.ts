// packages/kernel/src/intake/degenerate.ts
//
// Detects and removes degenerate triangles: zero-area triangles (including
// the duplicate-vertex-index case, which is always zero-area) that would
// otherwise poison downstream area/volume/manifold-3d computations.

import type { IndexedMesh } from '../mesh/types.ts';

/**
 * A triangle is degenerate if the norm of its edge cross product
 * (`|cross(v1-v0, v2-v0)|`, i.e. twice its area) is below this threshold —
 * per this task's brief: "zero-area (cross-product norm < 1e-12 mm²)". Note
 * this compares the CROSS-PRODUCT NORM itself (not the triangle's area,
 * which is half that) against 1e-12 mm² — so the effective area threshold
 * is 5e-13 mm². A triangle with a repeated vertex index has an exactly-zero
 * cross product (two of its three edge vectors are identical or the
 * triangle collapses to a line/point), so it always falls under this same
 * threshold — `isDegenerateTriangle` checks both conditions but the
 * duplicate-index case is, in practice, a subset of the zero-area case.
 */
export const DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4 = 1e-12 * 1e-12;

export interface DegenerateCheck {
  degenerate: boolean;
  /** `true` iff the triangle repeats a vertex index (a===b, b===c, or
   * a===c) — a strict subset of `degenerate`, reported separately so
   * `dropDegenerateTriangles`'s stats distinguish "corrupt indexing" from
   * "genuinely zero-area but distinct indices" (e.g. 3 distinct but
   * collinear/coincident points). */
  duplicateIndex: boolean;
}

/** Shared by `dropDegenerateTriangles` (which removes these) and
 * `analyzeMesh` (which only counts them) — see degenerate.ts's module doc
 * for the exact threshold. `t` is a triangle index (0-based, into
 * `mesh.indices` in units of 3). */
export function checkDegenerateTriangle(mesh: IndexedMesh, t: number): DegenerateCheck {
  const base = t * 3;
  const a = mesh.indices[base]!;
  const b = mesh.indices[base + 1]!;
  const c = mesh.indices[base + 2]!;

  if (a === b || b === c || a === c) {
    return { degenerate: true, duplicateIndex: true };
  }

  const ax = mesh.positions[a * 3]!;
  const ay = mesh.positions[a * 3 + 1]!;
  const az = mesh.positions[a * 3 + 2]!;
  const bx = mesh.positions[b * 3]!;
  const by = mesh.positions[b * 3 + 1]!;
  const bz = mesh.positions[b * 3 + 2]!;
  const cx = mesh.positions[c * 3]!;
  const cy = mesh.positions[c * 3 + 1]!;
  const cz = mesh.positions[c * 3 + 2]!;

  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;

  const crossX = e1y * e2z - e1z * e2y;
  const crossY = e1z * e2x - e1x * e2z;
  const crossZ = e1x * e2y - e1y * e2x;
  const crossNormSq = crossX * crossX + crossY * crossY + crossZ * crossZ;

  return { degenerate: crossNormSq < DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4, duplicateIndex: false };
}

export interface DropDegenerateResult {
  mesh: IndexedMesh;
  triangleCountBefore: number;
  triangleCountAfter: number;
  /** Total triangles removed (zero-area OR duplicate-index — see
   * `checkDegenerateTriangle`'s doc: duplicate-index is a subset). */
  degenerateCount: number;
  /** Of `degenerateCount`, how many were removed specifically for
   * repeating a vertex index. */
  duplicateIndexCount: number;
}

/**
 * Removes degenerate triangles (see `checkDegenerateTriangle`) from an
 * `IndexedMesh`, preserving the relative order of surviving triangles.
 *
 * **Buffer ownership**: `mesh.positions` is never mutated. Because this
 * step only ever removes triangles (it never repositions or removes
 * vertices — a vertex that becomes unreferenced after its last triangle is
 * dropped is simply left, unused, in `positions`; compacting unreferenced
 * vertices is repair-pipeline territory, Task 8, out of scope here), the
 * returned mesh's `positions` is the SAME array reference as the input's,
 * not a copy — avoiding a gratuitous full-buffer copy (72 MB for a 1M-
 * triangle mesh) when nothing about the vertex buffer actually changed.
 * `indices` is always a freshly allocated `Uint32Array`.
 *
 * Accumulation (Phase 2 Task 2 intake scalability rebuild): surviving
 * triangle indices are written directly into a preallocated `Uint32Array`
 * sized to the worst case (`triangleCountBefore * 3` — dropping can only
 * ever keep as many triangles as went in), trimmed to the actual count with
 * one `.slice()` at the end — never a plain `number[]` accumulated via
 * `.push()` + `Uint32Array.from()` (see weld.ts's matching doc for why this
 * matters at multi-million-triangle scale).
 */
export function dropDegenerateTriangles(mesh: IndexedMesh): DropDegenerateResult {
  const triangleCountBefore = mesh.indices.length / 3;
  const keptIndices = new Uint32Array(triangleCountBefore * 3);
  let keptTriangleCount = 0;
  let degenerateCount = 0;
  let duplicateIndexCount = 0;

  for (let t = 0; t < triangleCountBefore; t++) {
    const check = checkDegenerateTriangle(mesh, t);
    if (check.degenerate) {
      degenerateCount++;
      if (check.duplicateIndex) duplicateIndexCount++;
      continue;
    }
    const base = t * 3;
    const dst = keptTriangleCount * 3;
    keptIndices[dst] = mesh.indices[base]!;
    keptIndices[dst + 1] = mesh.indices[base + 1]!;
    keptIndices[dst + 2] = mesh.indices[base + 2]!;
    keptTriangleCount++;
  }

  return {
    mesh: { positions: mesh.positions, indices: keptIndices.slice(0, keptTriangleCount * 3) },
    triangleCountBefore,
    triangleCountAfter: keptTriangleCount,
    degenerateCount,
    duplicateIndexCount,
  };
}
