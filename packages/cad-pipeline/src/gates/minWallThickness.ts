// packages/cad-pipeline/src/gates/minWallThickness.ts
//
// Phase 4 Task 7: the MINIMUM WALL THICKNESS gate — measures the thinnest
// wall of a constructed crown shell (the inner↔outer surface distance) and
// passes iff it meets the material profile minimums: `minWallThicknessMm`
// (axial walls) and `occlusalMinWallThicknessMm` (occlusal walls). Both come
// from the profile via `PipelineContext` — NEVER hardcoded here (CLAUDE.md
// invariant 7); the 0.5 mm zirconia numbers live only in
// `clinical-profiles/`.
//
// ## Fail-safe: over-report thin, never silently pass a thin wall
//
// The measurement (kernel `measureWallThickness`) is the straight-line
// closest-surface distance between the inner and outer surfaces, sampled at
// BOTH meshes' vertices (min of both directions). That distance is a LOWER
// BOUND on the true through-material wall thickness, so the gate can only
// OVER-report thinness — it never lets a genuinely thin wall pass (CLAUDE.md's
// overriding rule: accuracy over speed, and a thickness gate that under-reports
// is a patient-safety defect).
//
// ## Sampling-margin fail-safe (the dangerous direction is defended)
//
// Discrete sampling could MISS a thin spot between samples — the distance
// field is 1-Lipschitz, so a between-samples point can be below the sampled
// minimum by up to the sample spacing. That is the DANGEROUS direction (the
// gate over-reporting the minimum and passing a sub-threshold wall). The
// kernel already grid-samples both surfaces at a small spacing; this gate
// closes the residual gap by SUBTRACTING the achieved `sampleSpacingMm` from
// the measured minimum before comparing to the threshold — so a wall that
// could be thinner than the threshold WITHIN sampling error FAILS. Both the
// measured minimum and the conservative (margin-subtracted) value are surfaced
// in the `QcGateResult.message` (the report).
//
// ## Dual-validation: ZERO DOM/Three/browser deps
//
// Like `marginFit.ts` / `runner.ts`, this is a pure `(input) -> QcGateResult`
// over plain Float64 buffers + `@dqcad/kernel` measurement utilities —
// callable identically from the client worker and the Node server (invariant
// 6), never touching a renderer.
import type { IndexedMesh, Vec3, WallThicknessResult } from '@dqcad/kernel';
import { measureWallThickness, distanceToClosedPolyline } from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';

/** The gate name (stable — used in the QcReport, acknowledgment lookup, UI). */
export const MIN_WALL_THICKNESS_GATE_NAME = 'minWallThickness';

/**
 * When the margin-band exclusion removes MORE than this fraction of the sampled
 * points, the gate is measuring a small residual core and the caller-supplied
 * `marginExclusionMm` band dominates the result — a defense-in-depth disclosure
 * (surfaced in the gate message) that the excluded feather/wedge, not the
 * structural bulk, is most of the surface. Chosen at one HALF of all samples:
 * once the majority of the wall is excluded, the "min wall" figure is no longer
 * a whole-restoration statement and the reviewer should confirm the band width
 * is geometry-appropriate (the crown's 0.2 mm finish-line feather vs the
 * inlay/onlay's ~restoration-thickness cavosurface convergence wedge). This is a
 * DISCLOSURE, never a pass/fail change — the gate still passes/fails on the
 * INCLUDED samples exactly as before (accuracy over speed; never weaken a gate).
 */
export const EXCLUDED_DOMINANCE_FRACTION = 0.5;

export interface MinWallThicknessGateInput {
  /** The crown shell's INNER surface (intaglio). */
  readonly innerSurfaceMesh: IndexedMesh;
  /** The crown shell's OUTER surface (morphed anatomy). */
  readonly outerSurfaceMesh: IndexedMesh;
  /** Axial minimum wall thickness (mm) — `restorationParams.minWallThicknessMm`
   * from the profile. REQUIRED (never defaulted here). */
  readonly minWallThicknessMm: number;
  /** Occlusal minimum wall thickness (mm) — `occlusalMinWallThicknessMm` from
   * the profile. REQUIRED. */
  readonly occlusalMinWallThicknessMm: number;
  /** Insertion axis — classifies occlusal vs axial walls. */
  readonly insertionAxis: Vec3;
  /** Confirmed margin polyline (dense `resampledPoints`) — samples within
   * `marginExclusionMm` of it are excluded (the feather edge). Optional. */
  readonly marginResampledPoints?: readonly Vec3[];
  /** Margin-band exclusion distance (mm) — default 0 (include every sample). */
  readonly marginExclusionMm?: number;
  /**
   * Phase 6 Task 5: FRAMEWORK MODE — when `true`, the gate judges the wall
   * against the single framework (coping/substructure) minimum
   * `frameworkMinThicknessMm` (BOTH axial and occlusal walls; a framework has
   * one reduced minimum, not the two full-contour minimums) instead of the
   * standing `minWallThicknessMm` / `occlusalMinWallThicknessMm`. When absent /
   * `false` (full-contour, the default) the gate behaves EXACTLY as before —
   * byte-identical result/message (proven by the unchanged full-contour tests).
   */
  readonly frameworkMode?: boolean;
  /** The framework minimum wall thickness (mm) — `profile.frameworkMinThicknessMm`.
   * REQUIRED when `frameworkMode` is `true` (never defaulted). */
  readonly frameworkMinThicknessMm?: number;
}

