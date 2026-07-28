// apps/client/src/engine/bridgeWorkflow.ts
//
// Phase 6 Task 7 — the BRIDGE (multi-unit) design workflow STATE MACHINE, as a
// PURE, side-effect-free module (no worker, no Three.js, no store, no case
// mutation). The bridge analogue of engine/cavityWorkflow.ts, built on the SAME
// shared core (engine/restorationWorkflow.ts): it answers, from a `Restoration`
// snapshot, "which bridge pipeline stage may run next, and why is a stage
// blocked?" engine/bridgeDesign.ts (the imperative controller) is the SOLE
// consumer — it consults these gates before dispatching a bridge worker job.
//
// The fixed stage order (docs/plans/phase-6-bridge.md Task 7) is:
//   margins → abutmentSurfaces → pontic → connectors → framework → assembly → qc
// where `margins` is the confirmed per-abutment margin lines + the shared
// insertion axis (a Phase-3 activity, the external prerequisite — like the crown's
// margin loop / the cavity's outline), NOT a worker stage. Each MILESTONE stage
// records a content hash in `Restoration.stages`, the single source of truth this
// module reads for "has stage N completed?".
//
// The downstream-invalidation cascade + the stale-QC guard come from the shared
// core, DERIVED from the ordered milestone-field list (the P4 Critical lesson,
// generalized: an upstream re-run can never leave a downstream stage's hash — or
// the QcReport — pointing at geometry that no longer exists).
import type { FdiTooth, Restoration, Vec3 } from '@dqcad/shared-types';
import { linearDownstreamFields, isRestorationQcStale, type StageGateBase } from './restorationWorkflow';

/** The seven bridge-design stages, in fixed pipeline order. `margins` is the
 * external prerequisite (confirmed per-abutment margins + shared axis), `qc`
 * writes `Restoration.qc`; the five between write `Restoration.stages` hashes. */
export type BridgeStage =
  | 'margins'
  | 'abutmentSurfaces'
  | 'pontic'
  | 'connectors'
  | 'framework'
  | 'assembly'
  | 'qc';

/** The full ordered stage list (all present — framework mode is a required,
 * always-journaled design decision, default full-contour). */
export const BRIDGE_STAGES: readonly BridgeStage[] = [
  'margins',
  'abutmentSurfaces',
  'pontic',
  'connectors',
  'framework',
  'assembly',
  'qc',
] as const;

/** The `Restoration.stages` hash field each MILESTONE bridge stage writes on
 * success (`margins` writes no hash — it is the external margin set; `qc` writes
 * `Restoration.qc`). `finalMesh` is the assembled bridge solid (shared field). */
export const BRIDGE_STAGE_HASH_FIELD = {
  abutmentSurfaces: 'bridgeAbutmentSurfaces',
  pontic: 'bridgePontic',
  connectors: 'bridgeConnectors',
  framework: 'bridgeFramework',
  assembly: 'finalMesh',
} as const satisfies Partial<Record<BridgeStage, keyof Restoration['stages']>>;

/** The ordered milestone hash-fields (pipeline order), for the invalidation
 * cascade. */
const ORDERED_MILESTONE_FIELDS: ReadonlyArray<keyof Restoration['stages']> = [
  'bridgeAbutmentSurfaces',
  'bridgePontic',
  'bridgeConnectors',
  'bridgeFramework',
  'finalMesh',
] as const;

/** Why a bridge stage cannot run yet. `no*` codes are external prerequisites (a
 * target scan + confirmed per-abutment margins); `*Incomplete` codes are earlier
 * bridge stages that have not produced their output. */
export type BridgePrerequisiteCode =
  | 'noTargetScan'
  | 'noAbutmentMargins'
  | 'abutmentSurfacesIncomplete'
  | 'ponticIncomplete'
  | 'connectorsIncomplete'
  | 'frameworkIncomplete'
  | 'assemblyIncomplete';

