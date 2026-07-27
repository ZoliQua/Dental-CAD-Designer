// apps/client/src/ui/BridgeDesignPanel.tsx
//
// Phase 6 Task 7 — the staged bridge (multi-unit) design panel. Pure React/DOM
// shell (the bridge analogue of ui/CavityDesignPanel.tsx): it subscribes to
// state/bridgeStore.ts (the ephemeral workflow snapshot) and state/caseStore.ts
// (the committed stages/QcReport) and calls back into `bridgeDesignEngine`
// (engine/bridgeDesign.ts) — ZERO geometry math, ZERO Three.js here (CLAUDE.md
// layer rule; the engine owns all of it). Renders the bridge stage sub-panels in
// fixed order (margins → abutment surfaces → pontic → connectors → framework →
// assembly → QC), each enabled/blocked by the pure state machine's gate, plus:
//   - the CONNECTOR EDITOR (per-connector profile semi-axis + LIVE min-area
//     readout + per-connector gate status);
//   - the framework/full-contour toggle (a journaled design decision; the
//     veneering-space + taper disclosure surfaced);
//   - the whole-bridge QC table (per-unit thickness rows + per-connector +
//     pontic-relief rows; per-gate pass/fail/ACKNOWLEDGE; the T6-review
//     per-unit-not-whole-solid scope note);
// an HONEST failure banner, and the insertion-axis placeholder warning.
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Restoration } from '@dqcad/shared-types';
import { bridgeDesignEngine, type PonticStyleName } from '../engine/bridgeDesign';
import { buildBridgeFixture } from '../engine/bridgeGeometry';
import { isBridgeQcStale } from '../engine/bridgeWorkflow';
import { insertionAxisIsPlaceholder } from '../engine/restorations';
import { useCaseStore } from '../state/caseStore';
import { useBridgeStore, type BridgePrerequisiteCode, type BridgeStageName, type BridgeFrameworkMode } from '../state/bridgeStore';

const STAGE_TITLE_KEY: Record<BridgeStageName, string> = {
  margins: 'bridge.marginsTitle',
  abutmentSurfaces: 'bridge.abutmentSurfacesTitle',
  pontic: 'bridge.ponticTitle',
  connectors: 'bridge.connectorsTitle',
  framework: 'bridge.frameworkTitle',
  assembly: 'bridge.assemblyTitle',
  qc: 'bridge.qcTitle',
};

const REASON_KEY: Record<BridgePrerequisiteCode, string> = {
  noTargetScan: 'bridge.reasonNoTargetScan',
  noAbutmentMargins: 'bridge.reasonNoAbutmentMargins',
  abutmentSurfacesIncomplete: 'bridge.reasonAbutmentSurfacesIncomplete',
  ponticIncomplete: 'bridge.reasonPonticIncomplete',
  connectorsIncomplete: 'bridge.reasonConnectorsIncomplete',
  frameworkIncomplete: 'bridge.reasonFrameworkIncomplete',
  assemblyIncomplete: 'bridge.reasonAssemblyIncomplete',
};

const PONTIC_STYLES: readonly PonticStyleName[] = ['hygienic', 'ridgeLap', 'ovate'];

/** Fire-and-forget an async engine action — the engine surfaces its own failures
 * into bridgeStore.error (rendered by the banner). */
function run(action: () => Promise<void>): void {
  void action().catch(() => {
    /* surfaced via bridgeStore.error */
  });
}

function um(mm: number): string {
  return (mm * 1000).toFixed(1);
}

