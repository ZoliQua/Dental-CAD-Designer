// packages/cad-pipeline/src/stages/prepDie.ts
//
// Phase 10 Task 3 (ADR-023 Decision 1): the PREPARE-DIE stage — the pipeline
// twin of the client crown engine's first stage (engine/crownDesign.ts
// `runPrepDie`, the `extractPrepDie` worker job) and of the server export's
// re-extraction (apps/server/src/export-die.ts). The kernel does the geometry
// (`extractPrepDie`: the kept scan surface, the synthetic closure, the
// clearance certificate); this stage packages it as a
// `RestorationStageResult` the caller journals under the engine's op name.
//
// ## The die is cut from the target's PERSISTED FORM
//
// As in the worker job and on the server: `persistedMeshForm(target)` — the
// scan as a stored binary STL reloads it (float32, re-welded). The form is
// idempotent, so a target that already is persisted is unchanged, and the
// three cuts (client, pipeline, server) agree bit for bit.
//
// ## The margin loop is used as confirmed
//
// The client and the server pass the confirmed `resampledPoints` unchanged
// (no dedup or resampling) — the stage does the same, so all three cut the
// identical die. The kernel validates the loop (every point on the kept
// surface).
//
// No clinical value enters: the skirts, floor gap, protected band and
// required clearance are the kernel's ALGORITHM defaults, journaled with the
// certificate.
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { CROWN_DIE_EXTRACT_OP } from '@dqcad/shared-types';
import { extractPrepDie, persistedMeshForm, type IndexedMesh, type PrepDieResult } from '@dqcad/kernel';
import type { PipelineContext } from '../pipeline/context.ts';
import { assertCrownContext } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';

/** Thrown when the context holds no margin loop for the requested tooth — a
 * die is cut around a confirmed margin. */
export class MissingMarginLoopError extends Error {
  constructor(tooth: FdiTooth) {
    super(`prepDie stage: no margin loop for tooth ${tooth} in context.marginLoops — a confirmed margin is required`);
    this.name = 'MissingMarginLoopError';
  }
}

export interface PrepDieStageOptions {
  /** Content-hash function for the die — injected by the caller (hashing
   * lives one layer up; see stageResult.ts). Deterministic. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

/** The stage result plus the kernel's full die record (the certificate with
 * its `Infinity` intact, for callers that check intaglio coverage). */
export interface PrepDieStageResult extends RestorationStageResult {
  readonly die: PrepDieResult;
}

/**
 * Runs the prepare-die stage for `tooth` — see this file's module doc. A
 * synchronous pure function of `(context, tooth)`.
 *
 * @throws {MissingMarginLoopError} if `tooth` has no margin loop.
 * @throws propagates the kernel's typed errors (`PrepDieRegionError`,
 * `PrepDieInvalidError`, `PrepDieClearanceError`, `RangeError`).
 */
export function runPrepDieStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: PrepDieStageOptions,
): PrepDieStageResult {
  assertCrownContext(context);
  const marginLoopInput = context.marginLoops[tooth];
  if (!marginLoopInput) throw new MissingMarginLoopError(tooth);
  const loop: Vec3[] = marginLoopInput.resampledPoints.map((p): Vec3 => [p[0], p[1], p[2]]);
  const die = extractPrepDie(persistedMeshForm(context.targetMesh.mesh), loop, context.insertionAxis);
  return {
    stage: 'prepDie',
    mesh: die.mesh,
    meshContentHash: options.hashMesh(die.mesh),
    operationName: CROWN_DIE_EXTRACT_OP,
    params: {
      tooth,
      scanForm: 'persisted-stl',
      marginLoopPointCount: loop.length,
      insertionAxis: die.insertionAxis,
      keptTriangleCount: die.keptTriangleCount,
      syntheticTriangleCount: die.syntheticTriangleCount,
      rimVertexCount: die.rimVertexCount,
      foldTrianglesDropped: die.foldTrianglesDropped,
      // JSON has no Infinity: an unbounded certificate (the scan closed the
      // die itself) is journaled as null, as the engine does.
      clearanceMm: Number.isFinite(die.clearanceMm) ? die.clearanceMm : null,
      marginMinHeightMm: die.marginMinHeightMm,
      floorHeightMm: die.floorHeightMm,
      volumeMm3: die.volumeMm3,
      radialSkirtMm: die.radialSkirtMm,
      depthSkirtMm: die.depthSkirtMm,
      protectBandMm: die.protectBandMm,
      floorGapMm: die.floorGapMm,
      requiredClearanceMm: die.requiredClearanceMm,
    },
    inputHashes: [context.targetMesh.contentHash],
    // No approximation: the kept surface is the persisted scan verbatim and
    // the closure is exact and certified (the kernel op's @errorBound).
    errorBoundMm: null,
    die,
  };
}