/** One bridge stage's runnability verdict against a `Restoration` snapshot. */
export type BridgeStageGate = StageGateBase<BridgeStage, BridgePrerequisiteCode>;

/** Minimum resampled points for an abutment margin loop the abutment-surface job
 * can consume (a closed loop needs at least a triangle's worth). */
const MIN_MARGIN_LOOP_POINTS = 3;

/** The abutment teeth on `restoration` — every tooth in `teeth` NOT listed as a
 * pontic (see `Restoration.pontics`). */
export function bridgeAbutmentTeeth(restoration: Restoration): FdiTooth[] {
  const pontics = new Set(restoration.pontics);
  return restoration.teeth.filter((t) => !pontics.has(t));
}

/** Whether EVERY abutment carries a confirmed margin loop dense enough to drive
 * the abutment fit-surface stage. A bridge with any abutment lacking its margin
 * cannot proceed (the shared insertion axis is assessed across ALL abutment prep
 * regions). Returns `false` for a bridge with zero abutments. */
export function hasAbutmentMargins(restoration: Restoration): boolean {
  const abutments = bridgeAbutmentTeeth(restoration);
  if (abutments.length === 0) return false;
  return abutments.every((tooth) => {
    const line = restoration.marginLines[tooth];
    if (!line) return false;
    const resampled = line.resampledPoints;
    if (resampled && resampled.length >= MIN_MARGIN_LOOP_POINTS) return true;
    return line.anchors.length >= MIN_MARGIN_LOOP_POINTS;
  });
}

/** The confirmed margin loop points for one abutment tooth (resampled, else raw
 * anchors), or `null` when absent/too sparse. */
export function abutmentMarginPoints(restoration: Restoration, tooth: FdiTooth): readonly Vec3[] | null {
  const line = restoration.marginLines[tooth];
  if (!line) return null;
  const resampled = line.resampledPoints;
  if (resampled && resampled.length >= MIN_MARGIN_LOOP_POINTS) return resampled;
  if (line.anchors.length >= MIN_MARGIN_LOOP_POINTS) return line.anchors.map((a) => a.position);
  return null;
}

/** Whether a stage has produced its output. For milestone stages this reads the
 * matching `stages` hash; `margins` reads the presence of confirmed abutment
 * margins; `qc` reads `Restoration.qc`. */
export function isBridgeStageComplete(stage: BridgeStage, restoration: Restoration): boolean {
  switch (stage) {
    case 'margins':
      return hasAbutmentMargins(restoration);
    case 'abutmentSurfaces':
      return restoration.stages.bridgeAbutmentSurfaces !== undefined;
    case 'pontic':
      return restoration.stages.bridgePontic !== undefined;
    case 'connectors':
      return restoration.stages.bridgeConnectors !== undefined;
    case 'framework':
      return restoration.stages.bridgeFramework !== undefined;
    case 'assembly':
      return restoration.stages.finalMesh !== undefined;
    case 'qc':
      return restoration.qc !== null;
  }
}

/** The FIRST unmet prerequisite for `stage`, in the order the pipeline needs
 * them, or `null` if the stage may run.
 *
 * Note on the insertion axis (same policy as crown/cavity): a placeholder-vs-
 * confirmed axis is detectable (engine/restorations.ts `insertionAxisIsPlaceholder`),
 * but it is deliberately NOT a hard gate here — the fresh-restoration placeholder
 * `[0,0,1]` is a structurally valid shared-insertion direction the whole bridge
 * pipeline CAN run against; running against an UNCONFIRMED shared axis is surfaced
 * as a non-blocking WARNING in the UI, never a block. Only the two structurally
 * required external prerequisites (a target scan + confirmed abutment margins)
 * hard-gate the pipeline. */
