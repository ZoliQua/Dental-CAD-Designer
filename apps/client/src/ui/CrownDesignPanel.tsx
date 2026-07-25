// apps/client/src/ui/CrownDesignPanel.tsx
//
// Phase 4 Task 10 — the staged crown-design panel. Pure React/DOM shell: it
// subscribes to state/crownStore.ts (the ephemeral workflow snapshot) and
// state/caseStore.ts (the committed stages/QcReport in the case document) and
// calls back into `crownDesignEngine` (engine/crownDesign.ts) — ZERO geometry
// math, ZERO Three.js here (CLAUDE.md layer rule; the engine owns all of it).
// Renders the six stage sub-panels in fixed order, each enabled/blocked by the
// pure state machine's gate (crownStore.gates), plus an HONEST failure banner
// that surfaces a stage error (e.g. the shell's NonManifoldInputError on the
// real distorted tooth-11 morph — T9) and never hides it.
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Restoration } from '@dqcad/shared-types';
import { crownDesignEngine } from '../engine/crownDesign';
import { isQcStale } from '../engine/crownWorkflow';
import { insertionAxisIsPlaceholder } from '../engine/restorations';
import { useCaseStore } from '../state/caseStore';
import {
  useCrownStore,
  type CrownPrerequisiteCode,
  type CrownStageName,
  type MorphStrengthsUi,
  type SculptBrushType,
} from '../state/crownStore';

const STAGE_TITLE_KEY: Record<CrownStageName, string> = {
  innerSurface: 'crown.innerTitle',
  anatomy: 'crown.anatomyTitle',
  morph: 'crown.morphTitle',
  shell: 'crown.shellTitle',
  freeform: 'crown.freeformTitle',
  qc: 'crown.qcTitle',
};

const REASON_KEY: Record<CrownPrerequisiteCode, string> = {
  noTargetScan: 'crown.reasonNoTargetScan',
  noMarginLine: 'crown.reasonNoMarginLine',
  innerSurfaceIncomplete: 'crown.reasonInnerSurfaceIncomplete',
  anatomyIncomplete: 'crown.reasonAnatomyIncomplete',
  morphIncomplete: 'crown.reasonMorphIncomplete',
  shellIncomplete: 'crown.reasonShellIncomplete',
};

/** Fire-and-forget an async engine action — the engine surfaces its own
 * failures into crownStore.error (rendered by the banner), so a rejected
 * promise here only needs swallowing to avoid an unhandled rejection. */
function run(action: () => Promise<void>): void {
  void action().catch(() => {
    /* surfaced via crownStore.error */
  });
}

function um(mm: number): string {
  return (mm * 1000).toFixed(0);
}

