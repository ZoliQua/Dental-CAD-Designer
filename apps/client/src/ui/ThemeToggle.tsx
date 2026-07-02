import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/appStore';

export function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);

  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const label = theme === 'dark' ? t('header.themeToggleToLight') : t('header.themeToggleToDark');

  return (
    <button type="button" className="theme-toggle" onClick={() => setTheme(nextTheme)}>
      {label}
    </button>
  );
}
