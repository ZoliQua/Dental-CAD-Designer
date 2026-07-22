// packages/kernel/src/axis/suggestInsertionAxis.ts
//
// Phase 3 Task 9: insertion-axis AUTO-SUGGESTION. The tilted-cylinder
// analytic acceptance for the UNDERCUT SCAN primitive itself is Phase 2
// Task 9's own concern (undercut/undercutScan.analytic.test.ts, cited —
// re-asserted, not re-derived — by this task's own analytic test); this
// module is the OPTIMIZATION built on top of it: given a restoration's ROI
// (roi.ts's `AxisRegion`), search for the insertion axis `d` that MINIMIZES
// undercut over that region.
//
// ## Objective: depth-weighted undercut AREA over the ROI
//
// For a candidate direction `d`, `undercutScanBatchIndices` (undercut/
// undercutScan.ts), restricted to the ROI's own triangles, gives every ROI
// triangle's undercut flag and blockout `depthMm`. This module's score is:
//
//   score(d) = sum over t in ROI, undercut[t] of ( area(t) * depthMm[t] )
//
// i.e. a depth-WEIGHTED undercut area, mm^2 * mm = mm^3 (physically: total
// "wax that would need to be blocked out" — the same quantity Task 10's
// blockout preview will materialize as an actual solid). Lower is better;
// `suggestInsertionAxis` MINIMIZES it. Depth-weighting (not just undercut
// AREA alone) matters because it distinguishes a shallow, easily-blocked-out
// graze from a deep pocket that would need substantial wax build-up and is
// clinically far more consequential for a rigid single-piece casting — two
// candidate axes with identical undercut AREA but very different depths are
// not equally good, and an area-only objective cannot tell them apart.
// `undercutAreaMm2`/`maxDepthMm`/`undercutTriangleCount` are ALSO reported
// per candidate (this task's brief: "per-direction stats") precisely so a
// caller/UI can see the breakdown behind the single scalar score, not just
// trust it blindly.
//
// ## Why the ROI restricts the SCAN's triangle set (not just the objective)
// — a corrected design, with the measured numbers that forced it
//
// An earlier draft of this module ran `undercutScanBatch` over the FULL
// mesh for every candidate direction and only restricted the SCORE
// accumulation to the ROI, reasoning that a whole-mesh sweep was already
// fast (an extrapolated ~0.5-1s for ~50 directions on the real ~250k-
// triangle arch-case-01 upperjaw). MEASURED reality on the real fixture
// contradicted that extrapolation badly: a 48-direction whole-mesh sweep
// actually took ~45 SECONDS, over 20x this task's <2s interactivity
// budget. The reason: `undercutScan`'s "Occlusion as an INDEPENDENT
// undercut detector" rule (undercut/undercutScan.ts) means almost every
// STRICTLY-FACING triangle (not just the facing-away ones) ALSO gets a real
// BVH raycast — for a well-tessellated closed mesh, that is the vast
// majority of ALL triangles, not a rare case — so a whole-mesh scan's true
// cost is `O(mesh triangleCount)` raycasts PER DIRECTION, not the "mostly
// cheap dot products, raycasts only for the interesting few" the original
// estimate assumed.
//
// The fix: `undercutScanIndices`/`undercutScanBatchIndices`
// (undercut/undercutScan.ts) evaluate the facing+occlusion rule ONLY for
// the triangles named in `region.triangleIndices` — `O(region size)` per
// direction, typically a few hundred to a few thousand triangles, not a
// quarter million. Crucially this does NOT trade away correctness: every
// raycast those functions issue still queries the FULL `bvh` (unchanged) —
// a ROI triangle occluded by a canopy OUTSIDE the ROI is still detected
// exactly as `undercutScan` would find it. Only the DECISION of which
// triangles to bother evaluating is restricted, never the geometry a
// raycast can hit. See `undercutScanIndices`'s own doc for the complexity
// argument and the same measured 45s-vs-ROI numbers.
//
// The default `coarseCount + refineCount` below (32 + 16 = 48) — see this
// task's report for the MEASURED real-fixture timing with this corrected
// design, comfortably meeting the <2s interactivity target.
//
// ## Coarse -> fine refinement
//
// 1. **Coarse**: `AXIS_COARSE_SAMPLE_COUNT` directions, equal-area over the
//    FULL hemisphere centered on a `pole` (see `deriveHemispherePole`
//    below), via `hemisphere.ts`'s Fibonacci spiral.
// 2. **Refine**: `AXIS_REFINE_SAMPLE_COUNT` directions, equal-area over a
//    small polar CAP centered on the COARSE winner, angular radius
//    `AXIS_REFINE_CAP_ANGLE_RAD` (derived below from the coarse sampling
//    density — see that constant's doc) — a genuine "zoom in" around the
//    coarse answer at much finer local angular resolution, without paying
//    for that resolution over the WHOLE hemisphere.
// Refinement can only ever match or improve the coarse result (it is never
// applied if it does not — see the explicit best-tracking below), so
// `best` is always at least as good as the coarse sweep alone would give.
//
// ## Hemisphere orientation: `pole` derived from the ROI's own
// area-weighted outward normal (this task's guardrail)
//
// `deriveHemispherePole` below is the area-weighted average outward unit
// normal over the ROI's triangles — a physically-motivated seed: the
// objective is minimized when as much of the ROI's surface as possible
// FACES `d` (undercut/undercutScan.ts's sign convention: undercut iff
// `normal . d < 0`, roughly), so centering the coarse search on the
// direction most of the ROI's own surface already faces is the natural
// starting point, not an arbitrary choice (e.g. always world +Z, which has
// no relationship to the restoration's actual orientation in the scan
// frame). This also directly resolves the tie-break for a region with NO
// undercut at any candidate direction (e.g. a symmetric patch of a sphere,
// this task's brief's dedicated test case): every candidate scores
// identically (`0`), and the documented tie-break (`hemisphere.ts`'s
// `fibonacciHemisphereDirections`: "index 0 is always the direction closest
// to `pole`") resolves to `pole` itself — the mathematically sensible
// "least surprising" default when nothing in the objective distinguishes
// any candidate.
//
// ## Determinism & tie-break (this task's brief: "deterministic tie-break —
// documented and tested")
//
// Every candidate direction set is generated by `hemisphere.ts`'s pure,
// unseeded-random-free Fibonacci spiral; `undercutScanBatchIndices` itself is a
// deterministic function of `(mesh, bvh, directions)`. The WINNER among
// possibly-tied scores is resolved by a fixed evaluation-order rule: a
// candidate only replaces the current best on a STRICT score improvement
// (`<`, never `<=`), scanning coarse candidates in generation order (index
// 0 first) and then refine candidates (also in generation order) — so an
// exact tie always keeps the EARLIEST-generated candidate, i.e. the coarse
// sweep's `pole`-nearest direction wins over any later tie, and the coarse
// sweep's winner is never displaced by an equally-good refine candidate.
// `ranked` (the full sorted candidate list) uses `Array.prototype.sort`,
// which the ECMAScript spec guarantees STABLE since ES2019 — for exactly-
// tied scores this preserves the [...coarse, ...refine] generation order,
// so `ranked[0]` is PROVABLY identical to the explicitly-tracked `best`
// (verified directly by this module's own determinism test, not just
// asserted here).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from '../bvh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import {
  undercutScanIndices,
  undercutScanBatchIndices,
  type UndercutSamplingPolicy,
  type UndercutScanIndicesResult,
} from '../undercut/undercutScan.ts';
import { fibonacciCapDirections, fibonacciHemisphereDirections } from './hemisphere.ts';
import { normalizeOrZero } from './vec.ts';
import { regionTriangleAreasMm2, regionAreaWeightedNormalSum, unionRegions, type AxisRegion } from './roi.ts';