export function CrownDesignPanel() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const active = useCrownStore((state) => state.active);
  const restorationId = useCrownStore((state) => state.restorationId);
  const [pendingId, setPendingId] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  const restorations = document.restorations;

  function handleStart(): void {
    if (!pendingId) return;
    setStartError(null);
    try {
      crownDesignEngine.start(pendingId);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  }

  if (!active || restorationId === null) {
    return (
      <section className="crown-panel" data-testid="crown-panel">
        <h2 className="crown-panel__title">{t('crown.panelTitle')}</h2>
        {restorations.length === 0 ? (
          <p className="crown-panel__empty">{t('crown.needsRestoration')}</p>
        ) : (
          <div className="crown-panel__start">
            <label className="crown-panel__field">
              {t('crown.restorationLabel')}
              <select
                value={pendingId}
                onChange={(event) => setPendingId(event.target.value)}
                data-testid="crown-restoration-select"
              >
                <option value="">{t('crown.selectPlaceholder')}</option>
                {restorations.map((r) => (
                  <option key={r.id} value={r.id}>
                    {t(`restoration.type.${r.type}`)} ({r.teeth.join(', ')})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleStart}
              disabled={!pendingId}
              data-testid="crown-start-button"
              className="crown-panel__start-button"
            >
              {t('crown.startButton')}
            </button>
            {startError && (
              <p className="crown-panel__error" data-testid="crown-start-error">
                {startError}
              </p>
            )}
          </div>
        )}
      </section>
    );
  }

  return <CrownWorkflow restorationId={restorationId} />;
}

function CrownWorkflow({ restorationId }: { restorationId: string }) {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const error = useCrownStore((state) => state.error);
  const errorStage = useCrownStore((state) => state.errorStage);
  const busyStage = useCrownStore((state) => state.busyStage);

  const restoration = document.restorations.find((r) => r.id === restorationId);

  return (
    <section className="crown-panel crown-panel--active" data-testid="crown-panel">
      <div className="crown-panel__header">
        <h2 className="crown-panel__title">{t('crown.panelTitle')}</h2>
        <button type="button" onClick={() => crownDesignEngine.clear()} data-testid="crown-close-button">
          {t('crown.cancelButton')}
        </button>
      </div>

      {restoration && insertionAxisIsPlaceholder(restoration) && (
        <div className="crown-panel__warning-banner" role="status" data-testid="crown-axis-warning">
          {t('crown.axisPlaceholderWarning')}
        </div>
      )}

      {error && (
        <div className="crown-panel__error-banner" role="alert" data-testid="crown-error">
          <span>{t('crown.errorBanner', { stage: errorStage ? t(STAGE_TITLE_KEY[errorStage]) : '', message: error })}</span>
          <button type="button" onClick={() => crownDesignEngine.clearError()} data-testid="crown-error-clear">
            {t('crown.clearError')}
          </button>
        </div>
      )}

      <InnerSurfaceStage busy={busyStage === 'innerSurface'} />
      <AnatomyStage busy={busyStage === 'anatomy'} />
      <MorphStage busy={busyStage === 'morph'} />
      <ShellStage busy={busyStage === 'shell'} />
      <FreeformStage busy={busyStage === 'freeform'} />
      <QcStage busy={busyStage === 'qc'} restoration={restoration ?? null} />
    </section>
  );
}

function useGate(stage: CrownStageName) {
  return useCrownStore((state) => state.gates.find((g) => g.stage === stage) ?? null);
}

function StageShell({
  stage,
  title,
  busy,
  children,
  showDone,
}: {
  stage: CrownStageName;
  title: string;
  busy: boolean;
  children: ReactNode;
  /** Overrides the ✓ "done" indicator (default: the gate's `complete` flag).
   * QC passes `qc?.passed === true && !stale` so a FAILED or STALE report
   * never shows a "done" checkmark (Important 3). */
  showDone?: boolean;
}) {
  const { t } = useTranslation();
  const gate = useGate(stage);
  const blocked = gate !== null && !gate.allowed;
  const done = showDone ?? gate?.complete ?? false;
  return (
    <div className={`crown-stage crown-stage--${stage}`} data-testid={`crown-stage-${stage}`} data-complete={done ? 'true' : 'false'}>
      <h3 className="crown-stage__title">
        {title}
        {done && <span className="crown-stage__done" data-testid={`crown-${stage}-done`}> ✓</span>}
        {busy && <span className="crown-stage__busy" data-testid={`crown-${stage}-busy`}> {t('crown.statusRunning')}</span>}
      </h3>
      {blocked && gate?.reason ? (
        <p className="crown-stage__blocked" data-testid={`crown-${stage}-blocked`}>
          {t('crown.blocked', { reason: t(REASON_KEY[gate.reason]) })}
        </p>
      ) : (
        children
      )}
    </div>
  );
}

function InnerSurfaceStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('innerSurface');
  const inner = useCrownStore((state) => state.inner);
  const ghost = useCrownStore((state) => state.innerGhostVisible);
  const [pitchUm, setPitchUm] = useState(20);
  return (
    <StageShell stage="innerSurface" title={t('crown.innerTitle')} busy={busy}>
      <label className="crown-stage__field">
        {t('crown.innerPitchLabel')}
        <input
          type="number"
          min={5}
          step={5}
          value={pitchUm}
          onChange={(event) => setPitchUm(Number(event.target.value))}
          data-testid="crown-inner-pitch"
        />
        <span>µm</span>
      </label>
      <button
        type="button"
        disabled={busy || !gate?.allowed}
        onClick={() => run(() => crownDesignEngine.runInnerSurface({ pitchMm: pitchUm / 1000 }))}
        data-testid="crown-inner-run"
      >
        {t('crown.innerRun')}
      </button>
      {inner && (
        <p className="crown-stage__readout" data-testid="crown-inner-readout">
          {t('crown.innerReadout', { error: um(inner.errorBoundMm), tris: inner.patchTriangleCount, verts: inner.marginVertexCount })}
        </p>
      )}
      <label className="crown-stage__checkbox">
        <input type="checkbox" checked={ghost} onChange={(e) => crownDesignEngine.setInnerGhostVisible(e.target.checked)} data-testid="crown-inner-ghost" />
        {t('crown.innerGhostToggle')}
      </label>
    </StageShell>
  );
}

function AnatomyStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('anatomy');
  const anatomy = useCrownStore((state) => state.anatomy);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [tz, setTz] = useState(0);
  return (
    <StageShell stage="anatomy" title={t('crown.anatomyTitle')} busy={busy}>
      <p className="crown-stage__note">{t('crown.anatomyLibraryNote')}</p>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => crownDesignEngine.placeAnatomyAuto())} data-testid="crown-anatomy-autoplace">
        {t('crown.anatomyAutoPlace')}
      </button>
      {anatomy && (
        <>
          <p className="crown-stage__readout" data-testid="crown-anatomy-readout">
            {t('crown.anatomyReadout', {
              md: anatomy.scaleMesialDistal.toFixed(2),
              bl: anatomy.scaleBuccoLingual.toFixed(2),
              og: anatomy.scaleOcclusoGingival.toFixed(2),
            })}
            {anatomy.usedProximalGap && ` · ${t('crown.anatomyProximalGap')}`}
            {anatomy.antagonistUsed && ` · ${t('crown.anatomyAntagonist')}`}
          </p>
          <fieldset className="crown-stage__manual">
            <legend>{t('crown.anatomyManualTitle')}</legend>
            <label className="crown-stage__field">
              {t('crown.anatomyTranslateX')}
              <input type="number" step={0.1} value={tx} onChange={(e) => setTx(Number(e.target.value))} data-testid="crown-anatomy-tx" />
            </label>
            <label className="crown-stage__field">
              {t('crown.anatomyTranslateY')}
              <input type="number" step={0.1} value={ty} onChange={(e) => setTy(Number(e.target.value))} data-testid="crown-anatomy-ty" />
            </label>
            <label className="crown-stage__field">
              {t('crown.anatomyTranslateZ')}
              <input type="number" step={0.1} value={tz} onChange={(e) => setTz(Number(e.target.value))} data-testid="crown-anatomy-tz" />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => crownDesignEngine.commitAnatomyTransform({ translationMm: [tx, ty, tz] }))}
              data-testid="crown-anatomy-commit"
            >
              {t('crown.anatomyCommit')}
            </button>
          </fieldset>
        </>
      )}
    </StageShell>
  );
}

function MorphStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('morph');
  const morph = useCrownStore((state) => state.morph);
  const strengths = useCrownStore((state) => state.strengths);
  const morphBusy = useCrownStore((state) => state.morphBusy);
  const contactHeatmap = useCrownStore((state) => state.contactHeatmapVisible);

  function onSlide(kind: keyof MorphStrengthsUi, value: number): void {
    const next = { ...strengths, [kind]: value };
    crownDesignEngine.setStrength(kind, value);
    // Live re-solve (resolveMorph) once the plan exists — fire-and-forget.
    if (morph) run(() => crownDesignEngine.previewMorphStrengths(next));
  }

  return (
    <StageShell stage="morph" title={t('crown.morphTitle')} busy={busy}>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => crownDesignEngine.runMorph())} data-testid="crown-morph-run">
        {t('crown.morphRun')}
      </button>
      {morph && (
        <>
          <StrengthSlider label={t('crown.morphStrengthMesial')} testid="crown-morph-mesial" value={strengths.proximalMesial} onChange={(v) => onSlide('proximalMesial', v)} />
          <StrengthSlider label={t('crown.morphStrengthDistal')} testid="crown-morph-distal" value={strengths.proximalDistal} onChange={(v) => onSlide('proximalDistal', v)} />
          <StrengthSlider label={t('crown.morphStrengthAntagonist')} testid="crown-morph-antagonist" value={strengths.antagonist} onChange={(v) => onSlide('antagonist', v)} />
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => crownDesignEngine.commitMorphStrengths(strengths))}
            data-testid="crown-morph-commit"
          >
            {t('crown.morphCommit')}
            {morphBusy && <span data-testid="crown-morph-updating"> {t('crown.morphUpdating')}</span>}
          </button>
          <p className="crown-stage__readout" data-testid="crown-morph-readout">
            {t('crown.morphReadout', {
              residual: morph.maxContactResidualMm !== null ? um(morph.maxContactResidualMm) : '—',
              seal: um(morph.marginSealMaxDeviationMm),
            })}
          </p>
          <label className="crown-stage__checkbox">
            <input type="checkbox" checked={contactHeatmap} onChange={(e) => crownDesignEngine.setContactHeatmapVisible(e.target.checked)} data-testid="crown-morph-contact-toggle" />
            {t('crown.morphContactHeatmapToggle')}
          </label>
        </>
      )}
    </StageShell>
  );
}

