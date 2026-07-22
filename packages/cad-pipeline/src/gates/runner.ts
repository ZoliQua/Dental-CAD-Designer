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
