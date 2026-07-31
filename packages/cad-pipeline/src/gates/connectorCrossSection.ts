// packages/cad-pipeline/src/gates/connectorCrossSection.ts
//
// Phase 4 Task 9: the CONNECTOR CROSS-SECTION QC gate — the §6 connector gate.
//
// ## Documented STUB for Phase 6 (bridges) — NOT a faked measurement
//
// A connector is the bar of material joining two units of a BRIDGE; its minimum
// cross-sectional area (`connectorAreaMm2` from the profile — anterior vs
// posterior) is a fracture-strength gate. A SINGLE crown has NO connector, so
// there is nothing to measure — this gate returns a structured N/A result that
// PASSES (a single crown cannot fail a connector gate it has no connector for),
// carrying the profile target so Phase 6's bridge work can fill in the real
// per-connector cross-section measurement without changing this gate's shape or
// its place in the ordered gate set.
//
// This is deliberately NOT a fabricated number: `value` is `null` (no
// measurement exists for a single crown), `threshold` is the profile target
// (threaded through from context — CLAUDE.md invariant 7, never hardcoded), and
// the message states plainly that connector evaluation is Phase 6 work. When
// Phase 6 supplies `connectors`, this gate will measure each connector's min
// cross-section and fail if any is below target.
//
// ## Phase 6 Task 4 — FILLED IN (the real per-connector measurement)
//
// Phase 6 supplies one `ConnectorCrossSection` per bridge connector, each
// carrying the kernel-measured minimum cross-section area (`@dqcad/kernel`'s
// `measureConnectorMinArea` — the fail-safe lower bound, never over-reporting)
// and, per connector, its OWN positional target resolved from the two units it
// spans via the documented FDI rule (`connectorPositionalTargetMm2`): a connector
// is POSTERIOR (target `connectorAreaMm2.posteriorMm2`, 9) iff EITHER spanned
// tooth is a premolar/molar (FDI position digit ≥ 4), else ANTERIOR (target
// `anteriorMm2`, 7) — the STRICTER (larger) target wins at an anterior↔posterior
// boundary, the conservative call for a fracture-strength gate. The single-crown
// N/A path (no `connectors`) is UNCHANGED (its existing tests pass byte-for-byte).
//
// Pure/deterministic; DOM/Three-free (invariant 6).
import type { FdiTooth, QcGateResult } from '@dqcad/shared-types';

/** Stable gate name (QcReport, acknowledgment lookup, UI). */
export const CONNECTOR_CROSS_SECTION_GATE_NAME = 'connectorCrossSection';

/** The profile's connector-area targets by position (structurally the pipeline
 * `PipelineConnectorAreaTargets` / clinical `ConnectorAreaTargets`). */
export interface ConnectorAreaTargetsMm2 {
  readonly posteriorMm2: number;
  readonly anteriorMm2: number;
}

/** The FDI POSITION digit of a tooth (1–8: 1 central incisor … 8 third molar).
 * `FdiTooth` is `quadrant*10 + position`, so `tooth % 10` is the position. */
export function fdiPositionDigit(tooth: FdiTooth): number {
  return tooth % 10;
}

/** Is `tooth` posterior (premolar or molar — FDI position digit ≥ 4)? Anterior
 * (incisor/canine) is position 1–3. */
export function isPosteriorTooth(tooth: FdiTooth): boolean {
  return fdiPositionDigit(tooth) >= 4;
}

/**
 * The documented FDI RULE for a connector's positional area target: a connector
 * spanning `toothA`↔`toothB` is POSTERIOR (returns `targets.posteriorMm2`) iff
 * EITHER tooth is posterior (position digit ≥ 4), else ANTERIOR
 * (`targets.anteriorMm2`). Using "either" (not "both") picks the STRICTER target
 * at an anterior↔posterior boundary connector (e.g. canine 3 ↔ premolar 4) —
 * the conservative choice for a fracture-strength gate. Pure/deterministic.
 */
export function connectorPositionalTargetMm2(
  toothA: FdiTooth,
  toothB: FdiTooth,
  targets: ConnectorAreaTargetsMm2,
): number {
  return isPosteriorTooth(toothA) || isPosteriorTooth(toothB) ? targets.posteriorMm2 : targets.anteriorMm2;
}