function StrengthSlider({ label, testid, value, onChange }: { label: string; testid: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="crown-stage__field">
      {label}
      <input type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testid} />
      <span className="crown-stage__field-value">{value.toFixed(2)}</span>
    </label>
  );
}

function ShellStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('shell');
  const shell = useCrownStore((state) => state.shell);
  const thickness = useCrownStore((state) => state.thicknessHeatmapVisible);
  const [autoThicken, setAutoThicken] = useState(false);
  return (
    <StageShell stage="shell" title={t('crown.shellTitle')} busy={busy}>
      <label className="crown-stage__checkbox">
        <input type="checkbox" checked={autoThicken} onChange={(e) => setAutoThicken(e.target.checked)} data-testid="crown-shell-autothicken" />
        {t('crown.shellAutoThicken')}
      </label>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => crownDesignEngine.constructShell({ autoThicken }))} data-testid="crown-shell-construct">
        {t('crown.shellConstruct')}
      </button>
      {shell && (
        <>
          <p className="crown-stage__readout" data-testid="crown-shell-readout">
            {shell.watertight ? t('crown.shellWatertightYes') : t('crown.shellWatertightNo')} ·{' '}
            {t('crown.shellReadout', { wall: shell.minWallThicknessMm.toFixed(2), volume: shell.volumeMm3.toFixed(1) })}
          </p>
          <label className="crown-stage__checkbox">
            <input type="checkbox" checked={thickness} onChange={(e) => crownDesignEngine.setThicknessHeatmapVisible(e.target.checked)} data-testid="crown-shell-thickness-toggle" />
            {t('crown.shellThicknessToggle')}
          </label>
        </>
      )}
    </StageShell>
  );
}

