// jobs/cervicalFit.ts — the CERVICAL-FIT worker job (Phase 10 Task 5,
// ADR-023 Decision 2): @dqcad/kernel's `fitCervicalRing` on a placed library
// template, off the UI thread. The emergence offset is built here from the
// profile values the engine passes (`cervicalEmergenceOffsetMm`), so the
// journaled inputs are the clinical values themselves.
//
// A refusal (`CervicalFitError`) is returned as `{ ok: false, reason }`, not
// thrown: the engine then places the built-in template and discloses why. Any
// other error (bad input, cancellation) still throws.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import { CervicalFitError, cervicalEmergenceOffsetMm, fitCervicalRing, type CervicalFitErrorReason, type Vec3 } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

export interface FitCervicalRingPayload {
  /** The placed template (world space), closed. */
  positions: Float64Array;
  indices: Uint32Array;
  /** The template's cervical ring (ordered vertex indices of this mesh). */
  cervicalRing: readonly number[];
  /** The confirmed margin loop, Float64 flat xyz. */
  marginLoop: Float64Array;
  insertionAxis: Vec3;
  /** Profile values the emergence offset is built from. */
  marginalGapMm: number;
  cementGapMm: number;
  minWallThicknessMm: number;
}

export type FitCervicalRingResult =
  | {
      ok: true;
      /** The fitted template: same topology, the cervical region moved. */
      positions: Float64Array;
      indices: Uint32Array;
      /** @errorBound — the ring-to-emergence-loop residual (mm). */
      errorBoundMm: number;
      ringToLoopMm: number;
      loopToRingMm: number;
      maxRingDisplacementMm: number;
      ringVertexCount: number;
      anchorCount: number;
      movedVertexCount: number;
      emergenceOffsetMm: number;
      cervicalBlendMm: number;
      blendHeightMm: number;
    }
  | { ok: false; reason: CervicalFitErrorReason; message: string };

/**
 * `fitCervicalRing` worker job — see this file's module doc.
 *
 * @throws {JobCancelledError} if cancelled.
 * @throws {RangeError | TypeError} on malformed input (never a refusal).
 */
export const fitCervicalRingJob = async (
  payload: FitCervicalRingPayload,
  ctx: JobContext,
): Promise<FitCervicalRingResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const marginLoop: Vec3[] = [];
  for (let i = 0; i < payload.marginLoop.length; i += 3) {
    marginLoop.push([payload.marginLoop[i]!, payload.marginLoop[i + 1]!, payload.marginLoop[i + 2]!]);
  }
  const emergenceOffsetMm = cervicalEmergenceOffsetMm({
    marginalGapMm: payload.marginalGapMm,
    cementGapMm: payload.cementGapMm,
    minWallThicknessMm: payload.minWallThicknessMm,
  });
  try {
    const fit = fitCervicalRing({
      mesh: { positions: payload.positions, indices: payload.indices },
      cervicalRing: payload.cervicalRing,
      marginLoop,
      insertionAxis: payload.insertionAxis,
      emergenceOffsetMm,
    });
    ctx.progress(1);
    return {
      ok: true,
      positions: fit.mesh.positions,
      indices: fit.mesh.indices,
      errorBoundMm: fit.errorBoundMm,
      ringToLoopMm: fit.ringToLoopMm,
      loopToRingMm: fit.loopToRingMm,
      maxRingDisplacementMm: fit.maxRingDisplacementMm,
      ringVertexCount: fit.ringVertexCount,
      anchorCount: fit.anchorCount,
      movedVertexCount: fit.movedVertexCount,
      emergenceOffsetMm: fit.emergenceOffsetMm,
      cervicalBlendMm: fit.cervicalBlendMm,
      blendHeightMm: fit.blendHeightMm,
    };
  } catch (error) {
    if (error instanceof CervicalFitError) return { ok: false, reason: error.reason, message: error.message };
    throw error;
  }
};
