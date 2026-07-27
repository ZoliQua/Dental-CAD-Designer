// jobs/runBridgeQc.ts — the WHOLE-BRIDGE QC-gate-suite worker job (Phase 6 Task
// 7): runs cad-pipeline's `runBridgeQc` off the UI thread and returns the
// `QcReport`. Several of its gates (selfIntersection, seating, the dies union)
// use the manifold-3d WASM booleans, so this belongs in a worker (heavy +
// async), never on the main thread — the same contract as jobs/runInlayQc.ts.
//
// The QC report is a deterministic, hash-stable pure function of its inputs +
// kernel/manifold-3d version — running it here yields a report identical to a
// direct `runBridgeQc` call at the same manifold-3d version (pinned by the
// client bridge-QC acceptance the browser-lane dom test drives on the serialized
// asset). NO TS ctor parameter properties; serialized flat transferable buffers
// (the P5-T8 lesson — never a ported construction).
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import type { FitRegionDescriptor, IndexedMesh, Vec3 } from '@dqcad/kernel';
import { runBridgeQc, type BridgeUnitQcInput, type ConnectorCrossSection, type RunBridgeQcInput } from '@dqcad/cad-pipeline';
import type { FdiTooth, QcReport } from '@dqcad/shared-types';
import { JobCancelledError, type JobContext } from './context.ts';

/** One unit's serialized QC inputs (flat transferable buffers). */
export interface RunBridgeQcUnitPayload {
  label: string;
  kind: 'abutment' | 'pontic';
  /** The unit's INNER (fit) surface — for min-wall. */
  innerPositions: Float64Array;
  innerIndices: Uint32Array;
  /** The unit's OUTER (anatomy) surface — for min-wall. */
  outerPositions: Float64Array;
  outerIndices: Uint32Array;
  insertionAxis: Vec3;
  /** The unit's margin polyline (dense resampled), flat xyz. */
  marginLoopFlat: Float64Array;
  marginExclusionMm?: number;
  /** REQUIRED for an abutment (the marginFit gate extracts the intaglio patch off
   * the assembled solid with it); omitted for a pontic. */
  fitRegion?: FitRegionDescriptor;
}

/** One connector's serialized gate currency (the T4 measured min area). */
export interface RunBridgeQcConnectorPayload {
  label: string;
  minAreaMm2: number;
  teeth?: readonly [number, number];
  targetMm2?: number;
}

export interface RunBridgeQcPayload {
  /** The fused watertight bridge solid (assembly output). */
  assembledPositions: Float64Array;
  assembledIndices: Uint32Array;
  units: readonly RunBridgeQcUnitPayload[];
  /** The abutment prep dies (each watertight) — fused for the seating simulation. */
  dies: readonly { positions: Float64Array; indices: Uint32Array }[];
  connectors: readonly RunBridgeQcConnectorPayload[];

  minWallThicknessMm: number;
  occlusalMinWallThicknessMm: number;
  connectorAreaTargetMm2: number;
  frameworkMode?: boolean;
  frameworkMinThicknessMm?: number;

  ponticRelief: {
    maxAbsDeviationMm: number;
    style: string;
    configuredReliefMm: number;
    thresholdMm?: number;
  };

  marginFitThresholdMm?: number;
  seatingInterferenceVolumeToleranceMm3?: number;

  kernelVersion: string;
  profileVersion: string;
  journalHash: string;
  acknowledgedGates?: readonly string[];
}

export interface RunBridgeQcResult {
  report: QcReport;
}

function rebuildLoop(flat: Float64Array): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

function mesh(positions: Float64Array, indices: Uint32Array): IndexedMesh {
  return { positions, indices };
}

/**
 * `runBridgeQc` worker job — see this file's module doc. Progress spans the
 * manifold-3d measurements + one tick per gate (via `runBridgeQc`'s
 * `onProgress`); cancellation checked before and after the run.
 *
 * @throws {JobCancelledError} if cancelled.
 * @throws {BridgeQcInputError} (from `runBridgeQc`) for no units / no dies /
 * a missing abutment fitRegion.
 */
export const runBridgeQcJob = async (payload: RunBridgeQcPayload, ctx: JobContext): Promise<RunBridgeQcResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();

  const units: BridgeUnitQcInput[] = payload.units.map((u) => ({
    label: u.label,
    kind: u.kind,
    innerSurfaceMesh: mesh(u.innerPositions, u.innerIndices),
    outerSurfaceMesh: mesh(u.outerPositions, u.outerIndices),
    insertionAxis: u.insertionAxis,
    marginLoop: rebuildLoop(u.marginLoopFlat),
    marginExclusionMm: u.marginExclusionMm,
    fitRegion: u.fitRegion,
  }));
  const connectors: ConnectorCrossSection[] = payload.connectors.map((c) => ({
    label: c.label,
    minAreaMm2: c.minAreaMm2,
    teeth: c.teeth ? ([c.teeth[0] as FdiTooth, c.teeth[1] as FdiTooth] as const) : undefined,
    targetMm2: c.targetMm2,
  }));

  const input: RunBridgeQcInput = {
    assembledSolid: mesh(payload.assembledPositions, payload.assembledIndices),
    units,
    dieSolids: payload.dies.map((d) => mesh(d.positions, d.indices)),
    connectors,
    minWallThicknessMm: payload.minWallThicknessMm,
    occlusalMinWallThicknessMm: payload.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: payload.connectorAreaTargetMm2,
    frameworkMode: payload.frameworkMode,
    frameworkMinThicknessMm: payload.frameworkMinThicknessMm,
    ponticRelief: payload.ponticRelief,
    marginFitThresholdMm: payload.marginFitThresholdMm,
    seatingInterferenceVolumeToleranceMm3: payload.seatingInterferenceVolumeToleranceMm3,
    kernelVersion: payload.kernelVersion,
    profileVersion: payload.profileVersion,
    journalHash: payload.journalHash,
    acknowledgedGates: payload.acknowledgedGates,
  };

  const report = await runBridgeQc(input, (f) => ctx.progress(f));

  if (await ctx.cancelled()) throw new JobCancelledError();
  return { report };
};
