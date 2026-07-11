// packages/kernel/src/repair/splitNonManifoldEdges.ts
//
// Resolves non-manifold edges (degree > 2 — shared by more than 2 triangles)
// by duplicating vertices so every edge ends up with <= 2 incident
// triangles. Reuses intake/topology.ts's `buildEdgeMap` (same edge-adjacency
// notion `MeshStats.manifoldEdges` is defined against) rather than
// re-deriving it.
//
// ## Algorithm: keep the first 2 incidences, disconnect the rest
//
// For a non-manifold edge {a, b} with incidences `[i0, i1, i2, ...]` (in
// triangle-scan order 0..n-1 — the SAME deterministic order
// `topology.ts#buildEdgeMap` builds them in, so this is stable regardless of
// `Map` iteration quirks), `i0` and `i1` are left exactly as they are: they
// keep referencing the shared vertices `a`/`b` unchanged, so the edge they
// form together is untouched (a real, ordinary manifold-interior edge in the
// output). Every OTHER incidence `i2, i3, ...` is DISCONNECTED from the
// shared edge: the triangle's two corners that reference `a`/`b` are each
// remapped to a fresh, private duplicate vertex (same position, new index),
// which necessarily makes that triangle's version of the edge unique to
// itself — i.e. a brand-new boundary edge (degree 1), never shared with
// anyone. This is correct (every edge ends up degree <= 2: either the
// untouched `{i0, i1}` pair, or a lone disconnected triangle's private
// edge) and deterministic, at the cost of not being "optimal" — e.g. a
// degree-4 edge could instead be split into two manifold PAIRS (i0+i1 and
// i2+i3) rather than one pair plus two disconnected singles; Phase 1 doesn't
// need that refinement (YAGNI — see this task's brief), and always
// disconnecting to singles keeps the remapping logic a single, easy-to-audit
// rule (see below) rather than a graph-coloring/pairing decision.
//
// A single triangle can have more than one of its 3 corners remapped (e.g.
// if two of its three edges are both non-manifold and it's an "excess"
// incidence on both) — handled by keying the remap by (triangle, corner)
// rather than by (triangle, original vertex id), so a corner is only ever
// assigned ONE new vertex regardless of how many of the triangle's edges
// independently wanted to touch it.
//
// ## Scope: edge non-manifoldness only, not "bowtie" vertices
//
// A vertex where two otherwise-manifold triangle fans meet ONLY at that one
// point (every edge around it still has degree <= 2, so `buildEdgeMap` never
// flags anything) is a different, subtler non-manifoldness ("non-manifold
// vertex") that this function does NOT detect or split — out of scope for
// Phase 1 per the brief ("duplicate non-manifold edges/vertices so every
// edge has <= 2 faces": the vertex duplication here is the MECHANISM for
// fixing edge degree, not a separate bowtie-vertex repair). Real scans
// essentially never produce a clean bowtie without also producing a
// non-manifold edge nearby, so this is a documented, low-risk gap.

import type { IndexedMesh } from '../mesh/types.ts';
import { buildEdgeMap } from '../intake/topology.ts';
import { countsOf } from '../intake/report.ts';
import type { SplitNonManifoldEdgesReport, SplitNonManifoldEdgesResult } from './types.ts';

export function splitNonManifoldEdges(mesh: IndexedMesh): SplitNonManifoldEdgesResult {
  const edges = buildEdgeMap(mesh);
  const triangleCount = mesh.indices.length / 3;

  let nonManifoldEdgeCountBefore = 0;
  // Key: `${triangle},${corner}` (corner in 0..2) -> new vertex index. A
  // corner is only ever assigned ONE new vertex even if more than one of the
  // triangle's edges independently wants to disconnect it (see module doc).
  const cornerRemap = new Map<string, number>();
  let nextVertexIndex = mesh.positions.length / 3;
  // originalVertexOfNewIndex[newVertexIndex - vertexCountBefore] = the
  // original vertex id a duplicate's position should be copied from —
  // appended in the same order new vertices are assigned above.
  const duplicateSourceVertex: number[] = [];

  for (const entry of edges.values()) {
    if (entry.incidences.length <= 2) continue;
    nonManifoldEdgeCountBefore++;
    // Deterministic: incidences are in triangle-scan (0..n-1) order — see
    // buildEdgeMap's doc. Keep the first two, disconnect the rest.
    for (let i = 2; i < entry.incidences.length; i++) {
      const triangle = entry.incidences[i]!.triangle;
      const base = triangle * 3;
      for (let corner = 0; corner < 3; corner++) {
        const v = mesh.indices[base + corner]!;
        if (v !== entry.a && v !== entry.b) continue;
        const key = `${triangle},${corner}`;
        if (cornerRemap.has(key)) continue; // already claimed by another excess edge on this triangle
        cornerRemap.set(key, nextVertexIndex);
        nextVertexIndex++;
        duplicateSourceVertex.push(v);
      }
    }
  }

  const vertexCountBefore = mesh.positions.length / 3;
  const newIndices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < triangleCount; t++) {
    const base = t * 3;
    for (let corner = 0; corner < 3; corner++) {
      const remapped = cornerRemap.get(`${t},${corner}`);
      newIndices[base + corner] = remapped ?? mesh.indices[base + corner]!;
    }
  }

  const duplicatedVertexCount = duplicateSourceVertex.length;
  let newPositions: Float64Array;
  if (duplicatedVertexCount === 0) {
    newPositions = mesh.positions; // nothing added — safe to share, positions are never mutated in place
  } else {
    newPositions = new Float64Array(mesh.positions.length + duplicatedVertexCount * 3);
    newPositions.set(mesh.positions);
    duplicateSourceVertex.forEach((originalVertex, i) => {
      const dst = (vertexCountBefore + i) * 3;
      newPositions[dst] = mesh.positions[originalVertex * 3]!;
      newPositions[dst + 1] = mesh.positions[originalVertex * 3 + 1]!;
      newPositions[dst + 2] = mesh.positions[originalVertex * 3 + 2]!;
    });
  }

  const newMesh: IndexedMesh = { positions: newPositions, indices: newIndices };

  // Re-derive the after-state edge map rather than assuming — cheap (same
  // cost as the initial pass) and gives an honest, verified
  // `nonManifoldEdgeCountAfter` instead of an assumed 0.
  const afterEdges = buildEdgeMap(newMesh);
  let nonManifoldEdgeCountAfter = 0;
  for (const entry of afterEdges.values()) {
    if (entry.incidences.length > 2) nonManifoldEdgeCountAfter++;
  }

  const report: SplitNonManifoldEdgesReport = {
    nonManifoldEdgeCountBefore,
    nonManifoldEdgeCountAfter,
    duplicatedVertexCount,
    before: countsOf(mesh),
    after: countsOf(newMesh),
  };

  return { mesh: newMesh, report };
}
