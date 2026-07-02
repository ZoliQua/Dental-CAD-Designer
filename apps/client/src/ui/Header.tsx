import { useTranslation } from 'react-i18next';
import { LanguagePicker } from './LanguagePicker';
import { ThemeToggle } from './ThemeToggle';

export function Header() {
  const { t } = useTranslation();

  return (
    <header className="app-header">
      <h1 className="app-header__title" data-testid="app-title">
        {t('app.title')}
      </h1>
      <div className="app-header__controls">
        <LanguagePicker />
        <ThemeToggle />
      </div>
    </header>
  );
}
