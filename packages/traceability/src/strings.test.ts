// packages/traceability/src/strings.test.ts
//
// i18n parity for the renderer's bundled locale tables: every key exists in
// all four locales (EN/HU/DE/ES), non-empty, and interpolation placeholders
// match across locales — the same completeness discipline as
// apps/client/src/i18n/locales.test.ts, applied to this package's own
// tables (the render function is shared server+client, so its strings
// cannot live in the client i18n bundle — see strings.ts's module doc).
import { describe, expect, it } from 'vitest';
import { TRACEABILITY_LOCALES, TRACEABILITY_STRINGS } from './strings.ts';

describe('traceability locale tables', () => {
  it('covers exactly the four supported locales', () => {
    expect([...TRACEABILITY_LOCALES]).toEqual(['en', 'hu', 'de', 'es']);
    expect(Object.keys(TRACEABILITY_STRINGS).sort()).toEqual([...TRACEABILITY_LOCALES].sort());
  });

  it('every locale has exactly the EN key set, every value non-empty', () => {
    const enKeys = Object.keys(TRACEABILITY_STRINGS.en).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    for (const locale of TRACEABILITY_LOCALES) {
      const table = TRACEABILITY_STRINGS[locale];
      expect(Object.keys(table).sort(), `key set of ${locale}`).toEqual(enKeys);
      for (const [key, value] of Object.entries(table)) {
        expect(value.trim().length, `${locale}.${key} must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('interpolation placeholders match EN in every locale', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of TRACEABILITY_LOCALES) {
      for (const [key, value] of Object.entries(TRACEABILITY_STRINGS[locale])) {
        expect(placeholders(value), `${locale}.${key} placeholders`).toEqual(
          placeholders(TRACEABILITY_STRINGS.en[key as keyof typeof TRACEABILITY_STRINGS.en]),
        );
      }
    }
  });

  it('every known QC gate id has a label in every locale', () => {
    const gateIds = [
      'watertight',
      'manifold',
      'selfIntersection',
      'minWallThickness',
      'marginFit',
      'seating',
      'connectorCrossSection',
      'contact',
      'seamDihedral',
      'cuspCoverageThickness',
      'ponticRelief',
    ];
    for (const locale of TRACEABILITY_LOCALES) {
      const table = TRACEABILITY_STRINGS[locale] as Record<string, string>;
      for (const id of gateIds) {
        expect(table[`gate.${id}`], `${locale} label for gate ${id}`).toBeTruthy();
      }
    }
  });
});
