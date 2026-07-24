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
// Pure/deterministic; DOM/Three-free (invariant 6).
import type { QcGateResult } from '@dqcad/shared-types';

/** Stable gate name (QcReport, acknowledgment lookup, UI). */
export const CONNECTOR_CROSS_SECTION_GATE_NAME = 'connectorCrossSection';

/** A single measured connector (Phase 6 fills these in for bridges). */
export interface ConnectorCrossSection {
  /** Human label, e.g. "21–22". */
  readonly label: string;
  /** Measured minimum cross-sectional area (mm²) along the connector. */
  readonly minAreaMm2: number;
}

export interface ConnectorCrossSectionGateInput {
  /** The profile's minimum connector cross-section target (mm²) for this
   * restoration's region (anterior/posterior) — from
   * `context.materialProfile.connectorAreaMm2`. Threaded through for Phase 6;
   * used as the reported `threshold`. */
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
  // Phase 6 path: fail if any connector is below the profile target.
  let minAreaMm2 = Number.POSITIVE_INFINITY;
  let worst: ConnectorCrossSection | null = null;
  for (const c of connectors) {
    if (c.minAreaMm2 < minAreaMm2) {
      minAreaMm2 = c.minAreaMm2;
      worst = c;
    }
  }
  const passed = minAreaMm2 >= input.connectorAreaTargetMm2;
  return {
    gate: CONNECTOR_CROSS_SECTION_GATE_NAME,
    passed,
    acknowledged: false,
    value: minAreaMm2,
    threshold: input.connectorAreaTargetMm2,
    unit: 'mm²',
    message: passed
      ? `min connector cross-section ${minAreaMm2.toFixed(2)} mm² ≥ ${input.connectorAreaTargetMm2} mm² (${connectors.length} connector(s))`
      : `connector "${worst?.label ?? '?'}" cross-section ${minAreaMm2.toFixed(2)} mm² BELOW ${input.connectorAreaTargetMm2} mm² — fracture risk`,
  };
}
