// packages/kernel/src/bvh/types.ts
//
// Flat, typed-array BVH representation. Deliberately NOT a tree of small JS
// objects (one per node) — for a 250k-1M triangle arch scan a node-per-object
// tree means millions of small heap allocations and pointer-chasing during
// traversal, which is measurable both in build time and per-query cost. A
// flat "struct of arrays" keyed by integer node index is the standard layout
// for production BVHs (see e.g. Ingo Wald's "On fast Construction of SAH-based
// Bounding Volume Hierarchies" for why): every array here is indexed by the
// same `nodeIndex`, and traversal only ever touches numbers, never objects.

/**
 * A static (build-once, query-many) triangle BVH over a single `IndexedMesh`.
 * Immutable once built — see build.ts's `buildBvh`. Every array is indexed by
 * `nodeIndex` (0..nodeCount-1); `rootNode` is always the last-built node for
 * a non-empty mesh (see build.ts) except for the reserved empty-mesh case
 * (see `EMPTY_BVH_ROOT`).
 */
export interface Bvh {
  /** Triangle count this BVH was built over (`mesh.indices.length / 3` at
   * build time) — closestPoint/raycast validate a mesh argument's triangle
   * count against this before trusting the cached tree, so a caller can't
   * accidentally query a BVH against a mismatched mesh. */
  readonly triangleCount: number;
  /** Per-node AABB, flattened as 3 components (x,y,z) per node — i.e.
   * `nodeBoundsMin[nodeIndex * 3 + axis]`. */
  readonly nodeBoundsMin: Float64Array;
  readonly nodeBoundsMax: Float64Array;
  /** Child node index, or -1 for a leaf. Internal nodes always have BOTH
   * children set (a median split never produces a single-child internal
   * node — see build.ts). */
  readonly nodeLeft: Int32Array;
  readonly nodeRight: Int32Array;
  /** Leaf-only: `triangleIndices[nodeLeafStart[n] .. nodeLeafStart[n] +
   * nodeLeafCount[n])` are this leaf's triangle indices. Both are 0
   * (unused/meaningless) for an internal node — callers must branch on
   * `nodeLeft[n] === -1` first. */
  readonly nodeLeafStart: Int32Array;
  readonly nodeLeafCount: Int32Array;
  /** A permutation of `0 .. triangleCount - 1`, grouped contiguously by leaf
   * — see `nodeLeafStart`/`nodeLeafCount`. */
  readonly triangleIndices: Uint32Array;
  /** Index of the root node into the arrays above. */
  readonly rootNode: number;
}

/** Result of a `closestPoint` query — see closestPoint.ts. */
export interface ClosestPointResult {
  /** The closest point ON the mesh surface, Float64 mm world coordinates
   * (same frame as the queried `IndexedMesh.positions`). */
  point: readonly [number, number, number];
  /** Euclidean distance from the query point to `point`, mm. Always >= 0. */
  distance: number;
  /** Lowest-index triangle achieving the minimum distance (deterministic
   * tie-break — see this module's top-level doc / build.ts). */
  triangleIndex: number;
  /** Barycentric coordinates of `point` within triangle `triangleIndex`,
   * summing to 1 (each component clamped into [0, 1] by construction — see
   * closestPoint.ts's `closestPointOnTriangle`). */
  barycentric: readonly [number, number, number];
}

/** Result of a `raycast` query — see raycast.ts. */
export interface RaycastHit {
  /** World-space Float64 hit point: `origin + direction * distance`. */
  point: readonly [number, number, number];
  /** Ray parameter `t` at the hit (== distance when `direction` is a unit
   * vector, which `raycast` requires — see raycast.ts). Always >= 0. */
  distance: number;
  /** Lowest-index triangle achieving the minimum `t` (deterministic
   * tie-break). */
  triangleIndex: number;
  /** Barycentric coordinates of the hit within triangle `triangleIndex`. */
  barycentric: readonly [number, number, number];
}
