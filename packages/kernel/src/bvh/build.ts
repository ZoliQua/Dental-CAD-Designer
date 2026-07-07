// packages/kernel/src/bvh/build.ts
//
// Static BVH construction: median-split (object-median, on the longest axis
// of each node's bounding box), NOT surface-area-heuristic (SAH).
//
// ## Why median-split over SAH
//
// SAH produces a measurably better (fewer/cheaper traversal steps) tree for
// ray-tracing-style workloads doing millions of queries against a static
// scene, at the cost of a more expensive build (evaluating a cost function
// over candidate split planes, typically via binned buckets). This kernel's
// BVH is queried a handful to a few thousand times per mesh per session
// (interactive point-to-point/point-to-surface picks — see kernel-workers'
// measurePointToSurface/raycastMesh jobs; Task 9's future heatmap batches
// many closestPoint calls but is still bounded, not a ray-traced-frame
// workload), while the brief's hard requirement is build time: "seconds not
// minutes" for 250k-1M triangles, off the UI thread but still bounded.
// Median-split builds in guaranteed O(n log n) with a simple, easily-tested
// deterministic algorithm (see `selectMedian` below); a correct SAH
// implementation is meaningfully more code and build time for a query
// workload that doesn't need it. If a future phase adds a ray-marching-heavy
// feature (e.g. dense per-pixel picking), revisit this choice — the `Bvh`
// type (bvh/types.ts) doesn't encode the build strategy, so swapping the
// builder later doesn't change any consumer.
//
// ## Determinism
//
// Same mesh (same `positions`/`indices` bytes) always produces the exact
// same tree (node bounds, split points, leaf triangle sets) — required by
// this task's brief and exercised by bvh.determinism.test.ts. This holds
// because:
//   - Triangle centroids/bounds are computed once, directly from the input
//     buffers, with no accumulation-order dependence (each triangle's
//     centroid/bounds is independent of every other's).
//   - The per-node split uses `selectMedian`, a quickselect with a
//     DETERMINISTIC pivot strategy (median-of-three of the range's first,
//     middle, and last elements — no `Math.random`) over a STRICT total
//     order (`compareTriangles`: primary key centroid-on-axis, secondary key
//     triangle index — see its doc for why the tie-break makes the ordering
//     strict, which is what makes quickselect's result independent of
//     partition-internal bookkeeping).
//   - Recursion always visits left-then-right in a fixed order.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from './types.ts';

/** Leaves stop splitting at this many triangles. 4 is a common default for
 * this class of BVH (small enough that leaf brute-force scanning is cheap,
 * large enough to keep node count — and therefore build/traversal
 * overhead — well below one node per triangle). */
export const DEFAULT_MAX_LEAF_TRIANGLES = 4;

/** How many leaves to build between `onProgress` callbacks (see
 * `BuildBvhOptions.onProgress`'s doc) — coarse enough that progress
 * reporting itself is not a measurable fraction of build time. */
const DEFAULT_PROGRESS_LEAF_INTERVAL = 4096;

export interface BuildBvhOptions {
  /** See DEFAULT_MAX_LEAF_TRIANGLES. */
  maxLeafTriangles?: number;
  /**
   * Synchronous progress hook, called periodically during the build (every
   * `progressLeafInterval` leaves) with the running count of triangles
   * already assigned to a completed leaf and the mesh's total triangle
   * count. Deliberately synchronous (not `async`/no cancellation hook) —
   * `buildBvh` itself is a synchronous, single-pass computation (matching
   * every other kernel algorithm — weldVertices, analyzeMesh, etc.; see
   * their module docs), so this is a coarse instrumentation point a caller
   * (kernel-workers' `buildBvh` job) can relay into `ctx.progress` for a
   * progress bar, not a way to interrupt an in-flight build. Mid-build
   * cancellation is intentionally out of scope for Phase 1 — a build is
   * bounded to a few seconds even at 1M triangles (see this module's build
   * doc), so the job-level "cancelled before starting" check (see
   * kernel-workers/src/jobs.ts's `buildBvh` handler) is judged sufficient.
   */
  onProgress?: (trianglesInCompletedLeaves: number, totalTriangles: number) => void;
  progressLeafInterval?: number;
}

