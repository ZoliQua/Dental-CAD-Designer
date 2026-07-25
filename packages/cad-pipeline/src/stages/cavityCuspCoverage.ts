// packages/cad-pipeline/src/stages/cavityCuspCoverage.ts
//
// Phase 5 Task 7: the ONLAY CUSP-COVERAGE SELECTION stage — a DESIGN DECISION
// journaled as an Operation. It takes the base (inlay) cavity outline + the
// covered-cusp SELECTION (the tooth surface the restoration caps) and produces
// the EXTENDED onlay outline via `@dqcad/kernel`'s `extendOutlineOverCusp` (the
// single boundary loop of cavity ∪ covered cusp). The extended outline then
// feeds the SAME T3–T6 cavity stages unchanged (an onlay = an inlay on the
// extended outline).
//
// ## Onlay-only (guard rail)
//
// `assertCavityContext` runs for inlay/onlay; this stage additionally requires an
// ONLAY (an inlay has no covered cusp) — a `RestorationTypeMismatchError` for an
// inlay/crown/bridge. The coverage SELECTION (`coveredCuspTriangleIndices`) is a
// user-driven design decision surfaced via options (identified from
// `identifyCuspRegions` + a documented coverage-margin rule); journaling it makes
// the onlay design reproducible (replay reproduces the identical extended
// outline).
//
// ## No mesh output; errorBoundMm = null (a topological boundary extraction)
//
// The op emits an on-mesh outline RING (no mesh, no offset approximation), so
// `mesh`/`meshContentHash` are null and `errorBoundMm` is null. The extended
// outline (+ the covered-cusp footprint) is surfaced on the result for the
// downstream cavity stages + the region-scoped `cuspCoverageThickness` gate.
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { extendOutlineOverCusp, marginLoopPolyline } from '@dqcad/kernel';
import type { PipelineContext, OnlayPipelineContext } from '../pipeline/context.ts';
import { assertCavityContext, RestorationTypeMismatchError } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';

/** Thrown when the base cavity outline for the tooth is absent — nothing to
 * extend. Explicit field + body assignment (NOT a TS constructor parameter
 * property — the worker strip-only-TS loader landmine). */
export class MissingCavityOutlineError extends Error {
  readonly tooth: FdiTooth;
  constructor(tooth: FdiTooth) {
    super(`cavityCuspCoverage stage: no base cavity outline for tooth ${tooth} in context.marginLoops`);
    this.name = 'MissingCavityOutlineError';
    this.tooth = tooth;
  }
}

export interface CavityCuspCoverageStageOptions {
  /** The coverage SELECTION — the covered-cusp surface triangle indices on the
   * target tooth mesh (the design decision). */
  readonly coveredCuspTriangleIndices: Uint32Array | readonly number[];
  /** Content hash of the outline point list (caller-supplied — the outline is
   * not a mesh). */
  readonly hashOutline: (points: readonly Vec3[]) => string;
}

export interface CavityCuspCoverageStageResult extends RestorationStageResult {
  /** The extended onlay outline (a closed on-mesh ring). */
  readonly extendedOutline: Vec3[];
  /** The covered-cusp footprint triangle indices (region-scoped gate currency). */
  readonly coveredCuspTriangleIndices: Uint32Array;
}

/**
 * Runs the onlay cusp-coverage selection stage. Deterministic; replay reproduces
 * the identical extended outline.
 *
 * @throws {RestorationTypeMismatchError} for a non-onlay context.
 * @throws {MissingCavityOutlineError} if the base outline is absent.
 * @throws propagates `extendOutlineOverCusp` typed errors (`CoverageBoundaryError`).
 */
export function runCavityCuspCoverageStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: CavityCuspCoverageStageOptions,
): CavityCuspCoverageStageResult {
  assertCavityContext(context); // inlay/onlay-only
  if (context.restorationType !== 'onlay') {
    throw new RestorationTypeMismatchError('onlay', context.restorationType);
  }
  const onlay = context as OnlayPipelineContext;
  const outlineInput = onlay.marginLoops[tooth];
  if (!outlineInput) {
    throw new MissingCavityOutlineError(tooth);
  }
  const baseOutline = marginLoopPolyline({ closed: outlineInput.closed, resampledPoints: outlineInput.resampledPoints });

  const result = extendOutlineOverCusp(onlay.targetMesh.mesh, baseOutline, onlay.insertionAxis, options.coveredCuspTriangleIndices);
  const extendedOutline = result.extendedOutline;

  return {
    stage: 'innerSurface', // the extended outline is consumed by the fit-surface stage next
    mesh: null,
    meshContentHash: null,
    operationName: 'cuspCoverage.select',
    params: {
      tooth,
      restorationType: context.restorationType,
      insertionAxis: onlay.insertionAxis,
      baseOutlinePointCount: baseOutline.length,
      coveredCuspTriangleCount: result.coveredCuspTriangleIndices.length,
      coveredCuspCount: result.coveredCuspCount,
      extendedOutlinePointCount: extendedOutline.length,
      extendedOutlineHash: options.hashOutline(extendedOutline),
    },
    inputHashes: [onlay.targetMesh.contentHash],
    errorBoundMm: null,
    extendedOutline,
    coveredCuspTriangleIndices: result.coveredCuspTriangleIndices,
  };
}
