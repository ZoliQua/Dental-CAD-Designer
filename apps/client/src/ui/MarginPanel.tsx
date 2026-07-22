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
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FdiTooth } from '@dqcad/shared-types';
import {
  MARGIN_PROPOSAL_ANCHOR_COUNT_MAX,
  MARGIN_PROPOSAL_ANCHOR_COUNT_MIN,
  marginEditor,
  type MarginErrorKind,
} from '../engine/marginEditor';
import { useCaseStore } from '../state/caseStore';
import { useMarginStore, type MarginHardFailureKind, type MarginToolMode } from '../state/marginStore';

function errorGuidanceKey(kind: MarginErrorKind | null): string {
  if (kind === 'noRidgeFound') return 'margin.errorNoRidgeFound';
  if (kind === 'noClosure') return 'margin.errorNoClosure';
  return 'margin.errorOther';
}

/** Maps a `MarginHardFailureKind` (state/marginStore.ts) to its i18n key —
 * same "typed kind -> key" convention as `errorGuidanceKey` above. */
function hardFailureReasonKey(kind: MarginHardFailureKind): string {
  switch (kind) {
    case 'open':
      return 'margin.validation.reasonOpen';
    case 'selfIntersecting':
      return 'margin.validation.reasonSelfIntersecting';
    case 'offSurface':
      return 'margin.validation.reasonOffSurface';
    case 'degenerate':
      return 'margin.validation.reasonDegenerate';
  }
}

type MarginBadgeStatus = 'checking' | 'valid' | 'warning' | 'invalid';

