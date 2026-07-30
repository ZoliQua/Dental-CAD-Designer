import { useTranslation } from 'react-i18next';
import { saveActiveCase } from '../engine/persistence';
import { usePersistenceStore } from '../state/persistenceStore';
import { LanguagePicker } from './LanguagePicker';
import { ThemeToggle } from './ThemeToggle';

/** Task 11: save status label — 'idle'/'saved'/'saving'/'unsaved'/'error'
 * (state/persistenceStore.ts's `SaveStatus`), with the failed save's error
 * message interpolated for the 'error' case.
 *
 * Phase 8 Task 4: when there are un-synced-to-server edits ('unsaved'/'error')
 * that the crash-safe LOCAL layer HAS captured (`localBackupAt` set), a small
 * "backed up locally" hint is shown ALONGSIDE the server status — the local
 * protection is visible without ever misrepresenting a not-yet-server-saved
 * state as 'saved' (the server status stays authoritative). */
function SaveStatusIndicator() {
  const { t } = useTranslation();
  const status = usePersistenceStore((state) => state.status);
  const errorMessage = usePersistenceStore((state) => state.errorMessage);
  const localBackupAt = usePersistenceStore((state) => state.localBackupAt);

  const label =
    status === 'error'
      ? t('persistence.status.error', { message: errorMessage ?? '' })
      : t(`persistence.status.${status}`);

  const showLocalBackupHint =
    localBackupAt !== null && (status === 'unsaved' || status === 'error');

  return (
    <span
      className={`app-header__save-status app-header__save-status--${status}`}
      data-testid="save-status"
    >
      {label}
      {showLocalBackupHint ? (
        <span className="app-header__local-backup-hint" data-testid="local-backup-hint">
          {t('persistence.localBackupHint')}
        </span>
      ) : null}
    </span>
  );
}

export function Header() {
  const { t } = useTranslation();
  const activeCaseName = usePersistenceStore((state) => state.activeCaseName);
  const status = usePersistenceStore((state) => state.status);

  function handleOpenPicker(): void {
    usePersistenceStore.getState().setPickerOpen(true);
  }

  return (
    <header className="app-header">
      <h1 className="app-header__title" data-testid="app-title">
        {t('app.title')}
      </h1>
      <div className="app-header__case">
        <span className="app-header__case-name" data-testid="active-case-name">
          {activeCaseName ?? t('persistence.noCaseOpen')}
        </span>
        <button
          type="button"
          className="app-header__open-case-button"
          data-testid="open-case-picker-button"
          onClick={handleOpenPicker}
        >
          {t('persistence.openCaseButton')}
        </button>
        <button
          type="button"
          className="app-header__save-button"
          data-testid="save-button"
          disabled={status === 'idle' || status === 'saving'}
          onClick={() => void saveActiveCase()}
        >
          {t('persistence.saveButton')}
        </button>
        <SaveStatusIndicator />
      </div>
      <div className="app-header__controls">
        <LanguagePicker />
        <ThemeToggle />
      </div>
    </header>
  );
}
