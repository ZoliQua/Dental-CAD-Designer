// apps/client/src/engine/cavityWorkflow.ts
//
// Phase 5 Task 8 — the inlay/onlay (cavity) design workflow STATE MACHINE, as a
// PURE, side-effect-free module (no worker, no Three.js, no store, no case
// mutation). The cavity analogue of engine/crownWorkflow.ts: it answers, from a
// `Restoration` snapshot, "which cavity pipeline stage may run next, and why is a
// stage blocked?" engine/cavityDesign.ts (the imperative controller) is the SOLE
// consumer — it consults these gates before dispatching a cavity worker job.
//
// The fixed stage order (docs/plans/phase-5-inlay-onlay.md Task 8) is:
//   outline → fit → patch → contacts → [cuspCoverage] → shell → qc
// where `cuspCoverage` is ONLY present for an ONLAY (an inlay covers no cusp), and
// `outline` is the confirmed cavity-outline margin line (a Phase-3 activity, the
// external prerequisite — like the crown's margin loop), not a worker stage. Each
// MILESTONE stage records a content hash in `Restoration.stages`, the single
// source of truth this module reads for "has stage N completed?".
//
// This module is restoration-type-AWARE (the shared-vs-forked choice documented
// in engine/restorationWorkflow.ts): the stage list, prerequisites, and the
// downstream-invalidation cascade all fold in whether the restoration is an inlay
// or an onlay. The reusable cascade + stale-QC guard come from the shared core.
import type { FdiTooth, Restoration, RestorationType, Vec3 } from '@dqcad/shared-types';
import { linearDownstreamFields, isRestorationQcStale, type StageGateBase } from './restorationWorkflow';

/** The seven cavity-design stages, in fixed pipeline order (`cuspCoverage` is
 * onlay-only — see `cavityStages`). */
export type CavityStage = 'outline' | 'fit' | 'patch' | 'contacts' | 'cuspCoverage' | 'shell' | 'qc';

/** The full ordered stage list. `cavityStages(type)` filters `cuspCoverage` out
 * for an inlay. */
const ALL_CAVITY_STAGES: readonly CavityStage[] = [
  'outline',
  'fit',
  'patch',
  'contacts',
  'cuspCoverage',
  'shell',
  'qc',
] as const;

/** The stage list for a restoration type — `cuspCoverage` is present ONLY for an
 * onlay (an inlay has no covered cusp). Order is otherwise fixed. */
export function cavityStages(type: RestorationType): readonly CavityStage[] {
  if (type === 'onlay') return ALL_CAVITY_STAGES;
  return ALL_CAVITY_STAGES.filter((s) => s !== 'cuspCoverage');
}

/** The `Restoration.stages` hash field each MILESTONE cavity stage writes on
 * success (`outline` writes no hash — it is the external margin; `qc` writes
 * `Restoration.qc`). `finalMesh` is shared with the crown shell. */
export const CAVITY_STAGE_HASH_FIELD = {
  fit: 'fitSurface',
  patch: 'occlusalPatch',
  contacts: 'proximalContacts',
  cuspCoverage: 'cuspCoverage',
  shell: 'finalMesh',
} as const satisfies Partial<Record<CavityStage, keyof Restoration['stages']>>;

/** The ordered milestone hash-fields (pipeline order), for the invalidation
 * cascade. `cuspCoverage` is included only for an onlay. */
function orderedMilestoneFields(type: RestorationType): Array<keyof Restoration['stages']> {
  const fields: Array<keyof Restoration['stages']> = ['fitSurface', 'occlusalPatch', 'proximalContacts'];
  if (type === 'onlay') fields.push('cuspCoverage');
  fields.push('finalMesh');
  return fields;
}

/** Why a cavity stage cannot run yet. `no*` codes are external prerequisites (a
 * target scan + a confirmed cavity outline); `*Incomplete` codes are earlier
 * cavity stages that have not produced their output. */
