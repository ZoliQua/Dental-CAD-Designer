// apps/client/src/ui/CavityDesignPanel.tsx
//
// Phase 5 Task 8 — the staged inlay/onlay (cavity) design panel. Pure React/DOM
// shell (the cavity analogue of ui/CrownDesignPanel.tsx): it subscribes to
// state/cavityStore.ts (the ephemeral workflow snapshot) and state/caseStore.ts
// (the committed stages/QcReport) and calls back into `cavityDesignEngine`
// (engine/cavityDesign.ts) — ZERO geometry math, ZERO Three.js here (CLAUDE.md
// layer rule; the engine owns all of it). Renders the cavity stage sub-panels in
// fixed order (the onlay-only cusp-coverage stage appears only for an onlay),
// each enabled/blocked by the pure state machine's gate, plus an HONEST failure
// banner that surfaces a stage error and never hides it, and the insertion-axis
// placeholder warning.
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Restoration } from '@dqcad/shared-types';
import { cavityDesignEngine } from '../engine/cavityDesign';
import { isCavityQcStale } from '../engine/cavityWorkflow';
import { insertionAxisIsPlaceholder } from '../engine/restorations';
import { useCaseStore } from '../state/caseStore';
import { useCavityStore, type CavityPrerequisiteCode, type CavityStageName } from '../state/cavityStore';

const STAGE_TITLE_KEY: Record<CavityStageName, string> = {
  outline: 'cavity.outlineTitle',
  fit: 'cavity.fitTitle',
  patch: 'cavity.patchTitle',
  contacts: 'cavity.contactsTitle',
  cuspCoverage: 'cavity.coverageTitle',
  shell: 'cavity.shellTitle',
  qc: 'cavity.qcTitle',
};

const REASON_KEY: Record<CavityPrerequisiteCode, string> = {
  noTargetScan: 'cavity.reasonNoTargetScan',
  noCavityOutline: 'cavity.reasonNoCavityOutline',
  fitIncomplete: 'cavity.reasonFitIncomplete',
  patchIncomplete: 'cavity.reasonPatchIncomplete',
  contactsIncomplete: 'cavity.reasonContactsIncomplete',
  cuspCoverageIncomplete: 'cavity.reasonCuspCoverageIncomplete',
  shellIncomplete: 'cavity.reasonShellIncomplete',
};

/** Fire-and-forget an async engine action — the engine surfaces its own failures
 * into cavityStore.error (rendered by the banner). */
function run(action: () => Promise<void>): void {
  void action().catch(() => {
    /* surfaced via cavityStore.error */
  });
}

function um(mm: number): string {
  return (mm * 1000).toFixed(0);
}

