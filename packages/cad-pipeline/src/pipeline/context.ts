// packages/cad-pipeline/src/pipeline/context.ts
//
// Phase 4 Task 1: `PipelineContext` — the shared inputs every restoration
// design STAGE (inner surface, anatomy placement, adaptation/morphing,
// shell construction, freeform, QC — docs/plans/phase-4-crown-design.md's
// "6 fixed-order stages") consumes. This file defines the SHAPE only — no
// stage lives here yet (YAGNI, this task's guardrail: "no pipeline STAGES
// yet").
//
// ## Why `PipelineMaterialProfile` is a LOCAL type, not an import of
// `@dqcad/clinical-profiles`' `MaterialProfile`
//
// The layer rule (CLAUDE.md, eslint.config.js's `boundaries/dependencies`)
// allows `cad-pipeline -> kernel, io, shared-types` — NOT
// `cad-pipeline -> clinical-profiles`. Clinical defaults live in
// `clinical-profiles/` and are NEVER hardcoded in pipeline code (CLAUDE.md
// invariant 7) — but the pipeline still needs the RESOLVED numbers (gaps,
// thicknesses, connector areas) to do its work, so they arrive as plain
// DATA on `PipelineContext`, assembled by a caller one layer up (the
// engine/kernel-workers job that already depends on `clinical-profiles` and
// passes the loaded `MaterialProfile`'s fields through). `PipelineMaterialProfile`
// below structurally mirrors `@dqcad/clinical-profiles`'
// `materialProfile.ts#MaterialProfile` field-for-field (see that file for
// each field's own PLAN.md §3 citation) — the SAME "duplicate the shape
// rather than cross a forbidden layer boundary" precedent `shared-types`'
// `MarginAnchor` already establishes for `@dqcad/kernel`'s `SurfacePoint`
// (see shared-types/src/index.ts's `MarginAnchor` doc).
import type { FdiTooth, RestorationParams, RestorationType, Vec3 } from '@dqcad/shared-types';
import type { IndexedMesh } from '@dqcad/kernel';

/** Structurally mirrors `@dqcad/clinical-profiles`'
 * `ConnectorAreaTargets` — see this file's module doc for why this is a
 * duplicated, not imported, type. */
export interface PipelineConnectorAreaTargets {
  readonly posteriorMm2: number;
  readonly anteriorMm2: number;
}

/** Structurally mirrors `@dqcad/clinical-profiles`' `MaterialProfile` — see
 * this file's module doc. Every field a Phase 4 stage/gate might need,
 * resolved to plain numbers by the caller (never re-derived or defaulted
 * inside `cad-pipeline` — CLAUDE.md invariant 7). */
export interface PipelineMaterialProfile {
  readonly id: string;
  readonly version: string;
  readonly restorationParams: RestorationParams;
  readonly connectorAreaMm2: PipelineConnectorAreaTargets;
  readonly undercutBlockoutThresholdMm: number;
  /** See `@dqcad/clinical-profiles`' `materialProfile.ts#MaterialProfile.occlusalMinWallThicknessMm`
   * doc — `restorationParams.minWallThicknessMm` is the AXIAL minimum. */
  readonly occlusalMinWallThicknessMm: number;
  readonly maxChordDeviationMm: number;
  /** See `@dqcad/clinical-profiles`' `materialProfile.ts#MaterialProfile.inlayMinThicknessMm`
   * — the inlay isthmus/floor thickness minimum (Phase 5 Task 6 gate). */
  readonly inlayMinThicknessMm: number;
  /** See `MaterialProfile.onlayMinThicknessMm` — the onlay isthmus/floor
   * thickness minimum (Phase 5 Task 7 gate). */
  readonly onlayMinThicknessMm: number;
  /** See `MaterialProfile.cuspCoverageMinThicknessMm` — the onlay covered-cusp
   * thickness minimum (Phase 5 Task 7 gate). */
  readonly cuspCoverageMinThicknessMm: number;
  /** See `MaterialProfile.marginExclusionMm` — the min-wall gate's marginal
   * feather-band exclusion width (Phase 4 carry-in; Phase 5 Task 8 wires it
   * into the live `runQc` path). */
  readonly marginExclusionMm: number;
}

/** A mesh handle a pipeline stage operates on — content-addressed (mirrors
 * `shared-types`' `MeshAsset.contentHash` convention) plus the actual
 * Float64 `IndexedMesh` buffers a kernel stage function needs. Meshes are
 * immutable values (CLAUDE.md invariant): a stage never mutates
 * `mesh.positions`/`mesh.indices` in place, it returns a NEW handle. */
