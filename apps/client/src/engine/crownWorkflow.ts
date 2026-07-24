// apps/client/src/engine/crownWorkflow.ts
//
// Phase 4 Task 10 — the crown-design workflow STATE MACHINE, as a PURE,
// side-effect-free module (no worker, no Three.js, no store, no case
// mutation). It answers exactly one question, deterministically, from a
// `Restoration` snapshot: "which pipeline stage may run next, and why is a
// stage blocked?" `engine/crownDesign.ts` (the imperative controller) is the
// SOLE consumer — it consults these gates before dispatching a worker job,
// so the order enforcement lives here, unit-testable on the node lane
// without spinning up a WorkerPool (mirrors engine/marginEditor.ts's split of
// "pure gesture logic" from the worker-driven parts — this task's
// "order-enforcing state machine (pure, testable node-lane logic)"
// guardrail).
//
// The fixed stage order (PLAN.md §4 Phase 4) is:
//   innerSurface -> anatomy -> morph -> shell -> { freeform*, qc }
// where `freeform` is optional and repeatable once the shell exists, and
// `qc` may run any time the shell exists. A stage may never run before its
// prerequisite has produced its output — that output is recorded as a
// content hash in `Restoration.stages` (shared-types), which is the single
// source of truth this module reads for "has stage N completed?".
import type { FdiTooth, Restoration, Vec3 } from '@dqcad/shared-types';

/** The six crown-design stages, in fixed pipeline order. */
export type CrownStage = 'innerSurface' | 'anatomy' | 'morph' | 'shell' | 'freeform' | 'qc';

/** Fixed stage order — `CrownDesignPanel` renders its sub-panels in exactly
 * this sequence, and `nextRunnableStage` scans it left-to-right. */
export const CROWN_STAGES: readonly CrownStage[] = [
  'innerSurface',
  'anatomy',
  'morph',
  'shell',
  'freeform',
  'qc',
] as const;

/** The `Restoration.stages` hash field each MILESTONE stage writes on
 * success (freeform re-writes `finalMesh`; qc writes `Restoration.qc`, not a
 * stage-hash field — both handled explicitly in the controller, not here). */
export const CROWN_STAGE_HASH_FIELD = {
  innerSurface: 'innerSurface',
  anatomy: 'anatomyPlacement',
  morph: 'morphState',
  shell: 'finalMesh',
} as const satisfies Partial<Record<CrownStage, keyof Restoration['stages']>>;

/** Why a stage cannot run yet. `no*` codes are external prerequisites from
 * Phase 3 (a target scan + a confirmed margin line); `*Incomplete` codes are
 * earlier crown stages that have not produced their output. */
export type CrownPrerequisiteCode =
  | 'noTargetScan'
  | 'noMarginLine'
  | 'innerSurfaceIncomplete'
  | 'anatomyIncomplete'
  | 'morphIncomplete'
  | 'shellIncomplete';

/** One stage's runnability verdict against a `Restoration` snapshot. */
export interface StageGate {
  stage: CrownStage;
  /** May this stage's worker job be dispatched right now? */
  allowed: boolean;
  /** Has this stage already produced its output (its `stages` hash, or `qc`)?
   * Always `false` for `freeform` — it is an editing stage that re-writes the
   * shell's `finalMesh` rather than a one-shot milestone with its own hash. */
  complete: boolean;
  /** The FIRST unmet prerequisite when `allowed` is `false`, else `null`. */
  reason: CrownPrerequisiteCode | null;
}

/** Minimum resampled points for a margin loop the inner-surface job can
 * consume (a closed loop needs at least a triangle's worth). Mirrors the
 * `innerSurface` job's own `marginLoop` `>= 9 coords` (3 points) contract. */
const MIN_MARGIN_LOOP_POINTS = 3;

/** The first tooth on `restoration` carrying a margin loop dense enough to
 * drive the inner-surface stage (a committed, resampled finish line — see
 * `MarginLine.resampledPoints`), or `null` if none does. The controller uses
 * this to pick which tooth's margin feeds the pipeline for a single-unit
 * crown; the workflow uses it purely to answer "is there a usable margin?".
 *
 * Falls back to the raw `anchors` when `resampledPoints` is absent but the
 * anchor ring is itself dense enough (>= 3) — an anchor-only margin is still
 * a real, journaled finish line; only an empty/degenerate one blocks. */
