// apps/client/src/ui/RecoveryPrompt.tsx
//
// Phase 8 Task 4 — the crash-recovery prompt. A modal shown at launch when the
// previous session left recoverable un-synced work (or a corrupt snapshot). Pure
// presentation: it reads state/recoveryStore.ts and calls engine/recovery.ts's
// actions. Both Restore and Discard are EXPLICIT choices — Escape/backdrop do
// NOT dismiss (a data-loss decision must be made deliberately), so onEscape is a
// no-op. i18n ×4; a11y: role=dialog + aria-modal + focus trap.
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { acceptRecovery, dismissRecovery } from '../engine/recovery';
import { useRecoveryStore } from '../state/recoveryStore';
import { useFocusTrap } from './actions/useFocusTrap';

export function RecoveryPrompt() {
  const { t } = useTranslation();
  const kind = useRecoveryStore((state) => state.kind);
  const info = useRecoveryStore((state) => state.info);
  const detail = useRecoveryStore((state) => state.detail);
  const dialogRef = useRef<HTMLDivElement>(null);

  // A critical data decision — Escape must not silently dismiss it.
  const noEscape = useCallback(() => {}, []);
  useFocusTrap(dialogRef, kind !== 'hidden', noEscape);

  if (kind === 'hidden') {
    return null;
  }

  const restoring = kind === 'restoring';
  const corrupt = kind === 'corrupt';

  return (
    <div className="recovery-prompt__backdrop" data-testid="recovery-prompt-backdrop">
      <div
        ref={dialogRef}
        className="recovery-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-prompt-title"
        data-testid="recovery-prompt"
        tabIndex={-1}
      >
        <h2 id="recovery-prompt-title" className="recovery-prompt__title">
          {corrupt ? t('recovery.corruptTitle') : t('recovery.title')}
        </h2>

        {corrupt ? (
          <p className="recovery-prompt__body" data-testid="recovery-prompt-corrupt">
            {t('recovery.corruptBody')}
          </p>
        ) : (
          <>
            <p className="recovery-prompt__body">{t('recovery.body')}</p>
            {info !== null ? (
              <dl className="recovery-prompt__meta" data-testid="recovery-prompt-meta">
                <div className="recovery-prompt__meta-row">
                  <dt>{t('recovery.caseLabel')}</dt>
                  <dd data-testid="recovery-prompt-case-name">{info.caseName}</dd>
                </div>
                <div className="recovery-prompt__meta-row">
                  <dt>{t('recovery.savedAtLabel')}</dt>
                  <dd>{t('recovery.savedAtValue', { date: info.snapshotAt })}</dd>
                </div>
                <div className="recovery-prompt__meta-row">
                  <dt>{t('recovery.operationsLabel')}</dt>
                  <dd>{t('recovery.operationsValue', { count: info.journalOperationCount })}</dd>
                </div>
              </dl>
            ) : null}
          </>
        )}

        {kind === 'error' ? (
          <p className="recovery-prompt__error" data-testid="recovery-prompt-error">
            {t('recovery.restoreFailed', { message: detail ?? '' })}
          </p>
        ) : null}

        <div className="recovery-prompt__actions">
          {corrupt ? (
            <button
              type="button"
              className="recovery-prompt__button recovery-prompt__button--primary"
              data-testid="recovery-prompt-acknowledge"
              onClick={() => void dismissRecovery()}
            >
              {t('recovery.acknowledgeButton')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="recovery-prompt__button"
                data-testid="recovery-prompt-discard"
                disabled={restoring}
                onClick={() => void dismissRecovery()}
              >
                {t('recovery.discardButton')}
              </button>
              <button
                type="button"
                className="recovery-prompt__button recovery-prompt__button--primary"
                data-testid="recovery-prompt-restore"
                disabled={restoring}
                onClick={() => void acceptRecovery()}
              >
                {restoring ? t('recovery.restoringButton') : t('recovery.restoreButton')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