/** Coarse-sweep sample count (full hemisphere) — see this module's top-of-
 * file "Coarse -> fine refinement" / "Why the ROI restricts the SCAN's
 * triangle set" docs for the perf-budget derivation. `24 + 8 = 32` total
 * directions — MEASURED (this task's report) on the real arch-case-01
 * upperjaw, ROI extracted from tooth 11's committed reference margin at a
 * clinically reasonable 2mm band radius (~13700 triangles): ~1.6s,
 * comfortably under this task's <2s interactivity target with margin for
 * machine variance. A margin-loop ROI is a THIN BAND around a ~20-30mm
 * loop, not a small disc — even a 1mm radius already reaches several
 * thousand triangles on the real, densely-tessellated upperjaw scan — so
 * the total direction budget (not just the per-triangle cost) is the lever
 * that keeps this under budget; 48 total directions (this module's
 * original, more generous draft) measured ~3.2s at the same 2mm radius, too
 * slow. */
export const AXIS_COARSE_SAMPLE_COUNT = 24;

/** Refine-sweep sample count (polar cap around the coarse winner). */
export const AXIS_REFINE_SAMPLE_COUNT = 8;

/**
 * Default refine-cap angular radius (radians), derived from the coarse
 * sample count: a hemisphere's total solid angle is `2*pi` steradians, so
 * `coarseCount` equal-area samples each "own" roughly `2*pi/coarseCount`
 * steradians; treating that per-sample patch as a small spherical cap of
 * solid angle `~ pi*r^2` gives a characteristic coarse angular spacing `r ~
 * sqrt(2/coarseCount)`. The refine cap uses TWICE that radius
 * (`2*sqrt(2/coarseCount)`) — generous enough to recover from the coarse
 * winner being off by up to about one full coarse cell (a genuine risk: the
 * coarse winner is only the best AMONG the coarse samples, not necessarily
 * the closest sample to the true continuous optimum), while still being a
 * small enough cap that `AXIS_REFINE_SAMPLE_COUNT` directions inside it
 * resolve at MUCH finer local angular density than the coarse sweep did.
 * For the default `AXIS_COARSE_SAMPLE_COUNT = 24` this evaluates to ~0.58
 * rad (~33.3 degrees) — see this module's analytic tests for the MEASURED
 * resulting angular accuracy on real/synthetic fixtures.
 */