export function CavityDesignPanel() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const active = useCavityStore((state) => state.active);
  const restorationId = useCavityStore((state) => state.restorationId);
  const [pendingId, setPendingId] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  // Only inlay/onlay restorations are eligible for this panel.
  const restorations = document.restorations.filter((r) => r.type === 'inlay' || r.type === 'onlay');

  function handleStart(): void {
    if (!pendingId) return;
    setStartError(null);
    try {
      cavityDesignEngine.start(pendingId);
    } catch (error) {
      // Wrap the raw engine message (developer-facing English) in a translated
      // frame so a HU/DE/ES dentist sees localized chrome + the technical
      // detail — same "translated frame, dynamic content" pattern the sibling
      // panels use (AlignmentPanel/AxisPanel/MarginPanel `startErrorOther`).
      setStartError(
        t('cavity.startErrorOther', { message: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  if (!active || restorationId === null) {
    return (
      <section className="cavity-panel" data-testid="cavity-panel">
        <h2 className="cavity-panel__title">{t('cavity.panelTitle')}</h2>
        {restorations.length === 0 ? (
          <p className="cavity-panel__empty">{t('cavity.needsRestoration')}</p>
        ) : (
          <div className="cavity-panel__start">
            <label className="cavity-panel__field">
              {t('cavity.restorationLabel')}
              <select value={pendingId} onChange={(event) => setPendingId(event.target.value)} data-testid="cavity-restoration-select">
                <option value="">{t('cavity.selectPlaceholder')}</option>
                {restorations.map((r) => (
                  <option key={r.id} value={r.id}>
                    {t(`restoration.type.${r.type}`)} ({r.teeth.join(', ')})
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={handleStart} disabled={!pendingId} data-testid="cavity-start-button" className="cavity-panel__start-button">
              {t('cavity.startButton')}
            </button>
            {startError && (
              <p className="cavity-panel__error" data-testid="cavity-start-error">
                {startError}
              </p>
            )}
          </div>
        )}
      </section>
    );
  }

  return <CavityWorkflow restorationId={restorationId} />;
}

function CavityWorkflow({ restorationId }: { restorationId: string }) {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const error = useCavityStore((state) => state.error);
  const errorStage = useCavityStore((state) => state.errorStage);
  const busyStage = useCavityStore((state) => state.busyStage);
  const restorationType = useCavityStore((state) => state.restorationType);

  const restoration = document.restorations.find((r) => r.id === restorationId);

  return (
    <section className="cavity-panel cavity-panel--active" data-testid="cavity-panel">
      <div className="cavity-panel__header">
        <h2 className="cavity-panel__title">{t('cavity.panelTitle')}</h2>
        <button type="button" onClick={() => cavityDesignEngine.clear()} data-testid="cavity-close-button">
          {t('cavity.cancelButton')}
        </button>
      </div>

      {restoration && insertionAxisIsPlaceholder(restoration) && (
        <div className="cavity-panel__warning-banner" role="status" data-testid="cavity-axis-warning">
          {t('cavity.axisPlaceholderWarning')}
        </div>
      )}

      {error && (
        <div className="cavity-panel__error-banner" role="alert" data-testid="cavity-error">
          <span>{t('cavity.errorBanner', { stage: errorStage ? t(STAGE_TITLE_KEY[errorStage]) : '', message: error })}</span>
          <button type="button" onClick={() => cavityDesignEngine.clearError()} data-testid="cavity-error-clear">
            {t('cavity.clearError')}
          </button>
        </div>
      )}

      <OutlineStage />
      <FitStage busy={busyStage === 'fit'} />
      <PatchStage busy={busyStage === 'patch'} />
      <ContactsStage busy={busyStage === 'contacts'} />
      {restorationType === 'onlay' && <CuspCoverageStage busy={busyStage === 'cuspCoverage'} />}
      <ShellStage busy={busyStage === 'shell'} />
      <QcStage busy={busyStage === 'qc'} restoration={restoration ?? null} />
    </section>
  );
}

function useGate(stage: CavityStageName) {
  return useCavityStore((state) => state.gates.find((g) => g.stage === stage) ?? null);
}

function StageShell({
  stage,
  title,
  busy,
  children,
  showDone,
}: {
  stage: CavityStageName;
  title: string;
  busy: boolean;
  children: ReactNode;
  showDone?: boolean;
}) {
  const { t } = useTranslation();
  const gate = useGate(stage);
  const blocked = gate !== null && !gate.allowed;
  const done = showDone ?? gate?.complete ?? false;
  return (
    <div className={`cavity-stage cavity-stage--${stage}`} data-testid={`cavity-stage-${stage}`} data-complete={done ? 'true' : 'false'}>
      <h3 className="cavity-stage__title">
        {title}
        {done && (
          <span className="cavity-stage__done" data-testid={`cavity-${stage}-done`}>
            {' '}
            ✓
          </span>
        )}
        {busy && (
          <span className="cavity-stage__busy" data-testid={`cavity-${stage}-busy`}>
            {' '}
            {t('cavity.statusRunning')}
          </span>
        )}
      </h3>
      {blocked && gate?.reason ? (
        <p className="cavity-stage__blocked" data-testid={`cavity-${stage}-blocked`}>
          {t('cavity.blocked', { reason: t(REASON_KEY[gate.reason]) })}
        </p>
      ) : (
        children
      )}
    </div>
  );
}

function OutlineStage() {
  const { t } = useTranslation();
  const gate = useGate('outline');
  return (
    <StageShell stage="outline" title={t('cavity.outlineTitle')} busy={false}>
      <p className="cavity-stage__note" data-testid="cavity-outline-status">
        {gate?.complete ? t('cavity.outlineReady') : t('cavity.outlineNeeded')}
      </p>
    </StageShell>
  );
}

function FitStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('fit');
  const fit = useCavityStore((state) => state.fit);
  const ghost = useCavityStore((state) => state.fitGhostVisible);
  const [pitchUm, setPitchUm] = useState(20);
  return (
    <StageShell stage="fit" title={t('cavity.fitTitle')} busy={busy}>
      <label className="cavity-stage__field">
        {t('cavity.fitPitchLabel')}
        <input type="number" min={5} step={5} value={pitchUm} onChange={(e) => setPitchUm(Number(e.target.value))} data-testid="cavity-fit-pitch" />
        <span>µm</span>
      </label>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => cavityDesignEngine.runFit({ pitchMm: pitchUm / 1000 }))} data-testid="cavity-fit-run">
        {t('cavity.fitRun')}
      </button>
      {fit && (
        <p className="cavity-stage__readout" data-testid="cavity-fit-readout">
          {t('cavity.fitReadout', { error: um(fit.errorBoundMm), tris: fit.patchTriangleCount, verts: fit.marginVertexCount })}
        </p>
      )}
      <label className="cavity-stage__checkbox">
        <input type="checkbox" checked={ghost} onChange={(e) => cavityDesignEngine.setFitGhostVisible(e.target.checked)} data-testid="cavity-fit-ghost" />
        {t('cavity.fitGhostToggle')}
      </label>
    </StageShell>
  );
}

function PatchStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('patch');
  const patch = useCavityStore((state) => state.patch);
  return (
    <StageShell stage="patch" title={t('cavity.patchTitle')} busy={busy}>
      <p className="cavity-stage__note">{t('cavity.patchNote')}</p>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => cavityDesignEngine.runPatch())} data-testid="cavity-patch-run">
        {t('cavity.patchRun')}
      </button>
      {patch && (
        <p className={patch.seamWithinBound ? 'cavity-stage__readout cavity-seam--ok' : 'cavity-stage__readout cavity-seam--warn'} data-testid="cavity-patch-seam">
          {t('cavity.patchSeamReadout', {
            max: patch.seamDihedralMaxDeg.toFixed(2),
            bound: patch.seamDihedralBoundDeg.toFixed(1),
            tris: patch.patchTriangleCount,
          })}
        </p>
      )}
    </StageShell>
  );
}

function ContactsStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('contacts');
  const contacts = useCavityStore((state) => state.contacts);
  return (
    <StageShell stage="contacts" title={t('cavity.contactsTitle')} busy={busy}>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => cavityDesignEngine.runContacts())} data-testid="cavity-contacts-run">
        {t('cavity.contactsRun')}
      </button>
      {contacts && (
        <>
          <table className="cavity-contacts__table" data-testid="cavity-contacts-table">
            <tbody>
              {contacts.boxes.map((b) => (
                <tr key={b.label} data-testid={`cavity-contact-${b.label}`}>
                  <td>{t(`cavity.box.${b.label}`)}</td>
                  <td>{t('cavity.contactResidual', { residual: um(b.contactResidualMm) })}</td>
                  <td>{b.clampBound ? <span className="cavity-contacts__clamp" data-testid={`cavity-contact-clamp-${b.label}`}>{t('cavity.contactClamped')}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="cavity-stage__readout" data-testid="cavity-contacts-seam">
            {t('cavity.contactsSeamReadout', {
              before: contacts.seamDihedralMaxBeforeDeg.toFixed(2),
              after: contacts.seamDihedralMaxAfterDeg.toFixed(2),
            })}
          </p>
        </>
      )}
    </StageShell>
  );
}

function CuspCoverageStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('cuspCoverage');
  const coverage = useCavityStore((state) => state.coverage);
  return (
    <StageShell stage="cuspCoverage" title={t('cavity.coverageTitle')} busy={busy}>
      <p className="cavity-stage__note">{t('cavity.coverageNote')}</p>
      <button
        type="button"
        disabled={busy || !gate?.allowed}
        onClick={() => run(() => cavityDesignEngine.selectCuspCoverage(cavityDesignEngine.defaultCoverageDivider()))}
        data-testid="cavity-coverage-select"
      >
        {t('cavity.coverageSelect')}
      </button>
      {coverage && (
        <p className="cavity-stage__readout" data-testid="cavity-coverage-readout">
          {t('cavity.coverageReadout', {
            x: coverage.pointMm[0].toFixed(2),
            y: coverage.pointMm[1].toFixed(2),
            z: coverage.pointMm[2].toFixed(2),
          })}
        </p>
      )}
    </StageShell>
  );
}

function ShellStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('shell');
  const shell = useCavityStore((state) => state.shell);
  return (
    <StageShell stage="shell" title={t('cavity.shellTitle')} busy={busy}>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => cavityDesignEngine.constructShell())} data-testid="cavity-shell-construct">
        {t('cavity.shellConstruct')}
      </button>
      {shell && (
        <p className="cavity-stage__readout" data-testid="cavity-shell-readout">
          {shell.watertight ? t('cavity.shellWatertightYes') : t('cavity.shellWatertightNo')} ·{' '}
          {t('cavity.shellReadout', { volume: shell.volumeMm3.toFixed(1), ring: shell.seamRingVertexCount })}
        </p>
      )}
    </StageShell>
  );
}

