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
// ## @errorBound surfaced to the QC report
//
// The pointwise distance is exact Float64; the only approximation is DISCRETE
// SAMPLING at mesh vertices (a thin feature narrower than the local vertex
// spacing could sit between samples). The kernel reports that resolution as
// `sampleSpacingMm`; this gate surfaces it in the `QcGateResult.message` (the
// report), so a reviewer sees the localization resolution behind the number.
//
// ## Dual-validation: ZERO DOM/Three/browser deps
//
// Like `marginFit.ts` / `runner.ts`, this is a pure `(input) -> QcGateResult`
// over plain Float64 buffers + `@dqcad/kernel` measurement utilities —
// callable identically from the client worker and the Node server (invariant
// 6), never touching a renderer.
import type { IndexedMesh, Vec3, WallThicknessResult } from '@dqcad/kernel';
import { measureWallThickness } from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';

/** The gate name (stable — used in the QcReport, acknowledgment lookup, UI). */
export const MIN_WALL_THICKNESS_GATE_NAME = 'minWallThickness';

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
  /** True iff every occlusal sample ≥ occlusal min AND every axial sample ≥
   * axial min. */
  readonly passed: boolean;
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
  const m = measureWallThickness(input.innerSurfaceMesh, input.outerSurfaceMesh, {
    insertionAxis: input.insertionAxis,
    marginLoop: input.marginResampledPoints,
    marginExclusionMm: input.marginExclusionMm,
  });

  // A region with no samples (Infinity) trivially satisfies its threshold.
  const occlusalOk = !Number.isFinite(m.minOcclusalThicknessMm) || m.minOcclusalThicknessMm >= input.occlusalMinWallThicknessMm;
  const axialOk = !Number.isFinite(m.minAxialThicknessMm) || m.minAxialThicknessMm >= input.minWallThicknessMm;
  const passed = m.sampleCount > 0 && occlusalOk && axialOk;

  // Governing threshold: whichever region's deficit is worst (for the reported
  // `value <= threshold` framing). Default to the axial minimum.
  const axialDeficit = input.minWallThicknessMm - m.minAxialThicknessMm;
  const occlusalDeficit = input.occlusalMinWallThicknessMm - m.minOcclusalThicknessMm;
  const governingThresholdMm =
    Number.isFinite(m.minOcclusalThicknessMm) && occlusalDeficit > axialDeficit
      ? input.occlusalMinWallThicknessMm
      : input.minWallThicknessMm;

  return { ...m, governingThresholdMm, passed };
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
  const value = Number.isFinite(m.minThicknessMm) ? m.minThicknessMm : null;
  const um = (mm: number): string => (Number.isFinite(mm) ? `${(mm * 1000).toFixed(0)} µm` : '—');
  const message =
    m.sampleCount === 0
      ? `min wall thickness UNMEASURABLE (no samples — inner/outer surfaces do not face each other)`
      : m.passed
        ? `min wall thickness ${um(m.minThicknessMm)} >= ${um(m.governingThresholdMm)} ` +
          `(axial ${um(m.minAxialThicknessMm)} >= ${um(input.minWallThicknessMm)}, occlusal ${um(m.minOcclusalThicknessMm)} >= ${um(input.occlusalMinWallThicknessMm)}; ` +
          `${m.excludedCount} margin sample(s) excluded; scan resolution ±${um(m.sampleSpacingMm)})`
        : `min wall thickness ${um(m.minThicknessMm)} BELOW minimum ` +
          `(axial ${um(m.minAxialThicknessMm)} vs ${um(input.minWallThicknessMm)}, occlusal ${um(m.minOcclusalThicknessMm)} vs ${um(input.occlusalMinWallThicknessMm)}; ` +
          `scan resolution ±${um(m.sampleSpacingMm)}) — thin wall; thicken (autoThicken) or acknowledge`;
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