export function defaultRefineCapAngleRad(coarseCount: number): number {
  return 2 * Math.sqrt(2 / coarseCount);
}

/**
 * Documented search-budget presets for `SuggestInsertionAxisOptions`
 * (Fix batch item 3a, review follow-up to this task).
 *
 * - `interactive` — the module default (`AXIS_COARSE_SAMPLE_COUNT` +
 *   `AXIS_REFINE_SAMPLE_COUNT` = 24 + 8), tuned for the <2s interactivity
 *   target measured on the real arch-case-01 upperjaw ROI (see this
 *   module's `AXIS_COARSE_SAMPLE_COUNT` doc). **Does NOT reach the
 *   zero-undercut optimum in general** — MEASURED on this module's own cone-
 *   frustum analytic fixture (`suggestInsertionAxis.analytic.test.ts`'s
 *   default-budget test): residual `best.scoreMm3 ≈ 28.82 mm³` (4.7% of the
 *   ROI's ~100.28mm² area still undercut, `maxDepthMm ≈ 8.11mm`) at an
 *   angular error of `≈9.58°` — a coarse-budget trade, not a bug: it is
 *   exactly `interactive`'s job to trade precision for speed, and the live
 *   µm-depth heatmap + manual angle-slider adjustment (this task's other
 *   deliverable) is the designed accuracy backstop, not an afterthought.
 * - `precise` — `refineCount: 200`, a FIXED (not `coarseCount`-derived)
 *   `refineCapAngleRad: 0.3` (~17.2°, narrower than `interactive`'s derived
 *   ~33° cap, but with 25x the refine directions inside it — the coarse
 *   sweep's own winner is already measured within ~9.6° of true optimum on
 *   the same fixture, comfortably inside this narrower cap, so the
 *   trade-off is pure resolution, not risk of missing the basin). MEASURED
 *   (this module's high-budget analytic tests) to converge to the TRUE
 *   zero-undercut optimum — `scoreMm3 = 0` exactly — on the same frustum and
 *   bridge fixtures, at `≈9.20°` angular error (matching the fixture's own
 *   ~9.46° zero-undercut cone radius), in `~0.6–0.9s` in-process. Too slow
 *   for a live per-slider-tick search, but fine for an explicit "refine
 *   precisely" action a caller could trigger once (e.g. on auto-suggest, or
 *   a dedicated button) rather than on every interactive adjustment.
 *
 * **UI wiring is NOT part of this batch** — `precise` is exposed here as a
 * documented, tested kernel option only; a future task can wire it to an
 * explicit UI action (e.g. an "increase precision" button on `AxisPanel`)
 * without any kernel change.
 */
