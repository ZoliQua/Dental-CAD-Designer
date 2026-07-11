// packages/kernel/src/bvh/raycast.ts
//
// Nearest-hit ray query against a built `Bvh`. Same branch-and-bound shape
// as closestPoint.ts, but pruned by ray parameter `t` (via the AABB slab
// test, geometry.ts's `rayAabbEntry`) instead of Euclidean distance, and
// ordered by entry-`t` (nearer-along-the-ray child first) rather than AABB
// distance-to-point.
import type { IndexedMesh } from '../mesh/types.ts';
import { rayAabbEntry, rayTriangleIntersect, type Vec3 } from './geometry.ts';
import type { Bvh, RaycastHit } from './types.ts';

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
      `raycast: mesh has ${triangleCount} triangles but bvh was built for ${bvh.triangleCount} — this Bvh was not built from this mesh (or the mesh changed since)`,
    );
  }
}

interface Best {
  t: number;
  triangleIndex: number;
  barycentric: Vec3;
}

function visitLeaf(mesh: IndexedMesh, bvh: Bvh, node: number, origin: Vec3, direction: Vec3, best: Best): void {
  const start = bvh.nodeLeafStart[node]!;
  const count = bvh.nodeLeafCount[node]!;
  for (let i = start; i < start + count; i++) {
    const triangleIndex = bvh.triangleIndices[i]!;
    const [a, b, c] = triangleVertices(mesh, triangleIndex);
    const hit = rayTriangleIntersect(origin, direction, a, b, c);
    if (!hit) continue;
    // Deterministic tie-break, same shape as closestPoint.ts's: strictly
    // smaller `t` always wins; an exactly tied `t` only replaces `best` if
    // the triangle index is lower (see raycast's own doc comment below for
    // why exact `t` ties are an expected, not pathological, case — a ray
    // landing exactly on a shared edge between two triangles).
    if (hit.t < best.t) {
      best.t = hit.t;
      best.triangleIndex = triangleIndex;
      best.barycentric = hit.barycentric;
    } else if (hit.t === best.t && triangleIndex < best.triangleIndex) {
      best.triangleIndex = triangleIndex;
      best.barycentric = hit.barycentric;
    }
  }
}

function visitNode(
  mesh: IndexedMesh,
  bvh: Bvh,
  node: number,
  origin: Vec3,
  direction: Vec3,
  invDirection: Vec3,
  best: Best,
): void {
  const { min, max } = nodeBounds(bvh, node);
  const entry = rayAabbEntry(origin, direction, invDirection, min, max, 0, best.t);
  if (entry === null) {
    return; // Ray misses this subtree's bounds entirely, or only within a range already worse than `best`.
  }

  const left = bvh.nodeLeft[node]!;
  if (left === -1) {
    visitLeaf(mesh, bvh, node, origin, direction, best);
    return;
  }
  const right = bvh.nodeRight[node]!;

  const leftBounds = nodeBounds(bvh, left);
  const rightBounds = nodeBounds(bvh, right);
  const leftEntry = rayAabbEntry(origin, direction, invDirection, leftBounds.min, leftBounds.max, 0, best.t);
  const rightEntry = rayAabbEntry(origin, direction, invDirection, rightBounds.min, rightBounds.max, 0, best.t);

  // Visit whichever child the ray enters first — same pruning rationale as
  // closestPoint.ts's nearer-child-first ordering. A `null` entry (ray
  // misses that child's bounds, or only beyond the current best) sorts last
  // by treating it as +Infinity.
  const leftFirst = (leftEntry ?? Infinity) <= (rightEntry ?? Infinity);
  if (leftFirst) {
    if (leftEntry !== null) visitNode(mesh, bvh, left, origin, direction, invDirection, best);
    if (rightEntry !== null) visitNode(mesh, bvh, right, origin, direction, invDirection, best);
  } else {
    if (rightEntry !== null) visitNode(mesh, bvh, right, origin, direction, invDirection, best);
    if (leftEntry !== null) visitNode(mesh, bvh, left, origin, direction, invDirection, best);
  }
}

/**
 * Nearest ray-mesh intersection (smallest `t >= 0`), using `bvh` (built via
 * `buildBvh(mesh)`) to prune the search. `direction` is normalized
 * internally (callers may pass any non-zero-length direction) so the
 * returned `distance`/`RaycastHit.distance` is a true Euclidean distance,
 * not a scaled ray parameter.
 *
 * Returns `null` for a miss. Throws if `bvh.triangleCount` doesn't match
 * `mesh`'s triangle count (see closestPoint.ts's identical check — same
 * "stale BVH" defense).
 */
export function raycast(mesh: IndexedMesh, bvh: Bvh, origin: Vec3, direction: Vec3): RaycastHit | null {
  validateMeshMatchesBvh(mesh, bvh);
  if (bvh.triangleCount === 0) {
    return null;
  }
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) {
    throw new TypeError('raycast: direction must be a non-zero-length vector');
  }
  const unit: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  const invDirection: Vec3 = [1 / unit[0], 1 / unit[1], 1 / unit[2]];

  const best: Best = { t: Infinity, triangleIndex: -1, barycentric: [0, 0, 0] };
  visitNode(mesh, bvh, bvh.rootNode, origin, unit, invDirection, best);
  if (best.triangleIndex === -1) {
    return null;
  }
  return {
    point: [origin[0] + unit[0] * best.t, origin[1] + unit[1] * best.t, origin[2] + unit[2] * best.t],
    distance: best.t,
    triangleIndex: best.triangleIndex,
    barycentric: best.barycentric,
  };
}
