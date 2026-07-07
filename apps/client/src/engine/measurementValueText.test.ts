// apps/client/src/engine/measurementValueText.test.ts
//
// Covers the shared display-text logic used by both MeasurementPanel.tsx and
// MeasurementOverlay.tsx (see that file's module doc). The client project's
// vitest config only runs `src/**/*.test.ts` under a plain `node`
// environment (no jsdom/testing-library configured for this package — see
// vitest.config.ts's `client` project) — this exercises the exact same
// degenerate-angle code path both components now delegate to, including the
// i18n-formatter callback shape each component actually passes, without
// needing a DOM.
import { describe, expect, it, vi } from 'vitest';
import type { Measurement } from '@dqcad/shared-types';
import { NOT_A_NUMBER_PLACEHOLDER } from './formatMm';
import { formatMeasurementValueText } from './measurementValueText';

/** Mirrors the real `(degreesValue) => t('measure.angleValue', { degrees:
 * degreesValue.toFixed(1) })` callback both MeasurementPanel.tsx and
 * MeasurementOverlay.tsx pass in — same shape, no i18next runtime needed. */
function formatAngleDegrees(degreesValue: number): string {
  return `${degreesValue.toFixed(1)}°`;
}

function angleMeasurement(value: number): Pick<Measurement, 'kind' | 'value'> {
  return { kind: 'angle', value };
}

function distanceMeasurement(kind: 'pointToPoint' | 'pointToSurface', value: number): Pick<Measurement, 'kind' | 'value'> {
  return { kind, value };
}

describe('formatMeasurementValueText — degenerate angle path (MeasurementPanel + MeasurementOverlay)', () => {
  it('renders the finite-angle case via the injected formatter', () => {
    expect(formatMeasurementValueText(angleMeasurement(42.567), formatAngleDegrees)).toBe('42.6°');
  });

  it('renders the "—" placeholder for a NaN angle (coincident-point degenerate case), not "NaN°"', () => {
    const result = formatMeasurementValueText(angleMeasurement(NaN), formatAngleDegrees);
    expect(result).toBe(NOT_A_NUMBER_PLACEHOLDER);
    expect(result).not.toContain('NaN');
  });

  it('renders the "—" placeholder for a non-finite (Infinity) angle', () => {
    expect(formatMeasurementValueText(angleMeasurement(Infinity), formatAngleDegrees)).toBe(NOT_A_NUMBER_PLACEHOLDER);
    expect(formatMeasurementValueText(angleMeasurement(-Infinity), formatAngleDegrees)).toBe(
      NOT_A_NUMBER_PLACEHOLDER,
    );
  });

  it('never calls the angle formatter for a non-finite angle (placeholder bypasses i18n entirely)', () => {
    const formatter = vi.fn(formatAngleDegrees);
    formatMeasurementValueText(angleMeasurement(NaN), formatter);
    expect(formatter).not.toHaveBeenCalled();
  });

  it('routes non-angle kinds through formatMm, ignoring the angle formatter', () => {
    const formatter = vi.fn(formatAngleDegrees);
    expect(formatMeasurementValueText(distanceMeasurement('pointToPoint', 12.3456), formatter)).toBe('12.346 mm');
    expect(formatMeasurementValueText(distanceMeasurement('pointToSurface', 0.05), formatter)).toBe(
      '0.050 mm (50 µm)',
    );
    expect(formatter).not.toHaveBeenCalled();
  });

  it('a non-finite pointToPoint/pointToSurface value also falls back to formatMm\'s own "—" placeholder', () => {
    expect(formatMeasurementValueText(distanceMeasurement('pointToPoint', NaN), formatAngleDegrees)).toBe(
      NOT_A_NUMBER_PLACEHOLDER,
    );
  });
});
