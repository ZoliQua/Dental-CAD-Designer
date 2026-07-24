// apps/client/src/engine/restorations.ts
//
// Phase 3 Task 2's restoration CRUD orchestration — the "engine builds the
// value + journal Operation, caseStore.ts commits + journals it" split used
// throughout engine/ (see engine/repair.ts's `applyRepairPreview` and
// engine/caseDocumentMigration.ts's migration Operation for the same
// pattern). No kernel-worker job is involved here (unlike repair.ts): a
// restoration's initial creation is pure case-document bookkeeping — no
// geometry is read or computed yet (margin lines/axis are Task 4+), so
// `inputHashes`/`outputHashes` are correctly empty on every Operation this
// module journals, exactly like caseDocumentMigration.ts's structural-only
// `migrate-schema-v1-to-v2` Operation.
import { KERNEL_VERSION } from '@dqcad/kernel-workers';
import { DEFAULT_RESTORATION_PARAMS } from '@dqcad/clinical-profiles';
import type {
  FdiTooth,
  MeshRole,
  Operation,
  Restoration,
  RestorationParams,
  RestorationType,
} from '@dqcad/shared-types';
import { caseStore } from './caseStore';

/** `MeshRole`s a restoration's target scan may be assigned to (docs/plans/
 * phase-3-margin-axis.md Task 2: "assign the target scan (SceneNode with
 * role prepDie/upperJaw/lowerJaw)") — the roles that can plausibly carry a
 * margin line. `antagonist`/`situ`/`gingiva` are reference-only scans, never
 * a restoration's own target. Exported so `ui/RestorationWizard.tsx` filters
 * its target-scan `<select>` by this list without duplicating it. */
export const PREP_CAPABLE_ROLES: readonly MeshRole[] = ['prepDie', 'upperJaw', 'lowerJaw'];

/** Placeholder `insertionAxis` for a freshly created restoration — a real
 * axis is only ever computed by Phase 3 Task 9's insertion-axis tool
 * (`axis-set` Operation); until then this is an arbitrary-but-valid "up"
 * direction, documented as unresolved (mirrors
 * caseDocumentMigration.ts's `UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX`
 * sentinel pattern, except `Vec3` has no natural "invalid" sentinel value —
 * every finite Vec3 is a structurally valid axis, so this is a documented
 * DEFAULT rather than a detectable sentinel). Every consumer of
 * `insertionAxis` before Task 9 runs is expected to treat it as "not yet
 * meaningful", exactly like a fresh restoration's empty `marginLines`. */
export const PLACEHOLDER_INSERTION_AXIS: readonly [number, number, number] = [0, 0, 1];

export interface CreateRestorationInput {
  type: RestorationType;
  teeth: readonly FdiTooth[];
  /** Bridge-only — see `Restoration.pontics`' doc (shared-types). Ignored
   * (forced to `[]`) for non-bridge types — see `normalizePontics`. */
  pontics?: readonly FdiTooth[];
  targetNodeId: string | null;
  /** Defaults to `DEFAULT_RESTORATION_PARAMS` (clinical-profiles) when
   * omitted — Phase 3 has no per-restoration material-profile picker yet
   * (Phase 4). */
  params?: RestorationParams;
}

export type UpdateRestorationInput = Partial<CreateRestorationInput>;

/** Bridge-only field: for any other `type`, pontics are meaningless (a
 * crown/inlay/onlay has no pontic concept) — always `[]`. For a bridge,
 * defensively restricts `pontics` to the subset that's actually IN `teeth`
 * (a pontic not in `teeth` would be nonsensical) and de-duplicates. */