/** Reserved root-node index for the (degenerate) empty-mesh BVH — see
 * `buildBvh`'s zero-triangle branch. Traversal (closestPoint/raycast) checks
 * `bvh.triangleCount === 0` up front and never actually visits this node. */
const EMPTY_BVH_ROOT = 0;

function emptyBvh(): Bvh {
  return {
    triangleCount: 0,
    nodeBoundsMin: new Float64Array([Infinity, Infinity, Infinity]),
    nodeBoundsMax: new Float64Array([-Infinity, -Infinity, -Infinity]),
    nodeLeft: new Int32Array([-1]),
    nodeRight: new Int32Array([-1]),
    nodeLeafStart: new Int32Array([0]),
    nodeLeafCount: new Int32Array([0]),
    triangleIndices: new Uint32Array(0),
    rootNode: EMPTY_BVH_ROOT,
  };
}

/**
 * Strict total order over triangle indices for a given split axis: primary
 * key is the triangle's centroid coordinate on that axis, secondary key
 * (breaking exact centroid ties) is the triangle index itself. Because
 * triangle indices are pairwise distinct, this is a genuine strict total
 * order (no two distinct triangles ever compare equal) — see this module's
 * top-of-file "Determinism" note for why that property is what makes
 * `selectMedian`'s result independent of the specific quickselect
 * implementation details.
 */
function compareTriangles(centroids: Float64Array, axis: number, a: number, b: number): number {
  const ca = centroids[a * 3 + axis]!;
  const cb = centroids[b * 3 + axis]!;
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a - b;
}

function swap(arr: Uint32Array, i: number, j: number): void {
  const tmp = arr[i]!;
  arr[i] = arr[j]!;
  arr[j] = tmp;
}

/** Position (within `[lo, hi]`) of the median-of-three among `arr[lo]`,
 * `arr[mid]`, `arr[hi]` under `compareTriangles` — the deterministic pivot
 * strategy `selectMedian` uses (protects against quickselect's worst-case
 * O(n^2) blowup on already-sorted/reverse-sorted ranges, which a
 * triangle-index-ordered mesh with spatially-coherent authoring order could
 * plausibly produce with a naive first/last-element pivot). */
function medianOfThreePosition(
  arr: Uint32Array,
  lo: number,
  hi: number,
  centroids: Float64Array,
  axis: number,
): number {
  const mid = lo + ((hi - lo) >> 1);
  const a = arr[lo]!;
  const b = arr[mid]!;
  const c = arr[hi]!;
  const ab = compareTriangles(centroids, axis, a, b);
  const bc = compareTriangles(centroids, axis, b, c);
  const ac = compareTriangles(centroids, axis, a, c);
  if (ab < 0) {
    if (bc < 0) return mid; // a < b < c
    return ac < 0 ? hi : lo; // a < c <= b -> c ; c <= a < b -> a
  }
  if (ac < 0) return lo; // b <= a < c -> a
  return bc < 0 ? hi : mid; // b < c <= a -> c ; c <= b <= a -> b
}

/**
 * In-place quickselect: after this call, `arr[targetPos]` holds the element
 * that would occupy that position under `compareTriangles`, with every
 * element in `[lo, targetPos)` comparing `<=` it and every element in
 * `(targetPos, hi]` comparing `>=` it (Lomuto partitioning around a
 * median-of-three pivot — see `medianOfThreePosition`'s doc for why that
 * pivot choice is what keeps this O(n) average / bounded worst case, and
 * deterministic).
 */
function selectMedian(
  arr: Uint32Array,
  loIn: number,
  hiIn: number,
  targetPos: number,
  centroids: Float64Array,
  axis: number,
): void {
  let lo = loIn;
  let hi = hiIn;
  while (lo < hi) {
    const pivotPos = medianOfThreePosition(arr, lo, hi, centroids, axis);
    swap(arr, pivotPos, hi);
    const pivot = arr[hi]!;
    let store = lo;
    for (let i = lo; i < hi; i++) {
      if (compareTriangles(centroids, axis, arr[i]!, pivot) < 0) {
        swap(arr, i, store);
        store++;
      }
    }
    swap(arr, store, hi);
    if (store === targetPos) return;
    if (targetPos < store) hi = store - 1;
    else lo = store + 1;
  }
}

/** Per-triangle precomputed data the builder needs repeatedly — computed
 * once up front (O(n)) rather than re-derived from `mesh` on every node
 * visit. */