function QcStage({ busy, restoration }: { busy: boolean; restoration: Restoration | null }) {
  const { t } = useTranslation();
  const gate = useGate('qc');
  const qc = restoration?.qc ?? null;
  const stale = restoration !== null && isCavityQcStale(restoration);
  return (
    <StageShell stage="qc" title={t('cavity.qcTitle')} busy={busy} showDone={qc?.passed === true && !stale}>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => cavityDesignEngine.runQc())} data-testid="cavity-qc-run">
        {qc ? t('cavity.qcRerun') : t('cavity.qcRun')}
      </button>
      {qc === null ? (
        <p className="cavity-stage__note" data-testid="cavity-qc-notrun">
          {t('cavity.qcNotRun')}
        </p>
      ) : stale ? (
        <p className="cavity-qc__stale" data-testid="cavity-qc-stale">
          {t('cavity.qcStale')}
        </p>
      ) : (
        <>
          <p className={qc.passed ? 'cavity-qc__passed' : 'cavity-qc__failed'} data-testid={qc.passed ? 'cavity-qc-passed' : 'cavity-qc-failed'}>
            {qc.passed ? t('cavity.qcPassed') : t('cavity.qcFailed')}
          </p>
          <table className="cavity-qc__table" data-testid="cavity-qc-table">
            <tbody>
              {qc.gates.map((g) => (
                <tr key={g.gate} data-testid={`cavity-qc-gate-${g.gate}`} data-passed={g.passed ? 'true' : 'false'}>
                  <td>{g.gate}</td>
                  <td>
                    {g.passed ? t('cavity.qcGatePass') : g.acknowledged ? t('cavity.qcAcknowledged') : t('cavity.qcGateFail')}
                    {g.value !== null && g.unit ? ` (${g.value.toFixed(3)} ${g.unit})` : ''}
                  </td>
                  <td>
                    {!g.passed && !g.acknowledged && (
                      <button type="button" disabled={busy} onClick={() => run(() => cavityDesignEngine.acknowledgeGate(g.gate))} data-testid={`cavity-qc-ack-${g.gate}`}>
                        {t('cavity.qcAcknowledge')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </StageShell>
  );
}
