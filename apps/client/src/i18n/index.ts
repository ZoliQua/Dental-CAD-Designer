// i18next setup for the client shell. EN/HU/DE/ES resources are bundled at
// build time (no runtime fetch) so the shell has zero network dependency for
// its own chrome. Every UI string lives in one of the four JSON resource
// files — components must never hardcode UI copy.
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from './de.json';
import en from './en.json';
import es from './es.json';
import hu from './hu.json';

export const SUPPORTED_LANGUAGES = ['en', 'hu', 'de', 'es'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

void i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    hu: { translation: hu },
    de: { translation: de },
    es: { translation: es },
  },
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18next;
