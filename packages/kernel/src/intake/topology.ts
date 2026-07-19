// packages/kernel/src/intake/topology.ts
//
// Shared edge-adjacency and connected-component machinery used by both
// `orientNormalsConsistently` (orient.ts) and `analyzeMesh` (analyze.ts) —
// kept in one place so both agree on exactly what "an edge" and "a
// component" mean (same connectivity notion, see MeshStats.componentCount's
// doc in types.ts).

import type { IndexedMesh } from '../mesh/types.ts';
import { assertSafeVertexCountForEdgeKey, edgeKey } from '../mesh/edgeKey.ts';

/** One triangle's incidence on an undirected edge {a, b} (a < b by vertex
 * index — the edge's "canonical" orientation). `directed` records whether
 * THIS triangle's stored winding traverses the edge a -> b (`true`) or
 * b -> a (`false`) — the fact `orientNormalsConsistently`'s flood fill
 * needs to decide whether two triangles sharing an edge are consistently
 * wound. */
export interface EdgeIncidence {
  triangle: number;
  directed: boolean;
}

export interface EdgeEntry {
  a: number;
  b: number;
  incidences: EdgeIncidence[];
}

/** Builds the undirected-edge -> incident-triangle map for every triangle
 * in `mesh`. An edge's `incidences.length` is its degree: 1 = boundary, 2 =
 * ordinary manifold-interior edge, >2 = non-manifold.
 *
 * **Map key** (Phase 2 Task 2 intake scalability rebuild): an integer
 * `edgeKey(a, b, vertexCount)` (`../mesh/edgeKey.ts`), not the earlier
 * `` `${a},${b}` `` string — a `Map<number, EdgeEntry>` avoids allocating and
 * hashing a fresh string on every one of a mesh's ~1.5 * triangleCount edge
 * visits, which measurably dominated `buildEdgeMap`'s cost at the
 * multi-million-triangle scale this project's NFR targets (PLAN.md §7); see
 * `edgeKey.ts`'s doc for the integer bound this relies on. Every caller
 * (`connectedComponents`, `countEdgeDegrees`, and every repair/orient/
 * analyze module that consumes this map) only ever calls `.values()` on the
 * result, never looks a specific edge up by its own reconstructed key, so
 * this is a pure internal-representation change — output (`EdgeEntry.a`/
 * `.b`/`.incidences`, iteration order) is identical to the string-keyed
 * version bit-for-bit. */
export function buildEdgeMap(mesh: IndexedMesh): Map<number, EdgeEntry> {
  const edges = new Map<number, EdgeEntry>();
  const triangleCount = mesh.indices.length / 3;
  const vertexCount = mesh.positions.length / 3;
  assertSafeVertexCountForEdgeKey(vertexCount, 'buildEdgeMap');

  function addEdge(u: number, v: number, triangle: number): void {
    const a = Math.min(u, v);
    const b = Math.max(u, v);
    const key = edgeKey(a, b, vertexCount);
    const directed = u === a;
    let entry = edges.get(key);
    if (!entry) {
      entry = { a, b, incidences: [] };
      edges.set(key, entry);
    }
    entry.incidences.push({ triangle, directed });
  }

  for (let t = 0; t < triangleCount; t++) {
    const base = t * 3;
    const p = mesh.indices[base]!;
    const q = mesh.indices[base + 1]!;
    const r = mesh.indices[base + 2]!;
    addEdge(p, q, t);
    addEdge(q, r, t);
    addEdge(r, p, t);
  }

  return edges;
}

/** Classic union-find (disjoint-set) over triangle indices `0..n-1`, with
 * path compression and union-by-rank — O(n α(n)) total for the
 * `union`/`find` calls `connectedComponents` makes. */
class UnionFind {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
    this.rank = new Uint8Array(size);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    const rankX = this.rank[rx]!;
    const rankY = this.rank[ry]!;
    if (rankX < rankY) {
      this.parent[rx] = ry;
    } else if (rankX > rankY) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx] = rankX + 1;
    }
  }
}

export interface ConnectedComponents {
  /** `rootOfTriangle[t]` is a stable identifier shared by every triangle in
   * `t`'s component (a union-find root — an arbitrary triangle index, not a
   * 0-based component id). Use `componentIndexOfRoot` to map it to a
   * 0-based, first-occurrence-ordered component index. */
  rootOfTriangle: Int32Array;
  /** Root -> 0-based component index, assigned in order of each root's
   * first appearance scanning triangles 0..n-1 (determinism: stable
   * regardless of `Map`/`Set` iteration order elsewhere). */
  componentIndexOfRoot: Map<number, number>;
  componentCount: number;
}

/**
 * Partitions a mesh's triangles into connected components: two triangles
 * are in the same component iff they share an edge (ANY multiplicity —
 * including non-manifold edges shared by >2 triangles, and NOT limited to
 * manifold-interior degree-2 edges — this is the "any shared edge" notion
 * `MeshStats.componentCount` and `orientNormalsConsistently`'s per-component
 * reasoning both use; see orient.ts's module doc for why its flood-fill
 * PROPAGATION is restricted to degree-2 edges even though its NOTION OF
 * COMPONENT, via this function, is not).
 */
export function connectedComponents(mesh: IndexedMesh, edges: Map<number, EdgeEntry>): ConnectedComponents {
  const triangleCount = mesh.indices.length / 3;
  const uf = new UnionFind(triangleCount);

  for (const entry of edges.values()) {
    if (entry.incidences.length < 2) continue;
    const first = entry.incidences[0]!.triangle;
    for (let i = 1; i < entry.incidences.length; i++) {
      uf.union(first, entry.incidences[i]!.triangle);
    }
  }

  const rootOfTriangle = new Int32Array(triangleCount);
  const componentIndexOfRoot = new Map<number, number>();
  let nextIndex = 0;
  for (let t = 0; t < triangleCount; t++) {
    const root = uf.find(t);
    rootOfTriangle[t] = root;
    if (!componentIndexOfRoot.has(root)) {
      componentIndexOfRoot.set(root, nextIndex);
      nextIndex++;
    }
  }

  return { rootOfTriangle, componentIndexOfRoot, componentCount: nextIndex };
}

export interface EdgeDegreeCounts {
  boundaryEdgeCount: number;
  manifoldInteriorEdgeCount: number;
  nonManifoldEdgeCount: number;
}

/** Tallies edges by degree across the whole edge map — see `EdgeEntry`'s
 * doc for what each degree means. */
export function countEdgeDegrees(edges: Map<number, EdgeEntry>): EdgeDegreeCounts {
  let boundaryEdgeCount = 0;
  let manifoldInteriorEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const entry of edges.values()) {
    if (entry.incidences.length === 1) boundaryEdgeCount++;
    else if (entry.incidences.length === 2) manifoldInteriorEdgeCount++;
    else nonManifoldEdgeCount++;
  }
  return { boundaryEdgeCount, manifoldInteriorEdgeCount, nonManifoldEdgeCount };
}
