// apps/client/src/engine/exportFlow.ts
//
// Phase 7 Task 3 — the EXPORT CONTROLLER: the imperative, engine-layer
// orchestrator of "final restoration solid → journaled manufacturing bytes
// → typed server request". One shared controller for all three workflows
// (crown / inlay-onlay / bridge — the P5-T8 shared-core discipline; the
// pure gate lives in engine/exportWorkflow.ts).
//
// What an export IS here (CLAUDE.md invariants 2/3/4):
//  1. GATE-ENFORCED at the action: the pure `exportGateVerdict` refusal
//     ladder runs first — no final solid / missing QC / stale QC /
//     hard-failing unacknowledged gates each publish a VISIBLE, i18n-keyed
//     `refused` snapshot (state/exportStore.ts). The 19b lesson is law: NO
//     pre-try synchronous validation that can silently no-op — every path
//     through `exportRestoration` ends in a published snapshot (`refused`,
//     `done`, or `error`), and the error path also rethrows.
//  2. SERIALIZED IN THE WORKER: the `exportRestorationMesh` job (kernel-
//     workers jobs/export.ts) composes the Task 2 io export layer and
//     hashes the exact bytes worker-side — the UI thread never serializes
//     or hashes a multi-MB solid. Private buffer COPIES ride the transfer
//     list; the live session masters are never detached.
//  3. JOURNALED as one `restoration-export` Operation: params carry every
//     byte-determining input (restoration type, teeth, format, the exact
//     headerText) plus the acknowledgment refs; `inputHashes[0]` is the
//     final mesh content hash, `outputHashes[0]` is the BYTES SHA-256.
//     Replaying the op (same mesh + same params + same kernel version)
//     reproduces the exact bytes — proven at the job layer
//     (exportJob.test.ts) and in the golden journal-replay harness
//     (scripts/journal-replay-lib.ts's export fixture).
//  4. STALE-AFTER-EDIT (and -AFTER-DEAUTHORIZATION): a completed export's
//     status is DERIVED (`isExportRecordStale`) on every case-document
//     publish — a design edit after an export, or a QC re-run that resets
//     the acknowledgment that authorized it, flips the snapshot to `stale`,
//     exactly like the per-workflow QC invalidation cascades (P5-T8).
//
// `buildExportRequest` is the thin, tested assembly seam for Task 4's
// endpoint (the actual HTTP send lands with T4/T7 wiring): it packages the
// held bytes (base64 — see `RestorationExportRequest`'s transport-decision
// doc in shared-types), the CURRENT QC report + acknowledgments, the case
// journal hash (kernel-workers' `hashCaseJournal`, computed over the FULL
// journal INCLUDING the export op itself), the material profile identity,
// and the kernel version.
//
// Layer rule: engine → kernel-workers / state / shared-types /
// clinical-profiles only.
import {
  hashCaseJournal,
  KERNEL_VERSION,
} from '@dqcad/kernel-workers';
import {
  EMAX_LITHIUM_DISILICATE_PROFILE,
  STANDARD_ZIRCONIA_PROFILE,
} from '@dqcad/clinical-profiles';
import type {
  CaseDocument,
  ExportAcknowledgment,
  ExportFormat,
  Operation,
  Restoration,
  RestorationExportRequest,
} from '@dqcad/shared-types';
import { caseStore } from './caseStore';
import { bridgeDesignEngine } from './bridgeDesign';
import { cavityDesignEngine } from './cavityDesign';
import { crownDesignEngine } from './crownDesign';
import type { RunnablePool } from './crownDesign';
import {
  exportGateVerdict,
  isExportRecordStale,
  type ExportRefusalCode,
} from './exportWorkflow';
import { getPool } from './workers';
import { useCaseStore } from '../state/caseStore';
import {
  IDLE_EXPORT_STATUS,
  useExportStore,
  type ExportStatusSnapshot,
} from '../state/exportStore';

/** The final restoration solid's live Float64 buffers + content hash. */
export interface FinalMeshBuffers {
  positions: Float64Array;
  indices: Uint32Array;
  contentHash: string;
}

/** Resolves the LIVE final-mesh buffers for a restoration (null when no
 * design session holds them) — the default implementation consults the
 * three design engines; tests may inject a fake via
 * `__setFinalMeshSourceForTests`. */
export type FinalMeshSource = (restoration: Restoration) => FinalMeshBuffers | null;

