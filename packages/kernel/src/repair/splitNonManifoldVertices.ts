// packages/kernel/src/repair/splitNonManifoldVertices.ts
//
// Resolves "bowtie" vertices (Phase 2 Task 11 — retires the Phase 1 carry-
// over tracked in docs/plans/phase-2-kernel-core.md's Global Constraints:
// "bowtie-vertex splitting"): a vertex where two or more otherwise-manifold
// triangle fans meet ONLY at that single point, with no shared edge
// connecting them. This is a DIFFERENT, narrower non-manifoldness than
// `splitNonManifoldEdges.ts` fixes — every edge around a bowtie vertex can
// have degree <= 2 (perfectly manifold by edge-degree alone), so
// `buildEdgeMap`/`buildHalfedge`'s twin-pairing sees nothing wrong; only
// `findNonManifoldVertices` (halfedge/build.ts, Task 2) detects it, via a
// per-vertex link-edge union-find — see that function's doc for the exact
// "fan" definition this file relies on.
//
// ## Algorithm: duplicate every fan but the first
//
// For each bowtie vertex `v` (processed in ASCENDING vertex-id order —
// `findNonManifoldVertices`'s own sorted output), partition `v`'s incident
// triangles into fans: two triangles at `v` are in the same fan iff they
// share one of their two OTHER corners (i.e. they are directly adjacent
// around `v`, or transitively connected through a chain of such
// adjacencies) — the same equivalence `findNonManifoldVertices` computes,
// re-derived here at TRIANGLE granularity (that function's own union-find
// is scoped to neighbor-VERTEX slots, sufficient for detection but not for
// assigning a fan id to each triangle, which this file needs).
//
// The fan containing `v`'s LOWEST-triangle-index incident triangle (i.e.
// `v`'s incident triangles in ascending triangle-scan order, fan of the
// first one) KEEPS the original vertex id, unchanged — the same
// "keep the first, disconnect the rest" convention
// `splitNonManifoldEdges.ts` uses for its own excess-incidence handling.
// Every OTHER fan is assigned ONE fresh, private duplicate vertex (same
// position as `v`, new index) — every triangle in that fan has its `v`
// corner remapped to the duplicate — in order of the fan's first
// appearance walking `v`'s incident triangles in ascending index order.
// This is fully deterministic: a given (mesh, bowtie-vertex, fan)
// combination always gets the same duplicate-vertex assignment, and the
// GLOBAL order new vertices are appended in is "for each bowtie vertex
// (ascending id), for each of its non-first fans (in first-appearance
// order)".
//
// ## Why this is correct
//
// Splitting a bowtie vertex this way cannot introduce a new non-manifold
// EDGE: any edge with `v` as one endpoint that has 2 incident triangles
// means those two triangles are DIRECTLY adjacent around `v` (they share
// both `v` and the edge's other endpoint), which by this file's fan
// definition puts them in the SAME fan — so both get remapped to the same
// vertex copy (or both keep the original), never split across a copy
// boundary. Two DIFFERENT bowtie vertices are handled fully independently
// (each vertex's own corners, identified from the ORIGINAL, unmodified
// `mesh.indices`, are remapped without regard to any other vertex's
// remapping), so a single triangle with more than one bowtie corner is
// handled correctly — each corner independently, no interaction.
//
// **Known, documented, out-of-scope gap** (mirrors
// `findNonManifoldVertices`'s own "independent of buildHalfedge" doc): this
// operates on the raw `IndexedMesh`, purely combinatorially (no floating-
// point comparisons — `@errorBound` N/A, same as `findNonManifoldVertices`
// itself). It does NOT also resolve non-manifold EDGES (degree > 2) —
// `splitNonManifoldEdges.ts` is the fix for that, a genuinely separate
// non-manifoldness class; running both (either order — they operate on
// disjoint conditions and neither creates the other's condition) is a
// caller decision (see apps/client/src/ui/RepairPanel.tsx, which offers
// both cards independently, same as the other repair operations).
import type { IndexedMesh } from '../mesh/types.ts';
import { findNonManifoldVertices } from '../halfedge/build.ts';
import { countsOf } from '../intake/report.ts';
import type { SplitNonManifoldVerticesReport, SplitNonManifoldVerticesResult } from './types.ts';

