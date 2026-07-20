// scripts/margin-acceptance.ts
//
// Phase 3 Task 8 — THE phase acceptance measurement: on real prep fixtures,
// does `proposeMarginLoop`'s auto proposal land within 100 µm (mean) of a
// hand-traced reference polyline for >= 90% of its length? (PLAN.md /
// docs/plans/phase-3-margin-axis.md's phase acceptance criterion, verbatim.)
//
// References: `test-fixtures/margins/arch-case-01/{12,11,21,22}.reference.json`
// (Task 7 — dentist-traced, Task 6-validated `MarginReferenceExport`s; see
// that directory's README.md for full schema/provenance). This is a REAL
// case: the dentist's own disclosure (this task's brief) is that the margin
// is partially obscured by collapsed gingiva in some regions there — the
// hand trace reflects clinical judgment there, not scan geometry, so a
// legitimate auto-vs-reference divergence is EXPECTED in those stretches.
// That is exactly what the phase criterion's ">= 90% of its length" window
// is for, and exactly why this harness reports the FULL deviation
// distribution (not just a pass/fail bit) — see "Metric definitions" below.
//
// ## Seeds — deterministic, derived from the REFERENCE (not hand-picked)
//
// Unlike `scripts/kernel-ops-lib.ts`'s pinned `proposeMargin` golden entry
// (one fixed ambient seed, chosen once by hand), this harness derives a
// seed per tooth purely from that tooth's OWN committed reference file: the
// ambient centroid of `resampledPoints` (ALL of it — the dense geodesic
// loop, not just anchors), projected onto the real mesh surface via
// `snapToSurface` (BVH closest point). A closed margin loop's boundary-point
// centroid sits, by construction, some distance INSIDE the encircled prep
// area (never on the loop itself for a non-degenerate loop) — closest-point
// projection from there lands on the prep's own surface, roughly centrally
// within the loop, which is exactly "a seed roughly inside a crown prep,
// near its finish line" (`marginRidge.ts`'s own seed contract). This makes
// every seed here fully reproducible from the committed fixtures alone (no
// externally-recorded ambient coordinate to keep in sync by hand), at the
// cost of assuming the loop's simple point-average centroid re-projects
// within `MARGIN_SEARCH_RADIUS_MM` (10mm default) of a real ridge locus —
// true for all 4 real references here (see the measured
// `seedToRidgeDistanceMm`-adjacent numbers each tooth's `console.log`
// reports), but not a general guarantee for an arbitrarily-shaped loop.
//
// ## Non-closing candidate — tooth 11, established (not assumed)
//
// Task 4's report and `scripts/diagnose-margin-gap.ts` both document that
// ONE of the two central-incisor candidates on this real fixture does not
// close under `proposeMarginLoop`'s default parameters (a genuine
// interproximal scan-coverage gap — `k2` crosses into background/positive
// territory over a real multi-vertex stretch, not a threshold graze; see
// that script's own recorded verdict). Which FDI tooth that is was NOT
// assumed here: `scripts/kernel-ops-lib.ts`'s pinned golden comment calls
// its OWN fixed seed a "tooth21"-position candidate, while this task's own
// dispatch brief separately asserted the golden targets "tooth 11" — a
// direct contradiction between two claims already in this repo. Resolved by
// measurement (this repo's `git log`/task record, 2026-07-15): the 5
// anterior k2-qualifying clusters `diagnose-margin-gap.ts` finds have
// ambient centroids (x, y) of `(-9.96,-14.63)` [1781v], `(-4.83,-17.57)`
// [820v, THE NON-CLOSING ONE], `(0.45,-17.61)` [407v, unrelated to any of
// the 4 real preps], `(6.35,-15.95)` [1211v, the GOLDEN's own closing
// cluster], `(13.96,-12.87)` [1001v] — compared against this task's own
// freshly-computed reference centroids: tooth 12 `(-9.30,-15.21)`, tooth 11
// `(-3.12,-17.31)`, tooth 21 `(4.15,-16.69)`, tooth 22 `(10.36,-14.03)`.
// Nearest-centroid matching is unambiguous and monotonic in x across the
// arch (12 < 11 < 21 < 22, both in the clusters and in the references): the
// non-closing 820-vertex cluster sits ~2.0mm from reference tooth 11's own
// centroid (vs. ~3.6mm from tooth 12's) and the GOLDEN's 1211-vertex closing
// cluster sits ~2.3mm from reference tooth 21's centroid — so the GOLDEN
// kernel-ops.json comment is RIGHT (its seed is on tooth 21) and this task's
// own dispatch brief's "targets tooth 11" claim was wrong; the non-closing
// candidate is TOOTH 11. This harness does not hardcode that conclusion as
// an assumption — it runs `proposeMarginLoop` on EVERY one of the 4
// reference-derived seeds and lets whichever one(s) throw
// `NoClosureError`/`NoRidgeFoundError` self-report; `runMarginAcceptance`
// throws loudly if the observed non-closing set doesn't match this
// documented expectation (exactly `{11}`), so a future kernel change that
// alters this is caught, not silently absorbed.
//
// ## Metric definitions (documented honestly, per this task's brief)
//
// 1. **Proposal curve**: `proposeMarginLoop`'s `anchors` (a closed,
//    curvature-adaptive-spacing `SurfacePoint[]`) are turned into a DENSE
//    ambient polyline by walking `geodesicPath` between every consecutive
//    anchor pair (wrapping) and concatenating the results — the IDENTICAL
//    method `apps/client/src/engine/marginEditor.ts`'s
//    `flattenResampledPoints` uses to build the reference files'
//    `resampledPoints` themselves (test-fixtures/margins/README.md
//    "Density"). Using the same construction on both sides is what makes
//    "matched density" meaningful here, rather than comparing a coarse
//    anchor polyline against a dense reference one.
// 2. **Fixed arc-length resampling** (`ARC_LENGTH_STEP_MM`, 0.02mm = 20µm —
//    an order of magnitude finer than the 100µm acceptance tolerance, and
//    comfortably inside the reference fixtures' own documented mean-spacing
//    sanity band of 5µm-1mm): applied ONLY to the proposal curve, giving it
//    UNIFORM sample spacing so every per-sample statistic below is
//    automatically length-weighted (equal weight per sample) without extra
//    bookkeeping. The REFERENCE polyline is deliberately left at its own
//    native (denser, mesh-resolution-tracking) density and used AS-IS as
//    the closest-point TARGET — downsampling the target to match would only
//    lose target-curve fidelity; the target's own sample density does not
//    bias the metric because closest-point queries below are ambient
//    closest-point-ON-SEGMENT (interpolated), not nearest-existing-point.
// 3. **Distance metric**: for each resampled proposal sample, the exact
//    ambient (Euclidean, straight-line-in-3D) closest point on the
//    reference's own closed polyline (segment-by-segment, brute force — a
//    few hundred reference segments x ~1000-1500 proposal samples per
//    tooth, trivially fast at this fixture's scale; a BVH/kd-tree would be
//    needed at a much larger scale, not here). **This is NOT a geodesic
//    (on-surface) distance** — it is a straight ambient chord, which is
//    always <= the true along-surface separation between the two curves. At
//    the sub-mm deviation scale this task measures, with both curves lying
//    on the same real, only-mildly-curved surface (margin-region background
//    |k2| ~1-5mm^-1 per Task 4's report, i.e. local radius of curvature
//    ~0.2-1mm — the ambient/geodesic gap for a ~100µm-scale ambient
//    separation is second-order in that ratio and small relative to the
//    100µm acceptance threshold itself, but NOT independently proven zero
//    here) — documented as the metric's own limitation, not hidden.
// 4. **Reported variants per tooth** (all computed from the same per-sample
//    deviation array — see `ToothAcceptanceResult`):
//    - `bestNinetyPercentMeanDeviationMm` — THE acceptance metric: sort
//      samples ascending by deviation, drop the worst ~10% (by sample
//      count, which is length under the uniform resampling above), mean of
//      the rest. This operationalizes the phase criterion's own reading
//      (this task's brief): "MEAN deviation <=100µm computed over >=90% of
//      the length" = "excluding the worst <=10% of the length, the mean of
//      the rest must be <=100µm" — the natural fit for a real case with
//      legitimate, LOCALIZED gingiva-obscured divergence.
//    - `fullLengthMeanDeviationMm` — the stricter, no-exclusion mean over
//      100% of the length.
//    - `fractionOfLengthWithin100umMm` — the alternate stricter reading:
//      what fraction of the curve's length has PER-SAMPLE deviation
//      <=100µm (no averaging/exclusion at all).
//    - `maxDeviationMm` — worst single-sample deviation, full curve.
//    - `worstClusters` — contiguous runs (circular, >= `MIN_CLUSTER_RUN_SAMPLES`
//      samples) of proposal samples exceeding the 100µm threshold, each with
//      its own arc-length span and ambient centroid — lets the report say
//      WHERE the worst deviation sits (e.g. "coincides with the
//      interproximal region next to the excluded tooth 11" vs. scattered
//      noise).
//
// ## Runtime
//
// One `intake`+`buildHalfedge`+`buildBvh`+`computeCurvature` pass over the
// real ~250k-triangle arch-case-01 upperjaw (shared across all 4 teeth,
// computed once), then up to 4 `proposeMarginLoop` calls (1 of which is
// expected to throw quickly) plus O(a few) `geodesicPath` calls per
// successful tooth and the brute-force distance sweep above. See this
// task's report for the measured wall-clock total and the golden-lane-vs-
// perf-guard decision it drove (module doc of
// `test/golden/margin-acceptance.test.ts` records the final choice).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseStl } from '@dqcad/io';
import {
  KERNEL_VERSION,
  intake,
  buildHalfedge,
  buildBvh,
  computeCurvature,
  snapToSurface,
  evaluateSurfacePoint,
  geodesicPath,
  proposeMarginLoop,
  NoClosureError,
  NoRidgeFoundError,
  lerpVec3,
  type IndexedMesh,
  type HalfedgeMesh,
  type Bvh,
  type CurvatureResult,
  type SurfacePoint,
  type Vec3,
} from '@dqcad/kernel';
import type { MarginReferenceExport } from '@dqcad/shared-types';
import { createHash } from 'node:crypto';
import { repoRoot } from './kernel-ops-lib.ts';

