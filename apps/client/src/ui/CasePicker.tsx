// Case picker (Task 11): list/open/create/rename — a modal panel over the
// existing GET /api/cases listing plus this task's new open/create/rename
// actions (engine/persistence.ts). Pure React/DOM, same "engine owns
// network + state, ui only calls exported actions" pattern as
// ImportPanel.tsx's relationship to engine/importer.ts.
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createCase, listCases, openCase, renameCase } from '../engine/persistence';
import { type CaseSummary, usePersistenceStore } from '../state/persistenceStore';

export function CasePicker() {
  const { t } = useTranslation();
  const isOpen = usePersistenceStore((state) => state.isPickerOpen);
  const cases = usePersistenceStore((state) => state.cases);
  const casesLoading = usePersistenceStore((state) => state.casesLoading);
  const casesError = usePersistenceStore((state) => state.casesError);
  const activeCaseId = usePersistenceStore((state) => state.activeCaseId);
  const [newCaseName, setNewCaseName] = useState('');
  const [creating, setCreating] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (isOpen) {
      void listCases();
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  function close(): void {
    usePersistenceStore.getState().setPickerOpen(false);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = newCaseName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await createCase(name);
      setNewCaseName('');
      close();
    } finally {
      setCreating(false);
    }
  }

  async function handleOpen(id: string, name: string): Promise<void> {
    if (openingId) return;
    setOpeningId(id);
    try {
      await openCase(id, name);
      close();
    } finally {
      setOpeningId(null);
    }
  }

  function startRename(caseSummary: CaseSummary): void {
    setRenamingId(caseSummary.id);
    setRenameValue(caseSummary.name);
  }

  async function submitRename(event: FormEvent<HTMLFormElement>, id: string): Promise<void> {
    event.preventDefault();
    const name = renameValue.trim();
    if (!name) return;
    await renameCase(id, name);
    setRenamingId(null);
  }

  return (
    <div className="case-picker__backdrop">
      <div className="case-picker" role="dialog" aria-modal="true" data-testid="case-picker">
        <div className="case-picker__header">
          <h2 className="case-picker__title">{t('persistence.picker.title')}</h2>
          <button type="button" className="case-picker__close-button" onClick={close}>
            {t('persistence.picker.closeButton')}
          </button>
        </div>

        <form className="case-picker__create-form" onSubmit={(event) => void handleCreate(event)}>
          <input
            type="text"
            value={newCaseName}
            onChange={(event) => setNewCaseName(event.target.value)}
            placeholder={t('persistence.picker.newCaseNamePlaceholder')}
            data-testid="case-picker-new-case-name"
          />
          <button type="submit" disabled={creating || newCaseName.trim().length === 0}>
            {t('persistence.picker.createButton')}
          </button>
        </form>

        {casesLoading && <p className="case-picker__loading">{t('persistence.picker.loading')}</p>}
        {casesError && (
          <p className="case-picker__error">{t('persistence.picker.errorLabel', { message: casesError })}</p>
        )}
        {!casesLoading && cases.length === 0 && !casesError && (
          <p className="case-picker__empty">{t('persistence.picker.empty')}</p>
        )}

        <ul className="case-picker__list">
          {cases.map((caseSummary) => (
            <li key={caseSummary.id} className="case-picker__row" data-testid="case-picker-row">
              {renamingId === caseSummary.id ? (
                <form
                  className="case-picker__rename-form"
                  onSubmit={(event) => void submitRename(event, caseSummary.id)}
                >
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    autoFocus
                    data-testid="case-picker-rename-input"
                  />
                  <button type="submit">{t('persistence.picker.renameButton')}</button>
                </form>
              ) : (
                <>
                  <span className="case-picker__name">
                    {caseSummary.name}
                    {caseSummary.id === activeCaseId && (
                      <span className="case-picker__active-badge">{t('persistence.picker.activeLabel')}</span>
                    )}
                  </span>
                  <span className="case-picker__updated-at">
                    {t('persistence.picker.updatedAtLabel', { date: caseSummary.updatedAt })}
                  </span>
                  <button
                    type="button"
                    disabled={openingId !== null}
                    onClick={() => void handleOpen(caseSummary.id, caseSummary.name)}
                  >
                    {t('persistence.picker.openButton')}
                  </button>
                  <button type="button" onClick={() => startRename(caseSummary)}>
                    {t('persistence.picker.renameButton')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
