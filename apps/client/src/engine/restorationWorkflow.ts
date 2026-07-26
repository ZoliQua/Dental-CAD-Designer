// apps/client/src/engine/restorationWorkflow.ts
//
// Phase 5 Task 8 — the SHARED, restoration-type-agnostic workflow primitives
// that the cavity (inlay/onlay) workflow is built on, factored out so the
// staged-pipeline machinery is expressed ONCE rather than copy-pasted per
// restoration type.
//
// ## Shared-vs-forked decision (documented per the brief)
//
// The P4 crown workflow (engine/crownWorkflow.ts) hand-writes its
// `downstreamInvalidations` as a per-stage `switch` — correct, but every stage
// added is another hand-maintained case, and getting the cascade wrong is the
// P4 Critical bug (a stale "PASSED" QC report surviving an upstream re-run). The
// cavity pipeline has MORE milestone stages (fit → patch → contacts →
// [cuspCoverage, onlay-only] → shell) and is restoration-type-aware, so a
// hand-written switch is the exact place drift + mistakes creep in.
//
// So the genuinely reusable, error-prone part — "committing an upstream stage
// clears every DOWNSTREAM stage hash + the QcReport" — lives here, DERIVED from
// the ordered milestone-field list rather than restated per stage. The cavity
// workflow (engine/cavityWorkflow.ts) uses it; the crown workflow is left on its
// proven, golden-pinned bespoke module UNCHANGED (destabilizing a
// byte-pinned + browser-tested P4 deliverable to retrofit it onto this core is
// not worth the risk in a UI task) — the go-forward pattern is this shared core,
// and crown can migrate onto it in a later cleanup. This is a shared CORE, not a
// drifting copy: the invalidation cascade and stale-QC guard have exactly one
// implementation here.
//
// Pure, side-effect-free (no worker, no Three.js, no store) — node-lane testable
// like crownWorkflow.ts. Layer rule: engine may import shared-types only here.
import type { Restoration } from '@dqcad/shared-types';

/** One stage's runnability verdict against a `Restoration` snapshot — the
 * generic shape both crown and cavity `StageGate`s specialize (`Stage` =
 * the stage-name union, `Code` = the prerequisite-code union). */
export interface StageGateBase<Stage extends string, Code extends string> {
  stage: Stage;
  /** May this stage's worker job be dispatched right now? */
  allowed: boolean;
  /** Has this stage already produced its output (its `stages` hash, or `qc`)? */
  complete: boolean;
  /** The FIRST unmet prerequisite when `allowed` is `false`, else `null`. */
  reason: Code | null;
}

/**
 * The downstream milestone hash-fields a commit INVALIDATES, DERIVED from the
 * ordered list of milestone fields (in pipeline order) and the field the
 * just-committed stage writes. Everything AFTER the committed field in the order
 * is stale geometry and must be cleared — the P4 Critical lesson, generalized:
 * an upstream re-run can never leave a downstream stage's hash (or the QcReport)
 * pointing at geometry that no longer exists.
 *
 * `committedField === null` means a NON-milestone upstream step changed (e.g. the
 * cavity outline itself) — then EVERY milestone field is downstream and cleared.
 *
 * @param orderedFields the milestone hash-fields in strict pipeline order.
 * @param committedField the field the committed stage writes, or `null`.
 */
export function linearDownstreamFields<Field extends keyof Restoration['stages']>(
  orderedFields: readonly Field[],
  committedField: Field | null,
): Field[] {
  if (committedField === null) return [...orderedFields];
  const idx = orderedFields.indexOf(committedField);
  if (idx < 0) return [...orderedFields];
  return orderedFields.slice(idx + 1);
}

/**
 * Whether a stored `QcReport` still corresponds to the CURRENT final restoration
 * solid: `runQc`/`runInlayQc` stamps `qc.journalHash` with the `finalMesh`
 * content hash it ran against, so a mismatch (or a now-absent `finalMesh`) means
 * the report is STALE — the geometry changed under it. Restoration-type-agnostic
 * (both the crown shell and the inlay/onlay shell write `finalMesh`), so this is
 * the single shared staleness guard the cavity UI renders as an explicit "re-run
 * QC" state (defense-in-depth alongside the invalidation cascade, which normally
 * nulls `qc` outright on any edit). Mirrors crownWorkflow.ts's `isQcStale`.
 */
export function isRestorationQcStale(restoration: Restoration): boolean {
  if (restoration.qc === null) return false;
  return restoration.qc.journalHash !== restoration.stages.finalMesh;
}