function badgeStatusKey(status: MarginBadgeStatus): string {
  switch (status) {
    case 'valid':
      return 'margin.validation.badgeValid';
    case 'warning':
      return 'margin.validation.badgeWarnings';
    case 'invalid':
      return 'margin.validation.badgeInvalid';
    case 'checking':
      return 'margin.validation.checking';
  }
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
  const selectedAnchorIndices = useMarginStore((state) => state.selectedAnchorIndices);
  const proposalTargetAnchorCount = useMarginStore((state) => state.proposalTargetAnchorCount);
  const tooth = useMarginStore((state) => state.tooth);
  const validation = useMarginStore((state) => state.validation);
  const validationBusy = useMarginStore((state) => state.validationBusy);
  const confirmed = useMarginStore((state) => state.confirmed);

  const [pendingRestorationId, setPendingRestorationId] = useState('');
  const [pendingTooth, setPendingTooth] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  // `true` once `confirmMargin()` reports `requiresAcknowledgement: true` —
  // shows the "Acknowledge warnings and confirm" secondary action. Reset on
  // ANY anchor-list/closed change (a new edit invalidates whatever warnings
  // were about to be acknowledged — the user must re-confirm against the
  // FRESH geometry, not blindly acknowledge stale findings).
  const [pendingAcknowledge, setPendingAcknowledge] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    setPendingAcknowledge(false);
    setConfirmError(null);
  }, [anchors, closed]);

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

  const badgeStatus: MarginBadgeStatus = !validation ? 'checking' : validation.blocked ? 'invalid' : validation.hasWarnings ? 'warning' : 'valid';

  async function handleConfirm(acknowledgeWarnings: boolean): Promise<void> {
    setConfirmError(null);
    try {
      let outcome = await marginEditor.confirmMargin({ acknowledgeWarnings });
      // `stale: true` (Task-11-review Critical 3): a drag (or other edit)
      // committed newer geometry WHILE this confirm's validation was in
      // flight — `confirmMargin` deliberately journaled nothing rather than
      // risk clobbering that commit (see its own doc). The race window is
      // just one validation round trip, so a single immediate retry against
      // the now-settled anchors is expected to succeed and is transparent
      // to the user — no need to surface this as an error or make them
      // click confirm again themselves.
      if (outcome.stale) {
        outcome = await marginEditor.confirmMargin({ acknowledgeWarnings });
      }
      setPendingAcknowledge(outcome.requiresAcknowledgement);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
    }
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
              {mode === 'auto' && (
                // Anchor-count slider (Phase 3 editor-enhancement task 1) —
                // only meaningful BEFORE a proposal runs (this whole block is
                // already gated on anchors.length === 0); the chosen value is
                // journaled with the proposal (engine/marginEditor.ts's
                // `commit()`, `proposalDefaults.targetAnchorCount`). The
                // target is APPROXIMATE (curvature-adaptive — see the
                // kernel's `ProposeMarginLoopOptions.targetAnchorCount` doc),
                // hence the "≈" hint wording.
                <label className="margin-panel__field margin-panel__anchor-count" data-testid="margin-anchor-count-field">
                  {t('margin.targetAnchorCountLabel', { count: proposalTargetAnchorCount })}
                  <input
                    type="range"
                    min={MARGIN_PROPOSAL_ANCHOR_COUNT_MIN}
                    max={MARGIN_PROPOSAL_ANCHOR_COUNT_MAX}
                    step={1}
                    value={proposalTargetAnchorCount}
                    onChange={(event) => marginEditor.setProposalTargetAnchorCount(Number(event.target.value))}
                    data-testid="margin-anchor-count-slider"
                  />
                  <span className="margin-panel__hint">{t('margin.targetAnchorCountHint')}</span>
                </label>
              )}
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

          {selectedAnchorIndex !== null && selectedAnchorIndices.size === 0 && (
            <button
              type="button"
              onClick={() => void marginEditor.deleteSelectedAnchor()}
              data-testid="margin-delete-anchor-button"
            >
              {t('margin.deleteAnchorButton')}
            </button>
          )}
          {selectedAnchorIndices.size > 0 && (
            // Bulk delete (Phase 3 editor-enhancement task 2) — ONE
            // coalesced journal op for the whole shift-click selection; see
            // engine/marginEditor.ts's `deleteSelectedAnchors()`.
            <button
              type="button"
              onClick={() => void marginEditor.deleteSelectedAnchors()}
              data-testid="margin-delete-selected-button"
            >
              {t('margin.deleteSelectedButton', { count: selectedAnchorIndices.size })}
            </button>
          )}
          {anchors.length > 0 && <p className="margin-panel__hint">{t('margin.multiSelectHint')}</p>}

          {anchors.length > 0 && (
            <div className="margin-panel__validation" data-testid="margin-validation-badge" data-status={badgeStatus}>
              <p className="margin-panel__validation-status">{t(badgeStatusKey(badgeStatus))}</p>
              {validation && validation.hardFailureKinds.length > 0 && (
                <ul className="margin-panel__validation-reasons" data-testid="margin-validation-hard-failures">
                  {validation.hardFailureKinds.map((kind) => (
                    <li key={kind}>{t(hardFailureReasonKey(kind))}</li>
                  ))}
                </ul>
              )}
              {validation && validation.hasWarnings && (
                <p className="margin-panel__validation-warning" data-testid="margin-validation-smoothness-warning">
                  {t('margin.validation.reasonSmoothness', { count: validation.smoothnessWarningCount })}
                </p>
              )}
              {confirmed && (
                <p className="margin-panel__validation-confirmed" data-testid="margin-confirmed-indicator">
                  {t('margin.validation.confirmedLabel')}
                </p>
              )}
              {/* Phase 3 Task 7: DEV-ONLY reference-margin export — same
                  `import.meta.env.DEV` gate as engine/testHooks.ts's
                  `installTestHooksIfDev` (this repo's one other "dev-only
                  surface" precedent), so this button (and the file-download
                  side effect it triggers) never ships in a `vite build`
                  production bundle. Disabled whenever `!confirmed` — mirrors
                  `marginEditor.exportReferenceMargin()`'s own no-op guard
                  (defense in depth, not the only enforcement). */}
              {import.meta.env.DEV && (
                <button
                  type="button"
                  onClick={() => marginEditor.exportReferenceMargin()}
                  disabled={!confirmed}
                  data-testid="margin-export-reference-button"
                >
                  {t('margin.validation.exportReferenceButton')}
                </button>
              )}
              {confirmError && <p className="margin-panel__error">{confirmError}</p>}
              <button
                type="button"
                onClick={() => void handleConfirm(false)}
                disabled={!validation || validation.blocked || validationBusy}
                data-testid="margin-confirm-button"
              >
                {t('margin.validation.confirmButton')}
              </button>
              {pendingAcknowledge && (
                <button
                  type="button"
                  onClick={() => void handleConfirm(true)}
                  disabled={validationBusy}
                  data-testid="margin-acknowledge-confirm-button"
                >
                  {t('margin.validation.acknowledgeAndConfirmButton')}
                </button>
              )}
            </div>
          )}
        </>
      )}

      <button type="button" className="margin-panel__cancel-button" onClick={handleCancel} data-testid="margin-cancel-button">
        {t('margin.cancelButton')}
      </button>
    </section>
  );
}
