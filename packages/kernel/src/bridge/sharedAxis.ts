// packages/kernel/src/bridge/sharedAxis.ts
//
// Phase 6 Task 2: the bridge SHARED INSERTION AXIS assessment — a bridge seats
// as ONE rigid piece, so a single insertion axis must be undercut-acceptable
// across BOTH (all) abutment preps at once. This module is the FALSIFIABLE
// primitive that decides, for a GIVEN candidate axis, whether that axis is
// acceptable across every abutment region, plus the bridge axis SUGGESTION.
//
// ## Reuse map (what carries over verbatim vs. what is new here)
//
// This op reinvents NOTHING about undercut detection or the axis search — it
// is a thin, honest aggregation over machinery Phase 3 Task 9 already built and
// tested:
//
//   - `undercut/undercutScan.ts`'s `undercutScanIndices` — the per-triangle,
//     ROI-restricted undercut+depth verdict against one direction. REUSED
//     VERBATIM (one call per region). Every raycast it issues still queries the
//     FULL bvh, so occlusion by geometry OUTSIDE a region (e.g. the neighbouring
//     abutment, or a canopy) is still detected exactly.
//   - `axis/roi.ts`'s `unionRegions` + `regionTriangleAreasMm2` — the union of
//     the abutment ROIs (the region the shared axis is judged over as a whole)
//     and the per-triangle area weighting for the depth-weighted score. REUSED
//     VERBATIM.
//   - `axis/suggestInsertionAxis.ts`'s `suggestInsertionAxisForRegions` — the
//     coarse->fine Fibonacci-hemisphere search over the UNION region (the best
//     shared axis) + its per-region report AT that winner. REUSED VERBATIM by
//     `suggestSharedAxis` below (which only ADDS a uniform `assessSharedAxis`
//     readout at the suggested axis).
//
// What is NEW (and why it did not already exist): `suggestInsertionAxisForRegions`
// only reports each region's undercut AT THE AXIS IT CHOSE. Task 2's
// falsifiability needs the OPPOSITE capability — assess an ARBITRARY,
// caller-supplied candidate axis across every region (e.g. verify the fixture's
// analytic `[0,0,1]` is EXACT-ZERO on both preps; or sweep dozens of candidate
// axes and confirm NONE achieves zero-on-both on a tilted bridge). That
// given-axis, union-plus-per-abutment aggregation with an explicit
// `sharedAxisAcceptable` verdict is `assessSharedAxis`.
//
// ## The score (identical formulation to suggestInsertionAxis.ts's objective)
//
// Per region, the depth-weighted undercut area `sum over undercut t of
// area(t)*depthMm(t)` (mm^3) — the same physical "wax to block out" quantity
// `suggestInsertionAxis.ts` minimizes, reproduced here (its `scoreDirection` is
// module-private there) so a bridge caller sees the SAME number per abutment
// that the search optimized over the union. `undercutTriangleCount` /
// `undercutAreaMm2` / `maxDepthMm` are reported alongside — the breakdown behind
// the scalar, and `undercutTriangleCount === 0` is the EXACT-ZERO test the
// falsifiable acceptance turns on.
//
// ## Determinism
//
// Every call is a pure function of `(mesh, bvh, regions, direction, sampling)` —
// `undercutScanIndices` and `regionTriangleAreasMm2` are themselves deterministic
// (no randomness, no Date.now, no worker scheduling), so the same inputs yield
// bit-identical reports. `suggestSharedAxis` inherits `suggestInsertionAxisForRegions`'s
// documented determinism + tie-break.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from '../bvh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { undercutScanIndices, type UndercutSamplingPolicy } from '../undercut/undercutScan.ts';
import { unionRegions, regionTriangleAreasMm2, type AxisRegion } from '../axis/roi.ts';
import {
  suggestInsertionAxisForRegions,
  EmptyRegionError,
  type SuggestInsertionAxisOptions,
  type SuggestInsertionAxisForRegionsResult,
} from '../axis/suggestInsertionAxis.ts';

