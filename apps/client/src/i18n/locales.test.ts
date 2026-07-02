// Guards against locale resource drift: every UI string key must exist in
// all 4 languages (PLAN.md / CLAUDE.md i18n invariant), or react-i18next
// silently falls back and a shipped locale ends up with English leaking
// through.
import { describe, expect, it } from 'vitest';
import de from './de.json';
import en from './en.json';
import es from './es.json';
import hu from './hu.json';

function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    collectKeyPaths(nested, prefix ? `${prefix}.${key}` : key),
  );
}

const locales = { en, hu, de, es } as const;

describe('i18n locale resources', () => {
  it('every locale has a non-empty key set', () => {
    for (const [locale, resource] of Object.entries(locales)) {
      expect(collectKeyPaths(resource).length, `${locale} has keys`).toBeGreaterThan(0);
    }
  });

  it('all 4 locales define the exact same set of translation keys', () => {
    const [referenceLocale, ...otherLocales] = Object.keys(locales) as Array<keyof typeof locales>;
    if (!referenceLocale) {
      throw new Error('no locales configured');
    }
    const referenceKeys = collectKeyPaths(locales[referenceLocale]).sort();

    for (const locale of otherLocales) {
      const keys = collectKeyPaths(locales[locale]).sort();
      expect(keys, `${locale} vs ${referenceLocale}`).toEqual(referenceKeys);
    }
  });
});
