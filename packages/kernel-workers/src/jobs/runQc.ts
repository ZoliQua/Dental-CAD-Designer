// jobs/runQc.ts — the crown QC-gate-suite worker job (Phase 4 Task 9):
// runs cad-pipeline's full §6 gate set (`runCrownQc`) off the UI thread and
// returns the `QcReport`. Two of its gates (seating, selfIntersection) use the
// manifold-3d WASM booleans, so this belongs in a worker (heavy + async), never
// on the main thread. Progress is emitted per gate (via `runCrownQc`'s
// `onProgress`); cancellation is checked cooperatively before and after the run.
//
// The QC report is a deterministic, hash-stable pure function of its inputs +
// kernel/manifold-3d version (cad-pipeline invariant) — running it here yields a
// report identical to a direct `runCrownQc` call at the same manifold-3d version.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import type { Vec3 } from '@dqcad/kernel';
import {
  runCrownQc,
  type ContactResidualInput,
  type ConnectorCrossSection,
} from '@dqcad/cad-pipeline';
import type { QcReport } from '@dqcad/shared-types';
import { JobCancelledError, type JobContext } from './context.ts';

export interface RunQcPayload {
  /** Finished watertight crown solid, Float64 flat xyz + triangle indices. */
  crownPositions: Float64Array;
  crownIndices: Uint32Array;
  /** Crown inner (intaglio) surface. */
  innerPositions: Float64Array;
  innerIndices: Uint32Array;
  /** Crown outer (trimmed) surface. */
  outerPositions: Float64Array;
  outerIndices: Uint32Array;
  /** Prep die (watertight) for the seating simulation. */
  diePositions: Float64Array;
  dieIndices: Uint32Array;
  /** Confirmed margin dense polyline, Float64 flat xyz. */
  marginLoop: Float64Array;
  insertionAxis: Vec3;
  // profile-resolved thresholds
  minWallThicknessMm: number;
  occlusalMinWallThicknessMm: number;
  connectorAreaTargetMm2: number;
  // T6 contact residuals
  contacts: readonly ContactResidualInput[];
  contactClampWarning: boolean;
  // optional overrides
  marginExclusionMm?: number;
  marginFitThresholdMm?: number;
  seatingInterferenceVolumeToleranceMm3?: number;
  contactToleranceMm?: number;
  connectors?: readonly ConnectorCrossSection[];
  // metadata
  kernelVersion: string;
  profileVersion: string;
  journalHash: string;
  acknowledgedGates?: readonly string[];
}

export interface RunQcResult {
  report: QcReport;
}

function rebuildLoop(flat: Float64Array): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

/**
 * `runCrownQc` worker job — see this file's module doc. Progress spans the two
 * WASM measurements + one tick per gate; cancellation checked before and after.
 *
 * @throws {JobCancelledError} if cancelled.
 */
export const runQcJob = async (payload: RunQcPayload, ctx: JobContext): Promise<RunQcResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();

  const report = await runCrownQc(
    {
      crownSolid: { positions: payload.crownPositions, indices: payload.crownIndices },
      innerSurfaceMesh: { positions: payload.innerPositions, indices: payload.innerIndices },
      outerSurfaceMesh: { positions: payload.outerPositions, indices: payload.outerIndices },
      dieSolid: { positions: payload.diePositions, indices: payload.dieIndices },
      marginResampledPoints: rebuildLoop(payload.marginLoop),
      insertionAxis: payload.insertionAxis,
      minWallThicknessMm: payload.minWallThicknessMm,
      occlusalMinWallThicknessMm: payload.occlusalMinWallThicknessMm,
      connectorAreaTargetMm2: payload.connectorAreaTargetMm2,
      contacts: payload.contacts,
      contactClampWarning: payload.contactClampWarning,
      marginExclusionMm: payload.marginExclusionMm,
      marginFitThresholdMm: payload.marginFitThresholdMm,
      seatingInterferenceVolumeToleranceMm3: payload.seatingInterferenceVolumeToleranceMm3,
      contactToleranceMm: payload.contactToleranceMm,
      connectors: payload.connectors,
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
