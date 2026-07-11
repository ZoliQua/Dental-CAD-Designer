// packages/kernel/src/bvh/closestPoint.ts
//
// Branch-and-bound nearest-point-on-surface query against a built `Bvh`.
// Standard BVH nearest-neighbor traversal: visit the child whose AABB is
// closer to the query point first (better pruning in the common case), and
// never descend into a node whose AABB distance already exceeds the best
// distance found so far.
import type { IndexedMesh } from '../mesh/types.ts';
import { closestPointOnTriangle, distanceSquared, pointAabbDistanceSquared, type Vec3 } from './geometry.ts';
import type { Bvh, ClosestPointResult } from './types.ts';

function nodeBounds(bvh: Bvh, node: number): { min: Vec3; max: Vec3 } {
  return {
    min: [bvh.nodeBoundsMin[node * 3]!, bvh.nodeBoundsMin[node * 3 + 1]!, bvh.nodeBoundsMin[node * 3 + 2]!],
    max: [bvh.nodeBoundsMax[node * 3]!, bvh.nodeBoundsMax[node * 3 + 1]!, bvh.nodeBoundsMax[node * 3 + 2]!],
  };
}

function triangleVertices(mesh: IndexedMesh, triangleIndex: number): [Vec3, Vec3, Vec3] {
  const i0 = mesh.indices[triangleIndex * 3]!;
  const i1 = mesh.indices[triangleIndex * 3 + 1]!;
  const i2 = mesh.indices[triangleIndex * 3 + 2]!;
  const p = mesh.positions;
  return [
    [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!],
    [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!],
    [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!],
  ];
}

function validateMeshMatchesBvh(mesh: IndexedMesh, bvh: Bvh): void {
  const triangleCount = mesh.indices.length / 3;
  if (triangleCount !== bvh.triangleCount) {
    throw new RangeError(
      `closestPoint: mesh has ${triangleCount} triangles but bvh was built for ${bvh.triangleCount} — this Bvh was not built from this mesh (or the mesh changed since)`,
    );
  }
}

interface Best {
  distanceSq: number;
  point: Vec3;
  triangleIndex: number;
  barycentric: Vec3;
}

function visitLeaf(mesh: IndexedMesh, bvh: Bvh, node: number, p: Vec3, best: Best): void {
  const start = bvh.nodeLeafStart[node]!;
  const count = bvh.nodeLeafCount[node]!;
  for (let i = start; i < start + count; i++) {
    const triangleIndex = bvh.triangleIndices[i]!;
    const [a, b, c] = triangleVertices(mesh, triangleIndex);
    const { point, barycentric } = closestPointOnTriangle(p, a, b, c);
    const distanceSq = distanceSquared(p, point);
    // Deterministic tie-break (this package's brief: "lowest triangle index
    // wins on exact ties"): a strictly closer triangle always replaces
    // `best`; an EXACTLY tied triangle only replaces it if its index is
    // lower. Because `visitNode` orders sibling visits by AABB distance (not
    // by triangle index), the lower-index tied triangle can be visited
    // either before or after the current `best` — the explicit index
    // comparison in the `else if` below is what makes the final result
    // independent of that visitation order, not the pruning bound (pruning
    // only uses `>` (strict), so an equally-close subtree is never skipped).
    if (distanceSq < best.distanceSq) {
      best.distanceSq = distanceSq;
      best.point = point;
      best.triangleIndex = triangleIndex;
      best.barycentric = barycentric;
    } else if (distanceSq === best.distanceSq && triangleIndex < best.triangleIndex) {
      best.point = point;
      best.triangleIndex = triangleIndex;
      best.barycentric = barycentric;
    }
  }
}

