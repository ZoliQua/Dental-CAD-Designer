// apps/client/src/engine/exportWorkflow.ts
//
// Phase 7 Task 3 — the PURE export gate, shared by ALL THREE restoration
// workflows (crown / inlay-onlay / bridge): "may this restoration's final
// solid leave the system as manufacturing bytes right now?", answered
// deterministically from a `Restoration` snapshot + the case journal alone.
// The P5-T8 shared-core discipline (engine/restorationWorkflow.ts): the
// enforcement ladder and the export-staleness rule have exactly ONE
// implementation here — the imperative controller (engine/exportFlow.ts)
// consults these functions before dispatching the export worker job, and
// the type-specific workflows contribute nothing but their `Restoration`
// snapshot (the gate table itself is already uniform in `Restoration.qc`).
//
// CLAUDE.md invariant 4, enforced at the export action:
//  - no final solid / no QC report / stale QC report → REFUSED with an
//    actionable, i18n-keyed reason;
//  - hard-failing UNACKNOWLEDGED gates → REFUSED with the failing-gate list;
//  - acknowledged-with-warning → ALLOWED, and the acknowledgments (gate ids
//    + messages + journal refs) ride into the export record — journaled,
//    never silently bypassed.
//
// Pure, side-effect-free (no worker, no store) — node-lane testable like
// restorationWorkflow.ts. Layer rule: engine may import shared-types here.
import type { ExportAcknowledgment, Operation, Restoration } from '@dqcad/shared-types';
import { isRestorationQcStale } from './restorationWorkflow';

/** Why an export is refused. Kept in sync with state/exportStore.ts's
 * mirror union (the established "duplicate the trivial shape at the layer
 * boundary" convention). `finalMeshUnavailable` is produced by the
 * CONTROLLER (the document says a final mesh exists but no live session
 * holds its buffers — e.g. right after a reload), never by
 * `exportGateVerdict`, which only sees the document. */
export type ExportRefusalCode =
  | 'noFinalMesh'
  | 'qcMissing'
  | 'qcStale'
  | 'gatesFailing'
  | 'finalMeshUnavailable';

/** The i18n key each refusal code renders as — every refusal is a VISIBLE,
 * localized state (the 19b lesson; keys exist in all 4 locales, asserted by
 * exportWorkflow.test.ts). */
export const EXPORT_REFUSAL_I18N_KEY: Record<ExportRefusalCode, string> = {
  noFinalMesh: 'export.refusedNoFinalMesh',
  qcMissing: 'export.refusedQcMissing',
  qcStale: 'export.refusedQcStale',
  gatesFailing: 'export.refusedGatesFailing',
  finalMeshUnavailable: 'export.refusedFinalMeshUnavailable',
};

export type ExportGateVerdict =
  | {
      allowed: true;
      /** `Restoration.stages.finalMesh` — the content hash the export must
       * serialize (the controller verifies its live buffers against it). */
      finalMeshHash: string;
      /** Every acknowledged-with-warning gate, with journal refs — rides
       * into the export `Operation` and the Task 4 request. */
      acknowledgments: readonly ExportAcknowledgment[];
    }
  | {
      allowed: false;
      refusalCode: Exclude<ExportRefusalCode, 'finalMeshUnavailable'>;
      /** Non-empty iff `refusalCode === 'gatesFailing'`: the failing
       * UNACKNOWLEDGED gate ids, in report order. */
      failingGates: readonly string[];
    };

/** An ack journal op: `crown-qc-ack` / `inlay-qc-ack` / `bridge-qc-ack` —
 * matched by suffix so the shared core needs no per-type table. */
function isAckOpFor(operation: Operation, restorationId: string, gate: string): boolean {
  if (!operation.name.endsWith('-qc-ack')) return false;
  if (operation.params.restorationId !== restorationId) return false;
  if (operation.params.acknowledgedGate === gate) return true;
  const list = operation.params.acknowledgedGates;
  return Array.isArray(list) && list.includes(gate);
}

/**
 * The acknowledged-with-warning gates of `restoration.qc`, each tied to the
 * LAST journal `Operation` that recorded its acknowledgment (the op that
 * produced the CURRENT report state — an older ack of a since-re-run report
 * still matches by gate id, which is correct: the acknowledgment decision
 * is per-gate, and the newest op for that gate is the one in force).
 * `operationId: null` is defensive only (a journal that never recorded the
 * ack — e.g. hand-edited/truncated document); it is carried, flagged, never
 * hidden — see `ExportAcknowledgment.operationId`'s doc (shared-types).
 */
export function collectAcknowledgments(
  restoration: Restoration,
  history: readonly Operation[],
): ExportAcknowledgment[] {
  const qc = restoration.qc;
  if (qc === null) return [];
  const acknowledgments: ExportAcknowledgment[] = [];
  for (const gateResult of qc.gates) {
    if (!gateResult.acknowledged) continue;
    let operationId: string | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (isAckOpFor(history[i]!, restoration.id, gateResult.gate)) {
        operationId = history[i]!.id;
        break;
      }
    }
    acknowledgments.push({
      gate: gateResult.gate,
      message: gateResult.message,
      value: gateResult.value,
      threshold: gateResult.threshold,
      unit: gateResult.unit,
      operationId,
    });
  }
  return acknowledgments;
}

/**
 * The export gate — the refusal ladder, in order of actionability:
 * 1. `noFinalMesh`: no final restoration solid exists (build it first);
 * 2. `qcMissing`: QC never ran for the current design;
 * 3. `qcStale`: the design changed after the last QC run
 *    (`isRestorationQcStale` — the shared `qc.journalHash` vs
 *    `stages.finalMesh` guard);
 * 4. `gatesFailing`: hard-failing gates the user has NOT acknowledged;
 * 5. otherwise ALLOWED, with every acknowledged gate riding along.
 * Deterministic, pure — same snapshot in, same verdict out.
 */
export function exportGateVerdict(
  restoration: Restoration,
  history: readonly Operation[],
): ExportGateVerdict {
  const finalMeshHash = restoration.stages.finalMesh;
  if (finalMeshHash === undefined) {
    return { allowed: false, refusalCode: 'noFinalMesh', failingGates: [] };
  }
  if (restoration.qc === null) {
    return { allowed: false, refusalCode: 'qcMissing', failingGates: [] };
  }
  if (isRestorationQcStale(restoration)) {
    return { allowed: false, refusalCode: 'qcStale', failingGates: [] };
  }
  const failingGates = restoration.qc.gates
    .filter((g) => !g.passed && !g.acknowledged)
    .map((g) => g.gate);
  if (failingGates.length > 0) {
    return { allowed: false, refusalCode: 'gatesFailing', failingGates };
  }
  return {
    allowed: true,
    finalMeshHash,
    acknowledgments: collectAcknowledgments(restoration, history),
  };
}

/**
 * Whether a completed export no longer corresponds to the restoration's
 * CURRENT state — the P5-T8 invalidation-cascade discipline extended to
 * exports: a design edit after an export (which moves/clears
 * `stages.finalMesh` and nulls `qc` via the per-workflow cascades) marks
 * the export stale, as does any QC change that would no longer authorize
 * it. Derived from hashes, never hand-maintained.
 */
export function isExportRecordStale(
  restoration: Restoration | undefined,
  record: { finalMeshHash: string },
): boolean {
  if (!restoration) return true;
  if (restoration.stages.finalMesh !== record.finalMeshHash) return true;
  if (restoration.qc === null) return true;
  return isRestorationQcStale(restoration);
}