export function splitNonManifoldVertices(mesh: IndexedMesh): SplitNonManifoldVerticesResult {
  const bowties = findNonManifoldVertices(mesh); // sorted ascending by vertex id
  const nonManifoldVertexCountBefore = bowties.length;

  if (bowties.length === 0) {
    // Nothing to split — same buffer references, no-op by reference (the
    // same "idempotent by reference, not just by value" convention
    // `removeComponents.ts`'s no-op path documents).
    const counts = countsOf(mesh);
    const report: SplitNonManifoldVerticesReport = {
      nonManifoldVertexCountBefore: 0,
      nonManifoldVertexCountAfter: 0,
      duplicatedVertexCount: 0,
      before: counts,
      after: counts,
    };
    return { mesh, report };
  }

  const triangleCount = mesh.indices.length / 3;

  // vertex -> incident triangle indices, in ascending triangle-scan order —
  // built once, O(triangleCount).
  const incidentTriangles = new Map<number, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    const base = t * 3;
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.indices[base + corner]!;
      let list = incidentTriangles.get(v);
      if (!list) {
        list = [];
        incidentTriangles.set(v, list);
      }
      list.push(t);
    }
  }

  const newIndices = Uint32Array.from(mesh.indices);
  let nextVertexIndex = mesh.positions.length / 3;
  const duplicateSourceVertex: number[] = [];

  for (const { vertex } of bowties) {
    const triangles = incidentTriangles.get(vertex)!; // ascending triangle-scan order

    // Local union-find over `triangles`' INDICES (not vertex ids) — see
    // module doc's "Algorithm" section for the fan equivalence.
    const parent = triangles.map((_, i) => i);
    function find(x: number): number {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    }
    function union(a: number, b: number): void {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    const firstTriangleWithOtherCorner = new Map<number, number>(); // other-corner vertex id -> first local triangle index seen with it
    const otherCornersOf: [number, number][] = [];
    for (let i = 0; i < triangles.length; i++) {
      const base = triangles[i]! * 3;
      const corners: [number, number, number] = [mesh.indices[base]!, mesh.indices[base + 1]!, mesh.indices[base + 2]!];
      const p = corners.indexOf(vertex);
      const a = corners[(p + 1) % 3]!;
      const b = corners[(p + 2) % 3]!;
      otherCornersOf.push([a, b]);
      for (const c of [a, b]) {
        const firstIdx = firstTriangleWithOtherCorner.get(c);
        if (firstIdx === undefined) firstTriangleWithOtherCorner.set(c, i);
        else union(i, firstIdx);
      }
    }

    // Deterministic fan-id assignment: fan 0 = the component containing
    // local triangle index 0 (`triangles[0]`, the lowest-triangle-index
    // incidence — see module doc). Subsequent NEW roots, encountered while
    // scanning `i` ascending, get fan ids 1, 2, ... in first-appearance
    // order.
    const fanIdOfRoot = new Map<number, number>();
    let nextFanId = 0;
    const fanIdOfLocal = new Array<number>(triangles.length);
    for (let i = 0; i < triangles.length; i++) {
      const root = find(i);
      let fanId = fanIdOfRoot.get(root);
      if (fanId === undefined) {
        fanId = nextFanId++;
        fanIdOfRoot.set(root, fanId);
      }
      fanIdOfLocal[i] = fanId;
    }

    if (nextFanId <= 1) continue; // defensive: findNonManifoldVertices said fanCount > 1, but re-derive rather than trust blindly

    const newVertexOfFan = new Map<number, number>(); // fanId (>= 1) -> new duplicate vertex index
    for (let i = 0; i < triangles.length; i++) {
      const fanId = fanIdOfLocal[i]!;
      if (fanId === 0) continue; // keeps the original vertex id, untouched

      let duplicate = newVertexOfFan.get(fanId);
      if (duplicate === undefined) {
        duplicate = nextVertexIndex++;
        newVertexOfFan.set(fanId, duplicate);
        duplicateSourceVertex.push(vertex);
      }

      const t = triangles[i]!;
      const base = t * 3;
      for (let corner = 0; corner < 3; corner++) {
        if (mesh.indices[base + corner] === vertex) newIndices[base + corner] = duplicate;
      }
    }
  }

  const duplicatedVertexCount = duplicateSourceVertex.length;
  const vertexCountBefore = mesh.positions.length / 3;
  const newPositions = new Float64Array(mesh.positions.length + duplicatedVertexCount * 3);
  newPositions.set(mesh.positions);
  duplicateSourceVertex.forEach((originalVertex, i) => {
    const dst = (vertexCountBefore + i) * 3;
    newPositions[dst] = mesh.positions[originalVertex * 3]!;
    newPositions[dst + 1] = mesh.positions[originalVertex * 3 + 1]!;
    newPositions[dst + 2] = mesh.positions[originalVertex * 3 + 2]!;
  });

  const newMesh: IndexedMesh = { positions: newPositions, indices: newIndices };

  // Re-derive the after-state rather than assuming 0 — same "verified, not
  // assumed" convention splitNonManifoldEdges.ts uses.
  const nonManifoldVertexCountAfter = findNonManifoldVertices(newMesh).length;

  const report: SplitNonManifoldVerticesReport = {
    nonManifoldVertexCountBefore,
    nonManifoldVertexCountAfter,
    duplicatedVertexCount,
    before: countsOf(mesh),
    after: countsOf(newMesh),
  };

  return { mesh: newMesh, report };
}