export interface PipelineMeshHandle {
  readonly contentHash: string;
  readonly mesh: IndexedMesh;
}

/** A confirmed margin loop in the currency `@dqcad/kernel`'s
 * `margin/band.ts` primitive requires — see that module's "CHORD-CAP" doc
 * for why `resampledPoints` is REQUIRED (never optional) here, unlike
 * `shared-types`' `MarginLine.resampledPoints`. */
export interface PipelineMarginLoop {
  readonly closed: true;
  readonly resampledPoints: readonly Vec3[];
}

/**
 * The shared inputs every restoration-design stage consumes — assembled
 * once per design session by a caller (a `cad-pipeline`-external job/engine
 * layer) from the case's `Restoration` (shared-types), its target scan(s),
 * and the selected `PipelineMaterialProfile`. Stages are PURE functions of
 * `(context, ...stage-specific inputs)` — see `stageResult.ts`'s
 * `RestorationStageResult` for what a stage returns.
 *
 * One `PipelineContext` per restoration (a bridge's multiple abutment
 * margins are carried in `marginLoops`, keyed by `FdiTooth` — same
 * multi-abutment shape `shared-types`' `Restoration.marginLines` and
 * `axis/roi.ts`'s `abutmentMarginLoops` already use).
 */
export interface PipelineContext {
  readonly restorationId: string;
  /**
   * Which restoration this design session is for — the discriminant every
   * restoration-type-aware stage narrows on (Phase 5 Task 1 scaffold). A
   * crown-only stage never runs on a cavity case and vice versa: see
   * `CrownPipelineContext` / `CavityPipelineContext` (the compile-time
   * narrowings future stage inputs are typed against) and `assertCrownContext`
   * / `assertCavityContext` (the runtime guard rail existing crown stages call
   * at entry, for the dynamic-context callers — e.g. journal replay from a
   * persisted `Restoration.type` — where the type is not statically known).
   * `'bridge'` is accepted by the union (shared-types) but no bridge stage
   * exists yet (Phase 6). */
  readonly restorationType: RestorationType;
  readonly materialProfile: PipelineMaterialProfile;
  /** Unit vector, insertion-axis direction (Phase 3's confirmed axis —
   * `shared-types`' `Restoration.insertionAxis`). */
  readonly insertionAxis: Vec3;
  /** The prep/die (or, for a bridge, the shared arch scan) every abutment's
   * margin is anchored to — `shared-types`' `Restoration.targetNodeId`
   * resolved to an actual mesh handle by the caller. */
  readonly targetMesh: PipelineMeshHandle;
  /** One entry per abutment tooth (length 1 for crown/inlay/onlay). */
  readonly marginLoops: Partial<Record<FdiTooth, PipelineMarginLoop>>;
  /** The ADJACENT teeth bordering the restoration site, keyed by FDI —
   * consumed by the anatomy-placement stage (Task 5) to derive the
   * mesial-distal axis (neighbour bounding centroids) and the M-D scale
   * (inter-proximal gap). Mirrors `marginLoops`' `Partial<Record<FdiTooth,…>>`
   * shape exactly (same round-trip-from-`Restoration` convention): a crown
   * site carries its mesial + distal neighbour, empty `{}` when none are
   * assigned yet. Each handle is a segmented neighbour tooth mesh (or a local
   * arch neighbourhood around it) — the stage only reads its vertex positions,
   * never its topology. Empty/insufficient neighbours is the placement stage's
   * OWN gate to enforce (like `antagonist` is for occlusal stages), not this
   * type's. */
  readonly neighbors: Partial<Record<FdiTooth, PipelineMeshHandle>>;
  /** The antagonist (opposing-arch) scan, when available — `null` if none
   * is assigned yet (occlusal-contact-dependent stages, e.g. morphing,
   * cannot run without one; that is THEIR gate to enforce, not this type's). */
  readonly antagonist: PipelineMeshHandle | null;
  /** Content hashes of every stage completed so far THIS session — mirrors
   * `shared-types`' `Restoration.stages` shape exactly (same field names),
   * so a caller can round-trip this straight from/to the persisted
   * `Restoration` record. */
  readonly stages: {
    readonly innerSurface?: string;
    readonly anatomyPlacement?: string;
    readonly morphState?: string;
    readonly finalMesh?: string;
  };
}

