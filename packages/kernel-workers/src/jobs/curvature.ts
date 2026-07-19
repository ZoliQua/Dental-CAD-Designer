// jobs/curvature.ts — computeCurvature (Phase 2 Task 3): per-vertex mean
// (H) and Gaussian (K) curvature, plus principal curvatures (k1/k2), via
// @dqcad/kernel's curvature/ module (cotangent-weighted Laplace-Beltrami +
// Meyer et al. mixed Voronoi areas — see that module's curvature.ts for
// every formula/sign-convention/error-bound/boundary-policy doc).
//
// Cancellation/progress granularity: `computeCurvature` is ONE synchronous,
// non-yielding kernel call — same shape as jobs/repair.ts's three repair
// jobs (see that file's module doc for the identical reasoning: nothing to
// check cancellation BETWEEN internally, so a single checkpoint before
// starting, then progress 0 -> 1).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import { computeCurvature, type IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireMeshPayload } from './shared.ts';

export interface ComputeCurvaturePayload {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface ComputeCurvatureResult {
  /** Signed mean curvature per vertex, mm^-1. */
  H: Float64Array;
  /** Gaussian curvature per vertex, mm^-2. */
  K: Float64Array;
  /** Larger principal curvature (k1 >= k2), mm^-1. */
  k1: Float64Array;
  /** Smaller principal curvature, mm^-1. */
  k2: Float64Array;
  /** `1` for a boundary/isolated vertex (H/K/k1/k2 are `0`, not meaningful
   * there — see @dqcad/kernel's curvature.ts "Boundary policy" doc), `0`
   * otherwise. */
  isBoundary: Uint8Array;
  /** Mixed Voronoi area per vertex, mm^2. */
  mixedArea: Float64Array;
}

export const computeCurvatureJob = async (
  payload: ComputeCurvaturePayload,
  ctx: JobContext,
): Promise<ComputeCurvatureResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'computeCurvature');
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };
  const { H, K, k1, k2, isBoundary, mixedArea } = computeCurvature(mesh);
  ctx.progress(1);
  return { H, K, k1, k2, isBoundary, mixedArea };
};
