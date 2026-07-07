// packages/kernel/src/repair/removeComponents.ts
//
// Removes whole connected components from a mesh — the "delete scanner
// floaters/specks" repair. Reuses intake/topology.ts's `buildEdgeMap` /
// `connectedComponents` (the SAME "any shared edge" connectivity notion
// `MeshStats.componentCount` uses) rather than re-deriving edge adjacency —
// see this package's module doc / CLAUDE.md's "reuse topology.ts" note.
//
// Unlike `dropDegenerateTriangles` (packages/kernel/src/intake/degenerate.ts,
// which deliberately leaves now-unreferenced vertices in `positions` — see
// its module doc: "compacting unreferenced vertices is repair-pipeline
// territory, Task 8"), this function DOES compact: every vertex belonging
// only to a removed component is dropped from the output `positions`, and
// surviving triangles' indices are remapped to the compacted buffer. This
// keeps a mesh that has had (e.g.) a large stray blob removed from carrying
// that blob's now-pointless vertex data around for the rest of the session.

import type { IndexedMesh } from '../mesh/types.ts';
import { buildEdgeMap, connectedComponents } from '../intake/topology.ts';
import type { Bbox } from '../intake/types.ts';
import { countsOf } from '../intake/report.ts';
import type { ComponentInfo, RemoveComponentsReport, RemoveComponentsResult, RemoveComponentsSelector } from './types.ts';

function bboxOfVertices(mesh: IndexedMesh, vertexIds: Iterable<number>): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (const v of vertexIds) {
    any = true;
    const x = mesh.positions[v * 3]!;
    const y = mesh.positions[v * 3 + 1]!;
    const z = mesh.positions[v * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return any ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : { min: [0, 0, 0], max: [0, 0, 0] };
}

/**
 * Analyzes `mesh`'s connected components (preview data — safe to call before
 * deciding a selector) and the actual kept/removed split for `selector`, both
 * in one pass — the `removeComponents` result's `report.components` field is
 * exactly this preview, so a UI never needs a separate "just preview" call:
 * running the real operation already produces list-every-component data
 * cheaply enough (same O(triangles) pass `removeComponents` needs anyway).
 */
function analyzeComponents(mesh: IndexedMesh): {
  rootOfTriangle: Int32Array;
  componentIndexOfRoot: Map<number, number>;
  componentCount: number;
  components: ComponentInfo[];
} {
  const edges = buildEdgeMap(mesh);
  const { rootOfTriangle, componentIndexOfRoot, componentCount } = connectedComponents(mesh, edges);
  const triangleCount = mesh.indices.length / 3;

  const triangleCounts = new Array<number>(componentCount).fill(0);
  const vertexSets: Set<number>[] = Array.from({ length: componentCount }, () => new Set<number>());

  for (let t = 0; t < triangleCount; t++) {
    const componentId = componentIndexOfRoot.get(rootOfTriangle[t]!)!;
    triangleCounts[componentId]!++;
    const base = t * 3;
    vertexSets[componentId]!.add(mesh.indices[base]!);
    vertexSets[componentId]!.add(mesh.indices[base + 1]!);
    vertexSets[componentId]!.add(mesh.indices[base + 2]!);
  }

  const components: ComponentInfo[] = [];
  for (let id = 0; id < componentCount; id++) {
    components.push({
      id,
      triangleCount: triangleCounts[id]!,
      vertexCount: vertexSets[id]!.size,
      bbox: bboxOfVertices(mesh, vertexSets[id]!),
    });
  }

  return { rootOfTriangle, componentIndexOfRoot, componentCount, components };
}

function resolveKeptIds(selector: RemoveComponentsSelector, components: readonly ComponentInfo[]): Set<number> {
  if (selector.mode === 'keep') {
    return new Set(selector.keepIds);
  }
  const kept = new Set<number>();
  for (const component of components) {
    if (component.triangleCount >= selector.minTriangles) {
      kept.add(component.id);
    }
  }
  return kept;
}

/**
 * Removes every component NOT selected to be kept (per `selector`), compacting
 * both the triangle and vertex buffers (see module doc). Returns the
 * ORIGINAL mesh unchanged (by value, not necessarily by reference) when
 * `selector` keeps every component — callers relying on idempotence (running
 * the same `minTriangles` selector twice) get an identical second result:
 * once small components are gone, a second pass finds nothing below the
 * threshold left to remove.
 */
export function removeComponents(mesh: IndexedMesh, selector: RemoveComponentsSelector): RemoveComponentsResult {
  const { rootOfTriangle, componentIndexOfRoot, components } = analyzeComponents(mesh);
  const keptIds = resolveKeptIds(selector, components);

  const removedComponentIds = components.map((c) => c.id).filter((id) => !keptIds.has(id));
  const keptComponentIds = components.map((c) => c.id).filter((id) => keptIds.has(id));

  if (removedComponentIds.length === 0) {
    // Nothing to remove — return the mesh unchanged (same buffer references,
    // no compaction pass) rather than a value-identical-but-reindexed copy.
    // This is what makes a `minTriangles` (or a `keep` selector naming every
    // id) idempotent by REFERENCE, not just by value, on a second call.
    const counts = countsOf(mesh);
    const report: RemoveComponentsReport = {
      selector,
      components,
      keptComponentIds,
      removedComponentIds,
      before: counts,
      after: counts,
    };
    return { mesh, report };
  }

  const triangleCount = mesh.indices.length / 3;
  const vertexRemap = new Map<number, number>();
  const newIndices: number[] = [];

  for (let t = 0; t < triangleCount; t++) {
    const componentId = componentIndexOfRoot.get(rootOfTriangle[t]!)!;
    if (!keptIds.has(componentId)) continue;
    const base = t * 3;
    for (let corner = 0; corner < 3; corner++) {
      const original = mesh.indices[base + corner]!;
      let compacted = vertexRemap.get(original);
      if (compacted === undefined) {
        compacted = vertexRemap.size;
        vertexRemap.set(original, compacted);
      }
      newIndices.push(compacted);
    }
  }

  const newPositions = new Float64Array(vertexRemap.size * 3);
  for (const [original, compacted] of vertexRemap) {
    newPositions[compacted * 3] = mesh.positions[original * 3]!;
    newPositions[compacted * 3 + 1] = mesh.positions[original * 3 + 1]!;
    newPositions[compacted * 3 + 2] = mesh.positions[original * 3 + 2]!;
  }

  const newMesh: IndexedMesh = { positions: newPositions, indices: Uint32Array.from(newIndices) };

  const report: RemoveComponentsReport = {
    selector,
    components,
    keptComponentIds,
    removedComponentIds,
    before: countsOf(mesh),
    after: countsOf(newMesh),
  };

  return { mesh: newMesh, report };
}
