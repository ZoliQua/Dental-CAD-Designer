// apps/client/src/engine/measurementValueText.ts
//
// Shared display-text logic for a single measurement's value, used by both
// MeasurementPanel.tsx (results list) and MeasurementOverlay.tsx (screen-
// space labels) — extracted here (rather than left duplicated in both
// components) so the degenerate-angle guard below has exactly one
// implementation to test and keep correct, not two copies that can drift.
//
// `pointToPoint`/`pointToSurface` values are mm and go through `formatMm`
// (which already guards non-finite input — see formatMm.ts). `angle` values
// are degrees and are NOT run through `formatMm` (a "°" suffix needs no
// mm/µm unit-conversion logic) — they were previously interpolated straight
// into `t('measure.angleValue', { degrees: value.toFixed(1) })`, which has
// no numeric awareness of its own: a degenerate angle (picked at/near-
// coincident points — see ToolManager.ts's `angleDegrees`) is NaN, and
// `NaN.toFixed(1)` is the string `"NaN"`, so this rendered a literal "NaN°"
// instead of the documented '—' placeholder. Guarded here the same way
// formatMm.ts guards its own non-finite input, using formatMm's exact same
// placeholder constant so both value types are visually consistent.
import type { Measurement } from '@dqcad/shared-types';
import { formatMm, NOT_A_NUMBER_PLACEHOLDER } from './formatMm';

/**
 * Renders `measurement.value` for display. `formatAngleDegrees` is the
 * caller's i18n-bound formatter for the finite-angle case (typically
 * `(value) => t('measure.angleValue', { degrees: value.toFixed(1) })`) —
 * kept as an injected callback rather than importing `useTranslation` here
 * so this stays a plain, synchronously-testable function with no React/i18n
 * runtime dependency.
 */
export function formatMeasurementValueText(
  measurement: Pick<Measurement, 'kind' | 'value'>,
  formatAngleDegrees: (degreesValue: number) => string,
): string {
  if (measurement.kind !== 'angle') {
    return formatMm(measurement.value);
  }
  if (!Number.isFinite(measurement.value)) {
    return NOT_A_NUMBER_PLACEHOLDER;
  }
  return formatAngleDegrees(measurement.value);
}
