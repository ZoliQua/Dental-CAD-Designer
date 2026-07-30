// Phase 8 Task 2 — keyboard-shortcuts help overlay (toggled by `?`). Lists the
// SAME registry actions that carry a chord (getAppActions), grouped, with
// their formatted keys — no second source of truth. a11y: role=dialog +
// aria-modal, Escape closes, focus trap, discoverable close button.
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiOverlayStore } from '../state/uiOverlayStore';
import {
  ACTION_GROUP_ORDER,
  actionShortcuts,
  getAppActions,
  type AppAction,
} from './actions/registry';
import { formatShortcut } from './actions/shortcuts';
import { useFocusTrap } from './actions/useFocusTrap';

export function ShortcutsHelpOverlay() {
  const { t } = useTranslation();
  const open = useUiOverlayStore((state) => state.shortcutsHelpOpen);
  const close = useUiOverlayStore((state) => state.closeShortcutsHelp);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open, close);

  if (!open) {
    return null;
  }

  const withShortcut: readonly AppAction[] = getAppActions().filter(
    (action) => action.shortcut !== undefined,
  );

  return (
    <div
      className="shortcuts-help__backdrop"
      data-testid="shortcuts-help-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="shortcuts-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-help-title"
        data-testid="shortcuts-help"
        tabIndex={-1}
      >
        <div className="shortcuts-help__header">
          <h2 id="shortcuts-help-title" className="shortcuts-help__title">
            {t('shortcutsHelp.title')}
          </h2>
          <button
            type="button"
            className="shortcuts-help__close"
            onClick={close}
            aria-label={t('shortcutsHelp.closeLabel')}
            data-testid="shortcuts-help-close"
          >
            {t('shortcutsHelp.closeLabel')}
          </button>
        </div>

        {ACTION_GROUP_ORDER.map((group) => {
          const groupActions = withShortcut.filter((action) => action.group === group);
          if (groupActions.length === 0) {
            return null;
          }
          return (
            <section
              key={group}
              className="shortcuts-help__group"
              data-testid={`shortcuts-help-group-${group}`}
            >
              <h3 className="shortcuts-help__group-title">{t(`actions.group.${group}`)}</h3>
              <dl className="shortcuts-help__list">
                {groupActions.map((action) => (
                  <div
                    key={action.id}
                    className="shortcuts-help__row"
                    data-testid={`shortcuts-help-row-${action.id}`}
                  >
                    <dt className="shortcuts-help__label">{t(action.labelKey)}</dt>
                    <dd className="shortcuts-help__keys">
                      {actionShortcuts(action).map((binding, index) => (
                        <kbd key={index} className="shortcuts-help__key">
                          {formatShortcut(binding)}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </div>
  );
}
