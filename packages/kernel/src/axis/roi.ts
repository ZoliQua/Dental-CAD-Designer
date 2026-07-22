// packages/kernel/src/axis/roi.ts
//
// Phase 3 Task 9: insertion-axis ROI (region of interest) extraction —
// "triangles within a geodesic/euclidean radius of the margin loop(s)"
// (this task's brief). This is the region `suggestInsertionAxis.ts` scores
// undercut against (see that module for why the SCAN itself still runs over
// the WHOLE mesh — occlusion is a whole-mesh property — while only the
// OBJECTIVE is restricted to this region).
//
// ## Method: graph-distance (Dijkstra ball), not a true surface geodesic —
// same documented choice as margin/marginRidge.ts's `boundedVertexRegion`
//
// This module reuses `boundedVertexRegion`'s (margin/marginRidge.ts)
// established, already-reviewed rationale for a Dijkstra ball over the
// mesh's VERTEX ADJACENCY graph (edge weight = real 3D Euclidean edge
// length) rather than a true along-surface geodesic distance field: walking
// mesh EDGES only (never cutting across a triangle interior, as a true
// surface geodesic would) can only ever be as long as or LONGER than the
// true geodesic between two points, so this graph distance is a documented,
// always-CONSERVATIVE upper bound on true geodesic distance — a region
// bounded this way is always a SUBSET of the true geodesic ball of the same
// radius, never a superset. That is exactly the safe direction of error for
// an insertion-axis ROI: under-including a sliver of legitimately-nearby
// surface only makes the objective slightly less complete; over-including
// unrelated, far-away surface (e.g. a neighboring tooth on the same arch)
// would corrupt the undercut objective with irrelevant geometry, which is
// the failure this ROI exists to prevent in the first place (see
// suggestInsertionAxis.ts's "why ROI" doc). Avoiding a full
// `geodesicPath`-style corridor search (repeated per candidate vertex) is
// unnecessary machinery for a bound that only needs to be conservative, not
// tight — same judgment call `boundedVertexRegion`'s own doc already makes.
//
// ## Generalization: MULTI-SOURCE, not "call boundedVertexRegion once per
// margin point and union the results"
//
// A margin LOOP is many points (`MarginLine.resampledPoints`, typically
// dozens), not the single `seed` `boundedVertexRegion` takes. This module
// runs ONE shared Dijkstra expansion seeded from EVERY loop point
// simultaneously (`marginRegionVertexBall` below) rather than calling
// `boundedVertexRegion` once per point and unioning `radiusMm` balls
// afterward — both for CORRECTNESS (the region should track "graph distance
// to the NEAREST loop point", which a true multi-source expansion computes
// exactly; unioning independent single-source balls of the same radius
// happens to produce the identical vertex set for this monotone,
// non-negative-weight case, but only a multi-source expansion computes it
// in one pass) and EFFICIENCY (one shared expansion, not O(loop points)
// independent ones).
//
// ## Triangle inclusion rule: ANY vertex within radius — inclusive/
// conservative
//
// A triangle is IN the region iff AT LEAST ONE of its 3 vertices lies
// within `radiusMm` (graph distance) of the loop. This is deliberately
// inclusive rather than requiring all 3 vertices in the ball: it never
// excludes a triangle with genuine area inside the disc (a triangle whose
// centroid is well inside the radius but happens to have one vertex just
// past it would be wrongly dropped by an "all 3" rule), at the cost of
// occasionally including a triangle whose other two vertices sit just
// outside — consistent with the graph-distance bound's own
// conservative-but-safe philosophy above.
//
// ## Kernel data is never decimated (CLAUDE.md / this task's brief)
//
// `AxisRegion` is a plain triangle-INDEX subset into the full, original
// mesh — never a separately extracted or simplified mesh. Every consumer
// (`suggestInsertionAxis.ts`) indexes back into the SAME `IndexedMesh` this
// region was extracted from.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { HalfedgeMesh } from '../halfedge/types.ts';
import type { SurfacePoint } from '../geodesic/types.ts';
import { evaluateSurfacePoint, triangleVertexIndices } from '../geodesic/surfacePoint.ts';
import { oneRingVertices } from '../halfedge/iterate.ts';
import { MinHeap } from '../geodesic/heap.ts';
import { triangleAreaMm2, triangleUnitNormal, triangleVertexPositions } from './vec.ts';

