// apps/client/src/ui/ExportPanel.tsx
//
// Phase 7 Task 7 — the export & manufacturing-handoff panel. Pure React/DOM
// shell (the same thin-renderer discipline as the three design panels): it
// reads state/caseStore.ts (the committed restorations + QC reports),
// state/exportStore.ts (the T3 client-side export status) and
// state/handoffStore.ts (the server release + archive status), and calls back
// into `handoffController` — ZERO geometry math, ZERO gate logic re-derived
// here. The export verdict is the shared pure `exportGateVerdict`
// (engine/exportWorkflow.ts) — rendered, never re-implemented — and every
// refusal/failure is a VISIBLE, i18n'd state (the 19b discipline; no silent
// no-op, no "retry until it passes" affordance).
//
// SYNTHETIC-DATA DISCLOSURE (ADR-014): the QC results recapped here originate
// from the demonstration design fixtures (Phases 4-6 are fixture-driven until
// real capture), so an UN-MISSABLE disclosure banner rides over the workflow.
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportFormat, QcGateResult, Restoration } from '@dqcad/shared-types';
import { exportGateVerdict } from '../engine/exportWorkflow';
import { EXPORT_REFUSAL_I18N_KEY } from '../engine/exportWorkflow';
import { handoffController } from '../engine/handoff';
import { RELEASE_FAILURE_I18N_KEY } from '../engine/handoff';
import { useCaseStore } from '../state/caseStore';
import { selectExportStatus, useExportStore } from '../state/exportStore';
import { selectRelease, useHandoffStore } from '../state/handoffStore';

const TRACEABILITY_LOCALES = new Set(['en', 'hu', 'de', 'es']);

function fire(action: () => Promise<void>): void {
  void action().catch(() => {
    /* every terminal is a published store snapshot; nothing to swallow here */
  });
}