/** Thrown when a required threshold is missing/non-finite — the profile
 * minimums are mandatory (there is no min-wall gate without a real minimum;
 * never defaulted — CLAUDE.md invariant 7). */
export class MinWallThicknessInputError extends Error {
  constructor(paramName: string, value: unknown) {
    super(
      `minWallThicknessGate: required threshold "${paramName}" is missing or non-finite (got ${String(value)}) — ` +
        `it must be resolved from the material profile (clinical-profiles), never defaulted here.`,
    );
    this.name = 'MinWallThicknessInputError';
  }
}

export interface MinWallThicknessMeasurement extends WallThicknessResult {
  /** The governing threshold (mm) the OVERALL min is judged against — the
   * region minimum that is (or is closest to being) violated. */
  readonly governingThresholdMm: number;
  /** The conservative minimum used for pass/fail: measured minimum MINUS the
   * achieved sample spacing (the fail-safe sampling margin — see this file's
   * doc). This, not the raw measured min, is compared to the threshold. */
  readonly conservativeMinThicknessMm: number;
  /** True iff a wall sample survived (`measured`) AND every occlusal sample ≥
   * occlusal min AND every axial sample ≥ axial min, each after subtracting the
   * sampling margin. `measured===false` (zero surviving samples) is an explicit
   * hard FAIL — never "infinitely thick" (kernel fold-in 516a283). */
  readonly passed: boolean;
  /** The THINNEST wall among the EXCLUDED (margin-band) inner vertices — i.e.
   * how thin the excluded feather/wedge actually got. `Infinity` when nothing
   * is excluded (no margin loop, exclusion 0, or no vertex fell in the band).
   * Computed at INNER-VERTEX resolution from `perInnerVertexMm` (the kernel
   * retains the raw, unmasked inner→outer distance at every inner vertex) — so
   * a caller can see the excluded region is a genuine thin feather governed by
   * `marginFit`, not a hidden structural defect the band silently swallowed.
   *
   * @errorBound Vertex-resolution, not grid-resolution: the INCLUDED minimum is
   * grid-sampled at ≤ `sampleSpacingMm`, but the kernel does not retain
   * per-excluded-sample distances, so this excluded minimum is taken over the
   * inner-surface VERTICES in the band only. A between-vertices excluded point
   * can be thinner than this value by up to the local inner-mesh edge length
   * (the 1-Lipschitz distance-field argument). Acceptable because this figure
   * is a DISCLOSURE about the marginFit-governed feather, never a pass/fail
   * input — the gate's verdict is computed solely from the grid-sampled
   * included region with its own conservative sampling margin. */
  readonly minExcludedThicknessMm: number;
  /** Fraction (0..1) of all considered grid samples the margin band excluded
   * (`excludedCount / (excludedCount + sampleCount)`). When it exceeds
   * `EXCLUDED_DOMINANCE_FRACTION` the band dominates the measurement — disclosed
   * in the gate message (defense-in-depth for the caller-supplied band). */
  readonly excludedFraction: number;
}

/**
 * Measures the shell's min wall thickness and evaluates it against the two
 * profile minimums. Pure/deterministic.
 *
 * @throws {MinWallThicknessInputError} if a threshold is missing/non-finite.
 */
