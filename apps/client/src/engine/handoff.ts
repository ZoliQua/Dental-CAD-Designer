// apps/client/src/engine/handoff.ts
//
// Phase 7 Task 7 — the SERVER-HANDOFF controller: the imperative seam the
// export panel (ui/ExportPanel.tsx) drives to (a) release a client-exported
// restoration through the server's independent re-validation
// (`POST /api/restorations/:id/export`) and (b) export/import a case archive
// (`POST /api/cases/:id/archive`, `POST /api/archives/import`). One shared
// controller for all three restoration workflows (the P5-T8 shared-core
// discipline; the pure client-side export gate + journaling already live in
// engine/exportFlow.ts, which this composes).
//
// ## Honesty, by construction (the 19b + invariant-6 disciplines)
//
//  - RELEASE is a two-step, both-visible flow: first the T3 client-side
//    journaled export (`exportFlowEngine.exportRestoration` — publishes the
//    gate-refusal ladder into state/exportStore.ts); only on a `done` client
//    export does the SERVER step run. The server independently re-imports the
//    exact bytes and re-runs every gate — a client/server divergence is a 409
//    the panel renders as WHAT diverged (the bug-report payload), NEVER a
//    retry-to-green affordance. Every terminal is a published snapshot
//    (`released` / `mismatch` / `error`), never a silent return.
//  - The server recomputes the journal hash over the SAVED case, so this
//    controller PERSISTS the case (journal incl. the export op + the
//    content-addressed final-mesh bytes for the outer-envelope certification)
//    BEFORE sending — the RestorationExportRequest sequencing contract.
//  - IMPORT never silently overwrites: a server 409 conflict surfaces as a
//    `conflict` snapshot the user must confirm (invariant 5), and the import
//    result names how many release rows arrived `importedUnverified` (the T6
//    trust boundary, made visible).
//
// Layer rule: engine → engine (exportFlow, the design engines, persistence),
// state, shared-types. Fetches the NEW export/archive routes directly (the
// persistence module owns only the /api/cases + /api/meshes routes).
import type { CaseDocument, ExportFormat, Restoration } from '@dqcad/shared-types';
import { caseStore } from './caseStore';
import { bridgeDesignEngine } from './bridgeDesign';
import { cavityDesignEngine } from './cavityDesign';
import { crownDesignEngine } from './crownDesign';
import type { ExportQcContext } from './exportContext';
import { ExportRequestUnavailableError, exportFlowEngine } from './exportFlow';
import { listCases, save } from './persistence';
import { useExportStore } from '../state/exportStore';
import {
  IDLE_ARCHIVE,
  useHandoffStore,
  type ArchiveSnapshot,
  type ReleaseFailure,
  type ReleaseSnapshot,
} from '../state/handoffStore';

const API_BASE = '/api';

/** Every local (pre-flight) release-failure code the controller can publish —
 * each maps 1:1 to an i18n key (the 19b lesson: every refusal is a visible,
 * localized state). Server error codes are rendered from the response's own
 * `message` under a generic localized heading. */
export const RELEASE_FAILURE_I18N_KEY: Record<string, string> = {
  'no-live-context':
    'exportServer.failNoLiveContext',
  'request-unavailable': 'exportServer.failRequestUnavailable',
  'no-restoration': 'exportServer.failNoRestoration',
  network: 'exportServer.failNetwork',
};

/** Resolves a restoration's RIDING QC context from its live design session —
 * the default dispatches to the matching design engine's `exportQcContext`
 * getter (null when no live session holds it, exactly like the export flow's
 * `finalMeshUnavailable`). Tests may inject a fake. */
export type QcContextSource = (restoration: Restoration) => ExportQcContext | null;

/** Sink for the archive-export bytes — the default triggers a browser
 * download; tests capture the bytes instead (no jsdom object-URL needed). */
export type ArchiveDownloadSink = (bytes: Uint8Array, filename: string) => void;

/** The persist step run before a server release — the default is the
 * persistence module's `save` (PUT the case with the export op + final-mesh
 * bytes); tests inject a no-op to avoid standing up the /api/cases route. */
export type PersistFn = () => Promise<void>;

