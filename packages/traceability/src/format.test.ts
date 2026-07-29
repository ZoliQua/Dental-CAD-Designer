// packages/traceability/src/format.test.ts
//
// The deterministic formatting helpers: the mm+µm clinical display
// convention (formatMm.ts parity), gate-value rendering across unit kinds,
// escaping, and interpolation — every branch exercised explicitly.
import { describe, expect, it } from 'vitest';
import { escapeHtml, formatGateValue, formatMmValue, interpolate } from './format.ts';

describe('formatMmValue (the formatMm.ts convention)', () => {
  it('sub-mm values carry the whole-µm parenthetical', () => {
    expect(formatMmValue(0.612)).toBe('0.612 mm (612 µm)');
    expect(formatMmValue(0.052)).toBe('0.052 mm (52 µm)');
    expect(formatMmValue(-0.5)).toBe('-0.500 mm (-500 µm)');
  });

  it('values at/above 1 mm print plain 3-decimal mm', () => {
    expect(formatMmValue(1.5)).toBe('1.500 mm');
    expect(formatMmValue(12.5)).toBe('12.500 mm');
  });

  it('the parenthetical decision uses the ROUNDED value (0.9995 → 1.000 mm, no µm)', () => {
    expect(formatMmValue(0.9995)).toBe('1.000 mm');
  });

  it('non-finite → the placeholder', () => {
    expect(formatMmValue(Number.NaN)).toBe('—');
    expect(formatMmValue(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatGateValue', () => {
  it('null / non-finite → the not-available marker', () => {
    expect(formatGateValue(null, 'mm', '—')).toBe('—');
    expect(formatGateValue(Number.NaN, 'mm²', '—')).toBe('—');
  });

  it('mm routes through the clinical convention', () => {
    expect(formatGateValue(0.5, 'mm', '—')).toBe('0.500 mm (500 µm)');
  });

  it('integers print exactly, with and without a unit', () => {
    expect(formatGateValue(0, 'edges', '—')).toBe('0 edges');
    expect(formatGateValue(3, null, '—')).toBe('3');
  });

  it('non-integer non-mm values print to 6 significant digits, zeros trimmed', () => {
    expect(formatGateValue(0.0021, 'mm³', '—')).toBe('0.0021 mm³');
    expect(formatGateValue(12.345678, 'mm²', '—')).toBe('12.3457 mm²');
    expect(formatGateValue(1.5, null, '—')).toBe('1.5');
  });
});

describe('escapeHtml / interpolate', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('interpolates named placeholders and leaves unknown ones visible', () => {
    expect(interpolate('a {x} b {y}', { x: '1', y: '2' })).toBe('a 1 b 2');
    expect(interpolate('a {missing}', {})).toBe('a {missing}');
  });
});
