// packages/cad-pipeline/src/stages/shell.ts
//
// Phase 4 Task 7: the SHELL-CONSTRUCTION stage — the fourth crown-design
// stage (docs/plans/phase-4-crown-design.md's 6 fixed-order stages). It joins
// the morphed OUTER anatomy (Task 6) and the intaglio INNER surface (Task 4)
// into a SINGLE WATERTIGHT crown shell via the kernel's `constructShell` (the
// outer + inner surfaces stitched at the MARGIN BAND seam, then validated +
// cleaned through the manifold-3d wrapper), and — on explicit request —
// auto-thickens walls below the material minimum.
//
// ## Clinical params from the profile via the context — asserted loudly
//
// The wall minimums (`restorationParams.minWallThicknessMm` axial,
// `occlusalMinWallThicknessMm` occlusal) are read from `context.materialProfile`
// (resolved by the caller from the material profile) and asserted finite —
// never defaulted here (CLAUDE.md invariant 7). They are used ONLY by
// `autoThicken` (the min-wall GATE itself lives in `gates/minWallThickness.ts`
// and is assembled into the QC gate set in Task 9); a shell with thin walls is
// still CONSTRUCTED and returned — the gate is what blocks export, not this
// stage (a thin wall is a clinical outcome to surface, not a construction
// error).
//
// ## auto-thicken: user-invoked + journaled, never silent (invariant 5)
//
// `autoThicken` mutates the outer anatomy (a bounded outward displacement of
// thin regions). It is OFF by default and only runs when the caller passes
// `options.autoThicken === true` (the explicit user action). When it runs, the
// journaled op params record it fully (`autoThickenApplied`, the displaced /
// clamped vertex counts, the max displacement, the params) so replaying the
// journal reproduces the identical shell — the destructive mutation is
// recorded, never applied behind the user's back.
import type { FdiTooth } from '@dqcad/shared-types';
import {
  autoThickenOuter,
  constructShell,
  marginLoopPolyline,
  measureWallThickness,
  type IndexedMesh,
} from '@dqcad/kernel';
import type { PipelineContext, PipelineMeshHandle } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';

/** Thrown when the margin loop for the requested tooth is absent — the shell's
 * seam is anchored on the confirmed margin; there is no marginExclusion /
 * feather-edge reference without one. */
export class MissingMarginLoopError extends Error {
  constructor(tooth: FdiTooth) {
    super(`shell stage: no margin loop for tooth ${tooth} in context.marginLoops — a confirmed margin is required`);
    this.name = 'MissingMarginLoopError';
  }
}

/** Thrown when a required clinical minimum is missing/non-finite — never
 * defaulted here (CLAUDE.md invariant 7). Only asserted when auto-thicken is
 * requested (it is what consumes the minimum). */
export class MissingClinicalParamError extends Error {
  constructor(paramName: string, value: unknown) {
    super(
      `shell stage: required clinical param "${paramName}" is missing or non-finite (got ${String(value)}) — ` +
        `it must be resolved from the material profile onto context.materialProfile.`,
    );
    this.name = 'MissingClinicalParamError';
  }
}

export interface ShellStageOptions {
  /** The morphed OUTER anatomy (Task 6 output) — the CLOSED library tooth
   * solid; `constructShell` trims it to the margin. (A pre-opened dome also
   * works — the trim is skipped when the outer already has a cervical rim.) */
  readonly outerAnatomyMesh: PipelineMeshHandle;
  /** The intaglio INNER surface (Task 4 output) — an open cup whose boundary
   * is the margin polyline. */
  readonly innerSurfaceMesh: PipelineMeshHandle;
  /** Content-hash function for the produced mesh — injected by the caller
   * (hashing lives one layer up; see stageResult.ts's doc). Deterministic. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
  /** Run the bounded outward auto-thicken on walls below the profile minimum
   * BEFORE stitching the shell (default `false` — user-invoked, journaled). */
  readonly autoThicken?: boolean;
  /** Max total outward displacement (mm) for auto-thicken — REQUIRED when
   * `autoThicken` is true (an algorithmic bound the caller supplies; not a
   * clinical default). */
  readonly autoThickenMaxDisplacementMm?: number;
  /** Margin-band exclusion distance (mm) for thickness measurement + the
   * auto-thicken feather guard — default 0 (include everything). */
  readonly marginExclusionMm?: number;
}

function assertFiniteParam(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new MissingClinicalParamError(name, value);
  }
}