export const ARCH_UPPERJAW_PATH = 'test-fixtures/real-scans/arch-case-01/arch-case-01-upperjaw.stl';
export const MARGINS_DIR = 'test-fixtures/margins/arch-case-01';
export const REFERENCE_TEETH = [12, 11, 21, 22] as const;

/** The FDI teeth this task's own measurement (see this file's module doc)
 * established as NOT auto-closing under `proposeMarginLoop`'s default
 * parameters on this real fixture — a genuine interproximal scan-coverage
 * gap (Task 4's report / `scripts/diagnose-margin-gap.ts`), not a tuning
 * target. `runMarginAcceptance` asserts the OBSERVED non-closing set
 * matches this exactly, rather than silently trusting it. */
export const EXPECTED_NON_CLOSING_TEETH: readonly number[] = [11];

/** Phase acceptance criterion (PLAN.md / phase-3-margin-axis.md, verbatim):
 * "within 100 µm (mean) ... for >= 90% of its length". */
export const ACCEPTANCE_THRESHOLD_MM = 0.1;
export const ACCEPTANCE_LENGTH_FRACTION = 0.9;
/** >= 3 of the 4 real references must pass — zero slack (this task's brief). */
export const ACCEPTANCE_MIN_PASSING_TEETH = 3;

/** Fixed arc-length resampling step for the PROPOSAL curve — see this
 * file's module doc, "Metric definitions" item 2. */
