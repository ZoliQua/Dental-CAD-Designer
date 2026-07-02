import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../i18n';
import { useAppStore, type Language } from '../state/appStore';

export function LanguagePicker() {
  const { t } = useTranslation();
  const language = useAppStore((state) => state.language);
  const setLanguage = useAppStore((state) => state.setLanguage);

  function handleChange(event: ChangeEvent<HTMLSelectElement>): void {
    setLanguage(event.target.value as Language);
  }

  return (
    <label className="language-picker">
      <span>{t('header.languagePickerLabel')}</span>
      <select value={language} onChange={handleChange}>
        {SUPPORTED_LANGUAGES.map((code) => (
          <option key={code} value={code}>
            {t(`language.${code}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