/** One region's undercut verdict against a single candidate axis — the same
 * quantities `axis/suggestInsertionAxis.ts`'s `AxisCandidate` carries (depth-
 * weighted score + the breakdown behind it), plus the region's own size. */
export interface SharedAxisRegionReport {
  /** The (normalized) axis this report was measured against — `undercutScanIndices`
   * normalizes internally, so this is the exact unit vector the scan used. */
  readonly direction: Vec3;
  /** Undercut triangle count in this region at `direction` — the EXACT-ZERO
   * falsifiability test turns on this being `0`. */
  readonly undercutTriangleCount: number;
  /** Plain (non-depth-weighted) undercut area over the region, mm^2. */
  readonly undercutAreaMm2: number;
  /** Max blockout `depthMm` over the region's undercut triangles (`0` if none). */
  readonly maxDepthMm: number;
  /** Depth-weighted undercut area, mm^3 — the objective `suggestInsertionAxis.ts`
   * minimizes (see this module's "score" doc). Lower is better; `0` iff no
   * undercut. */
  readonly scoreMm3: number;
  readonly regionTriangleCount: number;
}

export interface SharedAxisAssessment {
  /** The (normalized) candidate axis assessed. */
  readonly direction: Vec3;
  /** The undercut report over the UNION of every input region — the shared
   * axis judged as one whole. */
  readonly union: SharedAxisRegionReport;
  /** One report per INPUT region (same order/length as `regions`) — each
   * abutment's OWN undercut at the SAME shared `direction`. This is the
   * per-abutment breakdown a bridge needs: a shared axis can be tolerable on
   * one abutment while catching on another. */
  readonly perAbutment: readonly SharedAxisRegionReport[];
  /** `true` iff EVERY abutment has ZERO undercut triangles at `direction` — the
   * falsifiable acceptance: a genuinely shared, undercut-free seating direction.
   * A tilted bridge with no common draft has this `false` for every candidate
   * axis (at least one abutment always retains a residual — see this task's
   * tests, which report those residual numerals). */
  readonly sharedAxisAcceptable: boolean;
}

export interface AssessSharedAxisOptions {
  /** Forwarded to every `undercutScanIndices` call — default `'centroid'` (see
   * undercut/undercutScan.ts's "Sampling policy" doc). Use `'corners'` for the
   * strictly-more-conservative worst-case verdict. */
  readonly sampling?: UndercutSamplingPolicy;
}

/** Depth-weighted undercut report for `region` against `directionUnit` — the
 * same accumulation `suggestInsertionAxis.ts`'s (module-private) `scoreDirection`
 * performs, reproduced here so a bridge caller sees the SAME per-abutment number
 * the union search optimized. `regionAreas` is `regionTriangleAreasMm2(mesh,
 * region)` — aligned 1:1 with `region.triangleIndices` and with the scan output. */
function scoreRegion(
  mesh: IndexedMesh,
  bvh: Bvh,
  region: AxisRegion,
  directionUnit: Vec3,
  sampling: UndercutSamplingPolicy,
): SharedAxisRegionReport {
  const scan = undercutScanIndices(mesh, bvh, directionUnit, region.triangleIndices, { sampling });
  const regionAreas = regionTriangleAreasMm2(mesh, region);
  let scoreMm3 = 0;
  let undercutAreaMm2 = 0;
  let maxDepthMm = 0;
  let undercutTriangleCount = 0;
  for (let i = 0; i < region.triangleIndices.length; i++) {
    if (scan.undercut[i] === 1) {
      const area = regionAreas[i]!;
      const depth = scan.depthMm[i]!;
      scoreMm3 += area * depth;
      undercutAreaMm2 += area;
      undercutTriangleCount++;
      if (depth > maxDepthMm) maxDepthMm = depth;
    }
  }
  return {
    direction: scan.directionUnit,
    undercutTriangleCount,
    undercutAreaMm2,
    maxDepthMm,
    scoreMm3,
    regionTriangleCount: region.triangleIndices.length,
  };
}

