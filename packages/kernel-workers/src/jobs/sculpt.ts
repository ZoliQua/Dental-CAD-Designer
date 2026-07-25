// jobs/sculpt.ts — the FREEFORM SCULPTING worker job (Phase 4 Task 8):
// @dqcad/kernel's `computeShellLock` (freeze the fit surface — inner intaglio +
// margin + seam) + `applySculptGesture` (deterministic add/remove/smooth brush
// strokes on the OUTER surface, fold-guarded so a stroke never tears the
// watertight shell). Fast + interactive (< 50 ms/stroke on the real shell); a
// gesture (ordered stroke sequence) is applied as one call, mirroring the
// coalesced journaling the cad-pipeline stage does.
//
// The op is pure Float64 and deterministic: same shell + inner + strokes + lock
// params ⇒ byte-identical mesh (no manifold-3d boundary here — unlike the shell
// job — so no manifoldVersion sensitivity). Progress/cancel are checked up front
// and after the (dominant) gesture application; they affect NO computed value.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import {
  applySculptGesture,
  computeShellLock,
  type IndexedMesh,
  type SculptStroke,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

export interface ApplySculptStrokePayload {
  /** The crown shell to sculpt, Float64 flat xyz + triangle indices. */
  shellPositions: Float64Array;
  shellIndices: Uint32Array;
  /** The inner intaglio surface — defines the LOCKED fit surface. */
  innerPositions: Float64Array;
  innerIndices: Uint32Array;
  /** The gesture: ordered brush strokes, applied as a unit (journaled/replayed
   * together by the caller). */
  strokes: readonly SculptStroke[];
  /** Confirmed margin loop, Float64 flat xyz — margin-band lock + reference.
   * Optional. */
  marginLoop?: Float64Array;
  /** Lock tuning (mm / count) — kernel defaults when omitted. */
  marginLockBandMm?: number;
  lockInnerEpsilonMm?: number;
  seamRingGrowth?: number;
  /** Explicitly unlock the fit surface (default false — journaled by caller). */
  unlockFitSurface?: boolean;
}

export interface ApplySculptStrokeResult {
  positions: Float64Array;
  indices: Uint32Array;
  watertight: boolean;
  componentCount: number;
  movedVertexCount: number;
  peakDisplacementMm: number;
  clampedStrokeCount: number;
  lockedVertexCount: number;
  sculptableVertexCount: number;
}

function rebuildLoop(flat: Float64Array | undefined): Vec3[] | undefined {
  if (!flat) return undefined;
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

/**
 * `applySculptStroke` worker job — computes the fit-surface lock then applies
 * the gesture. Deterministic; interactive (< 50 ms/stroke on the real shell).
 *
 * @throws {JobCancelledError} if cancelled.
 * @throws propagates @dqcad/kernel's `SculptStrokeParamError` / `SculptNotWatertightError`.
 */
export const applySculptStrokeJob = async (
  payload: ApplySculptStrokePayload,
  ctx: JobContext,
): Promise<ApplySculptStrokeResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const shell: IndexedMesh = { positions: payload.shellPositions, indices: payload.shellIndices };
  const inner: IndexedMesh = { positions: payload.innerPositions, indices: payload.innerIndices };
  const marginLoop = rebuildLoop(payload.marginLoop);

  let locked: Uint8Array;
  let lockedVertexCount: number;
  let sculptableVertexCount: number;
  if (payload.unlockFitSurface === true) {
    locked = new Uint8Array(shell.positions.length / 3);
    lockedVertexCount = 0;
    sculptableVertexCount = shell.positions.length / 3;
  } else {
    const lock = computeShellLock(shell, {
      innerMesh: inner,
      marginLoop,
      marginLockBandMm: payload.marginLockBandMm,
      lockInnerEpsilonMm: payload.lockInnerEpsilonMm,
      seamRingGrowth: payload.seamRingGrowth,
    });
    locked = lock.locked;
    lockedVertexCount = lock.lockedCount;
    sculptableVertexCount = lock.outerCount;
  }
  ctx.progress(0.3);
  if (await ctx.cancelled()) throw new JobCancelledError();

  const result = applySculptGesture(shell, payload.strokes, locked);
  ctx.progress(1);

  return {
    positions: result.mesh.positions,
    indices: result.mesh.indices,
    watertight: result.stats.watertight,
    componentCount: result.stats.componentCount,
    movedVertexCount: result.movedVertexCount,
    peakDisplacementMm: result.peakDisplacementMm,
    clampedStrokeCount: result.clampedStrokeCount,
    lockedVertexCount,
    sculptableVertexCount,
  };
};
