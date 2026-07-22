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
import type { FdiTooth, RestorationParams, Vec3 } from '@dqcad/shared-types';
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
