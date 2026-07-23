// packages/cad-pipeline/src/stages/morphing.ts
//
// Phase 4 Task 6: the ADAPTATION / MORPHING stage — the THIRD crown-design
// stage (docs/plans/phase-4-crown-design.md's 6 fixed-order stages). It
// deforms the placed library tooth (Task 5 output) so it makes correct
// contacts, orchestrating the kernel's deterministic RBF morph
// (`@dqcad/kernel`'s `planAnatomyMorph` → `solveAnatomyMorph`; see that
// module's doc for the φ(r)=r biharmonic formulation, the control-point
// construction, and the direct-solve determinism) into a journalable
// `RestorationStageResult`.
//
// ## Clinical targets come from the profile via the context — asserted loudly
//
// The proximal-contact penetration (`proximalContactPenetrationMm`) and the
// occlusal contact (`occlusalContactMm`) are read from
// `context.materialProfile.restorationParams` (resolved by the caller from the
// material profile — CLAUDE.md invariant 7, NEVER hardcoded here). Both are
// REQUIRED and asserted finite (`MissingClinicalParamError`) — there is no
// correct contact without a real target.
//
// ## Gates this stage enforces
//
//  - a confirmed margin loop for the tooth (the cervical seal locus) —
//    `MissingMarginLoopError`;
//  - EXACTLY two neighbours (mesial + distal), reusing the placement stage's
//    FDI identification — `InsufficientNeighborsError`;
//  - an antagonist (the occlusal contact is undefined without one) —
//    `MissingAntagonistError` (the context type's doc names morphing as the
//    stage that owns this gate).
//
// ## @errorBound
//
// The RBF morph is an approximation of the target contacts (see the kernel
// module's `@errorBound`): the measured achieved-vs-target penetration residual
// is carried on `errorBoundMm` (the max over contacts) and journaled per
// contact, for the downstream contact QC gates to consume.
import type { FdiTooth } from '@dqcad/shared-types';
import {
  marginLoopPolyline,
  planAnatomyMorph,
  solveAnatomyMorph,
  type AnatomyMorphPlan,
  type IndexedMesh,
  type MorphContactInput,
  type MorphOptions,
  type MorphStrengths,
} from '@dqcad/kernel';
import type { PipelineContext, PipelineMeshHandle } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';
import { identifyNeighbors, InsufficientNeighborsError } from './anatomyPlacement.ts';

/** The RBF kernel identifier journaled with the morph (documented in the
 * kernel module) — pins the deformation basis for reproducibility/audit. */
export const MORPH_RBF_KERNEL = 'biharmonic-r';

export class MissingMarginLoopError extends Error {
  constructor(tooth: FdiTooth) {
    super(`morphing stage: no margin loop for tooth ${tooth} in context.marginLoops — the cervical seal locus is required`);
    this.name = 'MissingMarginLoopError';
  }
}

export class MissingAntagonistError extends Error {
  constructor() {
    super('morphing stage: no antagonist in context — the occlusal contact target is undefined without an opposing arch (this stage\'s gate, per PipelineContext.antagonist\'s doc)');
    this.name = 'MissingAntagonistError';
  }
}

export class MissingClinicalParamError extends Error {
  constructor(paramName: string, value: unknown) {
    super(
      `morphing stage: required clinical param "${paramName}" is missing or non-finite (got ${String(value)}) — ` +
        `it must be resolved from the material profile onto context.materialProfile.restorationParams`,
    );
    this.name = 'MissingClinicalParamError';
  }
}