// ---------------------------------------------------------------------------
// Restoration-type guard rails (Phase 5 Task 1 scaffold)
//
// The pipeline gains inlay/onlay cavity stages in Phase 5 Tasks 3+; those
// stages and the existing crown stages must NOT be interchangeable — running a
// crown-only stage on a cavity case (or vice versa) would silently produce
// wrong geometry. Two complementary mechanisms enforce this:
//
//   1. COMPILE-TIME (preferred): a stage function types its context parameter
//      as the narrowed `CrownPipelineContext` / `CavityPipelineContext` (or
//      `InlayPipelineContext` / `OnlayPipelineContext`). Passing a context of
//      the wrong restoration type is then a type error at the call site — the
//      `restorationType` discriminant is a string-literal type that does not
//      unify across the two families. Future cavity stages (Task 3+) take a
//      `CavityPipelineContext`; a `CrownPipelineContext` cannot be passed to
//      them and vice versa. See `context.guardrails.test.ts` for the
//      `@ts-expect-error` proof.
//
//   2. RUNTIME (for dynamically-typed callers): where the context's
//      restoration type is NOT known statically — most importantly the server
//      journal-replay path, which reconstructs a `PipelineContext` from a
//      persisted `Restoration.type` (`RestorationType`, only known at runtime)
//      — a stage calls `assertCrownContext(ctx)` / `assertCavityContext(ctx)`
//      at entry. The assert both throws a typed `RestorationTypeMismatchError`
//      (never a silent wrong-geometry result) AND narrows the type for the
//      rest of the function body. The existing crown stages call
//      `assertCrownContext` at entry so a mis-typed cavity context fails loudly
//      rather than running the crown algorithm on a cavity.
//
// No inlay/onlay STAGE lives here yet (YAGNI — Task 3+ builds them); this file
// ships only the discriminant, the narrowings, and the guards.
// ---------------------------------------------------------------------------

/** A `PipelineContext` statically known to be a crown case. Crown-only stages
 * type their context parameter as this (compile-time guard rail). */
export type CrownPipelineContext = PipelineContext & { readonly restorationType: 'crown' };

/** A `PipelineContext` statically known to be an inlay case. */
export type InlayPipelineContext = PipelineContext & { readonly restorationType: 'inlay' };

/** A `PipelineContext` statically known to be an onlay case. */
export type OnlayPipelineContext = PipelineContext & { readonly restorationType: 'onlay' };

/** A `PipelineContext` statically known to be a cavity restoration (inlay OR
 * onlay) — the shared narrowing the Phase 5 cavity stages (offset, blockout,
 * occlusal patch, box adaptation) type their context parameter against, since
 * those stages are identical for inlay and onlay except at the thickness-gate
 * step (which re-reads `restorationType`). */
export type CavityPipelineContext = PipelineContext & { readonly restorationType: 'inlay' | 'onlay' };

/** Thrown by the restoration-type guards when a stage is handed a context of
 * the wrong restoration type — a loud, typed failure (never a silent
 * wrong-geometry result), per CLAUDE.md invariant 4's "corrupt → loud typed
 * error" spirit applied to the pipeline dispatch. */
export class RestorationTypeMismatchError extends Error {
  // NOTE: explicit fields + body assignment, NOT constructor parameter
  // properties — this file is in the Node worker's strip-only-TS import
  // closure (kernel-workers → cad-pipeline), and parameter properties are not
  // supported by Node's strip-only loader (they would crash every worker job).
  readonly expected: RestorationType | readonly RestorationType[];
  readonly actual: RestorationType;
  constructor(expected: RestorationType | readonly RestorationType[], actual: RestorationType) {
    const exp = Array.isArray(expected) ? expected.join("' | '") : expected;
    super(
      `RestorationTypeMismatchError: stage requires restorationType '${exp}', ` +
        `but the context is a '${actual}' restoration — a crown-only stage cannot run ` +
        `on a cavity case (or vice versa).`,
    );
    this.name = 'RestorationTypeMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** Runtime guard rail: asserts `ctx` is a crown case (narrows to
 * `CrownPipelineContext`), else throws `RestorationTypeMismatchError`. Crown
 * stages call this at entry for the dynamically-typed callers (journal
 * replay). */
export function assertCrownContext(ctx: PipelineContext): asserts ctx is CrownPipelineContext {
  if (ctx.restorationType !== 'crown') {
    throw new RestorationTypeMismatchError('crown', ctx.restorationType);
  }
}

/** Runtime guard rail: asserts `ctx` is a cavity case — inlay OR onlay
 * (narrows to `CavityPipelineContext`), else throws
 * `RestorationTypeMismatchError`. Phase 5 cavity stages (Task 3+) call this at
 * entry. */
export function assertCavityContext(ctx: PipelineContext): asserts ctx is CavityPipelineContext {
  if (ctx.restorationType !== 'inlay' && ctx.restorationType !== 'onlay') {
    throw new RestorationTypeMismatchError(['inlay', 'onlay'], ctx.restorationType);
  }
}
