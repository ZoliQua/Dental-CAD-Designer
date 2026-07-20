// apps/client/src/ui/MarginPanel.tsx
//
// Margin editor panel (Phase 3 Task 5): pick a restoration + (abutment)
// tooth, choose auto-propose vs manual mode, show propose progress /
// NoRidgeFoundError/NoClosureError guidance, the current anchor count, the
// close/open/save/accept/delete actions, and the unresolved-anchor re-snap
// banner. Pure React/DOM — all computation lives in engine/marginEditor.ts;
// this component only calls its exported actions and reads
// state/marginStore.ts (same "ui never mutates the snapshot directly" rule
// as every other panel — e.g. ui/AlignmentPanel.tsx).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FdiTooth } from '@dqcad/shared-types';
import { marginEditor, type MarginErrorKind } from '../engine/marginEditor';
import { useCaseStore } from '../state/caseStore';
import { useMarginStore, type MarginToolMode } from '../state/marginStore';

function errorGuidanceKey(kind: MarginErrorKind | null): string {
  if (kind === 'noRidgeFound') return 'margin.errorNoRidgeFound';
  if (kind === 'noClosure') return 'margin.errorNoClosure';
  return 'margin.errorOther';
}

export function MarginPanel() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const phase = useMarginStore((state) => state.phase);
  const mode = useMarginStore((state) => state.mode);
  const anchors = useMarginStore((state) => state.anchors);
  const closed = useMarginStore((state) => state.closed);
  const humanEdited = useMarginStore((state) => state.humanEdited);
  const progress = useMarginStore((state) => state.progress);
  const error = useMarginStore((state) => state.error);
  const unresolvedAnchorCount = useMarginStore((state) => state.unresolvedAnchorCount);
  const selectedAnchorIndex = useMarginStore((state) => state.selectedAnchorIndex);
  const tooth = useMarginStore((state) => state.tooth);

  const [pendingRestorationId, setPendingRestorationId] = useState('');
  const [pendingTooth, setPendingTooth] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  const restorations = document.restorations;
  const selectedRestoration = restorations.find((r) => r.id === pendingRestorationId);
  const abutmentTeeth = selectedRestoration
    ? selectedRestoration.teeth.filter((tt) => !selectedRestoration.pontics.includes(tt))
    : [];

  function handleStart(): void {
    if (!pendingRestorationId || !pendingTooth) return;
    setStartError(null);
    try {
      marginEditor.startForTooth(pendingRestorationId, Number(pendingTooth) as FdiTooth);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleCancel(): void {
    marginEditor.cancel();
    setPendingRestorationId('');
    setPendingTooth('');
    setStartError(null);
  }

  function handleModeChange(nextMode: MarginToolMode): void {
    marginEditor.setMode(nextMode);
  }

  if (phase === 'idle') {
    return (
      <section className="margin-panel" data-testid="margin-panel">
        <h2 className="margin-panel__title">{t('margin.panelTitle')}</h2>
        {restorations.length === 0 ? (
          <p className="margin-panel__empty">{t('margin.needsRestoration')}</p>
        ) : (
          <div className="margin-panel__selectors">
            <label className="margin-panel__field">
              {t('margin.restorationLabel')}
              <select
                value={pendingRestorationId}
                onChange={(event) => {
                  setPendingRestorationId(event.target.value);
                  setPendingTooth('');
                }}
                data-testid="margin-restoration-select"
              >
                <option value="">{t('margin.selectPlaceholder')}</option>
                {restorations.map((r) => (
                  <option key={r.id} value={r.id}>
                    {t(`restoration.type.${r.type}`)} ({r.teeth.join(', ')})
                  </option>
                ))}
              </select>
            </label>
            <label className="margin-panel__field">
              {t('margin.toothLabel')}
              <select
                value={pendingTooth}
                onChange={(event) => setPendingTooth(event.target.value)}
                data-testid="margin-tooth-select"
                disabled={!selectedRestoration}
              >
                <option value="">{t('margin.selectPlaceholder')}</option>
                {abutmentTeeth.map((tt) => (
                  <option key={tt} value={tt}>
                    {tt}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="margin-panel__start-button"
              onClick={handleStart}
              disabled={!pendingRestorationId || !pendingTooth || !selectedRestoration?.targetNodeId}
              data-testid="margin-start-button"
            >
              {t('margin.startButton')}
            </button>
            {selectedRestoration && !selectedRestoration.targetNodeId && (
              <p className="margin-panel__error">{t('margin.needsTargetScan')}</p>
            )}
            {startError && <p className="margin-panel__error">{startError}</p>}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="margin-panel" data-testid="margin-panel">
      <h2 className="margin-panel__title">{t('margin.panelTitle')}</h2>
      <p className="margin-panel__tooth" data-testid="margin-active-tooth">
        {t('margin.editingTooth', { tooth })}
      </p>

      {unresolvedAnchorCount > 0 && (
        <div className="margin-panel__unresolved" data-testid="margin-unresolved-banner">
          <p>{t('margin.unresolvedAnchors', { count: unresolvedAnchorCount })}</p>
          <button
            type="button"
            onClick={() => void marginEditor.reSnapUnresolvedAnchors()}
            data-testid="margin-resnap-button"
          >
            {t('margin.resnapButton')}
          </button>
        </div>
      )}

      {phase === 'proposing' && (
        <div
          className="margin-panel__progress"
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          data-testid="margin-progress"
        >
          <div className="margin-panel__progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          <span>{t('margin.proposing')}</span>
        </div>
      )}

      {error && (
        // Deliberately NOT gated on `phase` (marginStore.ts's
        // `MarginToolPhase` doc: a propose failure stays 'active', not a
        // separate 'error' phase) — the guidance stays visible while the
        // tool is immediately usable again (manual mode).
        <p className="margin-panel__error" data-testid="margin-error">
          {t(errorGuidanceKey(marginEditor.getErrorKind()), { message: error })}
        </p>
      )}

      {phase === 'active' && unresolvedAnchorCount === 0 && (
        <>
          {anchors.length === 0 && (
            <div className="margin-panel__mode" data-testid="margin-mode-selector">
              <button
                type="button"
                className={mode === 'auto' ? 'margin-panel__mode-button--active' : ''}
                onClick={() => handleModeChange('auto')}
                data-testid="margin-mode-auto"
              >
                {t('margin.modeAuto')}
              </button>
              <button
                type="button"
                className={mode === 'manual' ? 'margin-panel__mode-button--active' : ''}
                onClick={() => handleModeChange('manual')}
                data-testid="margin-mode-manual"
              >
                {t('margin.modeManual')}
              </button>
              <p className="margin-panel__hint">{mode === 'auto' ? t('margin.autoHint') : t('margin.manualHint')}</p>
            </div>
          )}

          {anchors.length > 0 && (
            <p className="margin-panel__count" data-testid="margin-anchor-count">
              {t('margin.anchorCount', { count: anchors.length })}
            </p>
          )}

          {!humanEdited && anchors.length > 0 && (
            <button type="button" onClick={() => void marginEditor.acceptProposal()} data-testid="margin-accept-button">
              {t('margin.acceptProposalButton')}
            </button>
          )}

          {!closed && anchors.length >= 3 && (
            <button type="button" onClick={() => void marginEditor.toggleClosed()} data-testid="margin-close-button">
              {t('margin.closeButton')}
            </button>
          )}
          {!closed && anchors.length >= 2 && (
            <button type="button" onClick={() => void marginEditor.saveOpenTrace()} data-testid="margin-save-open-button">
              {t('margin.saveOpenButton')}
            </button>
          )}
          {closed && (
            <button type="button" onClick={() => void marginEditor.toggleClosed()} data-testid="margin-open-button">
              {t('margin.openButton')}
            </button>
          )}

          {selectedAnchorIndex !== null && (
            <button
              type="button"
              onClick={() => void marginEditor.deleteSelectedAnchor()}
              data-testid="margin-delete-anchor-button"
            >
              {t('margin.deleteAnchorButton')}
            </button>
          )}
        </>
      )}

      <button type="button" className="margin-panel__cancel-button" onClick={handleCancel} data-testid="margin-cancel-button">
        {t('margin.cancelButton')}
      </button>
    </section>
  );
}