export const ARC_LENGTH_STEP_MM = 0.02;
/** Minimum contiguous run length (in resampled proposal samples) to report
 * as a "worst cluster" rather than isolated single-sample noise. */
export const MIN_CLUSTER_RUN_SAMPLES = 5;

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function centroidOf(points: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = points.length;
  return [x / n, y / n, z / n];
}

/** Closed-loop length (wraps last -> first), matching the reference
 * fixtures' own `resampledPoints`/`closed: true` circumference convention
 * (test/golden/margin-references.test.ts's `polylineSpacingsMm`). */
function closedPolylineLengthMm(points: readonly Vec3[]): number {
  let total = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    total += dist3(points[i]!, points[(i + 1) % n]!);
  }
  return total;
}

/** Exact ambient closest point on a CLOSED polyline (segment-by-segment,
 * brute force — see this file's module doc, "Metric definitions" item 3). */
function closestPointOnClosedPolyline(
  p: Vec3,
  poly: readonly Vec3[],
): { distanceMm: number; segmentIndex: number } {
  const n = poly.length;
  let bestDist = Infinity;
  let bestSeg = -1;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const abLenSq = abx * abx + aby * aby + abz * abz;
    let t = abLenSq > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / abLenSq : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const qx = a[0] + abx * t;
    const qy = a[1] + aby * t;
    const qz = a[2] + abz * t;
    const d = Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz);
    if (d < bestDist) {
      bestDist = d;
      bestSeg = i;
    }
  }
  return { distanceMm: bestDist, segmentIndex: bestSeg };
}