interface TriangleData {
  centroids: Float64Array; // 3 per triangle
  boundsMin: Float64Array; // 3 per triangle
  boundsMax: Float64Array; // 3 per triangle
}

function computeTriangleData(mesh: IndexedMesh, triangleCount: number): TriangleData {
  const centroids = new Float64Array(triangleCount * 3);
  const boundsMin = new Float64Array(triangleCount * 3);
  const boundsMax = new Float64Array(triangleCount * 3);
  const { positions, indices } = mesh;

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3]!;
    const i1 = indices[t * 3 + 1]!;
    const i2 = indices[t * 3 + 2]!;
    for (let axis = 0; axis < 3; axis++) {
      const v0 = positions[i0 * 3 + axis]!;
      const v1 = positions[i1 * 3 + axis]!;
      const v2 = positions[i2 * 3 + axis]!;
      const lo = Math.min(v0, v1, v2);
      const hi = Math.max(v0, v1, v2);
      boundsMin[t * 3 + axis] = lo;
      boundsMax[t * 3 + axis] = hi;
      centroids[t * 3 + axis] = (v0 + v1 + v2) / 3;
    }
  }
  return { centroids, boundsMin, boundsMax };
}

/** Growable node storage during build — converted to the flat typed arrays
 * `Bvh` exposes once the recursion finishes (see `buildBvh`'s return). Plain
 * JS arrays (not preallocated typed arrays) because the final node count
 * isn't known ahead of time (it depends on how the median splits land
 * relative to `maxLeafTriangles`) and V8 grows a numeric-only array
 * efficiently; the one-time `Float64Array.from`/`Int32Array.from` copy at
 * the end is a small, bounded, O(nodeCount) cost.
 */
interface NodeBuilder {
  minX: number[];
  minY: number[];
  minZ: number[];
  maxX: number[];
  maxY: number[];
  maxZ: number[];
  left: number[];
  right: number[];
  leafStart: number[];
  leafCount: number[];
}

function newNodeBuilder(): NodeBuilder {
  return {
    minX: [], minY: [], minZ: [], maxX: [], maxY: [], maxZ: [],
    left: [], right: [], leafStart: [], leafCount: [],
  };
}

/** Reserves a new node slot, returning its index. Bounds/children/leaf
 * fields are filled in by the caller immediately after (see `buildRange`) —
 * this only handles the array-growth bookkeeping. */
function allocateNode(nodes: NodeBuilder): number {
  const index = nodes.minX.length;
  nodes.minX.push(0); nodes.minY.push(0); nodes.minZ.push(0);
  nodes.maxX.push(0); nodes.maxY.push(0); nodes.maxZ.push(0);
  nodes.left.push(-1); nodes.right.push(-1);
  nodes.leafStart.push(0); nodes.leafCount.push(0);
  return index;
}

/**
 * Builds an axis-aligned `mesh`'s BVH, exactly as `buildBvh` (below)
 * documents. Recursive: recursion depth is O(log(triangleCount /
 * maxLeafTriangles)) because every split is an (approximately) balanced
 * median split — ~20 for 1M triangles at the default leaf size — nowhere
 * near JS's default stack limit, so this does not need an explicit-stack
 * iterative rewrite.
 */