/**
 * Runs the shell-construction stage for `tooth` — see this file's module doc.
 * Pure async function of `(context, tooth, options)`; returns the watertight
 * crown shell as a `RestorationStageResult` ready to journal. Deterministic:
 * same context + options + manifold-3d version -> byte-identical mesh + hash.
 *
 * @throws {MissingMarginLoopError} if `tooth` has no margin loop in the context.
 * @throws {MissingClinicalParamError} if `autoThicken` is requested but a
 * required minimum / bound is missing/non-finite.
 * @throws propagates `constructShell`'s typed errors (ShellBoundaryError,
 * NonManifoldInputError, ShellNotWatertightError).
 */
export async function runShellStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: ShellStageOptions,
): Promise<RestorationStageResult> {
  const marginLoopInput = context.marginLoops[tooth];
  if (!marginLoopInput) {
    throw new MissingMarginLoopError(tooth);
  }
  const marginLoop = marginLoopPolyline({ closed: marginLoopInput.closed, resampledPoints: marginLoopInput.resampledPoints });
  const insertionAxis = context.insertionAxis;
  const marginExclusionMm = options.marginExclusionMm ?? 0;

  const innerMesh = options.innerSurfaceMesh.mesh;
  let outerMesh = options.outerAnatomyMesh.mesh;

  // --- auto-thicken (user-invoked + journaled) ---
  const autoThicken = options.autoThicken === true;
  let autoThickenReport: {
    displacedVertexCount: number;
    clampedVertexCount: number;
    maxAppliedMm: number;
    minThicknessMm: number;
    maxDisplacementMm: number;
  } | null = null;
  if (autoThicken) {
    const minWallThicknessMm = context.materialProfile.restorationParams.minWallThicknessMm;
    assertFiniteParam('minWallThicknessMm', minWallThicknessMm);
    const maxDisplacementMm = options.autoThickenMaxDisplacementMm;
    if (maxDisplacementMm === undefined) {
      throw new MissingClinicalParamError('autoThickenMaxDisplacementMm', maxDisplacementMm);
    }
    assertFiniteParam('autoThickenMaxDisplacementMm', maxDisplacementMm);
    const thickened = autoThickenOuter(outerMesh, innerMesh, {
      minThicknessMm: minWallThicknessMm,
      maxDisplacementMm,
      marginLoop,
      marginExclusionMm,
    });
    outerMesh = thickened.mesh;
    autoThickenReport = {
      displacedVertexCount: thickened.displacedVertexCount,
      clampedVertexCount: thickened.clampedVertexCount,
      maxAppliedMm: thickened.maxAppliedMm,
      minThicknessMm: minWallThicknessMm,
      maxDisplacementMm,
    };
  }

  // --- construct the watertight shell (outer + inner joined at the margin band) ---
  // Pass the margin loop so a CLOSED morphed tooth (the Task-6 output) is
  // trimmed to an open-cervical dome at the margin before stitching — this is
  // the pipeline connection (closed morphed tooth -> watertight shell).
  const shell = await constructShell(outerMesh, innerMesh, { insertionAxis, marginLoop });

  // --- measure the shell's min wall thickness (for the journal + report) ---
  // Measure against the TRIMMED outer the shell actually used (a closed tooth's
  // sub-margin cap would otherwise read a spurious 0-thickness margin shelf).
  const thickness = measureWallThickness(innerMesh, shell.outerUsedMesh, {
    insertionAxis,
    marginLoop,
    marginExclusionMm,
  });

  const meshContentHash = options.hashMesh(shell.mesh);

  const params: Record<string, unknown> = {
    tooth,
    insertionAxis,
    marginLoopPointCount: marginLoop.length,
    marginExclusionMm,
    outerRimVertexCount: shell.outerRimVertexCount,
    innerRimVertexCount: shell.innerRimVertexCount,
    seamTriangleCount: shell.seamTriangleCount,
    shellVolumeMm3: shell.volumeMm3,
    minWallThicknessMm: thickness.minThicknessMm,
    minOcclusalWallThicknessMm: thickness.minOcclusalThicknessMm,
    minAxialWallThicknessMm: thickness.minAxialThicknessMm,
    thicknessSampleSpacingMm: thickness.sampleSpacingMm,
    autoThickenApplied: autoThicken,
    ...(autoThickenReport
      ? {
          autoThickenDisplacedVertexCount: autoThickenReport.displacedVertexCount,
          autoThickenClampedVertexCount: autoThickenReport.clampedVertexCount,
          autoThickenMaxAppliedMm: autoThickenReport.maxAppliedMm,
          autoThickenTargetMinThicknessMm: autoThickenReport.minThicknessMm,
          autoThickenMaxDisplacementMm: autoThickenReport.maxDisplacementMm,
        }
      : {}),
  };

  return {
    stage: 'shell',
    mesh: shell.mesh,
    meshContentHash,
    operationName: 'shell.construct',
    params,
    inputHashes: [options.outerAnatomyMesh.contentHash, options.innerSurfaceMesh.contentHash],
    errorBoundMm: thickness.errorBoundMm,
  };
}
