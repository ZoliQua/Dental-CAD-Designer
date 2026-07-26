// packages/kernel/src/cavity/regions.ts
//
// Phase 5 Task 2: cavity region analysis — classify the cavity surface into
// FLOOR / AXIAL WALLS / PROXIMAL-BOX WALLS relative to the insertion axis,
// and expose the insertion-axis suitability scan for the cavity region.
// Every region is returned in the `AxisRegion` currency (axis/roi.ts —
// triangle-index subsets of the ORIGINAL mesh, sorted ascending, never a
// separate mesh), so downstream consumers (Phase 5 Task 5's scoped
// box-contact adaptation, Task 3's blockout) index straight back into the
// same `IndexedMesh`.
//
// ## Geometric definitions (all relative to the unit insertion axis `a`)
//
//  1. CAVITY REGION — the surface ENCLOSED by the cavity outline (the
//     margin currency: a dense, closed, on-mesh ring — the same
//     `resampledPoints`-shaped polyline margin/band.ts consumes; this
//     module runs it through `marginLoopPolyline` first, so dedup/closure
//     handling is the margin machinery's, not a reimplementation).
//     The outline's points are snapped to mesh VERTICES (bit-exact
//     coordinate lookup first, nearest-vertex fallback within
//     `MESH_WELD_EPSILON_MM` — a typed error beyond that: an outline that
//     is not on the mesh is a caller bug, not something to silently
//     "repair"), and consecutive outline vertices must be mesh-EDGE
//     neighbors, making the outline a closed edge ring. A closed simple
//     edge ring on a closed 2-manifold separates it into exactly TWO
//     components (Jordan; a different count is a typed error) — found by a
//     deterministic flood fill over triangle adjacency with the ring's
//     edges as barriers. The CAVITY is the component whose area-weighted
//     outward-normal sum (axis/roi.ts's `regionAreaWeightedNormalSum`,
//     reused) has POSITIVE mean projection on `a`: a cavity OPENS toward
//     the insertion axis, and on a closed mesh the two components' area
//     vectors are exact negatives (total = 0), so exactly one side
//     qualifies — both-near-zero (axis perpendicular to the opening) is a
//     typed `AmbiguousCavitySideError`.
//
//     WHY NOT `extractMarginRegion` (axis/roi.ts) for this step, despite
//     the family resemblance: that op is a RADIUS-LIMITED Dijkstra ball
//     AROUND a margin loop — by construction it includes triangles on BOTH
//     sides of the loop and cuts off at an arbitrary radius, which is
//     exactly right for an axis-search ROI band and exactly wrong for a
//     region whose acceptance criterion is an EXACT boundary (closed-form
//     per-region triangle counts, zero misclassified triangles — this
//     task's brief). What IS reused from axis/: the `AxisRegion` currency,
//     `regionAreaWeightedNormalSum`, `regionTriangleAreasMm2`, and
//     `undercutScanIndices` for the suitability scan below.
//
//  2. FLOOR — a cavity triangle FACING the axis: `normal . a >=
//     cos(floorMaxAngleDeg)`. Default `CAVITY_FLOOR_MAX_ANGLE_DEG` (45) —
//     see that constant's doc for the separation argument.
//
//  3. WALLS — every other cavity triangle (steep, near-perpendicular, or
//     genuinely overhanging/undercut — an undercut wall is still a WALL;
//     draft problems are the SCAN's job, not the classifier's).
//
//  4. PROXIMAL BOXES — floor triangles are grouped into edge-connected
//     components; each component's LEVEL is its area-weighted mean centroid
//     height along `a`. The REFERENCE level is the HIGHEST component (the
//     pulpal/isthmus floor). A component is a PROXIMAL-BOX floor iff it
//     steps DOWN from the reference by at least `floorStepMinMm` (default
//     `CAVITY_FLOOR_STEP_MIN_MM`) AND its axis-perpendicular offset from
//     the cavity's own area-weighted centroid is well-defined (the
//     PROXIMAL DIRECTION `p`; a deep component with no horizontal offset —
//     a centered pulpal extension — is deep floor, not a proximal box; see
//     `proximalDirectionUnit`).
//
//  5. BOX WALLS — a wall triangle belongs to box B iff its centroid lies
//     AT or BEYOND B's pulpal step along B's proximal direction:
//     `centroid . p >= min(v . p over B's floor vertices) -
//     CAVITY_ZONE_BOUNDARY_EPSILON_MM`. The box floor's nearest extent
//     along `p` IS the pulpal step line, so this half-space test puts the
//     transverse pulpal/step walls (centroids exactly ON the step plane,
//     up to Float64 rounding — hence the epsilon) in the box, matching the
//     dental reading (the step walls are the boxes' pulpal walls —
//     cavity.test-fixtures.ts's own doc). A triangle passing several
//     boxes' tests (not possible on the fixture; conceivable on exotic
//     geometry) goes to the box with the LARGEST margin beyond the step —
//     deterministic. AXIAL WALLS are the walls in no box.
//
// ## Thresholds are documented ALGORITHM parameters (not clinical values)
//
// `floorMaxAngleDeg`/`floorStepMinMm` are geometric definition knobs of
// this classifier (echoed in the result for journaling when a pipeline
// stage consumes this op), not clinical-profiles values — same judgment
// call as margin/validate.ts's own documented constants. Nothing here reads
// or hardcodes a clinical gap/thickness.
//
// @errorBound Exact (Float64) — no interpolation, iteration, or
// approximation of a continuous quantity: every classification is a direct
// comparison of exact triangle quantities (unit-normal dot products, vertex/
// centroid projections) against the documented thresholds. The two places
// judgment (not float noise) enters are the threshold DEFAULTS themselves
// (documented at their constants) and `CAVITY_ZONE_BOUNDARY_EPSILON_MM`
// (which only absorbs last-ULP rounding at the exact step plane, orders of
// magnitude below any real feature — see its doc). Determinism: pure
// function of (mesh bytes, outline, axis, options); no randomness, no time,
// no iteration-order dependence (all traversals run in ascending index
// order; outputs are sorted).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { Bvh } from '../bvh/types.ts';
import { MESH_WELD_EPSILON_MM } from '../intake/weld.ts';
import { marginLoopPolyline } from '../margin/band.ts';
import type { AxisRegion } from '../axis/roi.ts';
import { regionAreaWeightedNormalSum, regionTriangleAreasMm2 } from '../axis/roi.ts';
import { dot, normalizeOrZero, sub, triangleUnitNormal, triangleVertexPositions } from '../axis/vec.ts';
import { undercutScanIndices, type UndercutScanIndicesResult, type UndercutScanOptions } from '../undercut/undercutScan.ts';