/** A single measured connector (Phase 6 fills these in for bridges). */
export interface ConnectorCrossSection {
  /** Human label, e.g. "21–22". */
  readonly label: string;
  /** Measured minimum cross-sectional area (mm²) along the connector. */
  readonly minAreaMm2: number;
  /** The two units this connector spans (for the positional FDI rule + message).
   * Optional for backward-compatibility with the single-target path. */
  readonly teeth?: readonly [FdiTooth, FdiTooth];
  /** This connector's OWN positional target (mm²), pre-resolved by the caller
   * (via `connectorPositionalTargetMm2`). When present it OVERRIDES the gate's
   * global `connectorAreaTargetMm2` for THIS connector; absent ⇒ the global
   * target applies (the original single-target behaviour). */
  readonly targetMm2?: number;
}

export interface ConnectorCrossSectionGateInput {
  /** The profile's minimum connector cross-section target (mm²) for this
   * restoration's region (anterior/posterior) — from
   * `context.materialProfile.connectorAreaMm2`. Threaded through for Phase 6;
   * used as the reported `threshold` and as the fallback target for any
   * connector that does not carry its own `targetMm2`. */
  readonly connectorAreaTargetMm2: number;
  /** Measured connectors — EMPTY/absent for a single crown (the N/A stub path).
   * Phase 6 supplies one entry per bridge connector. */
  readonly connectors?: readonly ConnectorCrossSection[];
}

/**
 * The connector-cross-section QC gate. For a single crown (no `connectors`)
 * this is a documented N/A PASS (see this file's module doc). For a bridge
 * (Phase 6), it passes iff every connector's min cross-section ≥ the profile
 * target. Pure/deterministic.
 */
export function connectorCrossSectionGate(input: ConnectorCrossSectionGateInput): QcGateResult {
  const connectors = input.connectors ?? [];
  if (connectors.length === 0) {
    // Single-crown N/A stub — passes; Phase 6 fills in bridge connectors.
    return {
      gate: CONNECTOR_CROSS_SECTION_GATE_NAME,
      passed: true,
      acknowledged: false,
      value: null,
      threshold: input.connectorAreaTargetMm2,
      unit: 'mm²',
      message: `N/A — single crown has no connector (connector cross-section is a Phase 6 bridge gate; profile target ${input.connectorAreaTargetMm2} mm²)`,
    };
  }
  // Phase 6 path: fail if ANY connector's measured min area is below ITS target
  // (the per-connector positional `targetMm2` when present, else the global
  // `connectorAreaTargetMm2`). `value` remains the minimum measured area over
  // all connectors (the headline number); `threshold` remains the global target
  // (the single-target callers' behaviour is byte-identical — see this gate's
  // tests). The message names the worst OFFENDER (the connector furthest below
  // its own target), or the min connector when all pass.
  let minAreaMm2 = Number.POSITIVE_INFINITY;
  let passed = true;
  let worstOffender: ConnectorCrossSection | null = null;
  let worstOffenderTarget = input.connectorAreaTargetMm2;
  let worstMarginMm2 = Number.POSITIVE_INFINITY;
  for (const c of connectors) {
    if (c.minAreaMm2 < minAreaMm2) minAreaMm2 = c.minAreaMm2;
    const target = c.targetMm2 ?? input.connectorAreaTargetMm2;
    if (c.minAreaMm2 < target) passed = false;
    const margin = c.minAreaMm2 - target;
    if (margin < worstMarginMm2) {
      worstMarginMm2 = margin;
      worstOffender = c;
      worstOffenderTarget = target;
    }
  }
  // Report the threshold ACTUALLY ENFORCED against the binding (worst-offender)
  // connector — its per-connector positional `targetMm2` — not the global
  // `connectorAreaTargetMm2` (cad-pipeline review LOW #5). When a connector
  // carries its own positional target (the real bridge path always does, via
  // `connectorPositionalTargetMm2`) the reported `threshold` would otherwise
  // disagree with the target the pass/fail used: e.g. a posterior connector
  // (needs 9) under an anterior global (7) would headline "threshold 7" while
  // being judged — correctly — against 9. Reporting the enforced per-connector
  // target keeps the headline honest. When every connector shares the global
  // target (uniform bridge), `worstOffenderTarget === connectorAreaTargetMm2`,
  // so this is a no-op for those callers (their reports are byte-identical).
  return {
    gate: CONNECTOR_CROSS_SECTION_GATE_NAME,
    passed,
    acknowledged: false,
    value: minAreaMm2,
    threshold: worstOffenderTarget,
    unit: 'mm²',
    message: passed
      ? `min connector cross-section ${minAreaMm2.toFixed(2)} mm² ≥ target (${connectors.length} connector(s))`
      : `connector "${worstOffender?.label ?? '?'}" cross-section ${(worstOffender?.minAreaMm2 ?? minAreaMm2).toFixed(2)} mm² BELOW ${worstOffenderTarget} mm² — fracture risk`,
  };
}
