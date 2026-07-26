// packages/cad-pipeline/src/stages/cavityInnerSurface.ts
//
// Phase 5 Task 3: the CAVITY INNER-SURFACE stage — the inlay/onlay analogue of
// the crown `innerSurface` stage. It orchestrates the kernel's cavity fit
// surface (`@dqcad/kernel`'s `buildCavityInnerSurface`: two-zone cement-gap
// offset off the cavity surface + solid undercut blockout + skirt-to-outline)
// into a `RestorationStageResult` the caller journals: the kernel does the
// geometry, the stage supplies the RESOLVED clinical gaps (from the material
// profile via `PipelineContext`, per CLAUDE.md invariant 7 — NEVER hardcoded
// here) and the confirmed cavity OUTLINE, and packages the output + error
// bound + journal fields.
//
// ## Restoration-type guard rail (Phase 5 Task 1 scaffold)
//
// This stage calls `assertCavityContext(context)` at entry: it runs for an
// INLAY or ONLAY case and throws `RestorationTypeMismatchError` for a crown (or
// bridge) — the mirror of the crown stages' `assertCrownContext`. So the
// crown-only guard does NOT fire here (this is a cavity stage) and the cavity
// guard DOES — a mis-typed crown context fails loudly rather than running the
// cavity algorithm (invariant 4's "corrupt → loud typed error" for the pipeline
// dispatch). The inlay and onlay families share this ONE stage unchanged (the
// fit surface is identical for both; only the later thickness gate reads the
// restoration type).
//
// ## The cavity OUTLINE is the margin currency
//
// A cavity's "margin" is its cavosurface OUTLINE — the dense, closed, on-mesh
// ring Phase 5 Task 2's `classifyCavityRegions` / the margin machinery consume.
// It arrives on `context.marginLoops[tooth].resampledPoints` (CHORD-CAP: the
// dense on-surface polyline, never anchor chords), exactly as a crown margin
// does; `buildCavityInnerSurface` measures the two-zone height field against it
// and stitches the fit-surface boundary onto it (margin fit → 0).
import type { FdiTooth } from '@dqcad/shared-types';
import {
  buildCavityInnerSurface,
  marginLoopPolyline,
  INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM,
  type IndexedMesh,
} from '@dqcad/kernel';
import type { PipelineContext } from '../pipeline/context.ts';
import { assertCavityContext } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';

/** Thrown when the cavity outline for the requested tooth is absent from the
 * context — the fit surface is defined relative to a confirmed cavity outline;
 * there is nothing to offset without one. */
export class MissingCavityOutlineError extends Error {
  // Explicit field + body assignment, NOT a constructor parameter property —
  // this file is in the Node worker's strip-only-TS import closure
  // (kernel-workers → cad-pipeline); parameter properties crash that loader (the
  // Task 1 landmine, see pipeline/context.ts's RestorationTypeMismatchError).
  readonly tooth: FdiTooth;
  constructor(tooth: FdiTooth) {
    super(`cavityInnerSurface stage: no cavity outline for tooth ${tooth} in context.marginLoops — a confirmed cavity outline is required`);
    this.name = 'MissingCavityOutlineError';
    this.tooth = tooth;
  }
}

/** Thrown when a required clinical gap/spacer param is missing or non-finite —
 * never defaulted here (CLAUDE.md invariant 7). */
export class MissingClinicalParamError extends Error {
  readonly paramName: string;
  constructor(paramName: string, value: unknown) {
    super(
      `cavityInnerSurface stage: required clinical param "${paramName}" is missing or non-finite (got ${String(value)}) — ` +
        `it must be resolved from the material profile onto context.materialProfile.restorationParams`,
    );
    this.name = 'MissingClinicalParamError';
    this.paramName = paramName;
  }
}

