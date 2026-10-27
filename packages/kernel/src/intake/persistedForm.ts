// packages/kernel/src/intake/persistedForm.ts
//
// Phase 10 Task 2 (ADR-023, dual validation) — the PERSISTED FORM of a mesh:
// the exact mesh the server rebuilds from the binary STL the client stores for
// it. The client keeps scans in Float64, but binary STL holds float32
// coordinates and no shared vertices (packages/io's `writeStlBinary`; the
// reload path is `parseMeshFile` + `weldMeshSoup`). An op whose result the
// server must reproduce bit for bit from the stored scan (the prep die) runs
// on this form, on both sides.
//
// The form is: the triangles expanded to a soup in index order, every
// coordinate rounded to the nearest float32 (`Math.fround`, the same
// round-to-nearest-even as the writer's `DataView.setFloat32`), re-welded with
// `weldVertices` at the intake epsilon. It is idempotent — `weldVertices`
// keeps the first vertex of a cluster as its representative, so the welded
// vertices are pairwise farther apart than the epsilon and a second weld
// merges nothing, in the same first-use order — so a scan reloaded from its
// STL has the same persisted form as the scan it was written from.
//
// @errorBound Each coordinate moves by at most half a float32 ULP (≤ 2⁻²⁴ ×
// |coordinate|: 0.6 nm at 10 mm, 6 nm at 100 mm), plus the weld epsilon for a
// vertex merged into a cluster. A scan imported from STL is already
// float32-exact, so only the vertex numbering can change.
//
// `.ts` extension: reachable from the Node worker entry's import closure.
import type { IndexedMesh } from '../mesh/types.ts';
import { indexedToSoup } from './soup.ts';
import { MESH_WELD_EPSILON_MM, weldVertices } from './weld.ts';

/**
 * The mesh the server rebuilds from `mesh`'s persisted binary STL — see the
 * module doc. Pure; never mutates `mesh`.
 */
export function persistedMeshForm(mesh: IndexedMesh): IndexedMesh {
  const soup = indexedToSoup(mesh);
  for (let i = 0; i < soup.positions.length; i++) soup.positions[i] = Math.fround(soup.positions[i]!);
  return weldVertices(soup, MESH_WELD_EPSILON_MM);
}