export function BridgeDesignPanel() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const active = useBridgeStore((state) => state.active);
  const restorationId = useBridgeStore((state) => state.restorationId);
  const [pendingId, setPendingId] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  const restorations = document.restorations.filter((r) => r.type === 'bridge');

  function handleStart(): void {
    if (!pendingId) return;
    setStartError(null);
    try {
      bridgeDesignEngine.start(pendingId, buildBridgeFixture());
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  }

  if (!active || restorationId === null) {
    return (
      <section className="bridge-panel" data-testid="bridge-panel">
        <h2 className="bridge-panel__title">{t('bridge.panelTitle')}</h2>
        {restorations.length === 0 ? (
          <p className="bridge-panel__empty">{t('bridge.needsRestoration')}</p>
        ) : (
          <div className="bridge-panel__start">
            <label className="bridge-panel__field">
              {t('bridge.restorationLabel')}
              <select value={pendingId} onChange={(event) => setPendingId(event.target.value)} data-testid="bridge-restoration-select">
                <option value="">{t('bridge.selectPlaceholder')}</option>
                {restorations.map((r) => (
                  <option key={r.id} value={r.id}>
                    {t('restoration.type.bridge')} ({r.teeth.join(', ')})
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={handleStart} disabled={!pendingId} data-testid="bridge-start-button" className="bridge-panel__start-button">
              {t('bridge.startButton')}
            </button>
            {startError && (
              <p className="bridge-panel__error" data-testid="bridge-start-error">
                {startError}
              </p>
            )}
          </div>
        )}
      </section>
    );
  }

  return <BridgeWorkflow restorationId={restorationId} />;
}

function BridgeWorkflow({ restorationId }: { restorationId: string }) {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const error = useBridgeStore((state) => state.error);
  const errorStage = useBridgeStore((state) => state.errorStage);
  const busyStage = useBridgeStore((state) => state.busyStage);

  const restoration = document.restorations.find((r) => r.id === restorationId);

  return (
    <section className="bridge-panel bridge-panel--active" data-testid="bridge-panel">
      <div className="bridge-panel__header">
        <h2 className="bridge-panel__title">{t('bridge.panelTitle')}</h2>
        <button type="button" onClick={() => bridgeDesignEngine.clear()} data-testid="bridge-close-button">
          {t('bridge.cancelButton')}
        </button>
      </div>

      {restoration && insertionAxisIsPlaceholder(restoration) && (
        <div className="bridge-panel__warning-banner" role="status" data-testid="bridge-axis-warning">
          {t('bridge.axisPlaceholderWarning')}
        </div>
      )}

      {error && (
        <div className="bridge-panel__error-banner" role="alert" data-testid="bridge-error">
          <span>{t('bridge.errorBanner', { stage: errorStage ? t(STAGE_TITLE_KEY[errorStage]) : '', message: error })}</span>
          <button type="button" onClick={() => bridgeDesignEngine.clearError()} data-testid="bridge-error-clear">
            {t('bridge.clearError')}
          </button>
        </div>
      )}

      <MarginsStage />
      <AbutmentSurfacesStage busy={busyStage === 'abutmentSurfaces'} />
      <PonticStage busy={busyStage === 'pontic'} />
      <ConnectorsStage busy={busyStage === 'connectors'} />
      <FrameworkStage busy={busyStage === 'framework'} />
      <AssemblyStage busy={busyStage === 'assembly'} />
      <QcStage busy={busyStage === 'qc'} restoration={restoration ?? null} />
    </section>
  );
}

function useGate(stage: BridgeStageName) {
  return useBridgeStore((state) => state.gates.find((g) => g.stage === stage) ?? null);
}

function StageShell({
  stage,
  title,
  busy,
  children,
  showDone,
}: {
  stage: BridgeStageName;
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
    <div className={`bridge-stage bridge-stage--${stage}`} data-testid={`bridge-stage-${stage}`} data-complete={done ? 'true' : 'false'}>
      <h3 className="bridge-stage__title">
        {title}
        {done && (
          <span className="bridge-stage__done" data-testid={`bridge-${stage}-done`}>
            {' '}
            ✓
          </span>
        )}
        {busy && (
          <span className="bridge-stage__busy" data-testid={`bridge-${stage}-busy`}>
            {' '}
            {t('bridge.statusRunning')}
          </span>
        )}
      </h3>
      {blocked && gate?.reason ? (
        <p className="bridge-stage__blocked" data-testid={`bridge-${stage}-blocked`}>
          {t('bridge.blocked', { reason: t(REASON_KEY[gate.reason]) })}
        </p>
      ) : (
        children
      )}
    </div>
  );
}

function MarginsStage() {
  const { t } = useTranslation();
  const gate = useGate('margins');
  const sharedAxis = useBridgeStore((state) => state.sharedAxis);
  return (
    <StageShell stage="margins" title={t('bridge.marginsTitle')} busy={false}>
      <p className="bridge-stage__note" data-testid="bridge-margins-status">
        {gate?.complete ? t('bridge.marginsReady') : t('bridge.marginsNeeded')}
      </p>
      {sharedAxis && (
        <p className={sharedAxis.acceptable ? 'bridge-stage__readout bridge-axis--ok' : 'bridge-stage__readout bridge-axis--warn'} data-testid="bridge-shared-axis">
          {sharedAxis.acceptable ? t('bridge.sharedAxisOk', { count: sharedAxis.perAbutment.length }) : t('bridge.sharedAxisWarn')}
        </p>
      )}
    </StageShell>
  );
}

function AbutmentSurfacesStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('abutmentSurfaces');
  const summary = useBridgeStore((state) => state.abutmentSurfaces);
  return (
    <StageShell stage="abutmentSurfaces" title={t('bridge.abutmentSurfacesTitle')} busy={busy}>
      <p className="bridge-stage__note">{t('bridge.abutmentSurfacesNote')}</p>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => bridgeDesignEngine.commitAbutmentSurfaces())} data-testid="bridge-abutment-surfaces-run">
        {t('bridge.abutmentSurfacesRun')}
      </button>
      {summary && (
        <table className="bridge-abutments__table" data-testid="bridge-abutment-fit-table">
          <tbody>
            {summary.units.map((u) => (
              <tr key={u.label} data-testid={`bridge-abutment-fit-${u.label}`}>
                <td>{t('bridge.abutment', { tooth: u.label })}</td>
                <td>{t('bridge.marginFitReadout', { fit: um(u.marginFitMm) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </StageShell>
  );
}

function PonticStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('pontic');
  const pontic = useBridgeStore((state) => state.pontic);
  const [style, setStyle] = useState<PonticStyleName>('hygienic');
  return (
    <StageShell stage="pontic" title={t('bridge.ponticTitle')} busy={busy}>
      <label className="bridge-stage__field">
        {t('bridge.ponticStyleLabel')}
        <select value={style} onChange={(e) => setStyle(e.target.value as PonticStyleName)} data-testid="bridge-pontic-style">
          {PONTIC_STYLES.map((s) => (
            <option key={s} value={s}>
              {t(`bridge.ponticStyle.${s}`)}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => bridgeDesignEngine.commitPontic(style))} data-testid="bridge-pontic-commit">
        {t('bridge.ponticCommit')}
      </button>
      {pontic && (
        <p className={pontic.withinTolerance ? 'bridge-stage__readout bridge-relief--ok' : 'bridge-stage__readout bridge-relief--warn'} data-testid="bridge-pontic-readout">
          {t('bridge.ponticReadout', {
            style: t(`bridge.ponticStyle.${pontic.style}`),
            configured: um(pontic.configuredReliefMm),
            dev: um(pontic.maxAbsDeviationMm),
            bound: um(pontic.thresholdMm),
          })}
        </p>
      )}
    </StageShell>
  );
}

function ConnectorsStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('connectors');
  const committed = useBridgeStore((state) => state.connectors);
  const live = useBridgeStore((state) => state.liveConnectors);
  // The connector editor's per-connector semi-axis (µm-free mm), keyed by label,
  // seeded lazily from the captured connectors on first live measure/commit.
  const [semiByLabel, setSemiByLabel] = useState<Record<string, number>>({});

  const readout = live ?? committed;
  // Which connector labels to render editors for — from any readout we have.
  const labels = readout?.connectors.map((c) => c.label) ?? [];

  function setSemi(label: string, value: number): void {
    setSemiByLabel((prev) => ({ ...prev, [label]: value }));
  }
  function overrides(): Record<string, number> {
    return semiByLabel;
  }

  return (
    <StageShell stage="connectors" title={t('bridge.connectorsTitle')} busy={busy}>
      <p className="bridge-stage__note">{t('bridge.connectorsNote')}</p>
      {readout && (
        <table className="bridge-connectors__table" data-testid="bridge-connectors-table">
          <tbody>
            {readout.connectors.map((c) => (
              <tr key={c.label} data-testid={`bridge-connector-${c.label}`} data-passed={c.passed ? 'true' : 'false'}>
                <td>{t('bridge.connector', { label: c.label })}</td>
                <td>
                  <input
                    type="number"
                    min={0.5}
                    step={0.1}
                    value={semiByLabel[c.label] ?? c.semiAxisMm}
                    onChange={(e) => setSemi(c.label, Number(e.target.value))}
                    data-testid={`bridge-connector-semi-${c.label}`}
                    aria-label={t('bridge.connectorSemiLabel', { label: c.label })}
                  />
                  <span> mm</span>
                </td>
                <td data-testid={`bridge-connector-area-${c.label}`}>
                  {t('bridge.connectorArea', { area: c.minAreaMm2.toFixed(2), target: c.targetMm2 })}
                </td>
                <td>
                  <span className={c.passed ? 'bridge-connector--ok' : 'bridge-connector--warn'} data-testid={`bridge-connector-verdict-${c.label}`}>
                    {c.passed ? t('bridge.connectorPass') : t('bridge.connectorBlock')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="bridge-connectors__actions">
        <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => bridgeDesignEngine.previewConnectors(overrides()))} data-testid="bridge-connectors-preview">
          {t('bridge.connectorsPreview')}
        </button>
        <button type="button" disabled={busy || !gate?.allowed || labels.length === 0} onClick={() => run(() => bridgeDesignEngine.commitConnectors(overrides()))} data-testid="bridge-connectors-commit">
          {t('bridge.connectorsCommit')}
        </button>
      </div>
    </StageShell>
  );
}

function FrameworkStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('framework');
  const framework = useBridgeStore((state) => state.framework);
  const [mode, setMode] = useState<BridgeFrameworkMode>('fullContour');
  return (
    <StageShell stage="framework" title={t('bridge.frameworkTitle')} busy={busy}>
      <label className="bridge-stage__field">
        {t('bridge.frameworkModeLabel')}
        <select value={mode} onChange={(e) => setMode(e.target.value as BridgeFrameworkMode)} data-testid="bridge-framework-mode">
          <option value="fullContour">{t('bridge.frameworkModeFull')}</option>
          <option value="framework">{t('bridge.frameworkModeFramework')}</option>
        </select>
      </label>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => bridgeDesignEngine.selectFramework(mode))} data-testid="bridge-framework-select">
        {t('bridge.frameworkSelect')}
      </button>
      {framework && (
        <p className="bridge-stage__readout" data-testid="bridge-framework-readout">
          {framework.mode === 'framework'
            ? t('bridge.frameworkReadout', { space: um(framework.veneeringSpaceMm ?? 0), band: um(framework.taperBandMm ?? 0) })
            : t('bridge.frameworkFullReadout')}
        </p>
      )}
    </StageShell>
  );
}

function AssemblyStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('assembly');
  const assembly = useBridgeStore((state) => state.assembly);
  return (
    <StageShell stage="assembly" title={t('bridge.assemblyTitle')} busy={busy}>
      <p className="bridge-stage__note">{t('bridge.assemblyNote')}</p>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => bridgeDesignEngine.runAssembly())} data-testid="bridge-assembly-run">
        {t('bridge.assemblyRun')}
      </button>
      {assembly && (
        <p className="bridge-stage__readout" data-testid="bridge-assembly-readout">
          {assembly.watertight ? t('bridge.assemblyWatertightYes') : t('bridge.assemblyWatertightNo')} ·{' '}
          {t('bridge.assemblyReadout', { comp: assembly.componentCount, volume: (assembly.volumeMm3 ?? 0).toFixed(1), tris: assembly.triangleCount })}
        </p>
      )}
    </StageShell>
  );
}

function QcStage({ busy, restoration }: { busy: boolean; restoration: Restoration | null }) {
  const { t } = useTranslation();
  const gate = useGate('qc');
  const qc = restoration?.qc ?? null;
  const stale = restoration !== null && isBridgeQcStale(restoration);
  return (
    <StageShell stage="qc" title={t('bridge.qcTitle')} busy={busy} showDone={qc?.passed === true && !stale}>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => bridgeDesignEngine.runQc())} data-testid="bridge-qc-run">
        {qc ? t('bridge.qcRerun') : t('bridge.qcRun')}
      </button>
      {qc === null ? (
        <p className="bridge-stage__note" data-testid="bridge-qc-notrun">
          {t('bridge.qcNotRun')}
        </p>
      ) : stale ? (
        <p className="bridge-qc__stale" data-testid="bridge-qc-stale">
          {t('bridge.qcStale')}
        </p>
      ) : (
        <>
          <p className={qc.passed ? 'bridge-qc__passed' : 'bridge-qc__failed'} data-testid={qc.passed ? 'bridge-qc-passed' : 'bridge-qc-failed'}>
            {qc.passed ? t('bridge.qcPassed') : t('bridge.qcFailed')}
          </p>
          <table className="bridge-qc__table" data-testid="bridge-qc-table">
            <tbody>
              {qc.gates.map((g) => (
                <tr key={g.gate} data-testid={`bridge-qc-gate-${g.gate}`} data-passed={g.passed ? 'true' : 'false'}>
                  <td>{g.gate}</td>
                  <td>
                    {g.passed ? t('bridge.qcGatePass') : g.acknowledged ? t('bridge.qcAcknowledged') : t('bridge.qcGateFail')}
                    {g.value !== null && g.unit ? ` (${g.value.toFixed(3)} ${g.unit})` : ''}
                  </td>
                  <td>
                    {!g.passed && !g.acknowledged && (
                      <button type="button" disabled={busy} onClick={() => run(() => bridgeDesignEngine.acknowledgeGate(g.gate))} data-testid={`bridge-qc-ack-${g.gate}`}>
                        {t('bridge.qcAcknowledge')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="bridge-qc__scope-note" data-testid="bridge-qc-scope-note">
            {t('bridge.qcScopeNote')}
          </p>
        </>
      )}
    </StageShell>
  );
}
