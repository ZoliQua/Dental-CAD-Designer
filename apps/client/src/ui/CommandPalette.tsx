// Phase 8 Task 2 — command palette (Cmd/Ctrl+K). Renders the SAME registry
// (getAppActions) the global shortcuts + help overlay read — no second source
// of truth. Fuzzy-searchable, keyboard-driven (↑/↓ move, Enter runs, Esc
// closes), a11y: role=dialog + aria-modal, a combobox input driving a listbox
// via aria-activedescendant, focus trap, disabled actions honestly greyed
// (19b — a disabled action never runs, from click OR Enter).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiOverlayStore } from '../state/uiOverlayStore';
import { fuzzyMatch } from './actions/fuzzy';
import {
  getAppActions,
  isActionEnabled,
  type AppAction,
} from './actions/registry';
import { useFocusTrap } from './actions/useFocusTrap';

const LISTBOX_ID = 'command-palette-listbox';
const optionId = (actionId: string): string => `command-palette-option-${actionId}`;

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useUiOverlayStore((state) => state.commandPaletteOpen);
  const close = useUiOverlayStore((state) => state.closeCommandPalette);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useFocusTrap(dialogRef, open, close);

  // Reset the query + highlight and focus the search box each time the palette
  // opens (so a re-open always starts clean).
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Focus after the focus trap's initial focus settles.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open]);

  // Ranked, filtered view of the ONE registry. Stable sort keeps registry
  // order for equal scores (Array.prototype.sort is stable) — deterministic.
  const results = useMemo(() => {
    return getAppActions()
      .map((action) => ({ action, label: t(action.labelKey) }))
      .map((entry) => ({ ...entry, match: fuzzyMatch(query, entry.label) }))
      .filter((entry) => entry.match.matched)
      .sort((a, b) => b.match.score - a.match.score);
  }, [query, t]);

  // Keep the highlight in range as the result set shrinks/grows.
  useEffect(() => {
    setActiveIndex((current) => {
      if (results.length === 0) {
        return 0;
      }
      return Math.min(current, results.length - 1);
    });
  }, [results.length]);

  if (!open) {
    return null;
  }

  function runAction(action: AppAction): void {
    if (!isActionEnabled(action)) {
      return; // 19b: disabled actions never run.
    }
    close();
    action.run();
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (results.length === 0 ? 0 : Math.min(current + 1, results.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = results[activeIndex];
      if (chosen !== undefined) {
        runAction(chosen.action);
      }
    }
  }

  const activeAction = results[activeIndex]?.action;

  return (
    <div
      className="command-palette__backdrop"
      data-testid="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('commandPalette.title')}
        data-testid="command-palette"
        tabIndex={-1}
      >
        <input
          ref={inputRef}
          type="text"
          className="command-palette__input"
          role="combobox"
          aria-expanded="true"
          aria-controls={LISTBOX_ID}
          aria-activedescendant={activeAction ? optionId(activeAction.id) : undefined}
          aria-label={t('commandPalette.searchLabel')}
          placeholder={t('commandPalette.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          data-testid="command-palette-input"
        />

        {results.length === 0 ? (
          <p className="command-palette__empty" data-testid="command-palette-empty">
            {t('commandPalette.empty')}
          </p>
        ) : (
          <ul className="command-palette__list" role="listbox" id={LISTBOX_ID}>
            {results.map((entry, index) => {
              const enabled = isActionEnabled(entry.action);
              return (
                <li
                  key={entry.action.id}
                  id={optionId(entry.action.id)}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-disabled={!enabled}
                  className={[
                    'command-palette__option',
                    index === activeIndex ? 'command-palette__option--active' : '',
                    enabled ? '' : 'command-palette__option--disabled',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-testid={`command-palette-option-${entry.action.id}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => {
                    // Prevent the input from blurring before the click runs.
                    event.preventDefault();
                    runAction(entry.action);
                  }}
                >
                  <span className="command-palette__option-label">{entry.label}</span>
                  {!enabled && (
                    <span className="command-palette__option-hint">
                      {t('commandPalette.unavailable')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