export const AXIS_SEARCH_PRESETS = {
  interactive: { coarseCount: AXIS_COARSE_SAMPLE_COUNT, refineCount: AXIS_REFINE_SAMPLE_COUNT },
  precise: { coarseCount: AXIS_COARSE_SAMPLE_COUNT, refineCount: 200, refineCapAngleRad: 0.3 },
} as const satisfies Record<string, Pick<SuggestInsertionAxisOptions, 'coarseCount' | 'refineCount' | 'refineCapAngleRad'>>;

/** Thrown by `suggestInsertionAxis`/`suggestInsertionAxisForRegions` when
 * given an empty ROI (nothing to score an objective over) — `roi.ts`'s
 * extraction utilities themselves stay permissive and never throw (see that
 * module's doc); this is the layer that treats "no triangles" as a genuine
 * usage error, not a silently-degenerate answer. */
export class EmptyRegionError extends Error {
  constructor(callerName: string) {
    super(`${callerName}: region has no triangles — nothing to score an insertion-axis objective over`);
    this.name = 'EmptyRegionError';
  }
}

/** Thrown by `deriveHemispherePole` when the ROI's area-weighted outward
 * normals sum to a NEGLIGIBLE vector relative to the region's own total
 * area — a genuinely degenerate case (e.g. a perfectly symmetric closed
 * shell, or two exactly opposing flat halves of equal area) where there is
 * no well-defined "which way does this region mostly face" answer to seed
 * the hemisphere with. A caller hitting this in practice should pass an
 * explicit `pole` (e.g. derived from the restoration's own scene-node
 * orientation) via `SuggestInsertionAxisOptions.pole`. */
export class DegenerateRegionNormalError extends Error {
  constructor() {
    super(
      'deriveHemispherePole: region area-weighted outward normals sum to a negligible vector relative to the ' +
        "region's own total area — no well-defined hemisphere pole; pass an explicit `pole` option instead.",
    );
    this.name = 'DegenerateRegionNormalError';
  }
}

/** `deriveHemispherePole` treats the area-weighted normal sum as degenerate
 * when its magnitude is below this fraction of the region's own total
 * (unsigned) area — a RELATIVE, not absolute, threshold: the sum's units
 * are mm^2 (an area-weighted normal), so an absolute epsilon would be
 * meaningless across regions of wildly different scale (a 1 mm^2 patch vs.
 * a 500 mm^2 whole-arch region). `1e-6` is comfortably above Float64
 * rounding noise for a sum of ~hundreds to thousands of per-triangle terms
 * (each accumulation step's relative error is `~2e-16`; even a
 * pathologically long accumulation chain stays many orders of magnitude
 * below `1e-6`) while still being "negligible" in any physically meaningful
 * sense — a genuinely non-degenerate region's own normal variation
 * (this module's whole premise: SOME direction is measurably better than
 * others) produces a relative sum magnitude many orders of magnitude
 * larger than this. */
export const DEGENERATE_POLE_RELATIVE_EPSILON = 1e-6;

/**
 * Area-weighted average outward unit normal over `region`'s triangles,
 * normalized — see this module's top-of-file "Hemisphere orientation" doc
 * for the physical rationale.
 *
 * @throws {EmptyRegionError} if `region` has no triangles.
 * @throws {DegenerateRegionNormalError} if the area-weighted normal sum's
 * magnitude is below `DEGENERATE_POLE_RELATIVE_EPSILON` times the region's
 * total area.
 */
export function deriveHemispherePole(mesh: IndexedMesh, region: AxisRegion): Vec3 {
  if (region.triangleIndices.length === 0) {
    throw new EmptyRegionError('deriveHemispherePole');
  }
  const sum = regionAreaWeightedNormalSum(mesh, region);
  const sumLength = Math.hypot(sum[0], sum[1], sum[2]);
  const areas = regionTriangleAreasMm2(mesh, region);
  let totalArea = 0;
  for (const a of areas) totalArea += a;
  if (totalArea === 0 || sumLength < DEGENERATE_POLE_RELATIVE_EPSILON * totalArea) {
    throw new DegenerateRegionNormalError();
  }
  return normalizeOrZero(sum);
}

/** One evaluated candidate direction's ROI-restricted objective + stats
 * (this task's brief: "ranked axes + per-direction stats"). */
