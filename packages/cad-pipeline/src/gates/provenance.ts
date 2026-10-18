// packages/cad-pipeline/src/gates/provenance.ts
//
// ADR-022 Decision 2: a gate measured on a non-`case` input can never PASS. A
// measurement taken against a stand-in (synthetic neighbour boxes, a bbox
// coverage divider, the demo bridge asset) is not a measurement of the
// patient, so the gate FAILS CLOSED — exactly like the existing "measurement
// failed / no valid samples" fail-safe rule. The measured value and threshold
// are kept (they are still informative), the message names the stand-in, and
// the result carries `inputProvenance`. Acknowledgment stays the runner's
// business (soft gates only, journaled) — this module never acknowledges.
//
// Case-derived inputs (provenance absent or `'case'`) leave the gate result
// untouched, so every existing report serializes byte-identically.
//
// Pure/deterministic; DOM/Three-free (invariant 6).
import type { GeometryProvenance, NonCaseProvenance, QcGateResult } from '@dqcad/shared-types';

/** Prefix of every fail-closed message — a stable, greppable marker (the UI
 * keys its localized explanation off `inputProvenance`, not this text). */
export const NON_CASE_INPUT_MARKER = 'NON-CASE INPUT';

/** The most severe non-`case` provenance among `inputs` (`demo-fixture` >
 * `placeholder`), or `null` when every input is case-derived (absent = case). */
export function worstProvenance(
  inputs: readonly (GeometryProvenance | undefined)[],
): NonCaseProvenance | null {
  let worst: NonCaseProvenance | null = null;
  for (const p of inputs) {
    if (p === 'demo-fixture') return 'demo-fixture';
    if (p === 'placeholder') worst = 'placeholder';
  }
  return worst;
}

/**
 * Fails `result` closed because it was measured against `provenance` geometry
 * (`standIn` names it in the message). Never turns a failure into a pass.
 */
export function failClosedOnNonCaseInput(
  result: QcGateResult,
  provenance: NonCaseProvenance,
  standIn: string,
): QcGateResult {
  return {
    ...result,
    passed: false,
    acknowledged: false,
    message:
      `${NON_CASE_INPUT_MARKER}: measured against ${provenance} geometry (${standIn}), not this case's — ` +
      `not a measurement of the patient; fail-closed: does not pass | ${result.message}`,
    inputProvenance: provenance,
  };
}