export interface MorphingStageOptions {
  /** The placed library tooth mesh (Task 5's `anatomyPlacement` output) — the
   * morph deforms this. Immutable (a NEW mesh is returned). */
  readonly placedMesh: PipelineMeshHandle;
  /** Per-contact strength sliders [0..1] — omitted ⇒ full strength (1). The UI
   * re-runs the stage (or, for interactivity, the kernel `solveAnatomyMorph`
   * on a cached plan) as these change. */
  readonly strengths?: MorphStrengths;
  /** Optional RBF algorithm overrides (kernel `MorphOptions`) — journaled. */
  readonly morphOptions?: Partial<MorphOptions>;
  /** Content-hash function for the morphed mesh — injected by the caller
   * (hashing lives one layer up; same split as the other stages). */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

function assertFiniteParam(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new MissingClinicalParamError(name, value);
}

/**
 * Build the kernel morph plan for `tooth` from the pipeline context — the
 * geometry-dependent half (BVH builds, contact selection, anchor picking). The
 * caller can reuse the returned plan across interactive slider re-solves via
 * `solveAnatomyMorph`. Enforces this stage's gates (margin / neighbours /
 * antagonist / clinical params).
 */
export function buildMorphPlan(
  context: PipelineContext,
  tooth: FdiTooth,
  placedMesh: IndexedMesh,
  morphOptions?: Partial<MorphOptions>,
): AnatomyMorphPlan {
  const marginInput = context.marginLoops[tooth];
  if (!marginInput) throw new MissingMarginLoopError(tooth);
  const marginLoop = marginLoopPolyline({ closed: marginInput.closed, resampledPoints: marginInput.resampledPoints });

  if (!context.antagonist) throw new MissingAntagonistError();

  const rp = context.materialProfile.restorationParams;
  assertFiniteParam('proximalContactPenetrationMm', rp.proximalContactPenetrationMm);
  assertFiniteParam('occlusalContactMm', rp.occlusalContactMm);

  const { mesial, distal } = identifyNeighbors(tooth, context.neighbors);
  const mesialHandle = context.neighbors[mesial];
  const distalHandle = context.neighbors[distal];
  if (!mesialHandle || !distalHandle) {
    throw new InsufficientNeighborsError(tooth, [mesialHandle, distalHandle].filter(Boolean).length);
  }

  const contacts: MorphContactInput[] = [
    { kind: 'proximalMesial', mesh: mesialHandle.mesh, targetPenetrationMm: rp.proximalContactPenetrationMm },
    { kind: 'proximalDistal', mesh: distalHandle.mesh, targetPenetrationMm: rp.proximalContactPenetrationMm },
    { kind: 'antagonist', mesh: context.antagonist.mesh, targetPenetrationMm: rp.occlusalContactMm },
  ];

  return planAnatomyMorph({ placedMesh, marginLoop, contacts, options: morphOptions });
}

/**
 * Runs the adaptation/morphing stage for `tooth` — see this module's doc.
 * Deterministic: same context + placed mesh + strengths + options →
 * byte-identical morphed mesh + hash. Returns a `RestorationStageResult` ready
 * to journal.
 *
 * @throws {MissingMarginLoopError} / {MissingAntagonistError} /
 * {InsufficientNeighborsError} / {MissingClinicalParamError} — the stage gates.
 * @throws propagates the kernel's `MorphContactMeshError` / `MorphNoAnchorsError`.
 */
export function runMorphingStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: MorphingStageOptions,
): RestorationStageResult {
  const plan = buildMorphPlan(context, tooth, options.placedMesh.mesh, options.morphOptions);
  const result = solveAnatomyMorph(plan, options.strengths);

  const meshContentHash = options.hashMesh(result.mesh);
  const rp = context.materialProfile.restorationParams;

  const { mesial, distal } = identifyNeighbors(tooth, context.neighbors);
  const mesialHandle = context.neighbors[mesial]!;
  const distalHandle = context.neighbors[distal]!;
  const antagonist = context.antagonist!;

  return {
    stage: 'morphing',
    mesh: result.mesh,
    meshContentHash,
    operationName: 'morphing.morph',
    params: {
      tooth,
      rbfKernel: MORPH_RBF_KERNEL,
      mesialNeighborFdi: mesial,
      distalNeighborFdi: distal,
      proximalContactPenetrationMm: rp.proximalContactPenetrationMm,
      occlusalContactMm: rp.occlusalContactMm,
      strengths: {
        proximalMesial: options.strengths?.proximalMesial ?? 1,
        proximalDistal: options.strengths?.proximalDistal ?? 1,
        antagonist: options.strengths?.antagonist ?? 1,
      },
      morphOptions: plan.options,
      controlPointCount: result.controlPointCount,
      cervicalAnchorCount: plan.cervicalAnchorCount,
      farFieldAnchorCount: plan.farFieldAnchorCount,
      // Measured evidence (residuals REPORTED — the contact-gate inputs). Each
      // contact carries the single-vertex residual, the WORST region deviation
      // (regionResidualMm / regionMinSignedDistanceMm), and whether its
      // root-find was CLAMPED (target unachieved).
      contacts: result.contacts.map((c) => ({
        kind: c.kind,
        strength: c.strength,
        targetPenetrationMm: c.targetPenetrationMm,
        achievedSignedDistanceMm: c.achievedSignedDistanceMm,
        contactResidualMm: c.contactResidualMm,
        regionMinSignedDistanceMm: c.regionMinSignedDistanceMm,
        regionResidualMm: c.regionResidualMm,
        clampBound: c.clampBound,
      })),
      maxContactResidualMm: result.maxContactResidualMm,
      // The seal is proven by the field displacement AT the finish line + the
      // NON-anchor cervical surface motion (never only the pinned anchors).
      marginSealMaxDeviationMm: result.marginSealMaxDeviationMm,
      marginSealAtFinishLineMm: result.marginSealAtFinishLineMm,
      marginSealBetweenPinsMm: result.marginSealBetweenPinsMm,
      // QC WARNING: contacts whose target penetration was NOT achieved (the
      // root-find hit the travel clamp) — a clamped contact must not read as a
      // silent success downstream.
      clampedContacts: result.clampedContacts,
      contactClampWarning: result.clampedContacts.length > 0,
    },
    inputHashes: [options.placedMesh.contentHash, mesialHandle.contentHash, distalHandle.contentHash, antagonist.contentHash],
    // Conservative @errorBound: max of the single-vertex residual AND the worst
    // region over-penetration — so a region that over-penetrates while the
    // contact vertices sit on target cannot report a deceptively small bound to
    // the downstream contact/interpenetration gate.
    errorBoundMm: result.errorBoundMm,
  };
}
