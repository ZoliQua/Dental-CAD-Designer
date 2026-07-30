// Phase 8 Task 1 — hardcoded-string guard.
//
// Two jobs:
//  1. Unit-test the scanner core (scanHardcodedStrings.ts) — proving it is
//     FALSIFIABLE: a seeded hardcoded JSX string / user-facing prop is
//     flagged, while genuine non-copy (units, className, data-*, t() calls,
//     symbol glyphs) is not.
//  2. Run the scanner over the LIVE `apps/client/src/ui/**` tree and assert
//     zero hardcoded user-facing strings — the standing regression guard the
//     CLAUDE.md i18n invariant needs.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UNIT_TOKENS,
  scanSourceForHardcodedStrings,
  USER_FACING_PROPS,
} from './scanHardcodedStrings';

const UI_DIR = fileURLToPath(new URL('../ui', import.meta.url));

/** Every non-test `.tsx`/`.ts` source under ui/, sorted (deterministic). */
function collectUiSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectUiSources(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) {
      continue;
    }
    if (/\.test\.tsx?$/.test(entry.name)) {
      continue;
    }
    out.push(full);
  }
  return out.sort();
}

describe('hardcoded-string guard — scanner core (falsifiability)', () => {
  it('flags a bare JSX text node with prose', () => {
    const found = scanSourceForHardcodedStrings(
      'Seed.tsx',
      'export const C = () => <button>Export design</button>;',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'text', value: 'Export design' });
  });

  it('flags a hardcoded user-facing prop (aria-label / placeholder / title / label / alt)', () => {
    for (const prop of USER_FACING_PROPS) {
      const found = scanSourceForHardcodedStrings(
        'Seed.tsx',
        `export const C = () => <input ${prop}="Close panel" />;`,
      );
      expect(found, prop).toHaveLength(1);
      expect(found[0], prop).toMatchObject({ kind: `prop:${prop}`, value: 'Close panel' });
    }
  });

  it('flags a string literal wrapped in a JSX expression prop', () => {
    const found = scanSourceForHardcodedStrings(
      'Seed.tsx',
      "export const C = () => <input placeholder={'Search cases'} />;",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'prop:placeholder', value: 'Search cases' });
  });

  it('does NOT flag i18n-routed copy (t() calls)', () => {
    const found = scanSourceForHardcodedStrings(
      'Seed.tsx',
      "export const C = () => <button aria-label={t('sidebar.removeButton')}>{t('header.export')}</button>;",
    );
    expect(found).toEqual([]);
  });

  it('does NOT flag technical props (className / data-* / id / type / role / name)', () => {
    const found = scanSourceForHardcodedStrings(
      'Seed.tsx',
      'export const C = () => <button type="button" className="theme-toggle" data-testid="x" id="y" role="switch" name="z" />;',
    );
    expect(found).toEqual([]);
  });

  it('does NOT flag metric unit symbols (locale-invariant) or symbol glyphs', () => {
    const source = [
      'export const C = () => (<>',
      '  <span>µm</span>',
      '  <span> mm</span>',
      '  <span>mm²</span>',
      '  <button aria-label={t("sidebar.removeButton")}>×</button>',
      '  <span>·</span>',
      '  <span>—</span>',
      '</>);',
    ].join('\n');
    expect(scanSourceForHardcodedStrings('Seed.tsx', source)).toEqual([]);
  });

  it('flags prose even when it contains an allowlisted unit substring (whole-text match)', () => {
    const found = scanSourceForHardcodedStrings(
      'Seed.tsx',
      'export const C = () => <span>Depth in mm</span>;',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'text', value: 'Depth in mm' });
  });

  it('does NOT flag pure numbers or interpolated expressions', () => {
    const found = scanSourceForHardcodedStrings(
      'Seed.tsx',
      'export const C = () => <span>{value.toFixed(2)} — {42}</span>;',
    );
    expect(found).toEqual([]);
  });

  // Anti-neuter tripwire. A token is a genuine metric-unit symbol ONLY if it
  // either carries a unit-specific glyph (the micro sign `µ`, or a superscript
  // `²`/`³`) OR is one of a tiny fixed set of base length-unit stems. Crucially
  // this REJECTS short lowercase prose words (close/reset/apply/start/…) — the
  // exact way an earlier version (a bare `^[a-z…]+$` charset + length≤5) could
  // be neutered by parking a word in the allowlist.
  const BASE_LENGTH_UNIT_STEMS = new Set(['m', 'mm', 'cm', 'nm', 'dm', 'km', 'µm', 'um']);
  const isUnitShapedToken = (token: string): boolean => {
    if (token.length > 5) return false;
    if (!/^[a-zµ²³/]+$/.test(token)) return false;
    if (/[µ²³]/.test(token)) return true; // carries a unit glyph → definitely a unit
    // No unit glyph: every remaining part (split on the `/` of e.g. mm²/s — the
    // `²` already qualified that one, so here parts are glyph-free) must be a
    // base length-unit stem, never a word.
    return token.split('/').every((part) => BASE_LENGTH_UNIT_STEMS.has(part));
  };

  it('anti-neuter tripwire REJECTS prose words parked as units (falsifiable)', () => {
    for (const word of ['close', 'reset', 'apply', 'start', 'done', 'next', 'erase', 'clear']) {
      expect(isUnitShapedToken(word), word).toBe(false);
    }
    // And genuinely accepts the real unit shapes.
    for (const unit of ['mm', 'µm', 'cm', 'nm', 'mm²', 'µm³', 'mm²/s']) {
      expect(isUnitShapedToken(unit), unit).toBe(true);
    }
  });

  it('every allowlisted token is unit-shaped, and the set is frozen to a reviewed contents', () => {
    for (const token of ALLOWED_UNIT_TOKENS) {
      expect(isUnitShapedToken(token), token).toBe(true);
    }
    // Freeze the exact contents: adding ANY token (prose or otherwise) must be a
    // deliberate, reviewed act that also updates this frozen expectation — a
    // silent allowlist growth fails here even if the new token were unit-shaped.
    expect([...ALLOWED_UNIT_TOKENS].sort()).toEqual(
      ['cm', 'cm²', 'mm', 'mm²', 'mm²/s', 'mm³', 'nm', 'µm', 'µm²', 'µm³'].sort(),
    );
  });
});

describe('hardcoded-string guard — live apps/client/src/ui tree', () => {
  const sources = collectUiSources(UI_DIR);

  it('finds UI source files to scan', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('has zero hardcoded user-facing strings outside i18n', () => {
    const violations = sources.flatMap((file) =>
      scanSourceForHardcodedStrings(file.slice(UI_DIR.length + 1), readFileSync(file, 'utf8')),
    );
    const report = violations
      .map((v) => `  ${v.fileName}:${v.line} [${v.kind}] "${v.value}"`)
      .join('\n');
    expect(violations, `hardcoded UI strings found — route through i18n:\n${report}`).toEqual([]);
  });
});
