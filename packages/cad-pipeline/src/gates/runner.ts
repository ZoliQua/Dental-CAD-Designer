// packages/cad-pipeline/src/gates/runner.ts
//
// Phase 4 Task 1: the QC gate RUNNER — `QcGateResult`/`QcReport` already
// exist in `@dqcad/shared-types` (this task's brief); this file builds the
// thing that PRODUCES a `QcReport` from a list of gates, deterministically.
//
// ## Dual-validation prerequisite: ZERO DOM/Three/browser deps
//
// This is the foundation CLAUDE.md invariant 6 ("Dual validation stays
// dual... the server re-validates exports independently") and Phase 4's
// Global Constraint ("the QC gates must be callable from BOTH client-worker
// and Node-server contexts") both require. `runQcGates` below is a PURE
// function: no `window`/`document`, no Three.js, no filesystem, no network
// — only plain data in, plain data out. It has exactly the same
// `cad-pipeline -> kernel, io, shared-types` dependency budget as every other
// file in this package (eslint.config.js's boundaries policy already
// enforces "no `three` import" for `cad-pipeline` — see that config's
// `no-restricted-imports` rule — and this file adds nothing beyond that: no
// import here reaches outside `@dqcad/shared-types`). Callable identically
// from a browser Worker (`kernel-workers/src/worker-entry.browser.ts`) and
// from the Node server (`apps/server`) — the SAME function, not two
// implementations that could drift.
//
// ## A gate is a pure `(context) => QcGateResult`
//
// Per this task's brief literally: "each gate a pure `(context) =>
// QcGateResult`". A gate function must NEVER throw for a legitimate
// clinical failure — a failing gate returns `{ passed: false, ... }`, it
// does not throw (throwing is reserved for a genuine implementation bug —
// see `runQcGates`'s own doc for why a thrown error is deliberately NEVER
// caught/hidden here). `context` is generic (`QcGate<C>`) rather than
// hard-coded to `PipelineContext` — Task 1 ships only a trivial always
// -pass/always-fail TEST gate (this task's guardrail: "no gates beyond the
// runner + a trivial test gate"); real gates (margin-fit, thickness,
// seating, ...) arrive starting Task 4/7/9 and will supply whatever richer
// context shape they need (typically `PipelineContext` plus the specific
// mesh/measurement each gate checks).
//
// ## The gate "registry": a plain, caller-ordered array — no extra machinery
//
// `gates: readonly QcGate<C>[]` passed to `runQcGates` IS the registry — a
// plain, reviewable, explicitly-ordered list (Task 9 assembles the full
// Phase 4 gate set exactly this way: watertight, manifold, no
// -self-intersection, min-wall-thickness, margin-fit, seating-penetration,
// connector-cross-section, occlusal/proximal-contact, in that order).
// `runQcGates` runs gates in EXACTLY the order given (no reordering, no
// `Promise.all` racing — gates are synchronous) and rejects (throws) on a
// duplicate gate NAME among the results, so two gates can never silently
// collide in the acknowledgment lookup below.
//
// ## Acknowledgment (CLAUDE.md invariant 4: "acknowledged with a warning
// (journaled) — never silently bypassed")
//
// `RunQcGatesOptions.acknowledgedGates` names the gates a user has
// EXPLICITLY acknowledged (that acknowledgment action is itself journaled
// by the caller, same "journaling lives one layer up" split as
// `pipeline/stageResult.ts`'s doc) — a name here only takes effect for a
// gate that actually FAILED (`passed: false`); acknowledging an
// already-passing gate is a documented no-op (a passed gate's own
// `acknowledged` is always forced `false` — "acknowledged" is meaningless
// for something that never needed acknowledging). `QcReport.passed` is
// `true` iff EVERY gate either passed outright or is an acknowledged
// failure — this is the ONE place a failing gate can still let the overall
// report read "passed" (matching CLAUDE.md's exact phrase), and it requires
// an explicit, journaled, per-gate opt-in — never a global bypass switch.
//
// ## HARD gates: acknowledgment is REJECTED (never bypassed)
//
// A subset of gates — {@link NON_ACKNOWLEDGEABLE_GATES}: watertight, manifold,
// selfIntersection — are STRUCTURAL: a mesh that fails one is not manufacturable
// (unmillable/unprintable, not even booleanable). Invariant 4 permits
// acknowledge-with-warning for SOFT clinical misses (margin fit, wall thickness,
// seating, contact, ...), but a hard structural failure has no "proceed with a
// warning" — so an attempt to acknowledge a FAILING hard gate throws
// {@link HardGateAcknowledgmentError} rather than silently honouring the bypass.
import type { QcGateResult, QcReport } from '@dqcad/shared-types';

/** A single QC gate — pure, deterministic, synchronous. See this file's
 * module doc for the "never throw for a clinical failure" contract. */
export type QcGate<C> = (context: C) => QcGateResult;

