// packages/kernel/src/intersect/selfIntersect.ts
//
// BVH-accelerated whole-mesh self-intersection scan: does ANY pair of the
// mesh's own faces pass through each other? This is the geometric truth the
// `selfIntersection` QC gate now rests on — strictly stronger than the old
// manifold-topology proxy (a topologically-2-manifold, watertight mesh whose
// faces geometrically interpenetrate is accepted by manifold-3d but FAILS
// here). Pure Float64 kernel, no DOM/Three/WASM (layer rule).
//
// ## Broad phase (BVH) → narrow phase (tri-tri), and why it is O(n log n)-ish
//
// A naive scan is O(n²) tri-tri tests. Instead, for each triangle `i` we
// descend the mesh's own BVH (bvh/build.ts) collecting only triangles whose
// AABB overlaps triangle i's AABB — the classic broad phase. Each descent is
// ~O(log n) plus the number of genuinely overlapping candidates `k_i`; total
// cost is O(n log n + Σk_i). For a clean solid (faces overlap only their few
// neighbours) Σk_i = O(n), so the scan is effectively O(n log n). A pathologi-
// cally tangled mesh with many overlapping AABBs degrades toward O(n²) narrow-
// phase tests — acceptable and correct (accuracy over speed; CLAUDE.md), and
// the measured cost is reported by the caller for the QC report.
//
// ## Determinism
//
// The result (pair count, first locus, skipped count) is independent of BVH
// traversal order: we count each unordered pair once by only acting on
// candidates `j > i`, and `firstLocus` is defined as the lexicographically
// smallest (i, j) intersecting pair over the WHOLE scan — not "the first one
// traversal happened to hit". No Date.now / randomness / scheduling anywhere.
//
// ## Topological adjacency is EXCLUDED (not a self-intersection)
//
// Two faces that share ≥1 vertex INDEX meet at that shared vertex/edge by
// construction — that contact is topology, not a self-intersection — so such
// pairs are excluded before the tri-tri predicate ever runs. This is exact on
// a welded indexed mesh (coincident vertices share one index), which every
// mesh reaching a kernel op is, per the intake invariant (CLAUDE.md: "every-
// thing goes through the intake pipeline before any kernel op"; manifold-3d
// output is welded). On an UN-welded mesh two coincident-but-differently-
// indexed neighbours would not be excluded and their shared-edge touch would
// be (correctly, geometrically) reported — hence the welded-input assumption
// is documented, not silently assumed.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from '../bvh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { checkDegenerateTriangle } from '../intake/degenerate.ts';
import { triangleTriangleIntersect, readTriangle, type MutableVec3 } from './triangleTriangle.ts';

/** A single self-intersecting face pair (triangle indices, `a < b`). */
export interface SelfIntersectionLocus {
  readonly triangleA: number;
  readonly triangleB: number;
}

export interface SelfIntersectionScanResult {
  /** Count of distinct unordered face pairs that genuinely intersect
   * (topologically-adjacent pairs and degenerate triangles excluded). 0 ⇒
   * the mesh is provably free of triangle–triangle self-intersection up to
   * the predicate's `@errorBound`. */
  readonly intersectingPairCount: number;
  /** The lexicographically-smallest intersecting pair (for the QC report's
   * "first locus"), or null when `intersectingPairCount === 0`. Deterministic
   * regardless of traversal order. */
  readonly firstLocus: SelfIntersectionLocus | null;
  /** Degenerate (zero-area) triangles excluded from pairing — surfaced (not
   * silently dropped) so the caller can disclose them. Expected 0 for an
   * intake-repaired mesh. */
  readonly degenerateTrianglesSkipped: number;
  /** Triangle count scanned (== mesh.indices.length / 3) — for the report. */
  readonly triangleCount: number;
  /** Narrow-phase tri-tri predicate evaluations actually run — the honest
   * cost metric for the report (the broad phase's job is to keep this ≪ n²). */
  readonly candidatePairsTested: number;
}

/** Do triangles i and j share at least one vertex index (⇒ topologically
 * adjacent — excluded)? */
function shareVertexIndex(indices: Uint32Array, i: number, j: number): boolean {
  const ia = indices[i * 3]!;
  const ib = indices[i * 3 + 1]!;
  const ic = indices[i * 3 + 2]!;
  const ja = indices[j * 3]!;
  const jb = indices[j * 3 + 1]!;
  const jc = indices[j * 3 + 2]!;
  return (
    ia === ja ||
    ia === jb ||
    ia === jc ||
    ib === ja ||
    ib === jb ||
    ib === jc ||
    ic === ja ||
    ic === jb ||
    ic === jc
  );
}

export interface SelfIntersectionScanOptions {
  /** Reuse a BVH already built over this exact mesh (same triangle count) —
   * lets a caller that has one avoid a rebuild. When omitted, the scan builds
   * its own. */
  readonly bvh?: Bvh;
}

/**
 * Scans `mesh` for genuine self-intersections — see the module doc for the
 * broad/narrow-phase split, the determinism guarantee, and the
 * topological-adjacency exclusion.
 *
 * @errorBound Inherits `triangleTriangleIntersect`'s bound exactly (exact for
 * non-degenerate, non-coplanar Float64 face pairs; a 1e-9 mm on-plane snap for
 * coplanar/near-coplanar configs). The broad phase itself is exact — a BVH
 * node's AABB is the exact min/max of its triangles' exact vertices, so no
 * candidate pair that actually intersects is ever pruned. Degenerate triangles
 * are excluded from pairing and counted, never silently guessed.
 */