function visitNode(mesh: IndexedMesh, bvh: Bvh, node: number, p: Vec3, best: Best): void {
  const { min, max } = nodeBounds(bvh, node);
  const boundDistanceSq = pointAabbDistanceSquared(p, min, max);
  if (boundDistanceSq > best.distanceSq) {
    return; // Prune: even the closest possible point in this subtree can't improve `best`.
  }

  const left = bvh.nodeLeft[node]!;
  if (left === -1) {
    visitLeaf(mesh, bvh, node, p, best);
    return;
  }
  const right = bvh.nodeRight[node]!;

  const leftBounds = nodeBounds(bvh, left);
  const rightBounds = nodeBounds(bvh, right);
  const leftDistanceSq = pointAabbDistanceSquared(p, leftBounds.min, leftBounds.max);
  const rightDistanceSq = pointAabbDistanceSquared(p, rightBounds.min, rightBounds.max);

  // Visit the nearer child first — improves `best` sooner, which prunes the
  // farther child more aggressively (standard BVH nearest-neighbor
  // ordering). Ties (equal AABB distance) visit left first — arbitrary but
  // fixed, and irrelevant to the RESULT (only to how much pruning happens),
  // since `visitLeaf`'s tie-break is index-based, not visitation-order-based.
  if (leftDistanceSq <= rightDistanceSq) {
    visitNode(mesh, bvh, left, p, best);
    visitNode(mesh, bvh, right, p, best);
  } else {
    visitNode(mesh, bvh, right, p, best);
    visitNode(mesh, bvh, left, p, best);
  }
}

/**
 * Exact closest point on `mesh`'s surface to `point`, using `bvh` (built via
 * `buildBvh(mesh)`) to prune the search. Throws if `bvh` wasn't built from a
 * mesh with the same triangle count as `mesh` (see `validateMeshMatchesBvh`)
 * — a cheap, always-on sanity check; it can't catch every possible
 * mesh/BVH mismatch (e.g. same triangle count, different geometry), but
 * catches the common "stale BVH after a mesh edit" mistake.
 *
 * Throws `RangeError` if `mesh` has zero triangles (no surface to be
 * closest to).
 */
export function closestPoint(mesh: IndexedMesh, bvh: Bvh, point: Vec3): ClosestPointResult {
  validateMeshMatchesBvh(mesh, bvh);
  if (bvh.triangleCount === 0) {
    throw new RangeError('closestPoint: mesh has no triangles');
  }
  const best: Best = { distanceSq: Infinity, point: [0, 0, 0], triangleIndex: -1, barycentric: [0, 0, 0] };
  visitNode(mesh, bvh, bvh.rootNode, point, best);
  return {
    point: best.point,
    distance: Math.sqrt(best.distanceSq),
    triangleIndex: best.triangleIndex,
    barycentric: best.barycentric,
  };
}

/**
 * Batch entry point: `closestPoint` for every point in `points` (flat
 * xyz-triples, matching `IndexedMesh.positions`' layout). This is the
 * extension point Task 9's distance heatmap (out of this task's YAGNI scope
 * — see this task's brief) is expected to build on: a heatmap needs
 * per-vertex closest-surface-point distance for potentially hundreds of
 * thousands of query points against a second mesh's BVH, which is exactly
 * this loop, just called with `points` sized to a whole mesh's vertex
 * buffer instead of a handful of measurement picks. No batching-specific
 * optimization (e.g. SIMD, coherent-ray-style shared traversal state) is
 * implemented here — plain per-point `closestPoint` calls — since nothing in
 * Phase 1 exercises this path at heatmap scale yet; a future task can
 * profile and optimize this specific function without touching its callers'
 * contract (same input/output shape).
 */
export function closestPointBatch(mesh: IndexedMesh, bvh: Bvh, points: Float64Array): ClosestPointResult[] {
  const count = points.length / 3;
  if (!Number.isInteger(count)) {
    throw new TypeError('closestPointBatch: points.length must be a multiple of 3');
  }
  const results: ClosestPointResult[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const p: Vec3 = [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
    results[i] = closestPoint(mesh, bvh, p);
  }
  return results;
}