export function measureMinWallThickness(input: MinWallThicknessGateInput): MinWallThicknessMeasurement {
  if (!Number.isFinite(input.minWallThicknessMm)) {
    throw new MinWallThicknessInputError('minWallThicknessMm', input.minWallThicknessMm);
  }
  if (!Number.isFinite(input.occlusalMinWallThicknessMm)) {
    throw new MinWallThicknessInputError('occlusalMinWallThicknessMm', input.occlusalMinWallThicknessMm);
  }
  // Phase 6 Task 5: framework mode judges BOTH wall regions against the single
  // framework minimum. Full-contour (the default) keeps the two standing
  // minimums, so `axialMin`/`occlusalMin` equal the original inputs and every
  // downstream computation + message is byte-identical to the pre-Task-5 gate.
  if (input.frameworkMode && !Number.isFinite(input.frameworkMinThicknessMm)) {
    throw new MinWallThicknessInputError('frameworkMinThicknessMm', input.frameworkMinThicknessMm);
  }
  const axialMin = input.frameworkMode ? input.frameworkMinThicknessMm! : input.minWallThicknessMm;
  const occlusalMin = input.frameworkMode ? input.frameworkMinThicknessMm! : input.occlusalMinWallThicknessMm;
  const m = measureWallThickness(input.innerSurfaceMesh, input.outerSurfaceMesh, {
    insertionAxis: input.insertionAxis,
    marginLoop: input.marginResampledPoints,
    marginExclusionMm: input.marginExclusionMm,
  });

  // Fail-safe sampling margin: compare (measured − sampleSpacing) to the
  // threshold, so a wall that could be thinner than the threshold within
  // sampling error fails (see this file's doc).
  const margin = m.sampleSpacingMm;
  const consOcclusal = m.minOcclusalThicknessMm - margin;
  const consAxial = m.minAxialThicknessMm - margin;
  // A region with no samples (Infinity) trivially satisfies its threshold.
  const occlusalOk = !Number.isFinite(m.minOcclusalThicknessMm) || consOcclusal >= occlusalMin;
  const axialOk = !Number.isFinite(m.minAxialThicknessMm) || consAxial >= axialMin;
  // Fold-in from the kernel gate-feeder fix (516a283): a measurement over ZERO
  // surviving samples is a MEASUREMENT FAILURE, not "infinitely thick".
  // `measureWallThickness` now sets `measured=false` (+ a fail-closed
  // `minThicknessMm=0` sentinel) when no wall sample survived — every grid
  // sample fell inside the margin band, or a degenerate/over-cropped surface
  // left nothing to gate. This gate treats `measured===false` as an EXPLICIT
  // hard FAIL (never relying only on the `0 >= threshold` sentinel): the pass
  // predicate REQUIRES `m.measured`, and the message says so plainly.
  const passed = m.measured && occlusalOk && axialOk;
  const conservativeMinThicknessMm = m.minThicknessMm - margin;

  // Governing threshold: whichever region's deficit is worst (for the reported
  // `value <= threshold` framing). Default to the axial minimum.
  const axialDeficit = axialMin - consAxial;
  const occlusalDeficit = occlusalMin - consOcclusal;
  const governingThresholdMm =
    Number.isFinite(m.minOcclusalThicknessMm) && occlusalDeficit > axialDeficit
      ? occlusalMin
      : axialMin;

  // Max EXCLUDED thinness: the thinnest inner→outer distance among the inner
  // vertices the margin band excluded. `perInnerVertexMm` carries the raw,
  // unmasked distance at every inner vertex; an inner vertex is "excluded"
  // exactly when it is within `marginExclusionMm` of the margin loop (the same
  // predicate the kernel measurement applied to its grid samples — reapplied
  // here at vertex resolution because the kernel does not retain per-excluded
  // sample distances). Surfaced so the excluded band is disclosed as a genuine
  // feather governed by marginFit, not an unexamined blind spot.
  const marginLoop = input.marginResampledPoints;
  const exclusion = input.marginExclusionMm ?? 0;
  let minExcludedThicknessMm = Infinity;
  if (marginLoop !== undefined && exclusion > 0 && m.excludedCount > 0) {
    const positions = input.innerSurfaceMesh.positions;
    const vertexCount = m.perInnerVertexMm.length;
    for (let i = 0; i < vertexCount; i++) {
      const p: Vec3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
      if (distanceToClosedPolyline(p, marginLoop) < exclusion) {
        const d = m.perInnerVertexMm[i]!;
        if (d < minExcludedThicknessMm) minExcludedThicknessMm = d;
      }
    }
  }
  const totalSamples = m.sampleCount + m.excludedCount;
  const excludedFraction = totalSamples > 0 ? m.excludedCount / totalSamples : 0;

  return { ...m, governingThresholdMm, conservativeMinThicknessMm, passed, minExcludedThicknessMm, excludedFraction };
}

/**
 * The minimum-wall-thickness QC gate — emits a `QcGateResult` with the
 * measured overall min as `value`, the governing profile threshold, `'mm'`
 * unit. `passed` iff every occlusal sample ≥ occlusal min AND every axial
 * sample ≥ axial min. Pure/deterministic; Node- and worker-callable.
 *
 * @throws {MinWallThicknessInputError} via `measureMinWallThickness`.
 */