function FreeformStage({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const gate = useGate('freeform');
  const brush = useCrownStore((state) => state.brush);
  const radius = useCrownStore((state) => state.brushRadiusMm);
  const strength = useCrownStore((state) => state.brushStrength);
  const outerLock = useCrownStore((state) => state.outerLock);
  const sculpt = useCrownStore((state) => state.sculpt);

  const brushes: SculptBrushType[] = ['add', 'remove', 'smooth'];
  const brushLabel: Record<SculptBrushType, string> = {
    add: 'crown.freeformBrushAdd',
    remove: 'crown.freeformBrushRemove',
    smooth: 'crown.freeformBrushSmooth',
  };

  return (
    <StageShell stage="freeform" title={t('crown.freeformTitle')} busy={busy}>
      <div className="crown-stage__brushes">
        {brushes.map((b) => (
          <button key={b} type="button" className={brush === b ? 'is-active' : ''} onClick={() => crownDesignEngine.setBrush(b)} data-testid={`crown-freeform-brush-${b}`}>
            {t(brushLabel[b])}
          </button>
        ))}
      </div>
      <label className="crown-stage__field">
        {t('crown.freeformRadiusLabel')}
        <input type="range" min={0.1} max={2} step={0.05} value={radius} onChange={(e) => crownDesignEngine.setBrushRadius(Number(e.target.value))} data-testid="crown-freeform-radius" />
        <span>{radius.toFixed(2)}</span>
      </label>
      <label className="crown-stage__field">
        {t('crown.freeformStrengthLabel')}
        <input type="range" min={0.01} max={0.5} step={0.01} value={strength} onChange={(e) => crownDesignEngine.setBrushStrength(Number(e.target.value))} data-testid="crown-freeform-strength" />
        <span>{strength.toFixed(2)}</span>
      </label>
      <label className="crown-stage__checkbox" data-testid="crown-freeform-lock">
        <input type="checkbox" checked={outerLock} onChange={(e) => crownDesignEngine.setOuterLock(e.target.checked)} data-testid="crown-freeform-lock-toggle" />
        {outerLock ? t('crown.freeformOuterLockOn') : t('crown.freeformOuterLockOff')}
      </label>
      <button
        type="button"
        disabled={busy || !gate?.allowed}
        onClick={() => run(() => crownDesignEngine.applySculptStroke({ center: [0, 0, 0], radiusMm: radius, strength, brush }))}
        data-testid="crown-freeform-apply"
      >
        {t('crown.freeformApply')}
      </button>
      {sculpt && (
        <p className="crown-stage__readout" data-testid="crown-freeform-readout">
          {t('crown.freeformReadout', { moved: sculpt.movedVertexCount, peak: um(sculpt.peakDisplacementMm) })}
        </p>
      )}
    </StageShell>
  );
}

function QcStage({ busy, restoration }: { busy: boolean; restoration: Restoration | null }) {
  const { t } = useTranslation();
  const gate = useGate('qc');
  const qc = restoration?.qc ?? null;
  // Defense-in-depth (the invalidation cascade normally nulls qc on any edit):
  // if a report somehow survives a geometry change, its journalHash won't match
  // the current finalMesh — render an explicit "stale" state, never a bare
  // green banner for geometry that was never re-checked.
  const stale = restoration !== null && isQcStale(restoration);
  return (
    <StageShell stage="qc" title={t('crown.qcTitle')} busy={busy} showDone={qc?.passed === true && !stale}>
      <button type="button" disabled={busy || !gate?.allowed} onClick={() => run(() => crownDesignEngine.runQc())} data-testid="crown-qc-run">
        {qc ? t('crown.qcRerun') : t('crown.qcRun')}
      </button>
      {qc === null ? (
        <p className="crown-stage__note" data-testid="crown-qc-notrun">
          {t('crown.qcNotRun')}
        </p>
      ) : stale ? (
        <p className="crown-qc__stale" data-testid="crown-qc-stale">
          {t('crown.qcStale')}
        </p>
      ) : (
        <>
          <p className={qc.passed ? 'crown-qc__passed' : 'crown-qc__failed'} data-testid={qc.passed ? 'crown-qc-passed' : 'crown-qc-failed'}>
            {qc.passed ? t('crown.qcPassed') : t('crown.qcFailed')}
          </p>
          <table className="crown-qc__table" data-testid="crown-qc-table">
            <tbody>
              {qc.gates.map((g) => (
                <tr key={g.gate} data-testid={`crown-qc-gate-${g.gate}`} data-passed={g.passed ? 'true' : 'false'}>
                  <td>{g.gate}</td>
                  <td>
                    {g.passed ? t('crown.qcGatePass') : g.acknowledged ? t('crown.qcAcknowledged') : t('crown.qcGateFail')}
                    {g.value !== null && g.unit ? ` (${g.value.toFixed(3)} ${g.unit})` : ''}
                  </td>
                  <td>
                    {!g.passed && !g.acknowledged && (
                      <button type="button" disabled={busy} onClick={() => run(() => crownDesignEngine.acknowledgeGate(g.gate))} data-testid={`crown-qc-ack-${g.gate}`}>
                        {t('crown.qcAcknowledge')}
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