function normalizePontics(
  type: RestorationType,
  teeth: readonly FdiTooth[],
  pontics: readonly FdiTooth[],
): readonly FdiTooth[] {
  if (type !== 'bridge') {
    return [];
  }
  const teethSet = new Set(teeth);
  return Array.from(new Set(pontics)).filter((tooth) => teethSet.has(tooth));
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Creates a new `Restoration`, journals a `restoration-create` Operation
 * (params: a full snapshot — type/teeth/pontics/targetNodeId/params — per
 * this task's brief: "params snapshot in op"), and selects it (a freshly
 * created restoration becomes the wizard/sidebar's active one — see
 * `caseStore.setSelectedRestorationId`'s doc).
 */
export function createRestoration(input: CreateRestorationInput): Restoration {
  const pontics = normalizePontics(input.type, input.teeth, input.pontics ?? []);
  const params = input.params ?? DEFAULT_RESTORATION_PARAMS;
  const restoration: Restoration = {
    id: crypto.randomUUID(),
    type: input.type,
    teeth: input.teeth,
    pontics,
    targetNodeId: input.targetNodeId,
    marginLines: {},
    insertionAxis: PLACEHOLDER_INSERTION_AXIS,
    params,
    stages: {},
    qc: null,
  };
  const operation: Operation = {
    id: crypto.randomUUID(),
    name: 'restoration-create',
    params: {
      restorationId: restoration.id,
      type: restoration.type,
      teeth: restoration.teeth,
      pontics: restoration.pontics,
      targetNodeId: restoration.targetNodeId,
      params,
    },
    inputHashes: [],
    outputHashes: [],
    kernelVersion: KERNEL_VERSION,
    timestamp: nowIso(),
  };
  const created = caseStore.addRestoration(restoration, operation);
  caseStore.setSelectedRestorationId(created.id);
  return created;
}

/**
 * Updates an existing restoration's wizard-editable fields (type/teeth/
 * pontics/targetNodeId/params — never `marginLines`/`insertionAxis`/
 * `stages`/`qc`, which are owned by later tasks' own journaled ops), and
 * journals a `restoration-update` Operation with the new snapshot.
 * @throws {Error} if `id` doesn't name an existing restoration.
 */
export function updateRestoration(id: string, patch: UpdateRestorationInput): Restoration {
  const current = caseStore.getDocument().restorations.find((restoration) => restoration.id === id);
  if (!current) {
    throw new Error(`updateRestoration: no restoration registered for id ${id}`);
  }
  const type = patch.type ?? current.type;
  const teeth = patch.teeth ?? current.teeth;
  const pontics = normalizePontics(type, teeth, patch.pontics ?? current.pontics);
  const targetNodeId = patch.targetNodeId !== undefined ? patch.targetNodeId : current.targetNodeId;
  const params = patch.params ?? current.params;

  const next: Restoration = { ...current, type, teeth, pontics, targetNodeId, params };
  const operation: Operation = {
    id: crypto.randomUUID(),
    name: 'restoration-update',
    params: {
      restorationId: id,
      type,
      teeth,
      pontics,
      targetNodeId,
      params,
    },
    inputHashes: [],
    outputHashes: [],
    kernelVersion: KERNEL_VERSION,
    timestamp: nowIso(),
  };
  return caseStore.updateRestoration(next, operation);
}

/**
 * Deletes a restoration, journaling a `restoration-delete` Operation that
 * records what was deleted (type/teeth — an audit trail reader shouldn't
 * need to replay history backwards to know what a delete removed, same
 * rationale as engine/repair.ts's `paramsFor` capturing headline result
 * counts alongside the request). A no-op (still journals) if `id` is
 * already gone — mirrors `caseStore.removeRestoration`'s tolerant style.
 *
 * Task-11-review Critical 2 (journal completeness, CLAUDE.md invariant 5
 * "no silent data mutation" — a destructive delete is the sharpest case of
 * this): a restoration's `marginLines` (hand-traced, Phase 3 Task 4/5 —
 * curvature-ridge walk + per-anchor drag corrections) and `insertionAxis`
 * (Phase 3 Task 9 — coarse->fine undercut search, or a manual slider
 * session) are NOT reproducible from anything else in the case document —
 * deleting the restoration destroyed them permanently, but the OLD
 * `restoration-delete` op only ever recorded `type`/`teeth`, leaving no
 * trace of what was actually lost. Both are snapshotted into `params` here
 * (display-only bookkeeping for audit/support — this op still does not
 * RESTORE anything on replay, same as before) so a journal reader can see
 * exactly what a delete removed. `ui/RestorationWizard.tsx`'s
 * `handleDelete` gates this call behind an explicit confirm dialog whenever
 * either is present/non-placeholder (same Critical 2 fix).
 */
export function deleteRestoration(id: string): void {
  const current = caseStore.getDocument().restorations.find((restoration) => restoration.id === id);
  const operation: Operation = {
    id: crypto.randomUUID(),
    name: 'restoration-delete',
    params: {
      restorationId: id,
      type: current?.type ?? null,
      teeth: current?.teeth ?? [],
      marginLines: current?.marginLines ?? {},
      insertionAxis: current?.insertionAxis ?? PLACEHOLDER_INSERTION_AXIS,
    },
    inputHashes: [],
    outputHashes: [],
    kernelVersion: KERNEL_VERSION,
    timestamp: nowIso(),
  };
  caseStore.removeRestoration(id, operation);
}

/** Whether `restoration` carries any work Task-11-review Critical 2 requires
 * an explicit confirm for before deleting: a hand-traced margin line on any
 * tooth, or an `insertionAxis` that has moved off the fresh-restoration
 * placeholder (`PLACEHOLDER_INSERTION_AXIS`) — i.e. a real suggest/manual-
 * adjust session has run (`axis-set`, engine/axis.ts's `confirmAxis`).
 * Exported so `ui/RestorationWizard.tsx` can decide whether to show the
 * delete-confirm dialog without duplicating this rule. */
export function restorationHasIrreplaceableWork(restoration: Restoration): boolean {
  const hasMarginLines = Object.keys(restoration.marginLines).length > 0;
  return hasMarginLines || !insertionAxisIsPlaceholder(restoration);
}

/** Whether `restoration.insertionAxis` is still the fresh-restoration
 * placeholder (`PLACEHOLDER_INSERTION_AXIS`) — i.e. the Phase-3 insertion-axis
 * workflow (`axis-set`) has NOT confirmed a real axis. The inverse of
 * `restorationHasIrreplaceableWork`'s axis check, exported so
 * `ui/CrownDesignPanel.tsx` can warn (non-blocking) that a crown is being
 * designed against the arbitrary default insertion direction — insertion
 * axis/undercuts are core clinical params (CLAUDE.md). */
export function insertionAxisIsPlaceholder(restoration: Restoration): boolean {
  return restoration.insertionAxis.every((component, i) => component === PLACEHOLDER_INSERTION_AXIS[i]);
}