// ---------------------------------------------------------------------------
// Documented algorithmic defaults
// ---------------------------------------------------------------------------

/** Max angle (degrees) between a triangle's outward normal and the insertion
 * axis for the triangle to classify as FLOOR — the floor/wall definition
 * boundary. 45: on any machined cavity the two populations are far apart —
 * the MOD fixture's floors are EXACTLY axis-facing (0 deg) and its walls sit
 * at 90 deg minus the draft half-angle (78-88 deg over the fixture's whole
 * documented 2-12 deg taper range), so 45 has > 30 deg of clearance to BOTH
 * populations; a real bur-machined cavity's pulpal/gingival floors vs
 * axial walls separate the same way (floors are cut near-perpendicular to
 * the bur axis, walls near-parallel). An ALGORITHM parameter (echoed in the
 * result for journaling), not a clinical value. */
export const CAVITY_FLOOR_MAX_ANGLE_DEG = 45;

/** Minimum step DOWN (mm, along the axis) from the reference (highest)
 * floor level for a floor component to qualify as a PROXIMAL-BOX floor.
 * 0.5: well above tessellation/curvature noise on a floor that is
 * genuinely one level (exactly 0 on the fixture's flat floors), well below
 * any real Class II gingival step (the fixture default is 1.5mm =
 * boxDepthMm - isthmusDepthMm; clinically the box gingival floor sits
 * multiple mm below the pulpal floor). An ALGORITHM parameter (echoed in
 * the result for journaling), not a clinical value. */