/** Fixed arc-length resampling of a CLOSED polyline — see this file's
 * module doc, "Metric definitions" item 2. Returns exactly
 * `Math.max(8, Math.round(totalLength / stepMm))` uniformly-spaced points. */
export function resampleClosedPolylineArcLength(points: readonly Vec3[], stepMm: number): Vec3[] {
  const n = points.length;
  if (n < 3) {
    throw new RangeError(`resampleClosedPolylineArcLength: need >= 3 input points, got ${n}`);
  }
  const segLens: number[] = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = dist3(points[i]!, points[(i + 1) % n]!);
    segLens[i] = d;
    total += d;
  }
  if (!(total > 0)) {
    throw new RangeError('resampleClosedPolylineArcLength: closed polyline has zero total length');
  }
  const sampleCount = Math.max(8, Math.round(total / stepMm));
  const actualStep = total / sampleCount;
  const out: Vec3[] = new Array(sampleCount);
  let segIdx = 0;
  let segStartArc = 0;
  for (let k = 0; k < sampleCount; k++) {
    const target = k * actualStep;
    while (segIdx < n - 1 && segStartArc + segLens[segIdx]! < target) {
      segStartArc += segLens[segIdx]!;
      segIdx++;
    }
    const segLen = segLens[segIdx]!;
    let frac = segLen > 0 ? (target - segStartArc) / segLen : 0;
    if (frac < 0) frac = 0;
    else if (frac > 1) frac = 1;
    out[k] = lerpVec3(points[segIdx]!, points[(segIdx + 1) % n]!, frac);
  }
  return out;
}

/** Dense ambient polyline for a `proposeMarginLoop` result — geodesic path
 * between every consecutive anchor pair (wrapping), concatenated. See this
 * file's module doc, "Metric definitions" item 1. */
function buildProposalDensePolyline(mesh: IndexedMesh, hm: HalfedgeMesh, anchors: readonly SurfacePoint[]): Vec3[] {
  const out: Vec3[] = [];
  const n = anchors.length;
  for (let i = 0; i < n; i++) {
    const a = anchors[i]!;
    const b = anchors[(i + 1) % n]!;
    const { points } = geodesicPath(mesh, hm, a, b);
    const ambient = points.map((sp) => evaluateSurfacePoint(mesh, sp));
    // Drop the LAST point of each segment (shared with the next segment's
    // own first point) — same "don't repeat the shared point" convention
    // the reference fixtures' own `resampledPoints` use (closed loop, no
    // duplicate wraparound point).
    for (let j = 0; j < ambient.length - 1; j++) out.push(ambient[j]!);
  }
  return out;
}

interface ExceedingRun {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly sampleCount: number;
  readonly lengthMm: number;
  readonly maxDeviationMm: number;
  readonly centroidAmbient: Vec3;
}

/** Contiguous (circular) runs of samples whose deviation exceeds
 * `thresholdMm`, dropping runs shorter than `MIN_CLUSTER_RUN_SAMPLES` — see
 * this file's module doc, "Metric definitions" item 4 (`worstClusters`). */
function findExceedingRuns(
  proposalPoints: readonly Vec3[],
  deviationsMm: readonly number[],
  thresholdMm: number,
  stepMm: number,
): ExceedingRun[] {
  const n = deviationsMm.length;
  const exceeds = deviationsMm.map((d) => d > thresholdMm);
  if (!exceeds.some(Boolean)) return [];
  // Rotate to a non-exceeding start (if one exists) so a genuine run never
  // gets artificially split across the array's index-0 seam.
  let rotate = 0;
  if (!exceeds.every(Boolean)) {
    while (exceeds[rotate]) rotate++;
  }
  const runs: ExceedingRun[] = [];
  let idx = 0;
  while (idx < n) {
    const actual = (rotate + idx) % n;
    if (!exceeds[actual]) {
      idx++;
      continue;
    }
    const runStart = idx;
    while (idx < n && exceeds[(rotate + idx) % n]) idx++;
    const count = idx - runStart;
    if (count >= MIN_CLUSTER_RUN_SAMPLES) {
      const indices: number[] = [];
      let maxDev = -Infinity;
      for (let k = 0; k < count; k++) {
        const i = (rotate + runStart + k) % n;
        indices.push(i);
        if (deviationsMm[i]! > maxDev) maxDev = deviationsMm[i]!;
      }
      runs.push({
        startIndex: (rotate + runStart) % n,
        endIndex: (rotate + idx - 1) % n,
        sampleCount: count,
        lengthMm: count * stepMm,
        maxDeviationMm: maxDev,
        centroidAmbient: centroidOf(indices.map((i) => proposalPoints[i]!)),
      });
    }
  }
  return runs;
}