export interface AxisCandidate {
  direction: Vec3;
  /** The objective — depth-weighted undercut area over the ROI, mm^3 (see
   * this module's top-of-file "Objective" doc). Lower is better. */
  scoreMm3: number;
  /** Plain (non-depth-weighted) undercut area over the ROI, mm^2. */
  undercutAreaMm2: number;
  /** Max `depthMm` over the ROI's undercut triangles (`0` if none). */
  maxDepthMm: number;
  undercutTriangleCount: number;
}

export interface SuggestInsertionAxisOptions {
  /** Default `AXIS_COARSE_SAMPLE_COUNT`. */
  coarseCount?: number;
  /** Default `AXIS_REFINE_SAMPLE_COUNT`. `0` disables refinement entirely
   * (coarse-only result). */
  refineCount?: number;
  /** Default `defaultRefineCapAngleRad(coarseCount)`. */
  refineCapAngleRad?: number;
  /** Default `deriveHemispherePole(mesh, region)` — see that function's
   * doc. An explicit override bypasses the area-weighted-normal derivation
   * entirely (and so can never throw `DegenerateRegionNormalError`). */
  pole?: Vec3;
  /** Default `'centroid'` — see undercut/undercutScan.ts's "Sampling
   * policy" doc for the error-character tradeoff; forwarded to every
   * `undercutScanBatchIndices`/`undercutScanIndices` call this function makes. */
  sampling?: UndercutSamplingPolicy;
  /** `(done, total)` — `total` is `coarseCount + refineCount`, checkpointed
   * once per DIRECTION (a "batch" — this task's brief: "progress per
   * batch") across both the coarse and refine sweeps. */
  onProgress?: (done: number, total: number) => void;
}

export interface SuggestInsertionAxisResult {
  best: AxisCandidate;
  /** Every evaluated candidate (coarse then refine), sorted ascending by
   * `scoreMm3` — `ranked[0]` is provably identical to `best` (see this
   * module's "Determinism & tie-break" doc). */
  ranked: readonly AxisCandidate[];
  /** The hemisphere pole actually used (either `options.pole` or the
   * derived one). */
  poleUsed: Vec3;
  coarseCount: number;
  /** The refine count actually used (`0` if refinement was disabled or
   * — never currently, but defensively reported — produced no candidates). */
  refineCount: number;
}

/** `result` must be ALIGNED to `regionAreas` (both indexed 1:1 by the same
 * `region.triangleIndices` order) — the contract `undercutScanIndices`/
 * `undercutScanBatchIndices` guarantee (see those functions' doc). */
function scoreDirection(regionAreas: Float64Array, result: UndercutScanIndicesResult): AxisCandidate {
  let scoreMm3 = 0;
  let undercutAreaMm2 = 0;
  let maxDepthMm = 0;
  let undercutTriangleCount = 0;
  for (let i = 0; i < regionAreas.length; i++) {
    if (result.undercut[i] === 1) {
      const area = regionAreas[i]!;
      const depth = result.depthMm[i]!;
      scoreMm3 += area * depth;
      undercutAreaMm2 += area;
      undercutTriangleCount++;
      if (depth > maxDepthMm) maxDepthMm = depth;
    }
  }
  return { direction: result.directionUnit, scoreMm3, undercutAreaMm2, maxDepthMm, undercutTriangleCount };
}

/** First-strict-improvement scan — see this module's "Determinism &
 * tie-break" doc. `candidates` must be non-empty. */
function trackBest(current: AxisCandidate, candidates: readonly AxisCandidate[]): AxisCandidate {
  let best = current;
  for (const candidate of candidates) {
    if (candidate.scoreMm3 < best.scoreMm3) best = candidate;
  }
  return best;
}

/**
 * Insertion-axis auto-suggestion: deterministic coarse -> fine Fibonacci-
 * hemisphere search, scored by `undercutScanBatchIndices` restricted to `region`
 * (this task's brief) — see this module's top-of-file doc for the full
 * method, objective, and determinism/tie-break guarantees.
 *
 * @throws {EmptyRegionError} if `region` has no triangles.
 * @throws {DegenerateRegionNormalError} if `options.pole` is omitted and
 * `region`'s area-weighted outward normals sum to the zero vector.
 */
