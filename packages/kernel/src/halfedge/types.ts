// packages/kernel/src/halfedge/types.ts
//
// The `HalfedgeMesh` overlay type — see build.ts's module doc for the full
// construction/convention writeup. Kept in its own file (mirrors
// packages/kernel/src/bvh/types.ts's / mesh/types.ts's convention) so
// consumers that only need the TYPE (e.g. a future curvature/geodesic
// module's function signatures) don't have to pull in build.ts's
// construction logic.

import type { IndexedMesh } from '../mesh/types.ts';

/**
 * A lazily-built halfedge overlay over an `IndexedMesh` — see this
 * project's Global Constraints (docs/plans/phase-2-kernel-core.md): the
 * kernel's data of record stays `IndexedMesh` (flat positions/indices);
 * `HalfedgeMesh` is a derived, disposable adjacency structure built on
 * demand by `buildHalfedge` (build.ts) whenever an algorithm needs
 * topological traversal (one-ring, face loops, boundary loops, Euler
 * characteristic/genus — see iterate.ts), not stored alongside the mesh.
 *
 * ## Layout
 *
 * `faceCount` triangles contribute exactly `halfedgeCount = faceCount * 3`
 * halfedges, grouped in fixed triangle-corner order: halfedge index
 * `f * 3 + k` (`k` in `0..2`) is triangle `f`'s `k`-th corner's OUTGOING
 * halfedge — i.e. `vertex[f*3+k] === mesh.indices[f*3+k]` and it represents
 * the directed edge from that corner to the NEXT corner
 * (`mesh.indices[f*3 + (k+1)%3]`). `face`/`next` are therefore fully
 * determined by this fixed grouping (`face[he] = floor(he/3)`,
 * `next[he] = floor(he/3)*3 + (he%3+1)%3`) but are still stored as real
 * arrays (not computed inline at every call site) per this task's brief —
 * both for a uniform, self-describing structure and so a future
 * non-triangle-face extension (not needed today — YAGNI) wouldn't have to
 * change every consumer's indexing math.
 *
 * ## Boundary convention
 *
 * `twin[he] === -1` marks `he` as a BOUNDARY halfedge (its edge has only
 * one incident triangle) — there is no separate/virtual boundary-face
 * halfedge object for the "outside" of a boundary edge (contrast the
 * alternative convention some halfedge libraries use, where every edge gets
 * a twin, with boundary twins belonging to a phantom "outer face"). This
 * project uses the `-1` convention because it keeps `halfedgeCount` exactly
 * `faceCount * 3` (no extra allocation proportional to boundary length) and
 * because `findBoundaryLoops` (iterate.ts) only needs `vertexHalfedge` to
 * walk boundary loops directly (see its doc) — a virtual boundary face
 * buys nothing here. See build.ts's module doc for exactly how `twin` is
 * computed and rejected (non-manifold edges).
 */
export interface HalfedgeMesh {
  /** Back-reference to the source `IndexedMesh` this overlay was built
   * from — `positions`/`indices` are untouched (never mutated, never
   * copied) by `buildHalfedge`; `vertex`/`face` below index into it. */
  readonly mesh: IndexedMesh;
  /** `mesh.positions.length / 3` — includes vertices unreferenced by any
   * triangle (see intake/degenerate.ts's convention); such a vertex's
   * `vertexHalfedge` entry is `-1`. */
  readonly vertexCount: number;
  /** `mesh.indices.length / 3`. */
  readonly faceCount: number;
  /** `faceCount * 3`. */
  readonly halfedgeCount: number;
  /** Opposite halfedge across the same undirected edge, or `-1` for a
   * boundary halfedge — see this interface's "Boundary convention" doc.
   * `Int32Array` (not `Uint32Array`) specifically to represent `-1`. */
  readonly twin: Int32Array;
  /** Next halfedge around the same face (CCW), completing a 3-cycle per
   * triangle: `next[next[next[he]]] === he`. */
  readonly next: Uint32Array;
  /** The ORIGIN vertex of each halfedge (the vertex it points FROM — its
   * destination is `vertex[next[he]]`). */
  readonly vertex: Uint32Array;
  /** The face (triangle index) each halfedge belongs to. */
  readonly face: Uint32Array;
  /** One anchor outgoing halfedge per vertex (`vertex[vertexHalfedge[v]]
   * === v` whenever `vertexHalfedge[v] !== -1`), the starting point for
   * this module's one-ring circulators (iterate.ts) — `-1` for a vertex
   * referenced by no triangle. For a BOUNDARY vertex, `buildHalfedge`
   * always picks a boundary halfedge (`twin === -1`) as this anchor when
   * one touches that vertex as an origin — see build.ts's doc for why that
   * choice is what makes `forEachOutgoingHalfedge`'s single-direction walk
   * (iterate.ts) enumerate the vertex's ENTIRE fan, not just part of it. */
  readonly vertexHalfedge: Int32Array;
}