function defaultDownloadSink(bytes: Uint8Array, filename: string): void {
  // Guarded: the object-URL machinery only exists in a real browser. In a
  // headless/test env with no `URL.createObjectURL`, this is a documented
  // no-op (tests inject a capturing sink; the browser lane exercises the real
  // path).
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

class HandoffController {
  private qcContextOverride: QcContextSource | null = null;
  private downloadSink: ArchiveDownloadSink = defaultDownloadSink;
  private persist: PersistFn = save;

  /** TEST-ONLY: override the riding-context source (null restores the default
   * design-engine dispatch). */
  __setQcContextSourceForTests(source: QcContextSource | null): void {
    this.qcContextOverride = source;
  }

  /** TEST-ONLY: capture the archive-export bytes instead of downloading. */
  __setDownloadSinkForTests(sink: ArchiveDownloadSink | null): void {
    this.downloadSink = sink ?? defaultDownloadSink;
  }

  /** TEST-ONLY: override the pre-release persist step. */
  __setPersistForTests(fn: PersistFn | null): void {
    this.persist = fn ?? save;
  }

  /** TEST-ONLY: full reset (seams + store). */
  resetForTests(): void {
    this.qcContextOverride = null;
    this.downloadSink = defaultDownloadSink;
    this.persist = save;
    useHandoffStore.getState().reset();
  }

  private qcContextFor(restoration: Restoration): ExportQcContext | null {
    if (this.qcContextOverride) return this.qcContextOverride(restoration);
    switch (restoration.type) {
      case 'crown':
        return crownDesignEngine.exportQcContext(restoration.id);
      case 'inlay':
      case 'onlay':
        return cavityDesignEngine.exportQcContext(restoration.id);
      case 'bridge':
        return bridgeDesignEngine.exportQcContext(restoration.id);
    }
  }

  private setRelease(restorationId: string, snapshot: ReleaseSnapshot): void {
    useHandoffStore.getState().applyRelease(restorationId, snapshot);
  }

  private failRelease(restorationId: string, failure: ReleaseFailure): void {
    this.setRelease(restorationId, { state: 'error', released: null, failure });
  }

  /**
   * The full handoff for one restoration: run the T3 client-side journaled
   * export first (its gate-refusal ladder is published into
   * state/exportStore.ts), and ONLY on a `done` client export proceed to the
   * server re-validation. A non-`done` client export leaves this a no-op on
   * the release store — the refusal is already visible in the export store, so
   * there is nothing dishonest about returning here (the panel renders both
   * stores).
   */
  async exportAndRelease(restorationId: string, format: ExportFormat): Promise<void> {
    await exportFlowEngine.exportRestoration(restorationId, { format });
    const clientStatus = useExportStore.getState().byRestoration[restorationId];
    if (!clientStatus || clientStatus.state !== 'done') {
      // The client export was refused/failed — visible in the export store;
      // clear any prior release snapshot so a stale `released` never lingers.
      this.setRelease(restorationId, { state: 'idle', released: null, failure: null });
      return;
    }
    await this.releaseToServer(restorationId);
  }

  /**
   * The SERVER step alone (assumes a fresh `done` client export is held):
   * persist → assemble `{ request, qcContext }` → POST → publish
   * `released` / `mismatch` / `error`. Separated so a retry of ONLY the server
   * step (after a transient network error) does not re-serialize the bytes.
   */
  async releaseToServer(restorationId: string): Promise<void> {
    this.setRelease(restorationId, { state: 'releasing', released: null, failure: null });
    try {
      // Persist FIRST: the server recomputes the journal hash over the SAVED
      // case and resolves the content-addressed final-mesh bytes for the
      // outer-envelope certification (the RestorationExportRequest sequencing
      // contract).
      await this.persist();

      const document = caseStore.getDocument();
      const restoration = document.restorations.find((r) => r.id === restorationId);
      if (!restoration) {
        this.failRelease(restorationId, this.localFailure('no-restoration', 'the restoration no longer exists'));
        return;
      }

      const qcContext = this.qcContextFor(restoration);
      if (!qcContext) {
        this.failRelease(
          restorationId,
          this.localFailure(
            'no-live-context',
            'the design session that produced this export is not loaded — open the design workflow and re-run QC before releasing',
          ),
        );
        return;
      }

      let request;
      try {
        request = await exportFlowEngine.buildExportRequest(restorationId);
      } catch (error) {
        if (error instanceof ExportRequestUnavailableError) {
          this.failRelease(restorationId, this.localFailure('request-unavailable', error.message));
          return;
        }
        throw error;
      }

      const response = await fetch(`${API_BASE}/restorations/${restorationId}/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, qcContext }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.ok && payload.released === true) {
        this.setRelease(restorationId, {
          state: 'released',
          released: {
            exportId: String(payload.exportId),
            format: String(payload.format),
            bytesSha256: String(payload.bytesSha256),
            reimportMeshHash: String(payload.reimportMeshHash),
            byteLength: Number(payload.byteLength),
            downloadPath: String(payload.downloadPath),
            traceabilityJsonPath: String(payload.traceabilityJsonPath),
            traceabilityHtmlPath: String(payload.traceabilityHtmlPath),
            releasedAt: String(payload.releasedAt),
            alreadyStored: payload.alreadyStored === true,
          },
          failure: null,
        });
        return;
      }

      // Any server-returned non-OK is the HONEST DIAGNOSTIC surface — render
      // WHAT diverged (code + message + the per-field diff / failing gates),
      // never a retry-to-green.
      this.setRelease(restorationId, {
        state: 'mismatch',
        released: null,
        failure: {
          code: typeof payload.error === 'string' ? payload.error : `http-${response.status}`,
          message: typeof payload.message === 'string' ? payload.message : `server returned HTTP ${response.status}`,
          httpStatus: response.status,
          diagnosticId: typeof payload.diagnosticId === 'string' ? payload.diagnosticId : null,
          differences: Array.isArray(payload.differences)
            ? (payload.differences as ReleaseFailure['differences'])
            : null,
          failingGates: Array.isArray(payload.failingGates) ? (payload.failingGates as string[]) : null,
        },
      });
    } catch (error) {
      this.failRelease(
        restorationId,
        this.localFailure('network', error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private localFailure(code: string, message: string): ReleaseFailure {
    return { code, message, httpStatus: null, diagnosticId: null, differences: null, failingGates: null };
  }

  // ---- case archive -----------------------------------------------------

  private setArchive(snapshot: ArchiveSnapshot): void {
    useHandoffStore.getState().applyArchive(snapshot);
  }

  /**
   * Streams the case's `.dqca` archive down (POST /api/cases/:id/archive).
   * The browser download IS the feedback; the store returns to `idle` on
   * success. A failure is a visible `error` snapshot.
   */
  async exportCaseArchive(caseId: string): Promise<void> {
    this.setArchive({ ...IDLE_ARCHIVE, state: 'exporting' });
    try {
      const response = await fetch(`${API_BASE}/cases/${caseId}/archive`, { method: 'POST' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        this.setArchive({
          ...IDLE_ARCHIVE,
          state: 'error',
          error:
            typeof payload.message === 'string' ? payload.message : `server returned HTTP ${response.status}`,
        });
        return;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      this.downloadSink(bytes, `case-${caseId}.dqca`);
      this.setArchive({ ...IDLE_ARCHIVE, state: 'idle' });
    } catch (error) {
      this.setArchive({
        ...IDLE_ARCHIVE,
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Imports an archive (POST /api/archives/import). A server 409 conflict
   * (the case id already exists) is published as a `conflict` snapshot the
   * user must resolve by re-calling with `overwrite: true` (invariant 5: no
   * silent mutation). On success the imported case is named + its counts
   * published (incl. the `importedUnverified` release rows) and the case list
   * refreshed.
   */
  async importCaseArchive(bytes: Uint8Array, opts: { overwrite: boolean }): Promise<void> {
    this.setArchive({ ...IDLE_ARCHIVE, state: 'importing' });
    try {
      const query = opts.overwrite ? '?overwrite=true' : '';
      const response = await fetch(`${API_BASE}/archives/import${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes as unknown as BodyInit,
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.status === 409 && payload.error === 'archive-import-conflict') {
        this.setArchive({
          ...IDLE_ARCHIVE,
          state: 'conflict',
          conflictCaseId: typeof payload.caseId === 'string' ? payload.caseId : null,
        });
        return;
      }
      if (!response.ok || payload.imported !== true) {
        this.setArchive({
          ...IDLE_ARCHIVE,
          state: 'error',
          error:
            typeof payload.message === 'string' ? payload.message : `server returned HTTP ${response.status}`,
        });
        return;
      }

      const counts = payload.counts as ArchiveSnapshot['counts'];
      this.setArchive({
        ...IDLE_ARCHIVE,
        state: 'imported',
        importedCaseId: typeof payload.caseId === 'string' ? payload.caseId : null,
        overwritten: payload.overwritten === true,
        counts: counts ?? null,
      });
      // Refresh the case picker so the newly imported case is selectable.
      await listCases().catch(() => {
        /* the import succeeded regardless; a list-refresh failure is non-fatal */
      });
    } catch (error) {
      this.setArchive({
        ...IDLE_ARCHIVE,
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Dismisses the current archive snapshot back to idle (the panel's
   * "dismiss" affordance after an import result / error). */
  clearArchive(): void {
    this.setArchive({ ...IDLE_ARCHIVE });
  }
}

/** The single shared handoff controller (mirrors the export/design engine
 * singletons). */
export const handoffController = new HandoffController();

/** Re-export so the panel subscribes without importing the state module
 * twice (the design engines' re-export convention). */
export { useHandoffStore };

/** The document type is re-exported for the panel's typed selectors. */
export type { CaseDocument };