export type CavityPrerequisiteCode =
  | 'noTargetScan'
  | 'noCavityOutline'
  | 'fitIncomplete'
  | 'patchIncomplete'
  | 'contactsIncomplete'
  | 'cuspCoverageIncomplete'
  | 'shellIncomplete';

/** One cavity stage's runnability verdict against a `Restoration` snapshot. */
export type CavityStageGate = StageGateBase<CavityStage, CavityPrerequisiteCode>;

/** Minimum resampled points for a cavity outline the fit-surface job can consume
 * (a closed loop needs at least a triangle's worth). Mirrors the crown
 * workflow's `MIN_MARGIN_LOOP_POINTS`. */
const MIN_OUTLINE_POINTS = 3;

/** The first tooth on `restoration` carrying a cavity-outline loop dense enough
 * to drive the fit-surface stage (a committed, resampled outline — see
 * `MarginLine.resampledPoints`), or `null` if none does. The cavity outline IS a
 * `MarginLine` traced on the cavity margin (the "preparációs határvonal" of the
 * cavity), so the same machinery the crown uses applies. Falls back to raw
 * `anchors` when `resampledPoints` is absent but the anchor ring is dense enough. */
export function firstCavityOutline(
  restoration: Restoration,
): { tooth: FdiTooth; points: readonly Vec3[] } | null {
  const entries = Object.entries(restoration.marginLines) as Array<
    [string, Restoration['marginLines'][FdiTooth]]
  >;
  for (const [toothKey, line] of entries) {
    if (!line) continue;
    const resampled = line.resampledPoints;
    if (resampled && resampled.length >= MIN_OUTLINE_POINTS) {
      return { tooth: Number(toothKey) as FdiTooth, points: resampled };
    }
    if (line.anchors.length >= MIN_OUTLINE_POINTS) {
      return { tooth: Number(toothKey) as FdiTooth, points: line.anchors.map((a) => a.position) };
    }
  }
  return null;
}

/** Whether a stage has produced its output. For milestone stages this reads the
 * matching `stages` hash; `outline` reads the presence of a cavity outline; `qc`
 * reads `Restoration.qc`. */
export function isCavityStageComplete(stage: CavityStage, restoration: Restoration): boolean {
  switch (stage) {
    case 'outline':
      return firstCavityOutline(restoration) !== null;
    case 'fit':
      return restoration.stages.fitSurface !== undefined;
    case 'patch':
      return restoration.stages.occlusalPatch !== undefined;
    case 'contacts':
      return restoration.stages.proximalContacts !== undefined;
    case 'cuspCoverage':
      return restoration.stages.cuspCoverage !== undefined;
    case 'shell':
      return restoration.stages.finalMesh !== undefined;
    case 'qc':
      return restoration.qc !== null;
  }
}

/** The FIRST unmet prerequisite for `stage`, in the order the pipeline needs
 * them, or `null` if the stage may run.
 *
 * Note on the insertion axis (same policy as the crown): a placeholder-vs-
 * confirmed axis is detectable (engine/restorations.ts `insertionAxisIsPlaceholder`),
 * but it is deliberately NOT a hard gate here — the fresh-restoration placeholder
 * `[0,0,1]` is a structurally valid straight-insertion direction the whole cavity
 * pipeline CAN run against; running against an UNCONFIRMED axis is surfaced as a
 * non-blocking WARNING in the UI (ui/CavityDesignPanel.tsx), never a block. Only
 * the two structurally required external prerequisites (a target scan + a real
 * cavity outline) hard-gate stage 1. */