export interface ToothAcceptanceResult {
  readonly tooth: number;
  readonly seedCentroidAmbient: Vec3;
  readonly seedAmbient: Vec3;
  readonly closed: boolean;
  readonly nonClosureReason?: string;
  readonly nonClosureDetail?: { readonly closureDeviationMm: number; readonly closureToleranceMm: number; readonly stepsTaken: number };
  readonly proposalAnchorCount?: number;
  readonly proposalWalkVertexCount?: number;
  readonly proposalPerimeterMm?: number;
  readonly referencePerimeterMm?: number;
  readonly sampleCount?: number;
  readonly arcStepMm?: number;
  readonly fullLengthMeanDeviationMm?: number;
  readonly bestNinetyPercentMeanDeviationMm?: number;
  readonly bestNinetyPercentLengthFraction?: number;
  readonly fractionOfLengthWithin100umMm?: number;
  readonly maxDeviationMm?: number;
  readonly worstClusters?: readonly ExceedingRun[];
  readonly passesAcceptance?: boolean;
}

export interface MarginAcceptanceReport {
  readonly kernelVersion: string;
  readonly meshContentHash: string;
  readonly acceptanceThresholdMm: number;
  readonly acceptanceLengthFraction: number;
  readonly acceptanceMinPassingTeeth: number;
  readonly arcLengthStepMm: number;
  readonly teeth: readonly ToothAcceptanceResult[];
  readonly passingTeethCount: number;
  readonly measuredTeethCount: number;
  readonly overallPasses: boolean;
}

function hashMeshContentHex(mesh: IndexedMesh): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  hash.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return hash.digest('hex');
}