export function ExportPanel() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const [selectedId, setSelectedId] = useState('');

  const restorations = document.restorations;
  const selected = restorations.find((r) => r.id === selectedId) ?? null;

  return (
    <section className="export-panel" data-testid="export-panel">
      <h2 className="export-panel__title">{t('exportServer.panelTitle')}</h2>

      <div className="export-panel__disclosure" role="note" data-testid="export-disclosure">
        {t('exportServer.disclosure')}
      </div>

      {restorations.length === 0 ? (
        <p className="export-panel__empty" data-testid="export-empty">
          {t('exportServer.needsRestoration')}
        </p>
      ) : (
        <label className="export-panel__field">
          {t('exportServer.restorationLabel')}
          <select
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            data-testid="export-restoration-select"
          >
            <option value="">{t('exportServer.selectPlaceholder')}</option>
            {restorations.map((r) => (
              <option key={r.id} value={r.id}>
                {t(`restoration.type.${r.type}`)} ({r.teeth.join(', ')})
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && <ExportWorkflow restoration={selected} />}

      <ArchiveSection caseId={document.id} />
    </section>
  );
}

function ExportWorkflow({ restoration }: { restoration: Restoration }) {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const clientStatus = useExportStore((state) => selectExportStatus(state, restoration.id));
  const release = useHandoffStore((state) => selectRelease(state, restoration.id));
  const [format, setFormat] = useState<ExportFormat>('stl');

  // The AUTHORITATIVE export verdict — the shared pure function, rendered (the
  // UI never re-derives the refusal ladder). Drives the recap + button enable.
  const verdict = exportGateVerdict(restoration, document.history);
  const qc = restoration.qc;

  const busy = clientStatus.state === 'exporting' || release.state === 'releasing';

  return (
    <div className="export-workflow" data-testid="export-workflow">
      <h3 className="export-workflow__subtitle">{t('exportServer.qcRecapTitle')}</h3>
      {qc === null ? (
        <p className="export-workflow__note" data-testid="export-qc-noreport">
          {t('exportServer.qcNoReport')}
        </p>
      ) : (
        <>
          {!verdict.allowed && verdict.refusalCode === 'qcStale' && (
            <p className="export-workflow__stale" data-testid="export-qc-stale">
              {t('exportServer.qcStaleNote')}
            </p>
          )}
          <p
            className={qc.passed ? 'export-qc__passed' : 'export-qc__failed'}
            data-testid={qc.passed ? 'export-qc-passed' : 'export-qc-failed'}
          >
            {qc.passed ? t('exportServer.qcPassed') : t('exportServer.qcFailed')}
          </p>
          <table className="export-qc__table" data-testid="export-qc-recap">
            <tbody>
              {qc.gates.map((g) => (
                <GateRow key={g.gate} gate={g} />
              ))}
            </tbody>
          </table>
          {!verdict.allowed && verdict.refusalCode === 'gatesFailing' && (
            <p className="export-workflow__blocked" role="alert" data-testid="export-gate-block">
              {t('exportServer.gateBlockedTitle', { gates: verdict.failingGates.join(', ') })}
            </p>
          )}
        </>
      )}

      <label className="export-workflow__field">
        {t('exportServer.formatLabel')}
        <select
          value={format}
          onChange={(event) => setFormat(event.target.value as ExportFormat)}
          data-testid="export-format-select"
        >
          <option value="stl">{t('exportServer.formatStl')}</option>
          <option value="ply">{t('exportServer.formatPly')}</option>
        </select>
      </label>
      {format === 'stl' && (
        <p className="export-workflow__note" data-testid="export-header-policy">
          {t('exportServer.headerPolicyNote')}
        </p>
      )}

      <button
        type="button"
        className="export-workflow__run"
        disabled={busy || !verdict.allowed}
        onClick={() => fire(() => handoffController.exportAndRelease(restoration.id, format))}
        data-testid="export-run-button"
      >
        {t('exportServer.exportButton')}
      </button>

      <ClientStatus restorationId={restoration.id} />
      <ReleaseStatus restorationId={restoration.id} />
    </div>
  );
}

function GateRow({ gate }: { gate: QcGateResult }) {
  const { t } = useTranslation();
  const label = gate.passed
    ? t('exportServer.gatePass')
    : gate.acknowledged
      ? t('exportServer.gateAck')
      : t('exportServer.gateFail');
  return (
    <tr data-testid={`export-qc-gate-${gate.gate}`} data-passed={gate.passed ? 'true' : 'false'} data-acknowledged={gate.acknowledged ? 'true' : 'false'}>
      <td>{gate.gate}</td>
      <td>
        {label}
        {gate.value !== null && gate.unit ? ` (${gate.value.toFixed(3)} ${gate.unit})` : ''}
      </td>
    </tr>
  );
}

/** The T3 client-side export status (state/exportStore.ts) — every refusal is
 * i18n'd via EXPORT_REFUSAL_I18N_KEY (the shared engine map). */
function ClientStatus({ restorationId }: { restorationId: string }) {
  const { t } = useTranslation();
  const status = useExportStore((state) => selectExportStatus(state, restorationId));

  if (status.state === 'exporting') {
    return (
      <p className="export-client__status" data-testid="export-client-exporting">
        {t('export.statusExporting')}
      </p>
    );
  }
  if (status.state === 'refused' && status.refusalCode) {
    return (
      <p className="export-client__refused" role="alert" data-testid="export-client-refused">
        {t(EXPORT_REFUSAL_I18N_KEY[status.refusalCode], { gates: status.failingGates.join(', ') })}
      </p>
    );
  }
  if (status.state === 'stale') {
    return (
      <p className="export-client__stale" data-testid="export-client-stale">
        {t('export.statusStale')}
      </p>
    );
  }
  if (status.state === 'error') {
    return (
      <p className="export-client__error" role="alert" data-testid="export-client-error">
        {t('export.statusError', { message: status.error ?? '' })}
      </p>
    );
  }
  return null;
}

/** The SERVER release status (state/handoffStore.ts): releasing / released
 * (download + traceability links) / mismatch (the honest diagnostic) / error
 * (local pre-flight failure). */
function ReleaseStatus({ restorationId }: { restorationId: string }) {
  const { t, i18n } = useTranslation();
  const release = useHandoffStore((state) => selectRelease(state, restorationId));
  const lang = TRACEABILITY_LOCALES.has(i18n.language) ? i18n.language : 'en';

  if (release.state === 'releasing') {
    return (
      <p className="export-release__status" role="status" data-testid="export-releasing">
        {t('exportServer.statusReleasing')}
      </p>
    );
  }

  if (release.state === 'released' && release.released) {
    const r = release.released;
    return (
      <div className="export-release__released" data-testid="export-released">
        <p className="export-release__ok">{t('exportServer.releasedTitle')}</p>
        <ul className="export-release__links">
          <li>
            <a href={r.downloadPath} download data-testid="export-download-link">
              {t('exportServer.downloadLink')}
            </a>
          </li>
          <li>
            <a
              href={`${r.traceabilityHtmlPath}?lang=${lang}`}
              target="_blank"
              rel="noreferrer"
              data-testid="export-traceability-html"
            >
              {t('exportServer.traceabilityHtmlLink')}
            </a>
          </li>
          <li>
            <a href={r.traceabilityJsonPath} download data-testid="export-traceability-json">
              {t('exportServer.traceabilityJsonLink')}
            </a>
          </li>
        </ul>
        <p className="export-release__hash" data-testid="export-released-hash">
          {t('exportServer.releasedHashLabel', { hash: r.bytesSha256 })}
        </p>
        <p className="export-release__hash">{t('exportServer.reimportHashLabel', { hash: r.reimportMeshHash })}</p>
        {r.alreadyStored && <p className="export-release__note">{t('exportServer.alreadyStoredNote')}</p>}
      </div>
    );
  }

  if (release.state === 'mismatch' && release.failure) {
    const f = release.failure;
    return (
      <div className="export-release__mismatch" role="alert" data-testid="export-mismatch">
        <p className="export-release__mismatch-title">{t('exportServer.mismatchTitle')}</p>
        <p className="export-release__mismatch-intro">{t('exportServer.mismatchIntro', { code: f.code })}</p>
        <p className="export-release__mismatch-message" data-testid="export-mismatch-message">
          {f.message}
        </p>
        {f.failingGates && f.failingGates.length > 0 && (
          <p data-testid="export-mismatch-gates">
            {t('exportServer.mismatchFailingGates', { gates: f.failingGates.join(', ') })}
          </p>
        )}
        {f.differences && f.differences.length > 0 && (
          <table className="export-release__diff" data-testid="export-mismatch-diff">
            <thead>
              <tr>
                <th colSpan={3}>{t('exportServer.mismatchDiffHeader')}</th>
              </tr>
            </thead>
            <tbody>
              {f.differences.map((d, idx) => (
                <tr key={`${d.path}-${idx}`} data-testid="export-mismatch-diff-row">
                  <td>{d.path}</td>
                  <td>{String(d.server)}</td>
                  <td>{String(d.client)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {f.diagnosticId && (
          <p className="export-release__diag" data-testid="export-diagnostic-id">
            {t('exportServer.diagnosticIdLabel', { id: f.diagnosticId })}
          </p>
        )}
      </div>
    );
  }

  if (release.state === 'error' && release.failure) {
    const f = release.failure;
    const key = RELEASE_FAILURE_I18N_KEY[f.code];
    return (
      <div className="export-release__error" role="alert" data-testid="export-release-error">
        <p className="export-release__error-title">{t('exportServer.failHeading')}</p>
        <p data-testid="export-release-error-message">
          {key ? t(key, { detail: f.message }) : f.message}
        </p>
      </div>
    );
  }

  return null;
}

/** Case archive export/import — a fire-once `.dqca` download + a file-picker
 * import whose overwrite is a REAL user confirm (invariant 5), and whose
 * result names the `importedUnverified` provenance (T6 F-B1). */
function ArchiveSection({ caseId }: { caseId: string }): ReactNode {
  const { t } = useTranslation();
  const archive = useHandoffStore((state) => state.archive);
  const [pendingBytes, setPendingBytes] = useState<Uint8Array | null>(null);

  function handlePick(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-picking the same file
    if (!file) return;
    fire(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setPendingBytes(bytes);
      await handoffController.importCaseArchive(bytes, { overwrite: false });
    });
  }

  return (
    <div className="archive-section" data-testid="archive-section">
      <h3 className="archive-section__title">{t('exportServer.archiveTitle')}</h3>

      <button
        type="button"
        onClick={() => fire(() => handoffController.exportCaseArchive(caseId))}
        disabled={archive.state === 'exporting' || archive.state === 'importing'}
        data-testid="archive-export-button"
      >
        {t('exportServer.archiveExportButton')}
      </button>
      <p className="archive-section__note">{t('exportServer.archiveExportNote')}</p>

      <label className="archive-section__import">
        {t('exportServer.archiveImportButton')}
        <input type="file" accept=".dqca" onChange={handlePick} data-testid="archive-import-input" />
      </label>
      <p className="archive-section__note">{t('exportServer.archiveImportNote')}</p>

      {archive.state === 'importing' && (
        <p role="status" data-testid="archive-importing">
          {t('exportServer.archiveImporting')}
        </p>
      )}

      {archive.state === 'conflict' && (
        <div className="archive-section__conflict" role="alert" data-testid="archive-conflict">
          <p>{t('exportServer.archiveConflictTitle', { caseId: archive.conflictCaseId ?? '' })}</p>
          <p>{t('exportServer.archiveConflictPrompt')}</p>
          <button
            type="button"
            disabled={pendingBytes === null}
            onClick={() =>
              pendingBytes &&
              fire(() => handoffController.importCaseArchive(pendingBytes, { overwrite: true }))
            }
            data-testid="archive-conflict-confirm"
          >
            {t('exportServer.archiveConflictConfirm')}
          </button>
          <button type="button" onClick={() => handoffController.clearArchive()} data-testid="archive-conflict-cancel">
            {t('exportServer.archiveConflictCancel')}
          </button>
        </div>
      )}

      {archive.state === 'imported' && (
        <div className="archive-section__imported" data-testid="archive-imported">
          <p>{t('exportServer.archiveImportedTitle', { caseId: archive.importedCaseId ?? '' })}</p>
          {archive.overwritten && <p>{t('exportServer.archiveImportedOverwritten')}</p>}
          {archive.counts && (
            <>
              <p>
                {t('exportServer.archiveImportedCounts', {
                  scans: archive.counts.scans,
                  finalMeshes: archive.counts.finalMeshes,
                  exportRows: archive.counts.exportRows,
                  exportBytes: archive.counts.exportBytes,
                })}
              </p>
              {archive.counts.exportRows > 0 && (
                <p className="archive-section__provenance" role="note" data-testid="archive-imported-provenance">
                  {t('exportServer.archiveImportedProvenance', { count: archive.counts.exportRows })}
                </p>
              )}
            </>
          )}
          <button type="button" onClick={() => handoffController.clearArchive()} data-testid="archive-dismiss">
            {t('exportServer.archiveDismiss')}
          </button>
        </div>
      )}

      {archive.state === 'error' && (
        <div className="archive-section__error" role="alert" data-testid="archive-error">
          <p>{t('exportServer.archiveError', { message: archive.error ?? '' })}</p>
          <button type="button" onClick={() => handoffController.clearArchive()} data-testid="archive-dismiss">
            {t('exportServer.archiveDismiss')}
          </button>
        </div>
      )}
    </div>
  );
}