/** Thrown by `buildExportRequest` when there is no FRESH completed export
 * to assemble a server request from (nothing exported yet, or the design
 * changed since — re-export first). */
export class ExportRequestUnavailableError extends Error {
  readonly restorationId: string;
  constructor(restorationId: string, detail: string) {
    super(`exportFlow: no fresh export available for restoration ${restorationId} — ${detail}`);
    this.name = 'ExportRequestUnavailableError';
    this.restorationId = restorationId;
  }
}

/** Everything retained engine-side about the last completed export of a
 * restoration (the bytes stay OUT of the zustand snapshot — multi-MB
 * buffers don't belong in UI state; the store carries the hash). */
interface HeldExport {
  bytes: Uint8Array;
  bytesSha256: string;
  /** Worker-encoded base64 of `bytes` (P7-T3 review F3: the encode of a
   * multi-MB export must not run on the UI thread) — passed through
   * verbatim by `buildExportRequest`. */
  bytesBase64: string;
  byteLength: number;
  format: ExportFormat;
  headerText?: string;
  finalMeshHash: string;
  exportOperationId: string;
}

/** The known material profiles the client can name in an export request —
 * resolved by `CaseSettings.materialProfileId`, falling back to the
 * standard-zirconia profile: the design engines source every QC threshold
 * from `STANDARD_ZIRCONIA_PROFILE` until the live material picker lands
 * (tracked, NOT this phase — docs/plans/phase-7-export.md carry-ins), so
 * that profile is the honest identity of the parameters actually used. */
const KNOWN_PROFILES = [STANDARD_ZIRCONIA_PROFILE, EMAX_LITHIUM_DISILICATE_PROFILE] as const;

// Exported (Phase 7 Task 5) so the traceability PREVIEW builds its document
// with the SAME profile-identity resolution the export request ships — one
// rule, no drift (engine/traceabilityPreview.ts).
export function resolveMaterialProfile(document: CaseDocument): {
  id: string;
  version: string;
  checksum: string;
} {
  const byId = KNOWN_PROFILES.find((p) => p.id === document.settings.materialProfileId);
  const profile = byId ?? STANDARD_ZIRCONIA_PROFILE;
  return { id: profile.id, version: profile.version, checksum: profile.checksum };
}

/**
 * The deterministic STL header text — a pure function of JOURNALED params
 * only (restoration type + FDI teeth; the mm marker is part of the fixed
 * prefix). Recorded verbatim on the export op so a replay reproduces the
 * exact bytes. Bounded well under the 80-byte STL header field even for a
 * full-arch bridge (fixed prefix 25 chars + type ≤ 6 + 16 teeth × 3 = 79)
 * and never starts with 'solid' (both enforced again by the io layer's
 * `assertExportableStlHeaderText`).
 */