/**
 * Assess a GIVEN candidate axis across a bridge's abutment prep regions: the
 * undercut over the UNION of all regions, plus a per-abutment breakdown, plus
 * the `sharedAxisAcceptable` verdict — see this module's doc for the reuse map,
 * the score formulation, and why this given-axis capability is the new piece
 * (`suggestInsertionAxisForRegions` only reports at the axis IT chose).
 *
 * REUSES `undercutScanIndices` (one call per region, always querying the FULL
 * bvh for occlusion), `unionRegions`, and `regionTriangleAreasMm2` verbatim.
 * Deterministic.
 *
 * @throws {EmptyRegionError} if `regions` is empty (nothing to assess). An
 * individual region with no triangles is permitted (it trivially has no
 * undercut) — mirrors `axis/roi.ts`'s permissive extraction.
 */
export function assessSharedAxis(
  mesh: IndexedMesh,
  bvh: Bvh,
  regions: readonly AxisRegion[],
  directionUnit: Vec3,
  options: AssessSharedAxisOptions = {},
): SharedAxisAssessment {
  if (regions.length === 0) {
    throw new EmptyRegionError('assessSharedAxis');
  }
  const sampling = options.sampling ?? 'centroid';
  const perAbutment = regions.map((region) => scoreRegion(mesh, bvh, region, directionUnit, sampling));
  const union = scoreRegion(mesh, bvh, unionRegions(regions), directionUnit, sampling);
  const sharedAxisAcceptable = perAbutment.every((r) => r.undercutTriangleCount === 0);
  return { direction: union.direction, union, perAbutment, sharedAxisAcceptable };
}

export interface SharedAxisSuggestion {
  /** The union-region search result — `suggestion.common.best.direction` is the
   * one axis the bridge is assigned; `suggestion.perRegion` is the search's own
   * per-abutment report at that winner (`axis/suggestInsertionAxis.ts`). */
  readonly suggestion: SuggestInsertionAxisForRegionsResult;
  /** `assessSharedAxis` evaluated AT the suggested common axis — the same
   * uniform report shape (union + per-abutment + `sharedAxisAcceptable`) a
   * caller gets for any hand-supplied candidate, so the "suggested axis" and a
   * "swept candidate axis" are directly comparable. On a parallel bridge this
   * has `sharedAxisAcceptable === true`; on a tilted bridge it is `false` (the
   * suggestion is the LEAST-BAD shared axis, still not undercut-free on both). */
  readonly assessment: SharedAxisAssessment;
}

/**
 * The bridge axis SUGGESTION: `suggestInsertionAxisForRegions` over the union of
 * the abutment regions (REUSED VERBATIM — the coarse->fine hemisphere search),
 * then a uniform `assessSharedAxis` readout at the suggested common axis. See
 * `SharedAxisSuggestion`'s doc. Deterministic (inherits the search's tie-break).
 *
 * @throws {EmptyRegionError} if `regions` is empty, or their union has no
 * triangles (the search itself rejects an empty objective).
 * @throws {DegenerateRegionNormalError} if `options.pole` is omitted and the
 * union's area-weighted normals sum to a negligible vector.
 */
export function suggestSharedAxis(
  mesh: IndexedMesh,
  bvh: Bvh,
  regions: readonly AxisRegion[],
  options: SuggestInsertionAxisOptions = {},
): SharedAxisSuggestion {
  const suggestion = suggestInsertionAxisForRegions(mesh, bvh, regions, options);
  const assessment = assessSharedAxis(mesh, bvh, regions, suggestion.common.best.direction, {
    sampling: options.sampling,
  });
  return { suggestion, assessment };
}