function loadUpperjawMesh(): IndexedMesh {
  const bytes = readFileSync(join(repoRoot, ARCH_UPPERJAW_PATH));
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

function loadReference(tooth: number): MarginReferenceExport {
  const path = join(repoRoot, MARGINS_DIR, `${tooth}.reference.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as MarginReferenceExport;
}

function computeToothResult(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  curvature: CurvatureResult,
  bvh: Bvh,
  reference: MarginReferenceExport,
): ToothAcceptanceResult {
  const referencePoints: Vec3[] = reference.resampledPoints.map((p) => [p[0], p[1], p[2]]);
  const seedCentroidAmbient = centroidOf(referencePoints);
  const seed = snapToSurface(mesh, bvh, seedCentroidAmbient);
  const seedAmbient = evaluateSurfacePoint(mesh, seed);

  let proposal;
  try {
    proposal = proposeMarginLoop(mesh, hm, curvature, seed);
  } catch (e) {
    if (e instanceof NoClosureError) {
      return {
        tooth: reference.tooth,
        seedCentroidAmbient,
        seedAmbient,
        closed: false,
        nonClosureReason: 'NoClosureError',
        nonClosureDetail: { closureDeviationMm: e.closureDeviationMm, closureToleranceMm: e.closureToleranceMm, stepsTaken: e.stepsTaken },
      };
    }
    if (e instanceof NoRidgeFoundError) {
      return { tooth: reference.tooth, seedCentroidAmbient, seedAmbient, closed: false, nonClosureReason: 'NoRidgeFoundError' };
    }
    throw e;
  }

  const proposalDense = buildProposalDensePolyline(mesh, hm, proposal.anchors);
  const proposalResampled = resampleClosedPolylineArcLength(proposalDense, ARC_LENGTH_STEP_MM);
  const deviations = proposalResampled.map((p) => closestPointOnClosedPolyline(p, referencePoints).distanceMm);

  const n = deviations.length;
  const fullLengthMeanDeviationMm = deviations.reduce((s, d) => s + d, 0) / n;
  const maxDeviationMm = Math.max(...deviations);
  const withinCount = deviations.filter((d) => d <= ACCEPTANCE_THRESHOLD_MM).length;
  const fractionOfLengthWithin100umMm = withinCount / n;

  // "mean over best 90% of length": under uniform arc-length resampling,
  // sample count == length fraction (see this file's module doc). Sort
  // ascending, keep the smallest prefix whose count reaches
  // ACCEPTANCE_LENGTH_FRACTION of n.
  const sorted = [...deviations].sort((a, b) => a - b);
  const keepCount = Math.max(1, Math.ceil(n * ACCEPTANCE_LENGTH_FRACTION));
  const bestSubset = sorted.slice(0, keepCount);
  const bestNinetyPercentMeanDeviationMm = bestSubset.reduce((s, d) => s + d, 0) / bestSubset.length;
  const bestNinetyPercentLengthFraction = bestSubset.length / n;

  const worstClusters = findExceedingRuns(proposalResampled, deviations, ACCEPTANCE_THRESHOLD_MM, ARC_LENGTH_STEP_MM);

  return {
    tooth: reference.tooth,
    seedCentroidAmbient,
    seedAmbient,
    closed: true,
    proposalAnchorCount: proposal.anchors.length,
    proposalWalkVertexCount: proposal.walkVertexCount,
    proposalPerimeterMm: closedPolylineLengthMm(proposalDense),
    referencePerimeterMm: closedPolylineLengthMm(referencePoints),
    sampleCount: n,
    arcStepMm: ARC_LENGTH_STEP_MM,
    fullLengthMeanDeviationMm,
    bestNinetyPercentMeanDeviationMm,
    bestNinetyPercentLengthFraction,
    fractionOfLengthWithin100umMm,
    maxDeviationMm,
    worstClusters,
    passesAcceptance: bestNinetyPercentMeanDeviationMm <= ACCEPTANCE_THRESHOLD_MM,
  };
}

/**
 * Runs the full Task 8 acceptance harness against the committed real
 * arch-case-01 references. Pure computation, no console output (the CLI
 * `main()` below and `test/golden/margin-acceptance.test.ts` both call this
 * and format/assert independently).
 *
 * @throws {Error} if any committed reference file is missing (this harness,
 * unlike `margin-references.test.ts`, requires all 4 — it IS the acceptance
 * measurement, not a pre-tracing-session placeholder), or if the OBSERVED
 * non-closing tooth set doesn't match `EXPECTED_NON_CLOSING_TEETH`.
 */
export function runMarginAcceptance(): MarginAcceptanceReport {
  for (const tooth of REFERENCE_TEETH) {
    const path = join(repoRoot, MARGINS_DIR, `${tooth}.reference.json`);
    if (!existsSync(path)) {
      throw new Error(`runMarginAcceptance: missing committed reference ${path} — all 4 references are required for the phase acceptance measurement`);
    }
  }

  const mesh = loadUpperjawMesh();
  const meshContentHash = hashMeshContentHex(mesh);
  const hm = buildHalfedge(mesh);
  const curvature = computeCurvature(mesh, hm);
  const bvh = buildBvh(mesh);

  const teeth: ToothAcceptanceResult[] = [];
  for (const tooth of REFERENCE_TEETH) {
    const reference = loadReference(tooth);
    if (reference.meshContentHash !== meshContentHash) {
      throw new Error(
        `runMarginAcceptance: tooth ${tooth} reference's meshContentHash (${reference.meshContentHash}) does not match the freshly-computed ` +
          `arch-case-01 upperjaw hash (${meshContentHash}) — reference traced against a stale/different mesh version.`,
      );
    }
    teeth.push(computeToothResult(mesh, hm, curvature, bvh, reference));
  }

  const observedNonClosing = teeth.filter((t) => !t.closed).map((t) => t.tooth).sort((a, b) => a - b);
  const expectedSorted = [...EXPECTED_NON_CLOSING_TEETH].sort((a, b) => a - b);
  if (observedNonClosing.length !== expectedSorted.length || observedNonClosing.some((t, i) => t !== expectedSorted[i])) {
    throw new Error(
      `runMarginAcceptance: observed non-closing tooth set [${observedNonClosing.join(',')}] does not match the documented ` +
        `expectation [${expectedSorted.join(',')}] (this file's module doc) — a kernel/fixture change altered which tooth fails to ` +
        'close; investigate before trusting the acceptance count below.',
    );
  }

  const measured = teeth.filter((t) => t.closed);
  const passingTeethCount = measured.filter((t) => t.passesAcceptance === true).length;

  return {
    kernelVersion: KERNEL_VERSION,
    meshContentHash,
    acceptanceThresholdMm: ACCEPTANCE_THRESHOLD_MM,
    acceptanceLengthFraction: ACCEPTANCE_LENGTH_FRACTION,
    acceptanceMinPassingTeeth: ACCEPTANCE_MIN_PASSING_TEETH,
    arcLengthStepMm: ARC_LENGTH_STEP_MM,
    teeth,
    passingTeethCount,
    measuredTeethCount: measured.length,
    overallPasses: passingTeethCount >= ACCEPTANCE_MIN_PASSING_TEETH,
  };
}