export function firstMarginLoop(
  restoration: Restoration,
): { tooth: FdiTooth; points: readonly Vec3[] } | null {
  const entries = Object.entries(restoration.marginLines) as Array<
    [string, Restoration['marginLines'][FdiTooth]]
  >;
  for (const [toothKey, line] of entries) {
    if (!line) continue;
    const resampled = line.resampledPoints;
    if (resampled && resampled.length >= MIN_MARGIN_LOOP_POINTS) {
      return { tooth: Number(toothKey) as FdiTooth, points: resampled };
    }
    if (line.anchors.length >= MIN_MARGIN_LOOP_POINTS) {
      return { tooth: Number(toothKey) as FdiTooth, points: line.anchors.map((a) => a.position) };
    }
  }
  return null;
}

/** Whether a stage has produced its output. For milestone stages this reads
 * the matching `stages` hash; for `qc` it reads `Restoration.qc`. `freeform`
 * is never "complete" (see `StageGate.complete`). */
export function isStageComplete(stage: CrownStage, restoration: Restoration): boolean {
  switch (stage) {
    case 'innerSurface':
      return restoration.stages.innerSurface !== undefined;
    case 'anatomy':
      return restoration.stages.anatomyPlacement !== undefined;
    case 'morph':
      return restoration.stages.morphState !== undefined;
    case 'shell':
      return restoration.stages.finalMesh !== undefined;
    case 'freeform':
      return false;
    case 'qc':
      return restoration.qc !== null;
  }
}

/** The runnability verdict for a single stage — the pure heart of the order
 * enforcement. Reasons are reported for the FIRST unmet prerequisite, in the
 * order the pipeline itself would need them.
 *
 * Note on the insertion axis: it is NOT gated here. A `Restoration` ALWAYS
 * carries a structurally valid `insertionAxis` (the fresh-restoration
 * placeholder `[0, 0, 1]` is a documented default, not a detectable "missing"
 * sentinel — see engine/restorations.ts's `PLACEHOLDER_INSERTION_AXIS` doc),
 * so there is no honest "axis missing" state to block on; the inner-surface
 * job consumes whatever axis is set. Only the two structurally detectable
 * external prerequisites (a target scan + a real margin loop) gate stage 1. */
export function stageGate(stage: CrownStage, restoration: Restoration): StageGate {
  const complete = isStageComplete(stage, restoration);
  const reason = firstUnmetPrerequisite(stage, restoration);
  return { stage, allowed: reason === null, complete, reason };
}

function firstUnmetPrerequisite(
  stage: CrownStage,
  restoration: Restoration,
): CrownPrerequisiteCode | null {
  switch (stage) {
    case 'innerSurface':
      if (restoration.targetNodeId === null) return 'noTargetScan';
      if (firstMarginLoop(restoration) === null) return 'noMarginLine';
      return null;
    case 'anatomy':
      return isStageComplete('innerSurface', restoration) ? null : 'innerSurfaceIncomplete';
    case 'morph':
      return isStageComplete('anatomy', restoration) ? null : 'anatomyIncomplete';
    case 'shell':
      return isStageComplete('morph', restoration) ? null : 'morphIncomplete';
    case 'freeform':
      return isStageComplete('shell', restoration) ? null : 'shellIncomplete';
    case 'qc':
      return isStageComplete('shell', restoration) ? null : 'shellIncomplete';
  }
}

/** Whether `stage`'s worker job may be dispatched against `restoration` now. */
export function canRunStage(stage: CrownStage, restoration: Restoration): boolean {
  return firstUnmetPrerequisite(stage, restoration) === null;
}

/** All six gates, in fixed stage order — the whole state-machine snapshot the
 * UI renders (one sub-panel per gate, each enabled/blocked per `allowed`). */
export function workflowGates(restoration: Restoration): StageGate[] {
  return CROWN_STAGES.map((stage) => stageGate(stage, restoration));
}

/** The first stage that is runnable AND not yet complete — the "do this next"
 * the panel highlights. Scans in fixed order; `freeform` (never "complete")
 * is skipped in favour of `qc` so the suggestion advances to QC rather than
 * parking on the optional sculpt step. `null` when the pipeline is finished
 * (shell + qc done) or fully blocked. */
export function nextRunnableStage(restoration: Restoration): CrownStage | null {
  for (const stage of CROWN_STAGES) {
    if (stage === 'freeform') continue;
    if (canRunStage(stage, restoration) && !isStageComplete(stage, restoration)) {
      return stage;
    }
  }
  return null;
}