export function findSelfIntersections(
  mesh: IndexedMesh,
  options: SelfIntersectionScanOptions = {},
): SelfIntersectionScanResult {
  const triangleCount = mesh.indices.length / 3;
  if (!Number.isInteger(triangleCount)) {
    throw new TypeError('findSelfIntersections: mesh.indices.length must be a multiple of 3');
  }

  const bvh = options.bvh ?? buildBvh(mesh);
  if (bvh.triangleCount !== triangleCount) {
    throw new TypeError(
      'findSelfIntersections: provided bvh.triangleCount does not match the mesh',
    );
  }

  // Precompute per-triangle degeneracy once (skip these from all pairing).
  const degenerate = new Uint8Array(triangleCount);
  let degenerateTrianglesSkipped = 0;
  for (let t = 0; t < triangleCount; t++) {
    if (checkDegenerateTriangle(mesh, t).degenerate) {
      degenerate[t] = 1;
      degenerateTrianglesSkipped++;
    }
  }

  const {
    nodeBoundsMin,
    nodeBoundsMax,
    nodeLeft,
    nodeRight,
    nodeLeafStart,
    nodeLeafCount,
    triangleIndices,
  } = bvh;
  const { indices } = mesh;

  // Reusable vertex scratch — allocation-free narrow phase (module doc).
  const av: [MutableVec3, MutableVec3, MutableVec3] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bv: [MutableVec3, MutableVec3, MutableVec3] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  // Reusable traversal stack (node indices) — grows if a pathological tree
  // ever needs more than the initial depth (never silently overflows).
  let stack = new Int32Array(64);

  let intersectingPairCount = 0;
  let candidatePairsTested = 0;
  let firstA = -1;
  let firstB = -1;

  for (let i = 0; i < triangleCount; i++) {
    if (degenerate[i] === 1) continue;

    // Triangle i's AABB (exact, from its three vertices).
    const iBase = i * 3;
    let iMinX = Infinity,
      iMinY = Infinity,
      iMinZ = Infinity;
    let iMaxX = -Infinity,
      iMaxY = -Infinity,
      iMaxZ = -Infinity;
    for (let k = 0; k < 3; k++) {
      const vi = indices[iBase + k]! * 3;
      const x = mesh.positions[vi]!;
      const y = mesh.positions[vi + 1]!;
      const z = mesh.positions[vi + 2]!;
      if (x < iMinX) iMinX = x;
      if (y < iMinY) iMinY = y;
      if (z < iMinZ) iMinZ = z;
      if (x > iMaxX) iMaxX = x;
      if (y > iMaxY) iMaxY = y;
      if (z > iMaxZ) iMaxZ = z;
    }

    const tri1 = readTriangle(mesh, i, av);

    // Descend the BVH collecting candidates j > i whose AABB overlaps i's.
    let sp = 0;
    stack[sp++] = bvh.rootNode;
    while (sp > 0) {
      const node = stack[--sp]!;
      const nb = node * 3;
      // AABB–AABB overlap of node box vs triangle i's box (separating-axis).
      if (
        nodeBoundsMax[nb]! < iMinX ||
        nodeBoundsMin[nb]! > iMaxX ||
        nodeBoundsMax[nb + 1]! < iMinY ||
        nodeBoundsMin[nb + 1]! > iMaxY ||
        nodeBoundsMax[nb + 2]! < iMinZ ||
        nodeBoundsMin[nb + 2]! > iMaxZ
      ) {
        continue;
      }
      const left = nodeLeft[node]!;
      if (left === -1) {
        // Leaf: test its triangles.
        const start = nodeLeafStart[node]!;
        const end = start + nodeLeafCount[node]!;
        for (let s = start; s < end; s++) {
          const j = triangleIndices[s]!;
          if (j <= i) continue; // each unordered pair once, deterministically.
          if (degenerate[j] === 1) continue;
          if (shareVertexIndex(indices, i, j)) continue; // topological adjacency.
          const tri2 = readTriangle(mesh, j, bv);
          candidatePairsTested++;
          if (triangleTriangleIntersect(tri1[0], tri1[1], tri1[2], tri2[0], tri2[1], tri2[2])) {
            intersectingPairCount++;
            // Track lexicographically-smallest (i, j) — traversal-order-free.
            if (firstA === -1 || i < firstA || (i === firstA && j < firstB)) {
              firstA = i;
              firstB = j;
            }
          }
        }
      } else {
        if (sp + 2 > stack.length) {
          const grown = new Int32Array(stack.length * 2);
          grown.set(stack);
          stack = grown;
        }
        stack[sp++] = left;
        stack[sp++] = nodeRight[node]!;
      }
    }
  }

  return {
    intersectingPairCount,
    firstLocus: firstA === -1 ? null : { triangleA: firstA, triangleB: firstB },
    degenerateTrianglesSkipped,
    triangleCount,
    candidatePairsTested,
  };
}