function fmt(v: number | undefined, digits = 4): string {
  return v === undefined ? 'n/a' : v.toFixed(digits);
}

function printReport(report: MarginAcceptanceReport): void {
  console.log(`[margin-acceptance] KERNEL_VERSION ${report.kernelVersion}, mesh ${report.meshContentHash.slice(0, 12)}...`);
  console.log(
    `[margin-acceptance] acceptance rule: mean deviation over best ${(report.acceptanceLengthFraction * 100).toFixed(0)}% of length ` +
      `<= ${(report.acceptanceThresholdMm * 1000).toFixed(0)}um, on >= ${report.acceptanceMinPassingTeeth} of 4 teeth.`,
  );
  for (const t of report.teeth) {
    console.log(`\n--- tooth ${t.tooth} ---`);
    console.log(`  seed centroid (ambient): ${t.seedCentroidAmbient.map((c) => c.toFixed(3)).join(', ')}`);
    console.log(`  seed (on surface):       ${t.seedAmbient.map((c) => c.toFixed(3)).join(', ')}`);
    if (!t.closed) {
      console.log(`  NON-CLOSING (${t.nonClosureReason}) — EXCLUDED from the acceptance count.`);
      if (t.nonClosureDetail) {
        console.log(
          `    closestApproach=${t.nonClosureDetail.closureDeviationMm.toFixed(4)}mm, tolerance=${t.nonClosureDetail.closureToleranceMm}mm, steps=${t.nonClosureDetail.stepsTaken}`,
        );
      }
      continue;
    }
    console.log(`  anchors=${t.proposalAnchorCount}, walkVertices=${t.proposalWalkVertexCount}, samples=${t.sampleCount} @ ${(t.arcStepMm! * 1000).toFixed(0)}um step`);
    console.log(`  proposalPerimeterMm=${fmt(t.proposalPerimeterMm, 3)}, referencePerimeterMm=${fmt(t.referencePerimeterMm, 3)}`);
    console.log(`  full-length mean deviation:      ${fmt((t.fullLengthMeanDeviationMm ?? 0) * 1000, 1)} um`);
    console.log(`  best-90%-of-length mean deviation: ${fmt((t.bestNinetyPercentMeanDeviationMm ?? 0) * 1000, 1)} um (kept ${((t.bestNinetyPercentLengthFraction ?? 0) * 100).toFixed(1)}% of length) -- ACCEPTANCE METRIC`);
    console.log(`  fraction of length within 100um: ${(((t.fractionOfLengthWithin100umMm ?? 0)) * 100).toFixed(1)}%`);
    console.log(`  max deviation:                    ${fmt((t.maxDeviationMm ?? 0) * 1000, 1)} um`);
    console.log(`  PASSES: ${t.passesAcceptance}`);
    if (t.worstClusters && t.worstClusters.length > 0) {
      console.log(`  worst clusters (>100um, contiguous, >= ${MIN_CLUSTER_RUN_SAMPLES} samples):`);
      for (const c of t.worstClusters) {
        console.log(
          `    ${c.sampleCount} samples, ${(c.lengthMm).toFixed(2)}mm, max ${(c.maxDeviationMm * 1000).toFixed(1)}um, centroid (${c.centroidAmbient.map((v) => v.toFixed(2)).join(', ')})`,
        );
      }
    } else {
      console.log('  worst clusters: none (no contiguous exceeding run >= threshold sample count)');
    }
  }
  console.log(`\n[margin-acceptance] VERDICT: ${report.passingTeethCount}/${report.measuredTeethCount} measured teeth pass (need >= ${report.acceptanceMinPassingTeeth} of 4) -- overallPasses=${report.overallPasses}`);
}

function main(): void {
  const report = runMarginAcceptance();
  printReport(report);
  if (!report.overallPasses) {
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
