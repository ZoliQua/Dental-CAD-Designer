// packages/cad-pipeline/src/pipeline/stageResult.ts
//
// Phase 4 Task 1: `RestorationStageResult` — the shape every fixed-order
// crown-design stage returns (docs/plans/phase-4-crown-design.md: "6 fixed
// -order stages, each journaled: inner surface -> anatomy placement ->
// adaptation/morphing -> shell construction -> freeform -> QC"). No stage
// implementation lives here yet (YAGNI, this task's guardrail) — this is
// the CONTRACT future tasks' stage functions (`stages/innerSurface.ts`,
// etc.) return, and the caller (engine layer) journals.
//
// ## Journaling stays the CALLER's job, not this package's
//
// CLAUDE.md invariant 3 ("journal everything... every destructive operation
// appends an Operation") is enforced by whoever OWNS the `CaseDocument`'s
// `history` array (the engine layer) — `cad-pipeline` has no dependency on
// journal storage/persistence (it cannot: the layer rule permits only
// `kernel`/`io`/`shared-types`). A stage function instead returns every
// field an `Operation` (shared-types) needs — `operationName`, `params`,
// `inputHashes` — so the caller can construct and append the real
// `Operation` without re-deriving any of that from the stage's output.
import type { IndexedMesh } from '@dqcad/kernel';

export type PipelineStageName =
  | 'innerSurface'
  | 'anatomyPlacement'
  | 'morphing'
  | 'shell'
  | 'freeform'
  | 'qc';

/**
 * What a restoration-design stage returns — a pure function's output, ready
 * to be journaled by the caller. `mesh`/`meshContentHash` are both absent
 * for the `'qc'` stage (its output is a `QcReport`, not a mesh — see
 * `@dqcad/shared-types`' `QcReport`, produced by `gates/runner.ts`'s
 * `runQcGates`, not this type).
 */
export interface RestorationStageResult {
  readonly stage: PipelineStageName;
  /** The stage's produced mesh, when it has one (every stage except
   * `'qc'`). Immutable — a NEW mesh value, never the input mesh mutated in
   * place (CLAUDE.md invariant: "operations return new meshes"). */
  readonly mesh: IndexedMesh | null;
  /** Content hash of `mesh` (computed by the caller's hashing utility —
   * `cad-pipeline` has no hashing dependency of its own; same "hash lives
   * one layer up" split as journaling, above) — `null` iff `mesh` is
   * `null`. Echoed here (rather than making the caller re-derive it) so a
   * stage's own `Operation.outputHashes` and a later stage's
   * `PipelineContext.stages` entry are guaranteed to agree on exactly what
   * was hashed. */
  readonly meshContentHash: string | null;
  /** `Operation.name` the caller should journal this stage under (shared
   * -types' `Operation`). */
  readonly operationName: string;
  /** `Operation.params` — every parameter this stage's computation actually
   * depended on (clinical values, seeds, options) — REPLAYING the journal
   * with these exact params must reproduce `meshContentHash` bit-identically
   * (the phase's hardest determinism bar, docs/plans/phase-4-crown-design.md's
   * Global Constraints). */
  readonly params: Readonly<Record<string, unknown>>;
  /** `Operation.inputHashes` — content hashes of every mesh/value this
   * stage actually read (the prior stage's output, the target mesh, ...). */
  readonly inputHashes: readonly string[];
  /** Documented approximation error bound (mm), when this stage introduces
   * one (`@errorBound`, CLAUDE.md: "every approximating algorithm documents
   * its error bound... and, where user-relevant, reports it in
   * `QcReport`") — `null` for a stage that introduces no approximation
   * beyond what its own inputs already carry. */
  readonly errorBoundMm: number | null;
}