function buildRange(
  triIndices: Uint32Array,
  start: number,
  end: number,
  data: TriangleData,
  nodes: NodeBuilder,
  maxLeafTriangles: number,
  progress: { emitted: number; onProgress?: BuildBvhOptions['onProgress']; interval: number; total: number },
): number {
  const nodeIndex = allocateNode(nodes);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = start; i < end; i++) {
    const t = triIndices[i]!;
    const bx0 = data.boundsMin[t * 3]!, by0 = data.boundsMin[t * 3 + 1]!, bz0 = data.boundsMin[t * 3 + 2]!;
    const bx1 = data.boundsMax[t * 3]!, by1 = data.boundsMax[t * 3 + 1]!, bz1 = data.boundsMax[t * 3 + 2]!;
    if (bx0 < minX) minX = bx0;
    if (by0 < minY) minY = by0;
    if (bz0 < minZ) minZ = bz0;
    if (bx1 > maxX) maxX = bx1;
    if (by1 > maxY) maxY = by1;
    if (bz1 > maxZ) maxZ = bz1;
  }
  nodes.minX[nodeIndex] = minX; nodes.minY[nodeIndex] = minY; nodes.minZ[nodeIndex] = minZ;
  nodes.maxX[nodeIndex] = maxX; nodes.maxY[nodeIndex] = maxY; nodes.maxZ[nodeIndex] = maxZ;

  const count = end - start;
  if (count <= maxLeafTriangles) {
    nodes.leafStart[nodeIndex] = start;
    nodes.leafCount[nodeIndex] = count;
    // Deterministic, cheap (leaf size is small) — sorts this leaf's slice of
    // triIndices ascending by triangle index for readability/debuggability.
    // Typed-array `.sort()` with no comparator sorts numerically ascending
    // (unlike Array.prototype.sort's default lexicographic sort) — exactly
    // what's wanted here.
    triIndices.subarray(start, end).sort();

    progress.emitted += count;
    if (progress.onProgress && progress.emitted % progress.interval < count) {
      progress.onProgress(progress.emitted, progress.total);
    }
    return nodeIndex;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const axis = spanX >= spanY && spanX >= spanZ ? 0 : spanY >= spanZ ? 1 : 2;

  const mid = start + (count >> 1);
  selectMedian(triIndices, start, end - 1, mid, data.centroids, axis);

  const left = buildRange(triIndices, start, mid, data, nodes, maxLeafTriangles, progress);
  const right = buildRange(triIndices, mid, end, data, nodes, maxLeafTriangles, progress);
  nodes.left[nodeIndex] = left;
  nodes.right[nodeIndex] = right;
  return nodeIndex;
}

/**
 * Builds a static triangle BVH over `mesh` — see this module's top-of-file
 * doc for the median-split-vs-SAH tradeoff and the determinism argument.
 *
 * @errorBound None beyond ordinary Float64 rounding: node bounds are exact
 * (min/max over each triangle's exact vertex coordinates, no approximation),
 * so a correctly-implemented traversal (closestPoint.ts/raycast.ts) can
 * never incorrectly prune a node that actually contains the true answer.
 */
export function buildBvh(mesh: IndexedMesh, options: BuildBvhOptions = {}): Bvh {
  const triangleCount = mesh.indices.length / 3;
  if (!Number.isInteger(triangleCount)) {
    throw new TypeError('buildBvh: mesh.indices.length must be a multiple of 3');
  }
  if (triangleCount === 0) {
    return emptyBvh();
  }

  const maxLeafTriangles = options.maxLeafTriangles ?? DEFAULT_MAX_LEAF_TRIANGLES;
  if (!Number.isInteger(maxLeafTriangles) || maxLeafTriangles < 1) {
    throw new TypeError('buildBvh: maxLeafTriangles must be a positive integer');
  }

  const data = computeTriangleData(mesh, triangleCount);
  const triIndices = new Uint32Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) triIndices[t] = t;

  const nodes = newNodeBuilder();
  const progress = {
    emitted: 0,
    onProgress: options.onProgress,
    interval: options.progressLeafInterval ?? DEFAULT_PROGRESS_LEAF_INTERVAL,
    total: triangleCount,
  };
  const rootNode = buildRange(triIndices, 0, triangleCount, data, nodes, maxLeafTriangles, progress);
  if (options.onProgress) {
    options.onProgress(triangleCount, triangleCount);
  }

  return {
    triangleCount,
    nodeBoundsMin: interleave3(nodes.minX, nodes.minY, nodes.minZ),
    nodeBoundsMax: interleave3(nodes.maxX, nodes.maxY, nodes.maxZ),
    nodeLeft: Int32Array.from(nodes.left),
    nodeRight: Int32Array.from(nodes.right),
    nodeLeafStart: Int32Array.from(nodes.leafStart),
    nodeLeafCount: Int32Array.from(nodes.leafCount),
    triangleIndices: triIndices,
    rootNode,
  };
}

function interleave3(x: readonly number[], y: readonly number[], z: readonly number[]): Float64Array {
  const out = new Float64Array(x.length * 3);
  for (let i = 0; i < x.length; i++) {
    out[i * 3] = x[i]!;
    out[i * 3 + 1] = y[i]!;
    out[i * 3 + 2] = z[i]!;
  }
  return out;
}