/** A triangle-index SUBSET of a mesh — sorted ascending, de-duplicated.
 * Never a separate mesh (kernel data is never decimated — see this
 * module's top-of-file doc). */
export interface AxisRegion {
  readonly triangleIndices: Uint32Array;
}

/** Default graph-distance ROI radius (mm) around a margin loop — an
 * ALGORITHMIC default (same "keep in kernel as a documented param default"
 * judgment call as margin/marginRidge.ts's `MARGIN_SEARCH_RADIUS_MM`, not a
 * clinical-profiles value), kept here rather than only in a caller (the
 * worker job / golden script) so every consumer shares one source of truth.
 * `2mm`: MEASURED (this task's report) as a band width that keeps a full
 * axis-suggestion sweep (`AXIS_COARSE_SAMPLE_COUNT + AXIS_REFINE_SAMPLE_COUNT`
 * directions — see suggestInsertionAxis.ts) comfortably under this task's
 * <2s interactivity target on the real, densely-tessellated arch-case-01
 * upperjaw (~13700 ROI triangles at this radius around a real ~30mm margin
 * loop, ~1.6-1.7s measured) while still covering a clinically meaningful
 * band of the axial wall immediately around the margin — the region a
 * seating-direction undercut search actually needs to reason about. */
export const AXIS_DEFAULT_ROI_RADIUS_MM = 2;

function vertexPos(mesh: IndexedMesh, v: number): Vec3 {
  return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Multi-source Dijkstra ball (graph distance, mm) over `hm`'s vertex
 * adjacency graph, seeded from EVERY point in `seeds` simultaneously — see
 * this module's top-of-file doc for the method and why multi-source, not a
 * union of independent single-source balls. Each seed's OWN containing
 * triangle's 3 vertices are fan-out-seeded at the straight-line ambient
 * distance from the seed's evaluated position (mirrors
 * `boundedVertexRegion`'s own per-seed fan-out bias — a safety bound, not a
 * precision measurement). Returns every vertex reached within `radiusMm` of
 * its NEAREST seed, mapped to that distance.
 */
export function marginRegionVertexBall(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  seeds: readonly SurfacePoint[],
  radiusMm: number,
): Map<number, number> {
  const dist = new Map<number, number>();
  const heap = new MinHeap();
  for (const seed of seeds) {
    const seedPos = evaluateSurfacePoint(mesh, seed);
    for (const v of triangleVertexIndices(mesh, seed.triangleIndex)) {
      const d = dist3(seedPos, vertexPos(mesh, v));
      const existing = dist.get(v);
      if (existing === undefined || existing > d) {
        dist.set(v, d);
        heap.push(d, v);
      }
    }
  }

  while (heap.size > 0) {
    const top = heap.pop()!;
    const v = top.id;
    const known = dist.get(v);
    if (known === undefined || top.priority > known) continue; // stale heap entry
    if (known > radiusMm) continue; // do not expand past the radius
    const pv = vertexPos(mesh, v);
    for (const nb of oneRingVertices(hm, v)) {
      const cand = known + dist3(pv, vertexPos(mesh, nb));
      if (cand > radiusMm) continue;
      const existing = dist.get(nb);
      if (existing === undefined || cand < existing) {
        dist.set(nb, cand);
        heap.push(cand, nb);
      }
    }
  }
  return dist;
}

