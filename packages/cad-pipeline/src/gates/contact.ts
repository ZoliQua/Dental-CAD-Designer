// packages/cad-pipeline/src/gates/contact.ts
//
// Phase 4 Task 9: the CONTACT QC gate (occlusal + proximal) — the §6 contact
// gate. It checks that the morphed crown actually MAKES its designed contacts:
// each proximal (mesial/distal) and the occlusal (antagonist) contact must land
// within tolerance of the PROFILE target, consuming the Task-6 morphing stage's
// measured residuals (never re-deriving geometry here).
//
// ## Inputs come from the T6 morph result — genuine measured residuals
//
// The adaptation/morphing stage (`stages/morphing.ts`) already measures, per
// contact: the target penetration (`targetPenetrationMm`, from the profile —
// proximal `proximalContactPenetrationMm` 0.02, occlusal `occlusalContactMm` 0),
// the achieved signed distance, the single-vertex residual (`contactResidualMm`),
// the worst region over-penetration (`regionResidualMm`), and whether the
// root-find CLAMPED (target unreachable within the travel bound → `clampBound`).
// This gate consumes those numbers directly. The target is thus profile-sourced
// (invariant 7); only the ACHIEVEMENT tolerance is a gate parameter.
//
// ## Pass/fail + the clamp warning
//
// - The conservative per-contact residual is `max(contactResidualMm,
//   regionResidualMm)` (the same conservative pairing the morph's own
//   `errorBoundMm` uses — so a region that over-penetrates while the contact
//   vertex sits on target cannot read as a deceptively small residual).
// - The gate PASSES iff NO contact clamped (`contactClampWarning` false — every
//   target was actually reachable) AND the worst conservative residual ≤ the
//   achievement tolerance.
// - A CLAMPED contact means the designed contact was NOT achieved (the crown does
//   not reach the neighbour/antagonist there). That is a genuine failure, so it
//   fails the gate AND is surfaced in the message. Per CLAUDE.md invariant 4 a
//   failed gate is acknowledge-able-with-warning at the runner (journaled), never
//   silently flipped to pass — the clamp is exactly such a surfaced warning.
//
// ## Tolerance — a QC-gate tolerance, not a clinical profile default
//
// `CONTACT_GATE_DEFAULT_TOLERANCE_MM` (50 µm) is the allowed deviation of the
// ACHIEVED contact from its profile TARGET — a clinical contact-accuracy budget
// (proximal/occlusal contacts are clinically acceptable within a few tens of µm),
// on the same "QC-gate tolerance, not a clinical design default" footing as
// `marginFit.ts`'s fixed 10 µm bar (invariant 7 governs gaps/thicknesses/
// connector-area, which stay in the profile — a contact-achievement tolerance is
// not one of those). Overridable per-call.
//
// Pure/deterministic; DOM/Three-free (invariant 6).
import type { QcGateResult } from '@dqcad/shared-types';

/** Stable gate name (QcReport, acknowledgment lookup, UI). */
export const CONTACT_GATE_NAME = 'contact';

/** Default achievement tolerance (mm) — 50 µm (see this file's module doc). */
export const CONTACT_GATE_DEFAULT_TOLERANCE_MM = 0.05;

/** One contact's measured residuals, straight from the T6 morph result. */
export interface ContactResidualInput {
  /** 'proximalMesial' | 'proximalDistal' | 'antagonist' (the morph's kinds). */
  readonly kind: string;
  /** Profile target penetration depth (mm) for this contact. */
  readonly targetPenetrationMm: number;
  /** Achieved signed distance (mm; negative = penetrating). */
  readonly achievedSignedDistanceMm: number;
  /** Single-vertex residual |achieved − target| (mm). */
  readonly contactResidualMm: number;
  /** Worst region over-penetration residual (mm). */
  readonly regionResidualMm: number;
  /** True iff this contact's root-find hit the travel clamp (target unreached). */
  readonly clampBound: boolean;
}

export interface ContactGateInput {
  /** Per-contact residuals from the morph (`stages/morphing.ts` params.contacts). */
  readonly contacts: readonly ContactResidualInput[];
  /** Whether ANY contact clamped (morph `contactClampWarning`). */
  readonly contactClampWarning: boolean;
  /** Override the achievement tolerance (default `CONTACT_GATE_DEFAULT_TOLERANCE_MM`). */
  readonly toleranceMm?: number;
}

/** Conservative per-contact residual: the larger of the single-vertex and the
 * worst-region residual. */
function conservativeResidual(c: ContactResidualInput): number {
  return Math.max(c.contactResidualMm, c.regionResidualMm);
}

/**
 * The occlusal + proximal contact QC gate — passes iff every designed contact
 * was reached (no clamp) and lands within `toleranceMm` of its profile target.
 * Value = the worst conservative residual (mm); threshold = the tolerance. Pure/
 * deterministic; Node- and worker-callable.
 */
export function contactGate(input: ContactGateInput): QcGateResult {
  const tolerance = input.toleranceMm ?? CONTACT_GATE_DEFAULT_TOLERANCE_MM;

  if (input.contacts.length === 0) {
    // No contacts to evaluate is unverifiable — fail-safe (a crown that made no
    // contacts is not a passing crown). This is not the single-crown-N/A case:
    // a crown always has proximal + occlusal contact targets from the morph.
    return {
      gate: CONTACT_GATE_NAME,
      passed: false,
      acknowledged: false,
      value: null,
      threshold: tolerance,
      unit: 'mm',
      message: 'contact UNVERIFIABLE — no contact residuals supplied (the morph stage did not run); fail-safe: does not pass',
    };
  }

  let worst = 0;
  let worstKind = input.contacts[0]!.kind;
  const clamped: string[] = [];
  for (const c of input.contacts) {
    const r = conservativeResidual(c);
    if (r > worst) {
      worst = r;
      worstKind = c.kind;
    }
    if (c.clampBound) clamped.push(c.kind);
  }

  const withinTolerance = worst <= tolerance;
  const passed = !input.contactClampWarning && clamped.length === 0 && withinTolerance;

  const um = (mm: number): string => `${(mm * 1000).toFixed(1)} µm`;
  const clampNote = clamped.length > 0 ? ` | CLAMP WARNING: contact(s) [${clamped.join(', ')}] did NOT reach target (unachieved)` : '';
  const message = passed
    ? `contacts achieved — worst residual ${um(worst)} (${worstKind}) ≤ ${um(tolerance)} tolerance; no clamped contacts`
    : `contact residual ${um(worst)} (${worstKind}) ${withinTolerance ? 'within tolerance but' : `exceeds ${um(tolerance)} tolerance;`} ` +
      `${clamped.length > 0 ? 'one or more contacts were not achieved' : 'contact off target'}${clampNote}`;

  return {
    gate: CONTACT_GATE_NAME,
    passed,
    acknowledged: false,
    value: worst,
    threshold: tolerance,
    unit: 'mm',
    message,
  };
}