export function exportStlHeaderText(restoration: Restoration): string {
  return `DQ-Dental-CAD; units=mm; ${restoration.type} ${restoration.teeth.join(' ')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

class ExportFlowEngine {
  private testPool: RunnablePool | null = null;
  private testFinalMeshSource: FinalMeshSource | null = null;
  private held = new Map<string, HeldExport>();

  private pool(): RunnablePool {
    return this.testPool ?? getPool();
  }

  /** TEST-ONLY: inject a fake pool (mirrors the design engines' seam). */
  __setPoolForTests(pool: RunnablePool | null): void {
    this.testPool = pool;
  }

  /** TEST-ONLY: override the final-mesh source (null restores the default
   * design-engine-backed source). */
  __setFinalMeshSourceForTests(source: FinalMeshSource | null): void {
    this.testFinalMeshSource = source;
  }

  /** TEST-ONLY: full reset (held exports + seams + store). */
  resetForTests(): void {
    this.testPool = null;
    this.testFinalMeshSource = null;
    this.held.clear();
    useExportStore.getState().reset();
  }

  /** The DEFAULT final-mesh source: the live design session of the matching
   * workflow (crown shell / cavity shell / assembled bridge). */
  private finalMeshSource(restoration: Restoration): FinalMeshBuffers | null {
    if (this.testFinalMeshSource) return this.testFinalMeshSource(restoration);
    switch (restoration.type) {
      case 'crown':
        return crownDesignEngine.finalMeshForExport(restoration.id);
      case 'inlay':
      case 'onlay':
        return cavityDesignEngine.finalMeshForExport(restoration.id);
      case 'bridge':
        return bridgeDesignEngine.finalMeshForExport(restoration.id);
    }
  }

  private setStatus(restorationId: string, snapshot: ExportStatusSnapshot): void {
    useExportStore.getState().apply(restorationId, snapshot);
  }

  private patchStatus(restorationId: string, partial: Partial<ExportStatusSnapshot>): void {
    const current =
      useExportStore.getState().byRestoration[restorationId] ?? IDLE_EXPORT_STATUS;
    this.setStatus(restorationId, { ...current, ...partial });
  }

  private refuse(restorationId: string, refusalCode: ExportRefusalCode, failingGates: readonly string[]): void {
    this.setStatus(restorationId, {
      ...IDLE_EXPORT_STATUS,
      state: 'refused',
      refusalCode,
      failingGates,
    });
  }

  /**
   * The export action: gate → worker serialization → journal → snapshot.
   * Refusals are published `refused` snapshots (visible, i18n-keyed —
   * `EXPORT_REFUSAL_I18N_KEY`), not exceptions; genuine failures (a worker
   * reject, a vanished restoration) publish `error` AND rethrow. Every
   * validation lives INSIDE the try (the 19b discipline) so no path can
   * escape without a published state.
   */
  async exportRestoration(restorationId: string, opts: { format: ExportFormat }): Promise<void> {
    this.patchStatus(restorationId, {
      state: 'exporting',
      format: opts.format,
      refusalCode: null,
      failingGates: [],
      progress: 0,
      error: null,
    });
    try {
      const document = caseStore.getDocument();
      const restoration = document.restorations.find((r) => r.id === restorationId);
      if (!restoration) {
        throw new Error(`exportFlow: no restoration ${restorationId}`);
      }

      const verdict = exportGateVerdict(restoration, document.history);
      if (!verdict.allowed) {
        this.refuse(restorationId, verdict.refusalCode, verdict.failingGates);
        return;
      }

      const live = this.finalMeshSource(restoration);
      if (!live || live.contentHash !== verdict.finalMeshHash) {
        // The document names a final mesh but no live session holds ITS
        // buffers (post-reload, or a session/document drift) — exporting
        // anything else would ship bytes the QC report never certified.
        this.refuse(restorationId, 'finalMeshUnavailable', []);
        return;
      }

      const headerText = opts.format === 'stl' ? exportStlHeaderText(restoration) : undefined;
      const positionsCopy = live.positions.slice();
      const indicesCopy = live.indices.slice();
      const result = await this.pool().run(
        'exportRestorationMesh',
        {
          positions: positionsCopy,
          indices: indicesCopy,
          format: opts.format,
          ...(headerText === undefined ? {} : { headerText }),
        },
        {
          transfer: [positionsCopy.buffer, indicesCopy.buffer],
          onProgress: (f) => this.patchStatus(restorationId, { progress: f }),
        },
      );

      const acknowledgedGates = verdict.acknowledgments.map((a) => a.gate);
      const ackOperationIds = verdict.acknowledgments.map((a) => a.operationId);
      const operation: Operation = {
        id: crypto.randomUUID(),
        name: 'restoration-export',
        params: {
          restorationId,
          restorationType: restoration.type,
          teeth: [...restoration.teeth],
          format: opts.format,
          ...(headerText === undefined ? {} : { headerText }),
          byteLength: result.byteLength,
          acknowledgedGates,
          ackOperationIds,
        },
        inputHashes: [verdict.finalMeshHash],
        outputHashes: [result.bytesSha256],
        kernelVersion: KERNEL_VERSION,
        timestamp: nowIso(),
      };
      caseStore.appendOperation(operation);

      this.held.set(restorationId, {
        bytes: result.bytes,
        bytesSha256: result.bytesSha256,
        bytesBase64: result.bytesBase64,
        byteLength: result.byteLength,
        format: opts.format,
        ...(headerText === undefined ? {} : { headerText }),
        finalMeshHash: verdict.finalMeshHash,
        exportOperationId: operation.id,
      });
      this.setStatus(restorationId, {
        state: 'done',
        format: opts.format,
        refusalCode: null,
        failingGates: [],
        bytesSha256: result.bytesSha256,
        byteLength: result.byteLength,
        progress: 1,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.patchStatus(restorationId, { state: 'error', error: message, progress: 0 });
      throw error;
    }
  }

  /**
   * Assembles the Task 4 `RestorationExportRequest` from the last completed
   * export — the tested seam the T4/T7 wiring will hand to
   * `POST /api/restorations/:id/export`. Requires a FRESH export
   * (`isExportRecordStale` false); the QC report + acknowledgments are read
   * from the CURRENT document (consistent pair — a same-mesh re-ack after
   * the export legitimately updates both), and `caseJournalHash` covers the
   * FULL current journal, export op included.
   * @throws {ExportRequestUnavailableError} when nothing fresh is held.
   */
  async buildExportRequest(restorationId: string): Promise<RestorationExportRequest> {
    const held = this.held.get(restorationId);
    if (!held) {
      throw new ExportRequestUnavailableError(restorationId, 'nothing has been exported yet');
    }
    const document = caseStore.getDocument();
    const restoration = document.restorations.find((r) => r.id === restorationId);
    if (!restoration) {
      throw new ExportRequestUnavailableError(restorationId, 'the restoration no longer exists');
    }
    // The verdict must AUTHORIZE the request, not just harvest acks (P7-T3
    // review F1): assembling a request the current report does not authorize
    // — e.g. a plain QC re-run reset the acknowledgment that allowed the
    // export — would falsify the shared-types contract T4 builds on.
    // Checked FIRST (the more specific diagnostic); the record-vs-document
    // staleness check below then covers the remaining case (design moved on
    // to a NEW mesh whose fresh QC passes — the verdict allows, but not for
    // THESE bytes).
    const verdict = exportGateVerdict(restoration, document.history);
    if (!verdict.allowed) {
      throw new ExportRequestUnavailableError(
        restorationId,
        `the current QC report no longer authorizes this export (${verdict.refusalCode}${
          verdict.failingGates.length > 0 ? `: ${verdict.failingGates.join(', ')}` : ''
        }) — resolve or re-acknowledge, then re-export`,
      );
    }
    if (isExportRecordStale(restoration, held) || restoration.qc === null) {
      throw new ExportRequestUnavailableError(
        restorationId,
        'the design or its QC report changed after this export (stale) — re-run the export first',
      );
    }
    const acknowledgments: readonly ExportAcknowledgment[] = verdict.acknowledgments;
    return {
      schemaVersion: 1,
      caseId: document.id,
      restorationId,
      restorationType: restoration.type,
      teeth: [...restoration.teeth],
      format: held.format,
      ...(held.headerText === undefined ? {} : { headerText: held.headerText }),
      meshContentHash: held.finalMeshHash,
      exportOperationId: held.exportOperationId,
      bytesBase64: held.bytesBase64,
      bytesSha256: held.bytesSha256,
      byteLength: held.byteLength,
      qcReport: restoration.qc,
      acknowledgments,
      caseJournalHash: await hashCaseJournal(document.history),
      journalOperationCount: document.history.length,
      materialProfile: resolveMaterialProfile(document),
      kernelVersion: KERNEL_VERSION,
    };
  }

  /**
   * Re-derives every held export's freshness from the CURRENT document —
   * called on every case-document publish (the zustand subscription below).
   * Purely hash-derived (`isExportRecordStale`): `done` flips to `stale`
   * when the design moves out from under the export, and back to `done` if
   * the exact exported state returns (deterministic, no event flags).
   */
  onDocumentChange(document: CaseDocument): void {
    for (const [restorationId, held] of this.held) {
      const restoration = document.restorations.find((r) => r.id === restorationId);
      const stale = isExportRecordStale(restoration, held);
      const current = useExportStore.getState().byRestoration[restorationId];
      if (!current) continue;
      if (stale && current.state === 'done') {
        this.setStatus(restorationId, { ...current, state: 'stale' });
      } else if (!stale && current.state === 'stale') {
        this.setStatus(restorationId, { ...current, state: 'done' });
      }
    }
  }
}

/** The single shared export controller for the whole client (mirrors the
 * design engines' singleton pattern). */
export const exportFlowEngine = new ExportFlowEngine();

// The stale-after-edit cascade: every case-document publish re-derives the
// held exports' freshness. Subscribed once at module scope (the engine is a
// module singleton; zustand's subscribe works identically on the node test
// lane and in the browser).
useCaseStore.subscribe((state) => {
  exportFlowEngine.onDocumentChange(state.document);
});

/** Re-export so the panel (Task 7) can subscribe without importing the
 * state module twice (mirrors the design engines' re-export style). */
export { useExportStore };
