// packages/cad-pipeline/src/gates/cuspCoverageThickness.ts
//
// Phase 5 Task 7: the ONLAY covered-cusp REGION-SCOPED minimum-wall gate. An
// onlay must restore adequate material OVER the covered cusp — `e.max` requires
// `cuspCoverageMinThicknessMm` (1.5 mm) there, vs `onlayMinThicknessMm` (1.0 mm)
// for the isthmus/body. The body min-wall gate (minWallThickness.ts) judges the
// WHOLE restoration against the onlay minimum; THIS gate additionally judges the
// COVERED-CUSP REGION against the higher coverage minimum.
//
// ## The region-scoping rule (a documented design decision)
//
// A fit-surface sample belongs to the COVERED-CUSP region iff its footprint lies
// on the covered-cusp side of the cavity's buccal margin plane — the coverage
// DIVIDER `{ pointMm, normalMm }` supplied by the T7 cusp-coverage selection
// (the plane that separated the cavity/body from the covered cusp when the
// outline was extended). A sample `p` is coverage iff `(p − pointMm)·normalMm ≥
// 0`. The fit surface is the restoration intaglio (it exists only over the
// cavity + covered cusp), so this half-space classification is exactly the
// covered-cusp intaglio; the min over those samples is the covered-cusp wall
// thickness. Closed-form on the MOD onlay fixture (the covered cusp is exactly
// buccal of the cavity margin plane).
//
// ## Same fail-safes as the body gate (never silently pass a thin coverage)
//
// The convergence WEDGE where the restoration feathers to the cavosurface margin
// (and to the proximal break-through) crowds the covered cusp too, so — exactly
// like minWallThickness.ts — this gate EXCLUDES the `marginExclusionMm` band
// (distance to the extended outline) and SUBTRACTS the achieved `sampleSpacingMm`
// from the measured minimum before comparing to the threshold (the dangerous
// direction defended). A coverage region with NO measurable structural sample
// (all wedge) FAILS (a coverage that cannot be verified is not passed). Every
// number is surfaced in the `QcGateResult.message`.
//
// Pure `(input) -> QcGateResult` over Float64 buffers + `@dqcad/kernel`
// measurements — dual-validation clean (invariant 6), no DOM/Three deps.
import type { IndexedMesh, Vec3 } from '@dqcad/kernel';
import { measureWallThickness, distanceToClosedPolyline } from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';

/** The gate name (stable — QcReport / acknowledgment / UI). */
export const CUSP_COVERAGE_THICKNESS_GATE_NAME = 'cuspCoverageThickness';

/** The coverage DIVIDER plane: a fit sample `p` is covered-cusp iff
 * `(p − pointMm)·normalMm ≥ 0`. Supplied by the cusp-coverage selection. */
export interface CoverageDivider {
  readonly pointMm: Vec3;
  readonly normalMm: Vec3;
}

export interface CuspCoverageThicknessGateInput {
  /** The onlay INNER (fit) surface — the restoration intaglio. */
  readonly fitSurfaceMesh: IndexedMesh;
  /** The onlay OUTER (occlusal patch + adapted proximals) surface. */
  readonly patchMesh: IndexedMesh;
  readonly insertionAxis: Vec3;
  /** The EXTENDED (onlay) cavity outline — the margin-exclusion polyline. */
  readonly marginResampledPoints: readonly Vec3[];
  /** Convergence-wedge exclusion band width (mm). */
  readonly marginExclusionMm: number;
  /** The covered-cusp half-space divider. */
  readonly coverageDivider: CoverageDivider;
  /** The covered-cusp minimum wall thickness (mm) — from the profile
   * (`cuspCoverageMinThicknessMm`), NEVER defaulted here (invariant 7). */
  readonly cuspCoverageMinThicknessMm: number;
}

export interface CuspCoverageThicknessMeasurement {
  /** Structural covered-cusp min wall thickness (mm), or Infinity if no sample. */
  readonly minCoverageThicknessMm: number;
  /** minCoverageThicknessMm − sampleSpacingMm (the conservative value gated). */
  readonly conservativeMinThicknessMm: number;
  readonly sampleSpacingMm: number;
  /** Covered-cusp fit samples measured (excluding the wedge band). */
  readonly coverageSampleCount: number;
  readonly thresholdMm: number;
  readonly passed: boolean;
}

function dotSub(p: Vec3, o: Vec3, n: Vec3): number {
  return (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2];
}

/** Measures the covered-cusp region-scoped min wall thickness — see module doc. */
export function measureCuspCoverageThickness(input: CuspCoverageThicknessGateInput): CuspCoverageThicknessMeasurement {
  if (!(Number.isFinite(input.cuspCoverageMinThicknessMm) && input.cuspCoverageMinThicknessMm > 0)) {
    throw new TypeError(
      `measureCuspCoverageThickness: cuspCoverageMinThicknessMm must be finite and > 0 (got ${String(input.cuspCoverageMinThicknessMm)}) — resolve it from the material profile.`,
    );
  }
  const m = measureWallThickness(input.fitSurfaceMesh, input.patchMesh, {
    insertionAxis: input.insertionAxis,
    marginLoop: input.marginResampledPoints,
    marginExclusionMm: input.marginExclusionMm,
  });
  const excl = input.marginExclusionMm;
  const { pointMm, normalMm } = input.coverageDivider;
  const pos = input.fitSurfaceMesh.positions;
  let minCov = Infinity;
  let count = 0;
  for (let v = 0; v < m.perInnerVertexMm.length; v++) {
    const d = m.perInnerVertexMm[v]!;
    if (!Number.isFinite(d)) continue;
    const p: Vec3 = [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!];
    if (dotSub(p, pointMm, normalMm) < 0) continue; // body side, not covered cusp
    if (excl > 0 && distanceToClosedPolyline(p, input.marginResampledPoints) < excl) continue; // wedge band
    count++;
    if (d < minCov) minCov = d;
  }
  const conservative = Number.isFinite(minCov) ? minCov - m.sampleSpacingMm : Infinity;
  // A coverage region with no structural sample cannot be verified → FAIL.
  const passed = count > 0 && Number.isFinite(minCov) && conservative >= input.cuspCoverageMinThicknessMm;
  return {
    minCoverageThicknessMm: minCov,
    conservativeMinThicknessMm: conservative,
    sampleSpacingMm: m.sampleSpacingMm,
    coverageSampleCount: count,
    thresholdMm: input.cuspCoverageMinThicknessMm,
    passed,
  };
}

/** The covered-cusp region-scoped min-wall gate. */
export function cuspCoverageThicknessGate(input: CuspCoverageThicknessGateInput): QcGateResult {
  const m = measureCuspCoverageThickness(input);
  const value = Number.isFinite(m.minCoverageThicknessMm) ? m.minCoverageThicknessMm : null;
  const message = m.coverageSampleCount === 0
    ? `no structural covered-cusp sample outside the ${input.marginExclusionMm} mm convergence band — coverage cannot be verified`
    : `covered-cusp min wall ${(m.minCoverageThicknessMm * 1000).toFixed(0)} µm (conservative ${(m.conservativeMinThicknessMm * 1000).toFixed(0)} µm after −${(m.sampleSpacingMm * 1000).toFixed(0)} µm sampling margin) vs ${(m.thresholdMm * 1000).toFixed(0)} µm min; n=${m.coverageSampleCount}`;
  return {
    gate: CUSP_COVERAGE_THICKNESS_GATE_NAME,
    passed: m.passed,
    acknowledged: false,
    value,
    threshold: m.thresholdMm,
    unit: 'mm',
    message,
  };
}
