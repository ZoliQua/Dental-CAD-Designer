// apps/client/src/engine/provenance.ts
//
// ADR-022 Decision 6 — which of a restoration's QC verdicts are NOT statements
// about the patient. The export panel's disclosure banner follows this summary
// instead of claiming "demo data" unconditionally: a fully case-derived
// restoration shows no banner, and nothing that is not case-derived can look
// like a clean pass.
//
// Sources:
//  the per-gate `inputProvenance` the cad-pipeline gates set when they fail
//  closed on a stand-in input — the synthetic neighbour boxes and the bbox
//  coverage divider (crown / inlay / onlay), and every gate of the
//  demonstration bridge (`demo-fixture`). A bridge built from the case
//  (Phase 9 Task 6) carries none.
//
// Pure (no store, no worker) — node-lane testable.
import type { NonCaseProvenance, Restoration } from '@dqcad/shared-types';

export interface RestorationProvenanceSummary {
  /** The most severe non-`case` provenance, or `null` when every measured
   * input is case-derived (or nothing has been measured yet). */
  provenance: NonCaseProvenance | null;
  /** Gate ids measured on non-`case` input, in report order. */
  gates: string[];
}

export function restorationInputProvenance(restoration: Restoration): RestorationProvenanceSummary {
  const gates: string[] = [];
  let provenance: NonCaseProvenance | null = null;
  for (const gate of restoration.qc?.gates ?? []) {
    if (gate.inputProvenance === undefined) continue;
    gates.push(gate.gate);
    if (gate.inputProvenance === 'demo-fixture' || provenance === null)
      provenance = gate.inputProvenance;
  }
  return { provenance, gates };
}
