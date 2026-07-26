// jobs/runInlayQc.ts — the inlay/onlay QC-gate-suite worker job (Phase 5 Task
// 6): runs cad-pipeline's restoration-type-aware gate set (`runInlayQc`) off the
// UI thread and returns the `QcReport`. Two of its gates (seating,
// selfIntersection) use the manifold-3d WASM booleans, so this belongs in a
// worker (heavy + async), never on the main thread. Progress is emitted per gate
// (via `runInlayQc`'s `onProgress`); cancellation is checked cooperatively
// before and after the run.
//
// The QC report is a deterministic, hash-stable pure function of its inputs +
// kernel/manifold-3d version — running it here yields a report identical to a
// direct `runInlayQc` call at the same manifold-3d version.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import type { SeamEdge, Vec3 } from '@dqcad/kernel';
import { runInlayQc, type CavityThicknessMinimums, type ContactResidualInput, type CoverageDivider } from '@dqcad/cad-pipeline';
import type { QcReport, RestorationType } from '@dqcad/shared-types';
import { JobCancelledError, type JobContext } from './context.ts';

export interface RunInlayQcPayload {
  /** Finished watertight inlay/onlay solid, Float64 flat xyz + indices. */
  inlayPositions: Float64Array;
  inlayIndices: Uint32Array;
  /** Inlay INNER (fit) surface. */
  fitPositions: Float64Array;
  fitIndices: Uint32Array;
  /** Inlay OUTER (occlusal patch + adapted proximal faces). */
  patchPositions: Float64Array;
  patchIndices: Uint32Array;
  /** Tooth-with-cavity solid (the "die" + surrounding surface). */
  toothPositions: Float64Array;
  toothIndices: Uint32Array;
  /** Confirmed cavity outline dense polyline, Float64 flat xyz. */
  cavityOutline: Float64Array;
  insertionAxis: Vec3;
  restorationType: RestorationType;
  thicknessMinimums: CavityThicknessMinimums;
  marginExclusionMm: number;
  /** ONLAY covered-cusp coverage (T7) — present for an onlay carrying a coverage
   * selection; drives the region-scoped cusp-coverage thickness gate. Ignored by
   * `runInlayQc` for an inlay (no covered cusp). */
  coverage?: { coverageDivider: CoverageDivider; cuspCoverageMinThicknessMm: number };
  seamEdges: readonly SeamEdge[];
  cavityTriangleIndices: Uint32Array;
  contacts: readonly ContactResidualInput[];
  contactClampWarning: boolean;
  // optional overrides
  marginFitThresholdMm?: number;
  seamDihedralThresholdDeg?: number;
  seatingInterferenceVolumeToleranceMm3?: number;
  contactToleranceMm?: number;
  // metadata
  kernelVersion: string;
  profileVersion: string;
  journalHash: string;
  acknowledgedGates?: readonly string[];
}

export interface RunInlayQcResult {
  report: QcReport;
}

function rebuildLoop(flat: Float64Array): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

/**
 * `runInlayQc` worker job — see this file's module doc. Progress spans the two
 * WASM measurements + one tick per gate; cancellation checked before and after.
 *
 * @throws {JobCancelledError} if cancelled.
 * @throws {NonCavityRestorationTypeError} (from `runInlayQc`) for a non-cavity type.
 */
export const runInlayQcJob = async (payload: RunInlayQcPayload, ctx: JobContext): Promise<RunInlayQcResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();

  const report = await runInlayQc(
    {
      inlaySolid: { positions: payload.inlayPositions, indices: payload.inlayIndices },
      fitSurfaceMesh: { positions: payload.fitPositions, indices: payload.fitIndices },
      patchMesh: { positions: payload.patchPositions, indices: payload.patchIndices },
      toothWithCavitySolid: { positions: payload.toothPositions, indices: payload.toothIndices },
      cavityOutlineResampledPoints: rebuildLoop(payload.cavityOutline),
      insertionAxis: payload.insertionAxis,
      restorationType: payload.restorationType,
      thicknessMinimums: payload.thicknessMinimums,
      marginExclusionMm: payload.marginExclusionMm,
      coverage: payload.coverage,
      seamEdges: payload.seamEdges,
      cavityTriangleIndices: payload.cavityTriangleIndices,
      contacts: payload.contacts,
      contactClampWarning: payload.contactClampWarning,
      marginFitThresholdMm: payload.marginFitThresholdMm,
      seamDihedralThresholdDeg: payload.seamDihedralThresholdDeg,
      seatingInterferenceVolumeToleranceMm3: payload.seatingInterferenceVolumeToleranceMm3,
      contactToleranceMm: payload.contactToleranceMm,
      kernelVersion: payload.kernelVersion,
      profileVersion: payload.profileVersion,
      journalHash: payload.journalHash,
      acknowledgedGates: payload.acknowledgedGates,
    },
    (f) => ctx.progress(f),
  );

  if (await ctx.cancelled()) throw new JobCancelledError();
  return { report };
};