function firstUnmetPrerequisite(stage: CavityStage, restoration: Restoration): CavityPrerequisiteCode | null {
  const onlay = restoration.type === 'onlay';
  switch (stage) {
    case 'outline':
      return restoration.targetNodeId === null ? 'noTargetScan' : null;
    case 'fit':
      if (restoration.targetNodeId === null) return 'noTargetScan';
      if (firstCavityOutline(restoration) === null) return 'noCavityOutline';
      return null;
    case 'patch':
      return isCavityStageComplete('fit', restoration) ? null : 'fitIncomplete';
    case 'contacts':
      return isCavityStageComplete('patch', restoration) ? null : 'patchIncomplete';
    case 'cuspCoverage':
      return isCavityStageComplete('contacts', restoration) ? null : 'contactsIncomplete';
    case 'shell':
      if (onlay && !isCavityStageComplete('cuspCoverage', restoration)) return 'cuspCoverageIncomplete';
      if (!isCavityStageComplete('contacts', restoration)) return 'contactsIncomplete';
      return null;
    case 'qc':
      return isCavityStageComplete('shell', restoration) ? null : 'shellIncomplete';
  }
}

/** The runnability verdict for a single cavity stage. */
export function cavityStageGate(stage: CavityStage, restoration: Restoration): CavityStageGate {
  const complete = isCavityStageComplete(stage, restoration);
  const reason = firstUnmetPrerequisite(stage, restoration);
  return { stage, allowed: reason === null, complete, reason };
}

/** Whether `stage`'s worker job may be dispatched against `restoration` now. */
export function canRunCavityStage(stage: CavityStage, restoration: Restoration): boolean {
  return firstUnmetPrerequisite(stage, restoration) === null;
}

/** All gates for the restoration's stage list, in fixed order — the whole
 * state-machine snapshot the UI renders (one sub-panel per gate). */
export function cavityWorkflowGates(restoration: Restoration): CavityStageGate[] {
  return cavityStages(restoration.type).map((stage) => cavityStageGate(stage, restoration));
}

/**
 * The downstream outputs that committing `stage` INVALIDATES — DERIVED from the
 * restoration-type-aware ordered milestone-field list (the shared core's
 * `linearDownstreamFields`), so any upstream re-run clears every later stage
 * hash AND the `QcReport`. A stale "PASSED" report can never keep displaying for
 * geometry that no longer exists (the P4 Critical lesson, cavity edition).
 *
 * - `outline` (the cavity margin changed) → EVERY milestone field + qc
 * - `fit`     → patch, contacts, [cuspCoverage], finalMesh + qc
 * - `patch`   → contacts, [cuspCoverage], finalMesh + qc
 * - `contacts`→ [cuspCoverage], finalMesh + qc
 * - `cuspCoverage` → finalMesh + qc
 * - `shell`   → qc (it writes finalMesh itself)
 * - `qc`      → nothing downstream
 */
export function cavityDownstreamInvalidations(
  stage: CavityStage,
  type: RestorationType,
): { stageFields: Array<keyof Restoration['stages']>; clearQc: boolean } {
  if (stage === 'qc') return { stageFields: [], clearQc: false };
  const ordered = orderedMilestoneFields(type);
  // `outline` is not a milestone field — a null committed-field clears everything.
  const committedField = stage === 'outline' ? null : CAVITY_STAGE_HASH_FIELD[stage];
  return { stageFields: linearDownstreamFields(ordered, committedField), clearQc: true };
}

/** Whether a stored `QcReport` still corresponds to the CURRENT inlay/onlay shell
 * geometry — re-exported shared guard (see restorationWorkflow.ts). */
export function isCavityQcStale(restoration: Restoration): boolean {
  return isRestorationQcStale(restoration);
}

/** The first stage that is runnable AND not yet complete — the "do this next"
 * the panel highlights. Scans the type-aware stage list in fixed order; `null`
 * when the pipeline is finished (shell + qc done) or fully blocked. */
export function nextRunnableCavityStage(restoration: Restoration): CavityStage | null {
  for (const stage of cavityStages(restoration.type)) {
    if (canRunCavityStage(stage, restoration) && !isCavityStageComplete(stage, restoration)) {
      return stage;
    }
  }
  return null;
}
