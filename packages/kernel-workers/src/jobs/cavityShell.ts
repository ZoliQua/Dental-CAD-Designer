// jobs/cavityShell.ts — the inlay/onlay SHELL-construction worker job (Phase 5
// Task 6): @dqcad/kernel's `constructInlayShell` (the Task-3 fit surface +
// Task-4/5 occlusal patch welded along their shared cavity-outline ring into a
// single watertight solid, re-validated + cleaned through the manifold-3d
// wrapper — see @dqcad/kernel's cavity/inlayShell.ts for why a direct weld is
// preferred over a boolean, and the validation/determinism story). Progress
// spans the weld + WASM cleanup; cancellation is checked via the kernel op's
// `checkCancel` hook.
//
// The kernel op's hooks affect NO computed value (byte-identity contract) —
// running this job yields a mesh byte-identical to a direct `constructInlayShell`
// call at the same manifold-3d version (pinned by cavityShellJob.test.ts).
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention". NOTE: no TypeScript constructor
// parameter properties anywhere in this file (the Task 1 worker-loader landmine)
// — there are no classes here; payload/result are plain interfaces.
import { constructInlayShell, type IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

export interface CavityShellPayload {
  /** The Task-3 cavity fit (inner) surface, Float64 flat xyz + indices. */
  fitPositions: Float64Array;
  fitIndices: Uint32Array;
  /** The Task-4/5 occlusal patch (adapted), Float64 flat xyz + indices. */
  patchPositions: Float64Array;
  patchIndices: Uint32Array;
}

export interface CavityShellResult {
  positions: Float64Array;
  indices: Uint32Array;
  watertight: boolean;
  componentCount: number;
  seamRingVertexCount: number;
  fitTriangleCount: number;
  patchTriangleCount: number;
  volumeMm3: number;
}

/**
 * `constructInlayShell` worker job — see this file's module doc. Progress is
 * driven by the kernel op's `onProgress` hook (weld → orient → WASM cleanup);
 * cancellation is checked up front and via the op's `checkCancel` hook.
 *
 * @throws {JobCancelledError} if cancelled.
 * @throws propagates @dqcad/kernel's `InlayShellOpenBoundaryError` /
 * `InlayShellRingMismatchError` / `NonManifoldInputError` /
 * `InlayShellNotWatertightError`.
 */
export const cavityShellJob = async (payload: CavityShellPayload, ctx: JobContext): Promise<CavityShellResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const fitMesh: IndexedMesh = { positions: payload.fitPositions, indices: payload.fitIndices };
  const patchMesh: IndexedMesh = { positions: payload.patchPositions, indices: payload.patchIndices };

  const shell = await constructInlayShell(fitMesh, patchMesh, {
    onProgress: (f) => ctx.progress(f),
    checkCancel: async () => {
      if (await ctx.cancelled()) throw new JobCancelledError();
    },
  });
  ctx.progress(1);

  return {
    positions: shell.mesh.positions,
    indices: shell.mesh.indices,
    watertight: shell.stats.watertight,
    componentCount: shell.stats.componentCount,
    seamRingVertexCount: shell.seamRingVertexCount,
    fitTriangleCount: shell.fitTriangleCount,
    patchTriangleCount: shell.patchTriangleCount,
    volumeMm3: shell.volumeMm3,
  };
};