export function minWallThicknessGate(input: MinWallThicknessGateInput): QcGateResult {
  const m = measureMinWallThickness(input);
  // A measurement FAILURE (`measured===false`) reports a NULL value, not the
  // kernel's fail-closed `0` sentinel — the report must read "unmeasurable",
  // never a spurious "0 mm thick" figure that could be misread as a real value.
  const value = m.measured && Number.isFinite(m.minThicknessMm) ? m.minThicknessMm : null;
  // Effective per-region minimums for the message — equal to the standing
  // minimums in full-contour (byte-identical message), the single framework
  // minimum in framework mode.
  const axialMin = input.frameworkMode ? input.frameworkMinThicknessMm! : input.minWallThicknessMm;
  const occlusalMin = input.frameworkMode ? input.frameworkMinThicknessMm! : input.occlusalMinWallThicknessMm;
  const um = (mm: number): string => (Number.isFinite(mm) ? `${(mm * 1000).toFixed(0)} µm` : '—');
  // The EXCLUDED-band disclosure (T6-review gate hardening) — appended ONLY when
  // the margin band actually removed samples, so a run with nothing excluded is
  // byte-identical to the pre-hardening message (the excluded feather/wedge is a
  // marginFit concern, and the min-wall figure is a whole-restoration statement
  // only when the band does not dominate). Surfaces the MAX EXCLUDED THINNESS
  // (how thin the excluded feather got) and a dominance warning.
  // The un-missable disclosure (cad-pipeline review MEDIUM): when the gate
  // PASSES on the included core BUT the margin band excluded a wall thinner than
  // the governing minimum, that sub-minimum region is NOT gated here (it is
  // marginFit's concern). On a shallow cavity a thin pulpal FLOOR can fall
  // entirely inside the (~restoration-thickness) exclusion band while a thicker
  // central island keeps the gate passing — a silent clean pass would then hide
  // an ungated thin region. This annotation makes that consequence load-bearing
  // in the report (a DISCLOSURE, never a pass/fail change — never weaken the
  // gate). Guarded on `m.passed`: a FAILING gate is already blocked, so there is
  // no hidden pass to surface. A crown's ~0.2 mm feather stays above the wall
  // minimum, so it does NOT trigger (only the cavity's wide cavosurface band
  // does) — see the band-width contrast in this file's doc.
  const ungatedThinFloorWarning =
    m.passed && Number.isFinite(m.minExcludedThicknessMm) && m.minExcludedThicknessMm < m.governingThresholdMm
      ? `; WARNING: the excluded band contains a wall as thin as ${um(m.minExcludedThicknessMm)} (< the ${um(m.governingThresholdMm)} minimum) that is NOT gated here (governed by marginFit) — confirm it is a marginal feather, not an ungated structural floor`
      : '';
  const excludedDetail =
    m.excludedCount > 0
      ? ` — excluded ${m.excludedCount} sample(s) down to ${um(m.minExcludedThicknessMm)} (marginal feather/wedge, governed by marginFit)` +
        (m.excludedFraction > EXCLUDED_DOMINANCE_FRACTION
          ? `; WARNING: excluded ${(m.excludedFraction * 100).toFixed(0)}% of samples dominates the measurement (> ${(EXCLUDED_DOMINANCE_FRACTION * 100).toFixed(0)}% — verify the marginExclusion band is geometry-appropriate)`
          : '') +
        ungatedThinFloorWarning
      : '';
  const message = !m.measured
    ? // Fold-in hard FAIL (516a283): zero surviving wall samples is a measurement
      // FAILURE, never a pass. Distinguish the two causes so the report is clear.
      `min wall thickness MEASUREMENT FAILED — HARD FAIL (fail-closed): ${
        m.excludedCount > 0
          ? `every wall sample (${m.excludedCount}) fell inside the marginExclusion band — NO structural sample was gated; the wall is entirely within the marginFit-governed feather (verify the band width, or re-gate the floor)`
          : `zero wall samples (inner/outer surfaces do not face each other, or a degenerate/over-cropped surface)`
      } — not manufacturable`
    : m.passed
      ? `min wall thickness ${um(m.minThicknessMm)} (conservative ${um(m.conservativeMinThicknessMm)} after −${um(m.sampleSpacingMm)} sampling margin) >= ${um(m.governingThresholdMm)} ` +
        `(axial ${um(m.minAxialThicknessMm)}, occlusal ${um(m.minOcclusalThicknessMm)}; ${m.excludedCount} margin sample(s) excluded)` +
        excludedDetail
      : `min wall thickness ${um(m.minThicknessMm)} (conservative ${um(m.conservativeMinThicknessMm)} after −${um(m.sampleSpacingMm)} sampling margin) BELOW minimum ` +
        `(axial ${um(m.minAxialThicknessMm)} vs ${um(axialMin)}, occlusal ${um(m.minOcclusalThicknessMm)} vs ${um(occlusalMin)}) ` +
        `— thin wall; thicken (autoThicken) or acknowledge` +
        excludedDetail;
  return {
    gate: MIN_WALL_THICKNESS_GATE_NAME,
    passed: m.passed,
    acknowledged: false,
    value,
    threshold: m.governingThresholdMm,
    unit: 'mm',
    message,
  };
}