export interface RunQcGatesOptions {
  readonly kernelVersion: string;
  readonly profileVersion: string;
  /** Hash of the journal state this report is computed against —
   * `cad-pipeline` has no hashing utility of its own (same "lives one layer
   * up" split as journaling — see `pipeline/stageResult.ts`'s doc); the
   * caller computes this however the journal itself is hashed. */
  readonly journalHash: string;
  /** Gate names the user has explicitly (and, per CLAUDE.md, journaled-ly)
   * acknowledged — see this file's module doc, "Acknowledgment". */
  readonly acknowledgedGates?: ReadonlySet<string> | readonly string[];
}

/**
 * The HARD (non-acknowledgeable) structural gates. A failure of one of these
 * cannot be acknowledged past — the mesh is simply NOT manufacturable
 * (unmillable/unprintable) and cannot even be booleaned, so there is no
 * clinical scenario in which a user proceeds "with a warning". Distinct from
 * the soft gates (marginFit, minWallThickness, seating, contact, seamDihedral,
 * cuspCoverage, connectorCrossSection, ponticRelief) that CLAUDE.md invariant 4
 * permits to be acknowledged-with-a-journaled-warning.
 *
 * These string literals MIRROR the gate-name constants `WATERTIGHT_GATE_NAME`,
 * `MANIFOLD_GATE_NAME` (watertight.ts) and `SELF_INTERSECTION_GATE_NAME`
 * (selfIntersection.ts). They are duplicated here as literals — rather than
 * imported — to keep the generic runner free of a value dependency on the
 * concrete gate modules; `runner.test.ts` asserts this set equals those
 * constants, so any drift is caught at test time, not silently.
 *
 * `selfIntersection` IS included: a geometrically self-intersecting solid is
 * likewise not a valid manufacturable body (invariant 4 names it a mandatory
 * gate); acknowledging it away would export a self-penetrating part.
 */
export const NON_ACKNOWLEDGEABLE_GATES: ReadonlySet<string> = new Set(['watertight', 'manifold', 'selfIntersection']);

/** Thrown when a caller attempts to ACKNOWLEDGE a failing HARD gate
 * ({@link NON_ACKNOWLEDGEABLE_GATES}). A watertight/manifold/self-intersection
 * failure can never be acknowledged past (the mesh is not manufacturable), so
 * an acknowledgment of one is a programming/authorization bug — a loud, typed
 * error, never a silent bypass (CLAUDE.md invariant 4). */
export class HardGateAcknowledgmentError extends Error {
  readonly gate: string;
  constructor(gate: string) {
    super(
      `runQcGates: gate "${gate}" is a HARD (non-acknowledgeable) structural gate — a failure of it cannot be ` +
        `acknowledged past (the mesh is not manufacturable/booleanable). Remove it from acknowledgedGates and repair the mesh.`,
    );
    this.name = 'HardGateAcknowledgmentError';
    this.gate = gate;
  }
}

/** Thrown when two gates in the SAME `gates` array produce the same
 * `QcGateResult.gate` name — a genuine implementation bug (the
 * acknowledgment lookup and any per-gate UI display both assume gate names
 * are unique within one report), never a legitimate clinical outcome, so
 * this is a loud, typed error rather than a silently-overwritten result. */
export class DuplicateGateNameError extends Error {
  constructor(name: string) {
    super(`runQcGates: duplicate gate name "${name}" — every gate in one run must have a unique QcGateResult.gate`);
    this.name = 'DuplicateGateNameError';
  }
}

/**
 * Runs every gate in `gates`, in array order, against `context`, and
 * assembles the `QcReport` — see this file's module doc for the full
 * contract (purity, dual-validation portability, acknowledgment semantics,
 * deterministic ordering).
 *
 * @throws {DuplicateGateNameError} if two gates produce the same
 * `QcGateResult.gate` name.
 * @throws whatever a gate itself throws — NEVER caught here (see this
 * file's module doc: a thrown error is a bug, not a clinical failure to
 * report quietly).
 */
export function runQcGates<C>(
  context: C,
  gates: readonly QcGate<C>[],
  options: RunQcGatesOptions,
): QcReport {
  const acknowledged =
    options.acknowledgedGates instanceof Set
      ? options.acknowledgedGates
      : new Set(options.acknowledgedGates ?? []);

  const seen = new Set<string>();
  const results: QcGateResult[] = gates.map((gate) => {
    const raw = gate(context);
    if (seen.has(raw.gate)) {
      throw new DuplicateGateNameError(raw.gate);
    }
    seen.add(raw.gate);
    // A HARD structural gate can NEVER be acknowledged past — reject the attempt
    // loudly rather than silently honouring a bypass of an unmanufacturable mesh
    // (CLAUDE.md invariant 4). Only a genuine FAILURE that is being acknowledged
    // is rejected (acknowledging a PASSING gate stays the documented no-op).
    if (!raw.passed && acknowledged.has(raw.gate) && NON_ACKNOWLEDGEABLE_GATES.has(raw.gate)) {
      throw new HardGateAcknowledgmentError(raw.gate);
    }
    const isAcknowledged = !raw.passed && acknowledged.has(raw.gate);
    return { ...raw, acknowledged: isAcknowledged };
  });

  const passed = results.every((r) => r.passed || r.acknowledged);

  return {
    gates: results,
    passed,
    kernelVersion: options.kernelVersion,
    profileVersion: options.profileVersion,
    journalHash: options.journalHash,
  };
}