export const CAVITY_FLOOR_STEP_MIN_MM = 0.5;

/** Tie-break tolerance (mm) at the pulpal-step plane for box-wall
 * assignment — absorbs last-ULP Float64 rounding of centroid/projection
 * arithmetic for triangles whose centroid lies EXACTLY on the step plane
 * (the fixture's transverse pulpal walls: `(3a)/3` need not equal `a`
 * bitwise). 1e-9mm sits ~7 orders above that rounding noise and ~5 orders
 * below any real tessellation feature (the nearest competing triangle
 * centroid is a third of a segment length away, >= tens of microns). */
export const CAVITY_ZONE_BOUNDARY_EPSILON_MM = 1e-9;

/** Minimum |area-weighted mean normal projection| on the axis for the
 * cavity/outer side decision to be meaningful — below this on BOTH sides,
 * the axis is (numerically) perpendicular to the opening and no side
 * "opens" along it (`AmbiguousCavitySideError`). Mean projection is
 * dimensionless (|sum| / totalArea, in [-1, 1]); 1e-9 is far above Float64
 * cancellation noise of the area-weighted sums, far below any genuine
 * opening's projection (the fixture cavity's mean projection along its own
 * axis is ~0.9). */
export const CAVITY_SIDE_MIN_MEAN_PROJECTION = 1e-9;

// ---------------------------------------------------------------------------
// Typed errors — explicit fields only (NO TypeScript constructor parameter
// properties: kernel/src is inside the Node worker's strip-only-TS loader
// closure, where parameter properties crash the loader — the Task 1
// landmine, see cad-pipeline/pipeline/context.ts's RestorationTypeMismatchError).
// ---------------------------------------------------------------------------

/** An outline point is not on the mesh (no vertex within
 * `MESH_WELD_EPSILON_MM`) — the outline currency contract requires on-mesh
 * points (the fixture's are bit-exact mesh vertices; a confirmed margin's
 * resampled points are on-surface by construction). */
export class CavityOutlineNotOnMeshError extends Error {
  readonly outlineIndex: number;
  readonly pointMm: Vec3;
  readonly nearestDistanceMm: number;
  constructor(outlineIndex: number, pointMm: Vec3, nearestDistanceMm: number) {
    super(
      `classifyCavityRegions: outline point ${outlineIndex} (${pointMm.join(', ')}) is not a mesh vertex — ` +
        `nearest vertex is ${nearestDistanceMm}mm away (> ${MESH_WELD_EPSILON_MM}mm weld epsilon)`,
    );
    this.name = 'CavityOutlineNotOnMeshError';
    this.outlineIndex = outlineIndex;
    this.pointMm = pointMm;
    this.nearestDistanceMm = nearestDistanceMm;
  }
}

/** Two consecutive outline points snapped to mesh vertices that do NOT
 * share a mesh edge — the outline must be a closed EDGE ring for the
 * barrier flood fill to have an exact boundary (this module's doc, def 1). */
export class CavityOutlineNotEdgeConnectedError extends Error {
  readonly fromOutlineIndex: number;
  readonly toOutlineIndex: number;
  constructor(fromOutlineIndex: number, toOutlineIndex: number) {
    super(
      `classifyCavityRegions: consecutive outline points ${fromOutlineIndex} -> ${toOutlineIndex} do not share a ` +
        `mesh edge — the cavity outline must be a dense, edge-connected ring on the mesh`,
    );
    this.name = 'CavityOutlineNotEdgeConnectedError';
    this.fromOutlineIndex = fromOutlineIndex;
    this.toOutlineIndex = toOutlineIndex;
  }
}

/** The outline ring did not separate the mesh into exactly two components —
 * a leaking (non-closed/non-simple) ring or a non-manifold mesh. */
export class CavityPartitionError extends Error {
  readonly componentCount: number;
  constructor(componentCount: number) {
    super(
      `classifyCavityRegions: the outline ring separated the mesh into ${componentCount} component(s), expected ` +
        `exactly 2 (a closed simple edge ring on a closed 2-manifold) — leaking or degenerate outline?`,
    );
    this.name = 'CavityPartitionError';
    this.componentCount = componentCount;
  }
}