export interface CavityInnerSurfaceStageOptions {
  /** Voxel pitch, mm — REQUIRED (no default here; the caller passes the clinical
   * `DEFAULT_OFFSET_VOXEL_PITCH_MM` from `@dqcad/clinical-profiles`). */
  readonly pitchMm: number;
  /** C1 blend width, mm — default `INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM`
   * (kernel algorithmic default; NOT a clinical gap/thickness). */
  readonly blendWidthMm?: number;
  /** Content-hash function for the produced mesh — injected by the caller
   * (hashing lives one layer up; see stageResult.ts). Deterministic. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

function assertFiniteParam(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new MissingClinicalParamError(name, value);
  }
}

/**
 * Runs the cavity inner-surface stage for `tooth` — see this file's module doc.
 * Pure async function of `(context, tooth, options)`; returns the finished
 * cavity fit surface as a `RestorationStageResult` ready to journal.
 * Deterministic: same context + options → byte-identical mesh + hash.
 *
 * @throws {RestorationTypeMismatchError} if `context` is not an inlay/onlay case.
 * @throws {MissingCavityOutlineError} if `tooth` has no outline in the context.
 * @throws {MissingClinicalParamError} if a required gap/spacer param is missing.
 * @throws propagates `buildCavityInnerSurface`'s typed errors (pitch/gap/blend
 * validation, non-watertight target, empty offset, grid-too-large, outline not
 * an on-mesh edge ring).
 */
export async function runCavityInnerSurfaceStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: CavityInnerSurfaceStageOptions,
): Promise<RestorationStageResult> {
  assertCavityContext(context); // inlay/onlay-only stage — Phase 5 Task 1 guard rail
  const outlineInput = context.marginLoops[tooth];
  if (!outlineInput) {
    throw new MissingCavityOutlineError(tooth);
  }
  // Dedup + CHORD-CAP validation (margin/band.ts): consumes resampledPoints
  // ONLY (the dense, on-surface currency), never anchor chords.
  const outline = marginLoopPolyline({ closed: outlineInput.closed, resampledPoints: outlineInput.resampledPoints });

  const rp = context.materialProfile.restorationParams;
  assertFiniteParam('marginalGapMm', rp.marginalGapMm);
  assertFiniteParam('cementGapMm', rp.cementGapMm);
  assertFiniteParam('spacerStartMm', rp.spacerStartMm);
  // NOTE on `undercutBlockoutThresholdMm` (profile): the cavity blockout always
  // does a FULL draft-close (fills ALL wall undercut — threshold-0 semantics),
  // so the profile threshold does not influence the output; it is DELIBERATELY
  // NOT journaled as an op param here (journaling a value the op ignored would
  // be a false audit record). A retentive (nonzero) threshold is future work —
  // same policy the crown stage documents.

  const blendWidthMm = options.blendWidthMm ?? INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM;

  // ONE op: two-zone offset off the cavity surface + solid undercut blockout +
  // skirt-to-outline. The finished fit surface's boundary loop == the outline
  // polyline (the marginal seal); the marginFitGate re-measures that coincidence.
  const result = await buildCavityInnerSurface(context.targetMesh.mesh, {
    marginalGapMm: rp.marginalGapMm,
    cementGapMm: rp.cementGapMm,
    spacerStartMm: rp.spacerStartMm,
    blendWidthMm,
    pitchMm: options.pitchMm,
    cavityOutline: outline,
    insertionAxis: context.insertionAxis,
  });

  const meshContentHash = options.hashMesh(result.mesh);

  return {
    stage: 'innerSurface',
    mesh: result.mesh,
    meshContentHash,
    operationName: 'cavityInnerSurface.build',
    params: {
      tooth,
      restorationType: context.restorationType,
      pitchMm: options.pitchMm,
      marginalGapMm: rp.marginalGapMm,
      cementGapMm: rp.cementGapMm,
      spacerStartMm: rp.spacerStartMm,
      blendWidthMm,
      insertionAxis: context.insertionAxis,
      outlinePointCount: outline.length,
      patchTriangleCount: result.patchTriangleCount,
      skirtTriangleCount: result.skirtTriangleCount,
      marginVertexCount: result.marginVertexCount,
      errorBoundMm: result.errorBoundMm,
      flatZoneErrorBoundMm: result.flatZoneErrorBoundMm,
    },
    inputHashes: [context.targetMesh.contentHash],
    errorBoundMm: result.errorBoundMm,
  };
}
