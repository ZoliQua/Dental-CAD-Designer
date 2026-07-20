// Alignment panel (Phase 3 Task 3) — pick an overlap-mode preset (fix batch:
// "Full overlap" / "Partial overlap", see engine/alignment.ts's
// `OVERLAP_MODE_*` doc — DEFAULTS to partial, this tool's primary clinical
// use being bite/situ registration), pick mesh A (to move) and B (fixed
// target) from the scene tree, pick 3 point pairs alternating clicks on the
// two meshes (engine/alignment.ts's `handlePick`, routed here from
// ui/Viewport.tsx exactly like the measurement tool), run coarse+ICP
// registration with a progress bar, show RMS (µm) + inlier % + convergence,
// and require an EXPLICIT "Confirm" click before anything is written to the
// case document (no silent apply — Task 3 brief). Pure React/DOM — all
// computation lives in engine/alignment.ts; this component only calls its
// exported actions and reads state/alignmentStore.ts (same "ui never
// mutates the snapshot directly" rule as every other panel in this file).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SceneNode } from '@dqcad/shared-types';
import { alignmentEngine, type AlignmentOverlapMode } from '../engine/alignment';
import { useCaseStore } from '../state/caseStore';
import { useAlignmentStore } from '../state/alignmentStore';

const MM_TO_UM = 1000;

function formatUm(mm: number): string {
  return `${Math.round(mm * MM_TO_UM)} µm`;
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function AlignmentPanel() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const phase = useAlignmentStore((state) => state.phase);
  const overlapMode = useAlignmentStore((state) => state.overlapMode);
  const pairCount = useAlignmentStore((state) => state.pairCount);
  const awaitingSide = useAlignmentStore((state) => state.awaitingSide);
  const progress = useAlignmentStore((state) => state.progress);
  const result = useAlignmentStore((state) => state.result);
  const error = useAlignmentStore((state) => state.error);

  const [pendingSrcId, setPendingSrcId] = useState('');
  const [pendingDstId, setPendingDstId] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  const idle = phase === 'idle';
  const running = phase === 'running';
  const active = phase !== 'idle';

  function meshName(node: SceneNode): string {
    return document.meshes.find((mesh) => mesh.id === node.meshId)?.name ?? node.meshId;
  }

  function handleStart(): void {
    if (!pendingSrcId || !pendingDstId) return;
    setStartError(null);
    try {
      alignmentEngine.startPicking(pendingSrcId, pendingDstId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleOverlapModeChange(mode: AlignmentOverlapMode): void {
    alignmentEngine.setOverlapMode(mode);
  }

  function handleCancel(): void {
    alignmentEngine.cancel();
    setPendingSrcId('');
    setPendingDstId('');
    setStartError(null);
  }

  function handleRun(): void {
    void alignmentEngine.run();
  }

  function handleConfirm(): void {
    alignmentEngine.confirm();
    setPendingSrcId('');
    setPendingDstId('');
  }

  if (document.scene.length < 2) {
    return (
      <section className="alignment-panel" data-testid="alignment-panel">
        <h2 className="alignment-panel__title">{t('alignment.panelTitle')}</h2>
        <p className="alignment-panel__empty">{t('alignment.needsTwoMeshes')}</p>
      </section>
    );
  }

  return (
    <section className="alignment-panel" data-testid="alignment-panel">
      <h2 className="alignment-panel__title">{t('alignment.panelTitle')}</h2>

      {idle && (
        <div className="alignment-panel__selectors">
          <label className="alignment-panel__field">
            {t('alignment.overlapModeLabel')}
            <select
              value={overlapMode}
              onChange={(event) => handleOverlapModeChange(event.target.value as AlignmentOverlapMode)}
              data-testid="alignment-overlap-mode-select"
            >
              <option value="partial">{t('alignment.overlapModePartial')}</option>
              <option value="full">{t('alignment.overlapModeFull')}</option>
            </select>
          </label>
          <label className="alignment-panel__field">
            {t('alignment.meshSrcLabel')}
            <select
              value={pendingSrcId}
              onChange={(event) => setPendingSrcId(event.target.value)}
              data-testid="alignment-mesh-src-select"
            >
              <option value="">{t('alignment.selectPlaceholder')}</option>
              {document.scene.map((node) => (
                <option key={node.id} value={node.id}>
                  {meshName(node)}
                </option>
              ))}
            </select>
          </label>
          <label className="alignment-panel__field">
            {t('alignment.meshDstLabel')}
            <select
              value={pendingDstId}
              onChange={(event) => setPendingDstId(event.target.value)}
              data-testid="alignment-mesh-dst-select"
            >
              <option value="">{t('alignment.selectPlaceholder')}</option>
              {document.scene.map((node) => (
                <option key={node.id} value={node.id}>
                  {meshName(node)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="alignment-panel__start-button"
            onClick={handleStart}
            disabled={!pendingSrcId || !pendingDstId || pendingSrcId === pendingDstId}
            data-testid="alignment-start-button"
          >
            {t('alignment.startButton')}
          </button>
          {startError && <p className="alignment-panel__error">{startError}</p>}
        </div>
      )}

      {active && (
        <div className="alignment-panel__session" data-testid="alignment-session">
          {(phase === 'pickingPairs' || phase === 'ready') && (
            <p className="alignment-panel__instruction" data-testid="alignment-instruction">
              {phase === 'ready'
                ? t('alignment.readyInstruction')
                : t('alignment.pickInstruction', {
                    picked: pairCount,
                    side: t(awaitingSide === 'src' ? 'alignment.sideSrc' : 'alignment.sideDst'),
                  })}
            </p>
          )}

          {phase === 'ready' && (
            <button type="button" className="alignment-panel__run-button" onClick={handleRun} data-testid="alignment-run-button">
              {t('alignment.runButton')}
            </button>
          )}

          {running && (
            <div
              className="alignment-panel__progress"
              role="progressbar"
              aria-valuenow={Math.round(progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              data-testid="alignment-progress"
            >
              <div className="alignment-panel__progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              <span>{t('alignment.running')}</span>
            </div>
          )}

          {phase === 'error' && error && (
            <p className="alignment-panel__error" data-testid="alignment-error">
              {t('alignment.runError', { message: error })}
            </p>
          )}

          {phase === 'preview' && result && (
            <div className="alignment-panel__result" data-testid="alignment-result">
              <dl className="alignment-panel__stats">
                <dt>{t('alignment.rmsLabel')}</dt>
                <dd data-testid="alignment-rms">{formatUm(result.rmsMm)}</dd>
                <dt>{t('alignment.inlierLabel')}</dt>
                <dd data-testid="alignment-inliers">{formatPercent(result.inlierFraction)}</dd>
                <dt>{t('alignment.iterationsLabel')}</dt>
                <dd data-testid="alignment-iterations">{result.iterations}</dd>
              </dl>
              <p className="alignment-panel__converged" data-testid="alignment-converged">
                {t(result.converged ? 'alignment.convergedYes' : 'alignment.convergedNo')}
              </p>
              <p className="alignment-panel__confirm-help">{t('alignment.confirmHelp')}</p>
              <button
                type="button"
                className="alignment-panel__confirm-button"
                onClick={handleConfirm}
                data-testid="alignment-confirm-button"
              >
                {t('alignment.confirmButton')}
              </button>
            </div>
          )}

          <button type="button" className="alignment-panel__cancel-button" onClick={handleCancel} data-testid="alignment-cancel-button">
            {phase === 'preview' ? t('alignment.cancelPreviewButton') : t('alignment.cancelButton')}
          </button>
        </div>
      )}
    </section>
  );
}