/** Neither side of the outline ring opens along the given axis (both mean
 * normal projections below `CAVITY_SIDE_MIN_MEAN_PROJECTION`, or both on
 * the same side) — the axis is perpendicular/degenerate to the opening. */
export class AmbiguousCavitySideError extends Error {
  readonly meanProjectionA: number;
  readonly meanProjectionB: number;
  constructor(meanProjectionA: number, meanProjectionB: number) {
    super(
      `classifyCavityRegions: cannot decide which side of the outline is the cavity — mean normal projections on ` +
        `the axis are ${meanProjectionA} and ${meanProjectionB} (need one > ${CAVITY_SIDE_MIN_MEAN_PROJECTION} and ` +
        `the other < -${CAVITY_SIDE_MIN_MEAN_PROJECTION}); is the insertion axis perpendicular to the opening?`,
    );
    this.name = 'AmbiguousCavitySideError';
    this.meanProjectionA = meanProjectionA;
    this.meanProjectionB = meanProjectionB;
  }
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface ClassifyCavityRegionsOptions {
  /** Default `CAVITY_FLOOR_MAX_ANGLE_DEG`. */
  floorMaxAngleDeg?: number;
  /** Default `CAVITY_FLOOR_STEP_MIN_MM`. */
  floorStepMinMm?: number;
}

/** One proximal box — all regions in the `AxisRegion` currency (Phase 5
 * Task 5 consumes `walls`/`region` directly for scoped contact adaptation). */
export interface CavityBoxRegion {
  /** The box's (deep) gingival-floor component. */
  readonly floor: AxisRegion;
  /** The box's walls: the drafted wall subsets in the box zone plus the
   * transverse pulpal/step wall (this module's doc, def 5). */
  readonly walls: AxisRegion;
  /** `floor` ∪ `walls`, sorted. */
  readonly region: AxisRegion;
  /** Unit axis-perpendicular direction from the cavity centroid toward this
   * box (the "proximal direction" — ~ -X mesial / +X distal on the fixture). */
  readonly proximalDirectionUnit: Vec3;
  /** The box floor's area-weighted mean height along the axis (mm). */
  readonly floorLevelMm: number;
}

export interface CavityRegionsResult {
  /** The axis actually used (normalized). */
  readonly axisUnit: Vec3;
  /** Every triangle inside the outline (floor ∪ walls). */
  readonly cavity: AxisRegion;
  /** All floor triangles (reference/pulpal + box gingival floors). */
  readonly floor: AxisRegion;
  /** All wall triangles (axialWalls ∪ boxWalls). */
  readonly walls: AxisRegion;
  /** Walls belonging to no proximal box. */
  readonly axialWalls: AxisRegion;
  /** Union of every box's walls. */
  readonly boxWalls: AxisRegion;
  /** Proximal boxes, ordered by their floor component's smallest triangle
   * index (deterministic). Empty when no floor component steps down by
   * `floorStepMinMm` (a single-level cavity — no Class II boxes). */
  readonly boxes: readonly CavityBoxRegion[];
  /** The reference (highest) floor level along the axis, mm — `null` iff
   * `floor` is empty. */
  readonly floorReferenceLevelMm: number | null;
  /** Echo of the documented algorithm parameters this run used (journaling
   * currency for the pipeline stage that will consume this op). */
  readonly floorMaxAngleDeg: number;
  readonly floorStepMinMm: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function normalizeAxis(axis: Vec3, callerName: string): Vec3 {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(len > 0)) {
    throw new TypeError(`${callerName}: insertionAxisUnit must be a non-zero-length vector`);
  }
  return [axis[0] / len, axis[1] / len, axis[2] / len];
}

function vertexPos(mesh: IndexedMesh, v: number): Vec3 {
  return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
}

function triangleCentroid(mesh: IndexedMesh, t: number): Vec3 {
  const [a, b, c] = triangleVertexPositions(mesh, t);
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/** Snap every (deduplicated) outline point to a mesh vertex index —
 * bit-exact coordinate-key lookup first (the fixture path: outline points
 * ARE mesh vertices), nearest-vertex linear scan within
 * `MESH_WELD_EPSILON_MM` as the fallback (documented contract; typed error
 * beyond). Deterministic: exact map keeps the FIRST vertex per coordinate,
 * the fallback scans in ascending vertex order taking strict improvements. */
function snapOutlineToVertices(mesh: IndexedMesh, loop: readonly Vec3[]): number[] {
  const exact = new Map<string, number>();
  const vertexCount = mesh.positions.length / 3;
  for (let v = 0; v < vertexCount; v++) {
    const k = `${mesh.positions[v * 3]}|${mesh.positions[v * 3 + 1]}|${mesh.positions[v * 3 + 2]}`;
    if (!exact.has(k)) exact.set(k, v);
  }
  const snapped: number[] = [];
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!;
    const hit = exact.get(`${p[0]}|${p[1]}|${p[2]}`);
    if (hit !== undefined) {
      snapped.push(hit);
      continue;
    }
    let best = -1;
    let bestDist = Infinity;
    for (let v = 0; v < vertexCount; v++) {
      const d = Math.hypot(mesh.positions[v * 3]! - p[0], mesh.positions[v * 3 + 1]! - p[1], mesh.positions[v * 3 + 2]! - p[2]);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    if (!(bestDist <= MESH_WELD_EPSILON_MM)) {
      throw new CavityOutlineNotOnMeshError(i, p, bestDist);
    }
    snapped.push(best);
  }
  // Collapse consecutive duplicate vertex indices (two sub-weld-epsilon-
  // separated outline points can legally snap to the same vertex), wrapping.
  const ring: number[] = [];
  for (const v of snapped) {
    if (ring.length === 0 || ring[ring.length - 1] !== v) ring.push(v);
  }
  while (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
  return ring;
}

function edgeKeyOf(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

function sortedRegion(indices: readonly number[]): AxisRegion {
  return { triangleIndices: Uint32Array.from([...indices].sort((a, b) => a - b)) };
}

/** Area-weighted centroid over a triangle list — `areas` aligned 1:1 with
 * `tris` (the `regionTriangleAreasMm2` convention). */
function areaWeightedCentroid(mesh: IndexedMesh, tris: readonly number[], areas: Float64Array): Vec3 {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let total = 0;
  for (let i = 0; i < tris.length; i++) {
    const c = triangleCentroid(mesh, tris[i]!);
    const w = areas[i]!;
    sx += c[0] * w;
    sy += c[1] * w;
    sz += c[2] * w;
    total += w;
  }
  return total > 0 ? [sx / total, sy / total, sz / total] : [0, 0, 0];
}

/**
 * Unit proximal direction for a candidate box: the offset from the cavity's
 * area-weighted centroid to the deep floor component's centroid, projected
 * perpendicular to the axis and normalized — or `null` when that projection
 * is (numerically) zero: a deep component with no horizontal offset (a
 * centered pulpal extension) has no well-defined proximal direction and is
 * treated as deep FLOOR, not a proximal box (this module's doc, def 4).
 * Exported for direct unit-testing of the degenerate guard.
 */
export function proximalDirectionUnit(cavityCentroidMm: Vec3, floorComponentCentroidMm: Vec3, axisUnit: Vec3): Vec3 | null {
  const offset = sub(floorComponentCentroidMm, cavityCentroidMm);
  const along = dot(offset, axisUnit);
  const perp: Vec3 = [offset[0] - along * axisUnit[0], offset[1] - along * axisUnit[1], offset[2] - along * axisUnit[2]];
  const unit = normalizeOrZero(perp);
  if (Math.hypot(perp[0], perp[1], perp[2]) <= CAVITY_ZONE_BOUNDARY_EPSILON_MM) return null;
  return unit;
}

/** Deterministic flood fill over triangle adjacency (shared edges), never
 * crossing an edge in `barriers` — components in ascending seed order. */
function components(triangleCount: number, edgeTris: ReadonlyMap<string, readonly number[]>, mesh: IndexedMesh, barriers: ReadonlySet<string>): number[][] {
  const visited = new Uint8Array(triangleCount);
  const comps: number[][] = [];
  for (let seed = 0; seed < triangleCount; seed++) {
    if (visited[seed]) continue;
    const comp: number[] = [];
    const stack = [seed];
    visited[seed] = 1;
    while (stack.length > 0) {
      const t = stack.pop()!;
      comp.push(t);
      const i0 = mesh.indices[t * 3]!;
      const i1 = mesh.indices[t * 3 + 1]!;
      const i2 = mesh.indices[t * 3 + 2]!;
      for (const key of [edgeKeyOf(i0, i1), edgeKeyOf(i1, i2), edgeKeyOf(i2, i0)]) {
        if (barriers.has(key)) continue;
        for (const other of edgeTris.get(key) ?? []) {
          if (!visited[other]) {
            visited[other] = 1;
            stack.push(other);
          }
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

/**
 * Classifies the cavity surface enclosed by `cavityOutline` into floor /
 * axial-wall / proximal-box-wall regions relative to `insertionAxisUnit`
 * (normalized internally) — see this module's top doc for the exact
 * geometric definitions, threshold rationale, and `@errorBound`.
 *
 * Runtime: O(mesh triangles) + O(cavity triangles) with small constants —
 * measured sub-millisecond on the MOD fixture (see the Task 2 report), so
 * this op is synchronous with NO worker job (CLAUDE.md's >~10ms worker
 * threshold; a stage that later runs it on a large real scan re-measures).
 *
 * @throws {TypeError} zero-length axis.
 * @throws {MarginBandChordCapError | DegenerateMarginBandError} outline
 * empty/too short (margin machinery, reused).
 * @throws {CavityOutlineNotOnMeshError} outline point not on the mesh.
 * @throws {CavityOutlineNotEdgeConnectedError} outline not an edge ring.
 * @throws {CavityPartitionError} ring does not split the mesh into 2.
 * @throws {AmbiguousCavitySideError} no side opens along the axis.
 */
export function classifyCavityRegions(
  mesh: IndexedMesh,
  cavityOutline: readonly Vec3[],
  insertionAxisUnit: Vec3,
  options: ClassifyCavityRegionsOptions = {},
): CavityRegionsResult {
  const axisUnit = normalizeAxis(insertionAxisUnit, 'classifyCavityRegions');
  const floorMaxAngleDeg = options.floorMaxAngleDeg ?? CAVITY_FLOOR_MAX_ANGLE_DEG;
  const floorStepMinMm = options.floorStepMinMm ?? CAVITY_FLOOR_STEP_MIN_MM;
  const floorMinDot = Math.cos((floorMaxAngleDeg * Math.PI) / 180);

  // 1) The outline through the margin machinery (dedup/closure — reused).
  const loop = marginLoopPolyline({ closed: true, resampledPoints: cavityOutline });
  const ring = snapOutlineToVertices(mesh, loop);

  // 2) Edge map + barrier ring.
  const triangleCount = mesh.indices.length / 3;
  const edgeTris = new Map<string, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    const i0 = mesh.indices[t * 3]!;
    const i1 = mesh.indices[t * 3 + 1]!;
    const i2 = mesh.indices[t * 3 + 2]!;
    for (const key of [edgeKeyOf(i0, i1), edgeKeyOf(i1, i2), edgeKeyOf(i2, i0)]) {
      let arr = edgeTris.get(key);
      if (!arr) {
        arr = [];
        edgeTris.set(key, arr);
      }
      arr.push(t);
    }
  }
  const barriers = new Set<string>();
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const key = edgeKeyOf(a, b);
    if (!edgeTris.has(key)) {
      throw new CavityOutlineNotEdgeConnectedError(i, (i + 1) % ring.length);
    }
    barriers.add(key);
  }

  // 3) Two components; the cavity is the side that OPENS along the axis.
  const comps = components(triangleCount, edgeTris, mesh, barriers);
  if (comps.length !== 2) {
    throw new CavityPartitionError(comps.length);
  }
  const regionA = sortedRegion(comps[0]!);
  const regionB = sortedRegion(comps[1]!);
  const meanProjection = (region: AxisRegion): number => {
    const areas = regionTriangleAreasMm2(mesh, region);
    let total = 0;
    for (const a of areas) total += a;
    const sum = regionAreaWeightedNormalSum(mesh, region);
    return total > 0 ? dot(sum, axisUnit) / total : 0;
  };
  const projA = meanProjection(regionA);
  const projB = meanProjection(regionB);
  let cavity: AxisRegion;
  if (projA > CAVITY_SIDE_MIN_MEAN_PROJECTION && projB < -CAVITY_SIDE_MIN_MEAN_PROJECTION) {
    cavity = regionA;
  } else if (projB > CAVITY_SIDE_MIN_MEAN_PROJECTION && projA < -CAVITY_SIDE_MIN_MEAN_PROJECTION) {
    cavity = regionB;
  } else {
    throw new AmbiguousCavitySideError(projA, projB);
  }

  // 4) Floor / wall split (facing test — this module's doc, defs 2-3).
  const floorTris: number[] = [];
  const wallTris: number[] = [];
  for (const t of cavity.triangleIndices) {
    const [a, b, c] = triangleVertexPositions(mesh, t);
    const nd = dot(triangleUnitNormal(a, b, c), axisUnit);
    (nd >= floorMinDot ? floorTris : wallTris).push(t);
  }

  // 5) Floor components -> levels -> proximal boxes (defs 4-5).
  const floorSet = new Set(floorTris);
  const floorComps: number[][] = [];
  {
    const visited = new Set<number>();
    for (const seed of floorTris) {
      if (visited.has(seed)) continue;
      const comp: number[] = [];
      const stack = [seed];
      visited.add(seed);
      while (stack.length > 0) {
        const t = stack.pop()!;
        comp.push(t);
        const i0 = mesh.indices[t * 3]!;
        const i1 = mesh.indices[t * 3 + 1]!;
        const i2 = mesh.indices[t * 3 + 2]!;
        for (const key of [edgeKeyOf(i0, i1), edgeKeyOf(i1, i2), edgeKeyOf(i2, i0)]) {
          for (const other of edgeTris.get(key) ?? []) {
            if (floorSet.has(other) && !visited.has(other)) {
              visited.add(other);
              stack.push(other);
            }
          }
        }
      }
      comp.sort((x, y) => x - y);
      floorComps.push(comp);
    }
  }

  const cavityAreas = regionTriangleAreasMm2(mesh, cavity);
  const cavityCentroid = areaWeightedCentroid(mesh, [...cavity.triangleIndices], cavityAreas);

  interface FloorComp {
    tris: number[];
    levelMm: number;
  }
  const leveled: FloorComp[] = floorComps.map((tris) => {
    const region = sortedRegion(tris);
    const areas = regionTriangleAreasMm2(mesh, region);
    const centroid = areaWeightedCentroid(mesh, [...region.triangleIndices], areas);
    return { tris, levelMm: dot(centroid, axisUnit) };
  });
  const floorReferenceLevelMm = leveled.length > 0 ? Math.max(...leveled.map((c) => c.levelMm)) : null;

  interface BoxDraft {
    floorTris: number[];
    levelMm: number;
    direction: Vec3;
    stepMinProjection: number;
  }
  const boxDrafts: BoxDraft[] = [];
  if (floorReferenceLevelMm !== null) {
    for (const comp of leveled) {
      if (!(floorReferenceLevelMm - comp.levelMm >= floorStepMinMm)) continue;
      const region = sortedRegion(comp.tris);
      const areas = regionTriangleAreasMm2(mesh, region);
      const compCentroid = areaWeightedCentroid(mesh, [...region.triangleIndices], areas);
      const direction = proximalDirectionUnit(cavityCentroid, compCentroid, axisUnit);
      if (direction === null) continue; // centered deep floor — not a proximal box (def 4)
      let stepMinProjection = Infinity;
      for (const t of comp.tris) {
        const i0 = mesh.indices[t * 3]!;
        const i1 = mesh.indices[t * 3 + 1]!;
        const i2 = mesh.indices[t * 3 + 2]!;
        for (const v of [i0, i1, i2]) {
          const p = dot(vertexPos(mesh, v), direction);
          if (p < stepMinProjection) stepMinProjection = p;
        }
      }
      boxDrafts.push({ floorTris: comp.tris, levelMm: comp.levelMm, direction, stepMinProjection });
    }
  }
  // Deterministic box order: by the floor component's smallest triangle index.
  boxDrafts.sort((a, b) => a.floorTris[0]! - b.floorTris[0]!);

  // 6) Wall -> box assignment (half-space beyond the pulpal step, def 5).
  const boxWallLists: number[][] = boxDrafts.map(() => []);
  const axialWallTris: number[] = [];
  for (const t of wallTris) {
    const c = triangleCentroid(mesh, t);
    let bestBox = -1;
    let bestScore = -Infinity;
    for (let b = 0; b < boxDrafts.length; b++) {
      const draft = boxDrafts[b]!;
      const score = dot(c, draft.direction) - draft.stepMinProjection;
      if (score >= -CAVITY_ZONE_BOUNDARY_EPSILON_MM && score > bestScore) {
        bestScore = score;
        bestBox = b;
      }
    }
    if (bestBox >= 0) {
      boxWallLists[bestBox]!.push(t);
    } else {
      axialWallTris.push(t);
    }
  }

  const boxes: CavityBoxRegion[] = boxDrafts.map((draft, b) => {
    const floor = sortedRegion(draft.floorTris);
    const walls = sortedRegion(boxWallLists[b]!);
    return {
      floor,
      walls,
      region: sortedRegion([...draft.floorTris, ...boxWallLists[b]!]),
      proximalDirectionUnit: draft.direction,
      floorLevelMm: draft.levelMm,
    };
  });

  return {
    axisUnit,
    cavity,
    floor: sortedRegion(floorTris),
    walls: sortedRegion(wallTris),
    axialWalls: sortedRegion(axialWallTris),
    boxWalls: sortedRegion(boxWallLists.flat()),
    boxes,
    floorReferenceLevelMm,
    floorMaxAngleDeg,
    floorStepMinMm,
  };
}

// ---------------------------------------------------------------------------
// Insertion-axis suitability — the undercut scan scoped to the cavity
// ---------------------------------------------------------------------------

export interface CavityUndercutScanResult extends UndercutScanIndicesResult {
  /** The region that was scanned (echo — `undercut`/`depthMm` align 1:1
   * with `region.triangleIndices`, the `undercutScanIndices` convention). */
  readonly region: AxisRegion;
  /** MESH-triangle ids (not positions within `region`) of every undercut
   * triangle, sorted ascending — the direct currency for blockout/report
   * consumers. */
  readonly undercutTriangleIndices: Uint32Array;
}

/**
 * Insertion-axis suitability for a cavity: `undercutScanIndices`
 * (undercut/undercutScan.ts — the P3 primitive, reused verbatim: same sign
 * convention, occlusion rule, boundary-epsilon band, sampling policy and
 * documented error character) scoped to `cavityRegion` — a cavity's
 * undercut is exactly its wall subset occluded/facing-away along the axis.
 * Every raycast still queries the FULL mesh via `bvh` (occlusion by
 * geometry outside the region is detected correctly). Zero undercut on the
 * drafted MOD fixture and an exact detected set on its negative-taper
 * variant are pinned in regions.test.ts (the falsifiable both-ways pair).
 *
 * @throws see `undercutScanIndices` (stale BVH, out-of-range index, zero
 * axis).
 */
export function scanCavityUndercut(
  mesh: IndexedMesh,
  bvh: Bvh,
  cavityRegion: AxisRegion,
  insertionAxisUnit: Vec3,
  options: UndercutScanOptions = {},
): CavityUndercutScanResult {
  const result = undercutScanIndices(mesh, bvh, insertionAxisUnit, cavityRegion.triangleIndices, options);
  const undercutIds: number[] = [];
  for (let i = 0; i < result.undercut.length; i++) {
    if (result.undercut[i] === 1) undercutIds.push(cavityRegion.triangleIndices[i]!);
  }
  return { ...result, region: cavityRegion, undercutTriangleIndices: Uint32Array.from(undercutIds) };
}
