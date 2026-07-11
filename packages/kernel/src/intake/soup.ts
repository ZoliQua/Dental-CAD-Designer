// packages/kernel/src/intake/soup.ts
//
// Converts an already-indexed mesh back into an unindexed `TriangleSoup` —
// the inverse of `weldVertices`. Two uses: (1) test fixtures ("welding a
// soup built from an indexed mesh reproduces it" — see weld.property.test.ts),
// and (2) production callers that received a shared-vertex mesh (PLY's
// parser output, `PlyMesh`, is indexed by construction — see packages/io's
// module doc) but want the SAME weld semantics `intake()` applies to STL
// soup, rather than the "already indexed, skip weld" path `IntakeInput`
// otherwise offers (see intake.ts's module doc for when each is
// appropriate).

import type { IndexedMesh } from '../mesh/types.ts';
import type { TriangleSoup } from './types.ts';

/**
 * Expands `mesh.indices` into a flat, unindexed `TriangleSoup` by copying
 * each triangle's 3 vertex positions out of `mesh.positions` directly (no
 * dedup — this is the inverse of welding, not a redundant re-weld).
 * `normals` is always `null` in the result: an `IndexedMesh` carries no
 * per-facet normal to expand (unlike STL's `RawTriangleSoup`, which stores
 * one normal per triangle as read from the file — see packages/io's
 * `RawTriangleSoup` doc) — recompute normals geometrically downstream if
 * needed (that's what `orientNormalsConsistently` establishes winding for).
 *
 * Buffer ownership: `mesh.positions`/`mesh.indices` are only ever read,
 * never mutated; the result is a brand-new, disjoint `Float64Array` (see
 * weld.ts's matching note on `weldVertices`).
 */
export function indexedToSoup(mesh: IndexedMesh): TriangleSoup {
  if (!(mesh.positions instanceof Float64Array)) {
    throw new TypeError('indexedToSoup: mesh.positions must be a Float64Array (kernel Float64 rule)');
  }
  if (!(mesh.indices instanceof Uint32Array)) {
    throw new TypeError('indexedToSoup: mesh.indices must be a Uint32Array');
  }
  const triangleCount = mesh.indices.length / 3;
  const positions = new Float64Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const vertexIndex = mesh.indices[t * 3 + corner]!;
      const src = vertexIndex * 3;
      const dst = t * 9 + corner * 3;
      positions[dst] = mesh.positions[src]!;
      positions[dst + 1] = mesh.positions[src + 1]!;
      positions[dst + 2] = mesh.positions[src + 2]!;
    }
  }
  return { positions, normals: null, triangleCount };
}
