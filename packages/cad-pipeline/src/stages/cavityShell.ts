// packages/cad-pipeline/src/stages/cavityShell.ts
//
// Phase 5 Task 6: the CAVITY SHELL-CONSTRUCTION stage — the inlay/onlay
// analogue of the crown `shell` stage. It welds the Task-3 fit surface and the
// Task-4/5 occlusal patch (adapted proximal faces) into a SINGLE WATERTIGHT
// solid along their shared cavity-outline ring, via the kernel's
// `constructInlayShell` (a direct deterministic weld — NOT a boolean — see
// @dqcad/kernel's cavity/inlayShell.ts for why the shared bit-exact ring makes
// the weld preferable, and how it re-validates watertight/manifold/single-
// component through the manifold-3d wrapper), and packages the result + journal
// fields.
//
// ## Restoration-type guard rail (Phase 5 Task 1 scaffold)
//
// Calls `assertCavityContext(context)` at entry: runs for an INLAY or ONLAY and
// throws `RestorationTypeMismatchError` for a crown/bridge (the crown shell
// stage's `assertCrownContext` mirror). Inlay + onlay share this stage unchanged.
//
// ## @errorBound
//
// The weld introduces NO geometric approximation of its own; the only positional
// change is the manifold-3d Float32 cleanup applied to the whole shell (the
// kernel op's `@errorBound`). The QC gates measure the pre-cleanup Float64 fit /
// patch surfaces (never the cleaned solid), so the margin fit + seam dihedral are
// exact — carried into the assembled-shell QC byte-for-byte. `errorBoundMm` is
// therefore `null` for this stage (the cleanup's sub-µm boundary is documented
// on the kernel op, not surfaced as a stage measurement error).
import type { FdiTooth } from '@dqcad/shared-types';
import { constructInlayShell, type IndexedMesh } from '@dqcad/kernel';
import type { PipelineContext, PipelineMeshHandle } from '../pipeline/context.ts';
import { assertCavityContext } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';

export interface CavityShellStageOptions {
  /** The Task-3 cavity fit (inner) surface — an open cup whose boundary is the
   * cavity outline. */
  readonly fitSurfaceMesh: PipelineMeshHandle;
  /** The Task-4/5 occlusal patch (adapted proximal faces) — an open cap whose
   * boundary is the SAME cavity outline, bit-exact. */
  readonly patchMesh: PipelineMeshHandle;
  /** Content-hash function for the produced mesh — injected by the caller
   * (hashing lives one layer up; see stageResult.ts). Deterministic. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

export interface CavityShellStageResult extends RestorationStageResult {
  /** The assembled watertight inlay/onlay solid. */
  readonly mesh: IndexedMesh;
  /** Shell volume, mm³ (signed volume; > 0). */
  readonly volumeMm3: number;
  /** The welded shared cavity-outline ring vertex count. */
  readonly seamRingVertexCount: number;
}

/**
 * Runs the cavity shell-construction stage for `tooth` — see this file's module
 * doc. Pure async function of `(context, tooth, options)`; returns the
 * watertight inlay/onlay solid as a `CavityShellStageResult` ready to journal.
 * Deterministic: same context + options + manifold-3d version → byte-identical
 * mesh + hash.
 *
 * @throws {RestorationTypeMismatchError} if `context` is not an inlay/onlay case.
 * @throws propagates `constructInlayShell`'s typed errors
 * (`InlayShellOpenBoundaryError`, `InlayShellRingMismatchError`,
 * `NonManifoldInputError`, `InlayShellNotWatertightError`).
 */
export async function runCavityShellStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: CavityShellStageOptions,
): Promise<CavityShellStageResult> {
  assertCavityContext(context); // inlay/onlay-only stage — Phase 5 Task 1 guard rail

  const shell = await constructInlayShell(options.fitSurfaceMesh.mesh, options.patchMesh.mesh);
  const meshContentHash = options.hashMesh(shell.mesh);

  return {
    stage: 'shell',
    mesh: shell.mesh,
    meshContentHash,
    operationName: 'cavityShell.construct',
    params: {
      tooth,
      restorationType: context.restorationType,
      seamRingVertexCount: shell.seamRingVertexCount,
      fitTriangleCount: shell.fitTriangleCount,
      patchTriangleCount: shell.patchTriangleCount,
      shellTriangleCount: shell.mesh.indices.length / 3,
      shellVolumeMm3: shell.volumeMm3,
      watertight: shell.stats.watertight,
      componentCount: shell.stats.componentCount,
    },
    inputHashes: [options.fitSurfaceMesh.contentHash, options.patchMesh.contentHash],
    errorBoundMm: null,
    volumeMm3: shell.volumeMm3,
    seamRingVertexCount: shell.seamRingVertexCount,
  };
}
