// jobs/register.ts — icpRegister (Phase 3 Task 3): @dqcad/kernel's
// register/ module (coarseAlignFromPointTriples + icpRefine — see those
// files for the algorithm, `@errorBound`, and determinism notes) wired up
// as a single worker job covering BOTH the coarse step (3 picked point
// pairs) and the point-to-plane ICP refinement, with REAL per-iteration
// progress and cooperative cancellation.
//
// ## Why one job, not two
//
// The UI's alignment tool (Task 3 brief: "run coarse+ICP with progress")
// always wants both steps run together as one round trip — a coarse step
// alone is not a usable result (no refinement), and ICP alone needs SOME
// initial transform from somewhere. Bundling them into one job also means
// the coarse step's result never needs to cross the Comlink boundary on its
// own only to be sent right back in as ICP's `initial` — it's computed
// worker-side, once, and its own value is echoed back in the result purely
// for journaling (`IcpRegisterResult.initialTransform`).
//
// ## BVH / mesh cache reuse (guardrail: NOT the offset-job rebuild-per-call
// anti-pattern — same reasoning as jobs/undercut.ts's module doc)
//
// Both `srcContentHash` and `dstContentHash` must already be cached via
// `buildBvh` (jobs/bvh.ts) on THIS worker — this job builds NEITHER BVH
// itself (`requireCachedBvh` is a lookup, not a build). `srcMesh`'s BVH
// specifically is never queried by this job (only its geometry, for
// sampling) — it's still required to have been built, simply because
// `requireCachedBvh` is this registry's only mechanism for obtaining a
// mesh's Float64 buffers at all (same "no filesystem/network access"
// constraint jobs/bvh.ts's module doc states) — a caller (engine/alignment.ts)
// always builds both candidate meshes' BVHs anyway, via the SAME
// `ensureBvhBuilt`/single-worker-affinity convention ToolManager.ts and
// jobs/heatmap.ts already establish, so this is never extra worker-side
// build cost.
//
// ## Progress & cancellation
//
// This job does NOT call @dqcad/kernel's whole-run `icpRefine` convenience
// function — it drives the chunked primitive that function is itself built
// on, `icpRefineIteration` (see that function's kernel-side doc: "same
// split as undercutScanRange/undercutScan"), `await`ing `ctx.cancelled()`
// and reporting `ctx.progress` BETWEEN iterations — real async cancellation
// checkpoints a single synchronous whole-run call could never offer, and
// exactly the "progress per iteration" this task's brief asks for.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  coarseAlignFromPointTriples,
  icpRefineIteration,
  samplePointsOnMesh,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_CONVERGENCE_REL_TOL,
  DEFAULT_OUTLIER_REJECTION_FRACTION,
  ICP_ABSOLUTE_RMS_CONVERGED_FLOOR_MM,
  DegenerateTripleError,
  type Mat4,
} from '@dqcad/kernel';
import { requireCachedBvh } from './bvh.ts';
import { JobCancelledError, type JobContext } from './context.ts';
import type { Vec3Payload } from './shared.ts';

export interface CoarsePointPair {
  src: Vec3Payload;
  dst: Vec3Payload;
}

export interface IcpRegisterPayload {
  /** contentHash of the mesh to be MOVED (src) — must already be cached via
   * `buildBvh` (jobs/bvh.ts) on this worker (see `BvhNotCachedError`). */
  srcContentHash: string;
  /** contentHash of the fixed TARGET mesh (dst) — same caching requirement. */
  dstContentHash: string;
  /** Exactly 3 user-picked point pairs — the coarse initial transform is
   * computed from these via `coarseAlignFromPointTriples`. Mutually
   * exclusive with `initialTransform` (exactly one of the two must be
   * provided — this job throws `TypeError` otherwise). */
  coarsePairs?: readonly CoarsePointPair[];
  /** Column-major 16-number transform (SceneNode convention) to start ICP
   * from directly — e.g. an identity transform when both meshes are already
   * known to share a coordinate frame (see @dqcad/kernel's icpRefine.ts
   * module doc, "local-minimum caveat", for when this is/isn't valid).
   * Mutually exclusive with `coarsePairs`. */
  initialTransform?: readonly number[];
  sampleCount: number;
  /** Deterministic sampling seed — CALLER-provided and journaled (this
   * job's caller is responsible for journaling it as an `alignment-apply`
   * Operation param — see engine/alignment.ts). */
  seed: number;
  maxIterations?: number;
  convergenceRelTol?: number;
  outlierRejectionFraction?: number;
}

