// jobs/shell.ts — the crown SHELL-construction worker job (Phase 4 Task 7):
// @dqcad/kernel's `constructShell` (outer anatomy + inner intaglio joined at
// the margin-band seam into a watertight solid, validated through the
// manifold-3d wrapper) + optional bounded `autoThickenOuter` + a
// `measureWallThickness` scan for the QC report. Progress spans the
// (optional) thicken, the boolean/stitch, and the thickness measure;
// cancellation is checked between phases via the kernel op's `checkCancel` hook.
//
// The kernel op's hooks affect NO computed value (byte-identity contract) —
// running this job yields a mesh byte-identical to a direct `constructShell`
// call at the same manifold-3d version (pinned by shellJob.test.ts).
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import {
  constructShell,
  autoThickenOuter,
  measureWallThickness,
  type IndexedMesh,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

export interface ConstructShellPayload {
  /** Outer anatomy (morphed tooth), Float64 flat xyz + triangle indices. */
  outerPositions: Float64Array;
  outerIndices: Uint32Array;
  /** Inner intaglio surface, Float64 flat xyz + indices. */
  innerPositions: Float64Array;
  innerIndices: Uint32Array;
  /** Insertion axis (occlusal direction). */
  insertionAxis: Vec3;
  /** Confirmed margin loop, Float64 flat xyz — for the thickness margin
   * exclusion + the auto-thicken feather guard. Optional. */
  marginLoop?: Float64Array;
  marginExclusionMm?: number;
  /** Bounded outward auto-thicken BEFORE stitching (user-invoked). */
  autoThicken?: boolean;
  autoThickenMinThicknessMm?: number;
  autoThickenMaxDisplacementMm?: number;
  autoThickenOvershoot?: number;
  autoThickenPasses?: number;
}

export interface ConstructShellResultPayload {
  positions: Float64Array;
  indices: Uint32Array;
  watertight: boolean;
  componentCount: number;
  seamTriangleCount: number;
  outerRimVertexCount: number;
  innerRimVertexCount: number;
  volumeMm3: number;
  minWallThicknessMm: number;
  minOcclusalWallThicknessMm: number;
  minAxialWallThicknessMm: number;
  thicknessSampleSpacingMm: number;
  errorBoundMm: number;
  autoThickenApplied: boolean;
  autoThickenDisplacedVertexCount: number;
  autoThickenClampedVertexCount: number;
  autoThickenMaxAppliedMm: number;
  /** Per-inner-vertex thickness heatmap (mm). */
  thicknessHeatmap: Float64Array;
}

function rebuildLoop(flat: Float64Array | undefined): Vec3[] | undefined {
  if (!flat) return undefined;
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

/**
 * `constructShell` worker job — see this file's module doc. Progress: 0 →
 * (auto-thicken) 0.15 → boolean/stitch 0.15..0.9 → thickness 1. Cancellation
 * checked up front and through the kernel op's `checkCancel` hook.
 *
 * @throws {JobCancelledError} if cancelled.
 * @throws propagates @dqcad/kernel's `ShellBoundaryError` / `NonManifoldInputError`
 * / `ShellNotWatertightError`.
 */
export const constructShellJob = async (
  payload: ConstructShellPayload,
  ctx: JobContext,
): Promise<ConstructShellResultPayload> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const innerMesh: IndexedMesh = { positions: payload.innerPositions, indices: payload.innerIndices };
  let outerMesh: IndexedMesh = { positions: payload.outerPositions, indices: payload.outerIndices };
  const marginLoop = rebuildLoop(payload.marginLoop);
  const marginExclusionMm = payload.marginExclusionMm ?? 0;

  let autoThickenApplied = false;
  let autoThickenDisplacedVertexCount = 0;
  let autoThickenClampedVertexCount = 0;
  let autoThickenMaxAppliedMm = 0;
  if (payload.autoThicken === true) {
    const minThicknessMm = payload.autoThickenMinThicknessMm;
    const maxDisplacementMm = payload.autoThickenMaxDisplacementMm;
    if (minThicknessMm === undefined || maxDisplacementMm === undefined) {
      throw new TypeError('constructShell job: autoThicken requires autoThickenMinThicknessMm + autoThickenMaxDisplacementMm');
    }
    const thickened = autoThickenOuter(outerMesh, innerMesh, {
      minThicknessMm,
      maxDisplacementMm,
      overshoot: payload.autoThickenOvershoot,
      passes: payload.autoThickenPasses,
      marginLoop,
      marginExclusionMm,
    });
    outerMesh = thickened.mesh;
    autoThickenApplied = true;
    autoThickenDisplacedVertexCount = thickened.displacedVertexCount;
    autoThickenClampedVertexCount = thickened.clampedVertexCount;
    autoThickenMaxAppliedMm = thickened.maxAppliedMm;
  }
  ctx.progress(0.15);
  if (await ctx.cancelled()) throw new JobCancelledError();

  const shell = await constructShell(
    outerMesh,
    innerMesh,
    { insertionAxis: payload.insertionAxis },
    {
      onProgress: (f) => ctx.progress(0.15 + 0.75 * f),
      checkCancel: async () => {
        if (await ctx.cancelled()) throw new JobCancelledError();
      },
    },
  );
  ctx.progress(0.9);

  const thickness = measureWallThickness(innerMesh, outerMesh, {
    insertionAxis: payload.insertionAxis,
    marginLoop,
    marginExclusionMm,
  });
  ctx.progress(1);

  return {
    positions: shell.mesh.positions,
    indices: shell.mesh.indices,
    watertight: shell.stats.watertight,
    componentCount: shell.stats.componentCount,
    seamTriangleCount: shell.seamTriangleCount,
    outerRimVertexCount: shell.outerRimVertexCount,
    innerRimVertexCount: shell.innerRimVertexCount,
    volumeMm3: shell.volumeMm3,
    minWallThicknessMm: thickness.minThicknessMm,
    minOcclusalWallThicknessMm: thickness.minOcclusalThicknessMm,
    minAxialWallThicknessMm: thickness.minAxialThicknessMm,
    thicknessSampleSpacingMm: thickness.sampleSpacingMm,
    errorBoundMm: thickness.errorBoundMm,
    autoThickenApplied,
    autoThickenDisplacedVertexCount,
    autoThickenClampedVertexCount,
    autoThickenMaxAppliedMm,
    thicknessHeatmap: thickness.perInnerVertexMm,
  };
};