/**
 * Extracts the ROI: every triangle with at least one vertex within
 * `radiusMm` (graph distance) of `seeds` — see this module's top-of-file
 * doc. `seeds` should be dense enough along the margin loop that
 * consecutive seeds are closer together than any mesh feature the caller
 * cares about resolving (a restoration's `MarginLine.resampledPoints`, the
 * DENSE currency, not just its sparse `anchors` — see @dqcad/shared-types'
 * `MarginLine` doc); this function has no opinion on density, only on graph
 * distance from whatever points it is given. Returns an EMPTY region
 * (never throws) for an empty `seeds` list or a radius too small to reach
 * any vertex — `suggestInsertionAxis.ts` is the layer that decides an empty
 * region is an error (`EmptyRegionError`), keeping this extraction utility
 * itself permissive/side-effect-free.
 *
 * @throws {RangeError} if `radiusMm` is not a positive, finite number.
 */
export function extractMarginRegion(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  seeds: readonly SurfacePoint[],
  radiusMm: number,
): AxisRegion {
  if (!(radiusMm > 0) || !Number.isFinite(radiusMm)) {
    throw new RangeError(`extractMarginRegion: radiusMm must be a positive, finite number (got ${radiusMm})`);
  }
  if (seeds.length === 0) {
    return { triangleIndices: new Uint32Array(0) };
  }
  const vertexBall = marginRegionVertexBall(mesh, hm, seeds, radiusMm);
  if (vertexBall.size === 0) {
    return { triangleIndices: new Uint32Array(0) };
  }
  const triangleCount = mesh.indices.length / 3;
  const included: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const i0 = mesh.indices[t * 3]!;
    const i1 = mesh.indices[t * 3 + 1]!;
    const i2 = mesh.indices[t * 3 + 2]!;
    if (vertexBall.has(i0) || vertexBall.has(i1) || vertexBall.has(i2)) {
      included.push(t);
    }
  }
  return { triangleIndices: Uint32Array.from(included) };
}

/** Set union of triangle indices across `regions` — sorted ascending,
 * de-duplicated. The bridge case's "common axis over the UNION of abutment
 * regions" (this task's brief) — see suggestInsertionAxis.ts's
 * `suggestInsertionAxisForRegions`. */
export function unionRegions(regions: readonly AxisRegion[]): AxisRegion {
  const set = new Set<number>();
  for (const region of regions) {
    for (const t of region.triangleIndices) set.add(t);
  }
  return { triangleIndices: Uint32Array.from(Array.from(set).sort((a, b) => a - b)) };
}

/** Per-triangle area (mm^2), aligned 1:1 with `region.triangleIndices`
 * (index `i` here is triangle `region.triangleIndices[i]`, NOT a
 * mesh-triangle-indexed array) — the objective function's area weighting
 * and `deriveHemispherePole`'s area-weighted normal (both
 * suggestInsertionAxis.ts) consume this. */
export function regionTriangleAreasMm2(mesh: IndexedMesh, region: AxisRegion): Float64Array {
  const areas = new Float64Array(region.triangleIndices.length);
  for (let i = 0; i < region.triangleIndices.length; i++) {
    const [a, b, c] = triangleVertexPositions(mesh, region.triangleIndices[i]!);
    areas[i] = triangleAreaMm2(a, b, c);
  }
  return areas;
}

/** Area-weighted sum of outward unit normals over `region` — NOT
 * normalized (suggestInsertionAxis.ts's `deriveHemispherePole` normalizes
 * and checks for degeneracy itself; exposed separately so tests can inspect
 * the raw, pre-normalization vector, e.g. to confirm it is exactly zero for
 * a symmetric region). */
export function regionAreaWeightedNormalSum(mesh: IndexedMesh, region: AxisRegion): Vec3 {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const t of region.triangleIndices) {
    const [a, b, c] = triangleVertexPositions(mesh, t);
    const n = triangleUnitNormal(a, b, c);
    const area = triangleAreaMm2(a, b, c);
    sx += n[0] * area;
    sy += n[1] * area;
    sz += n[2] * area;
  }
  return [sx, sy, sz];
}