export function suggestInsertionAxis(
  mesh: IndexedMesh,
  bvh: Bvh,
  region: AxisRegion,
  options: SuggestInsertionAxisOptions = {},
): SuggestInsertionAxisResult {
  if (region.triangleIndices.length === 0) {
    throw new EmptyRegionError('suggestInsertionAxis');
  }
  const coarseCount = options.coarseCount ?? AXIS_COARSE_SAMPLE_COUNT;
  const refineCount = options.refineCount ?? AXIS_REFINE_SAMPLE_COUNT;
  const refineCapAngleRad = options.refineCapAngleRad ?? defaultRefineCapAngleRad(coarseCount);
  const sampling = options.sampling ?? 'centroid';
  const pole = options.pole ?? deriveHemispherePole(mesh, region);
  const regionAreas = regionTriangleAreasMm2(mesh, region);

  const totalDirections = coarseCount + refineCount;
  const onProgress = options.onProgress;

  const coarseDirections = fibonacciHemisphereDirections(coarseCount, pole);
  const coarseResults = undercutScanBatchIndices(mesh, bvh, coarseDirections, region.triangleIndices, {
    sampling,
    onProgress: onProgress ? (done) => onProgress(done, totalDirections) : undefined,
  });
  const coarseCandidates = coarseResults.map((r) => scoreDirection(regionAreas, r));
  let best = trackBest(coarseCandidates[0]!, coarseCandidates);

  let refineCandidates: AxisCandidate[] = [];
  if (refineCount > 0) {
    const refineDirections = fibonacciCapDirections(refineCount, best.direction, refineCapAngleRad);
    const refineResults = undercutScanBatchIndices(mesh, bvh, refineDirections, region.triangleIndices, {
      sampling,
      onProgress: onProgress ? (done) => onProgress(coarseCount + done, totalDirections) : undefined,
    });
    refineCandidates = refineResults.map((r) => scoreDirection(regionAreas, r));
    best = trackBest(best, refineCandidates);
  }

  const ranked = [...coarseCandidates, ...refineCandidates].sort((a, b) => a.scoreMm3 - b.scoreMm3);

  return { best, ranked, poleUsed: pole, coarseCount, refineCount: refineCandidates.length };
}

// ---------------------------------------------------------------------------
// Bridges — one COMMON axis over the UNION of abutment regions, plus a
// per-abutment undercut report at that common axis (this task's brief).
// ---------------------------------------------------------------------------

export interface SuggestInsertionAxisForRegionsResult {
  /** The suggestion computed over the UNION of every input region —
   * `common.best.direction` is the one axis a bridge (or any
   * multi-region restoration) is actually assigned. */
  common: SuggestInsertionAxisResult;
  /** One entry per INPUT region (same order/length as `regions`), each
   * region's OWN undercut stats evaluated AT `common.best.direction` — a
   * single `undercutScan` call at that one direction, not a re-run of the
   * whole search per region (this task's brief: "per-abutment undercut
   * report" — a report at the chosen common axis, not an independent
   * per-abutment optimization, which PLAN.md/this task's guardrail
   * explicitly rules out: "no per-tooth axis for bridges"). */
  perRegion: readonly AxisCandidate[];
}

/**
 * Bridge/multi-region insertion-axis suggestion: `suggestInsertionAxis`
 * over the UNION of `regions`, then a per-region undercut report at the
 * winning common axis — see `SuggestInsertionAxisForRegionsResult`'s doc.
 *
 * @throws {EmptyRegionError} if `regions` is empty, or their union has no
 * triangles.
 */
export function suggestInsertionAxisForRegions(
  mesh: IndexedMesh,
  bvh: Bvh,
  regions: readonly AxisRegion[],
  options: SuggestInsertionAxisOptions = {},
): SuggestInsertionAxisForRegionsResult {
  if (regions.length === 0) {
    throw new EmptyRegionError('suggestInsertionAxisForRegions');
  }
  const union = unionRegions(regions);
  const common = suggestInsertionAxis(mesh, bvh, union, options);
  const sampling = options.sampling ?? 'centroid';
  // One INDEX-RESTRICTED scan per input region at the winning common axis
  // (each cheap — `O(region size)`, per `undercutScanIndices`'s doc — not a
  // whole-mesh pass): a bridge's per-abutment REPORT, not an independent
  // per-abutment optimization (PLAN.md/this task's guardrail: "no per-tooth
  // axis for bridges").
  const perRegion = regions.map((region) => {
    const scan = undercutScanIndices(mesh, bvh, common.best.direction, region.triangleIndices, { sampling });
    return scoreDirection(regionTriangleAreasMm2(mesh, region), scan);
  });
  return { common, perRegion };
}