export interface IcpRegisterResult {
  /** Column-major 16-number rigid transform (SceneNode convention) mapping
   * src's own local geometry onto dst. */
  transform: readonly number[];
  /** The coarse transform ICP actually started from — echoes
   * `coarseAlignFromPointTriples`'s output when `coarsePairs` was given, or
   * `initialTransform` verbatim otherwise. Journaled alongside `transform`
   * so a replay can see exactly what initialization produced this result. */
  initialTransform: readonly number[];
  rmsMm: number;
  inlierFraction: number;
  iterations: number;
  converged: boolean;
}

function validateTransform(transform: readonly number[], callerName: string): Mat4 {
  if (transform.length !== 16) {
    throw new TypeError(`${callerName}: initialTransform must have exactly 16 elements (column-major 4x4)`);
  }
  return transform;
}

export const icpRegisterJob = async (payload: IcpRegisterPayload, ctx: JobContext): Promise<IcpRegisterResult> => {
  const { mesh: srcMesh } = requireCachedBvh(payload.srcContentHash);
  const { mesh: dstMesh, bvh: dstBvh } = requireCachedBvh(payload.dstContentHash);

  let initial: Mat4;
  if (payload.coarsePairs && payload.initialTransform) {
    throw new TypeError('icpRegister: pass exactly one of coarsePairs / initialTransform, not both');
  }
  if (payload.coarsePairs) {
    if (payload.coarsePairs.length !== 3) {
      throw new TypeError('icpRegister: coarsePairs must have exactly 3 entries');
    }
    const [p0, p1, p2] = payload.coarsePairs;
    const srcPts: readonly [Vec3Payload, Vec3Payload, Vec3Payload] = [p0!.src, p1!.src, p2!.src];
    const dstPts: readonly [Vec3Payload, Vec3Payload, Vec3Payload] = [p0!.dst, p1!.dst, p2!.dst];
    initial = coarseAlignFromPointTriples(srcPts, dstPts).transform;
  } else if (payload.initialTransform) {
    initial = validateTransform(payload.initialTransform, 'icpRegister');
  } else {
    throw new TypeError('icpRegister: either coarsePairs or initialTransform must be provided');
  }
  const initialTransform = initial;

  const { points: srcSamples } = samplePointsOnMesh(srcMesh, payload.sampleCount, payload.seed);
  const maxIterations = payload.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const convergenceRelTol = payload.convergenceRelTol ?? DEFAULT_CONVERGENCE_REL_TOL;
  const outlierRejectionFraction = payload.outlierRejectionFraction ?? DEFAULT_OUTLIER_REJECTION_FRACTION;

  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  let currentTransform = initial;
  let previousRms = Infinity;
  let lastRms = 0;
  let lastInlierFraction = 0;
  let iterationsRun = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterationsRun = iter + 1;
    const step = icpRefineIteration(srcSamples, dstMesh, dstBvh, currentTransform, outlierRejectionFraction);
    lastRms = step.rmsMm;
    lastInlierFraction = step.inlierFraction;

    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress(iterationsRun / maxIterations);

    if (step.transform === null) break; // singular system — stop where we are, report what we have
    currentTransform = step.transform;

    const relChange = Math.abs(previousRms - lastRms) / Math.max(previousRms, 1e-9);
    previousRms = lastRms;
    if (
      (Number.isFinite(relChange) && relChange < convergenceRelTol) ||
      lastRms < ICP_ABSOLUTE_RMS_CONVERGED_FLOOR_MM
    ) {
      converged = true;
      break;
    }
  }
  ctx.progress(1);

  return {
    transform: currentTransform,
    initialTransform,
    rmsMm: lastRms,
    inlierFraction: lastInlierFraction,
    iterations: iterationsRun,
    converged,
  };
};

export { DegenerateTripleError };