function firstUnmetPrerequisite(stage: BridgeStage, restoration: Restoration): BridgePrerequisiteCode | null {
  switch (stage) {
    case 'margins':
      return restoration.targetNodeId === null ? 'noTargetScan' : null;
    case 'abutmentSurfaces':
      if (restoration.targetNodeId === null) return 'noTargetScan';
      if (!hasAbutmentMargins(restoration)) return 'noAbutmentMargins';
      return null;
    case 'pontic':
      return isBridgeStageComplete('abutmentSurfaces', restoration) ? null : 'abutmentSurfacesIncomplete';
    case 'connectors':
      return isBridgeStageComplete('pontic', restoration) ? null : 'ponticIncomplete';
    case 'framework':
      return isBridgeStageComplete('connectors', restoration) ? null : 'connectorsIncomplete';
    case 'assembly':
      return isBridgeStageComplete('framework', restoration) ? null : 'frameworkIncomplete';
    case 'qc':
      return isBridgeStageComplete('assembly', restoration) ? null : 'assemblyIncomplete';
  }
}

/** The runnability verdict for a single bridge stage. */
export function bridgeStageGate(stage: BridgeStage, restoration: Restoration): BridgeStageGate {
  const complete = isBridgeStageComplete(stage, restoration);
  const reason = firstUnmetPrerequisite(stage, restoration);
  return { stage, allowed: reason === null, complete, reason };
}

/** Whether `stage`'s worker job may be dispatched against `restoration` now. */
export function canRunBridgeStage(stage: BridgeStage, restoration: Restoration): boolean {
  return firstUnmetPrerequisite(stage, restoration) === null;
}

/** All gates for the bridge stage list, in fixed order — the whole state-machine
 * snapshot the UI renders (one sub-panel per gate). */
export function bridgeWorkflowGates(restoration: Restoration): BridgeStageGate[] {
  return BRIDGE_STAGES.map((stage) => bridgeStageGate(stage, restoration));
}

/**
 * The downstream outputs that committing `stage` INVALIDATES — DERIVED from the
 * ordered milestone-field list (the shared core's `linearDownstreamFields`), so
 * any upstream re-run clears every later stage hash AND the `QcReport`. A stale
 * "PASSED" report can never keep displaying for geometry that no longer exists
 * (the P4 Critical lesson, bridge edition).
 *
 * - `margins` (an abutment margin changed) → EVERY milestone field + qc
 * - `abutmentSurfaces` → pontic, connectors, framework, finalMesh + qc
 * - `pontic`           → connectors, framework, finalMesh + qc
 * - `connectors`       → framework, finalMesh + qc
 * - `framework`        → finalMesh + qc
 * - `assembly`         → qc (it writes finalMesh itself)
 * - `qc`               → nothing downstream
 */
export function bridgeDownstreamInvalidations(
  stage: BridgeStage,
): { stageFields: Array<keyof Restoration['stages']>; clearQc: boolean } {
  if (stage === 'qc') return { stageFields: [], clearQc: false };
  // `margins` is not a milestone field — a null committed-field clears everything.
  const committedField = stage === 'margins' ? null : BRIDGE_STAGE_HASH_FIELD[stage];
  return { stageFields: linearDownstreamFields(ORDERED_MILESTONE_FIELDS, committedField), clearQc: true };
}

/** Whether a stored `QcReport` still corresponds to the CURRENT assembled bridge
 * solid — re-exported shared guard (see restorationWorkflow.ts). */
export function isBridgeQcStale(restoration: Restoration): boolean {
  return isRestorationQcStale(restoration);
}

/** The first stage that is runnable AND not yet complete — the "do this next"
 * the panel highlights. Scans the stage list in fixed order; `null` when the
 * pipeline is finished (assembly + qc done) or fully blocked. */
export function nextRunnableBridgeStage(restoration: Restoration): BridgeStage | null {
  for (const stage of BRIDGE_STAGES) {
    if (canRunBridgeStage(stage, restoration) && !isBridgeStageComplete(stage, restoration)) {
      return stage;
    }
  }
  return null;
}
