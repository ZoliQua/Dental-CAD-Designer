// packages/cad-pipeline/src/gates/ponticRelief.ts
//
// Phase 6 Task 6 — the PONTIC-RELIEF QC gate. Phase 3 Task 3 built the kernel
// instrument `measurePonticRelief`, which measures the signed distance between the
// pontic base and the gingiva mesh over the ACCEPTANCE (primary) patch — hygienic
// clearance / modified-ridge-lap buccal contact / ovate seat — and reports the
// worst absolute deviation from the CONFIGURED relief (`primary.maxAbsDeviationMm`).
// This gate turns that measurement into a pass/fail: the pontic–gingiva relation
// must match the configured relief within ±20 µm (the PLAN Phase 6 acceptance).
//
// ## The gate value + threshold
//
// `value` = `primary.maxAbsDeviationMm` (mm) — the worst |measured − configured|
// over the acceptance patch. `threshold` = ±20 µm (0.020 mm, the acceptance).
// `passed` iff `value <= threshold`. The gate does NOT re-measure geometry — it
// consumes the kernel measurement the pontic stage produced (the same
// "produce the measurement in the stage, judge it in the gate" split the connector-
// area gate uses). Falsifiable: a mis-configured / unshaped base produces a
// deviation ≫ 20 µm (Task 3 measured ~1000–2000 µm) and this gate BLOCKS.
//
// ## Threshold provenance (invariant 7 — not a clinical DESIGN default)
//
// The ±20 µm bar is the PLAN's QC acceptance TOLERANCE (how tightly the built
// geometry must match the configured relief), on the same footing as marginFit's
// fixed 10 µm — NOT a clinical gap/thickness (those live in the profile and are
// the CONFIGURED relief the deviation is measured AGAINST; the relief target itself
// comes from the profile, invariant 7, and is echoed here only for the message).
// Overridable per-call for testing a deliberately-tight/loose bar.
//
// Pure/deterministic; DOM/Three-free (invariant 6) — Node- and worker-callable.
import type { QcGateResult } from '@dqcad/shared-types';

/** Stable gate name (QcReport, acknowledgment lookup, UI). */
export const PONTIC_RELIEF_GATE_NAME = 'ponticRelief';

/** The ±20 µm phase acceptance threshold (mm) — PLAN Phase 6 acceptance #3
 * ("the pontic–gingiva relation matches the configured relief within ±20 µm").
 * A QC-gate tolerance (like marginFit's 10 µm), not a clinical design default.
 * Overridable per-call. */
export const PONTIC_RELIEF_GATE_THRESHOLD_MM = 0.02;

export interface PonticReliefGateInput {
  /** The worst |measured − configured| over the acceptance (primary) patch (mm) —
   * `measurePonticRelief(...).primary.maxAbsDeviationMm`. REQUIRED. */
  readonly maxAbsDeviationMm: number;
  /** The interface style, for the message ('hygienic' | 'modifiedRidgeLap' | 'ovate'). */
  readonly style: string;
  /** The CONFIGURED relief the deviation is measured against (mm, from the
   * profile) — echoed in the message. */
  readonly configuredReliefMm: number;
  /** Override the ±20 µm threshold (testing only — the acceptance is fixed). */
  readonly thresholdMm?: number;
}

/**
 * The pontic-relief QC gate — passes iff the measured pontic base ↔ gingiva relief
 * matches the configured value within ±20 µm. `value` = the worst abs deviation
 * (mm); `threshold` = the tolerance. Pure/deterministic; Node- and worker-callable.
 */
export function ponticReliefGate(input: PonticReliefGateInput): QcGateResult {
  const threshold = input.thresholdMm ?? PONTIC_RELIEF_GATE_THRESHOLD_MM;
  const dev = input.maxAbsDeviationMm;
  const passed = Number.isFinite(dev) && dev <= threshold;
  const um = (mm: number): string => (Number.isFinite(mm) ? `${(mm * 1000).toFixed(2)} µm` : '∞');
  const message = passed
    ? `pontic relief (${input.style}) matches configured ${input.configuredReliefMm} mm within ±${(threshold * 1000).toFixed(0)} µm ` +
      `(worst deviation ${um(dev)})`
    : `pontic relief (${input.style}) DEVIATES ${um(dev)} from configured ${input.configuredReliefMm} mm ` +
      `— exceeds ±${(threshold * 1000).toFixed(0)} µm acceptance (mis-shaped or mis-configured base)`;
  return {
    gate: PONTIC_RELIEF_GATE_NAME,
    passed,
    acknowledged: false,
    value: Number.isFinite(dev) ? dev : null,
    threshold,
    unit: 'mm',
    message,
  };
}
