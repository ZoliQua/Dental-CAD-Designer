// apps/client/src/engine/formatMm.ts
//
// Display formatting for a millimeter measurement value — this task's
// brief: "shows mm with 3 decimals + µm where < 1 mm". 3 decimal places on
// the mm figure already reaches the project's 1 µm display resolution
// (CLAUDE.md / docs/plans/phase-1-import-viewer.md Global Constraints:
// "measurement display resolution 1 µm" — 0.001 mm === 1 µm), but for
// sub-millimeter values (margin gaps, cement gaps — exactly the clinically
// interesting range per CLAUDE.md's "Units are mm... display formats µm
// where clinically meaningful") a bare "0.052 mm" is harder to read at a
// glance than "52 µm"; this appends the whole-µm figure in parentheses
// whenever the value would otherwise print with a leading "0.".
//
// "mm"/"µm" here are unit SYMBOLS, not UI copy — like every other unit
// suffix already embedded in an i18n string in this codebase (see
// apps/client/src/i18n/en.json's `import.stats.bbox`: "Bounding box (mm)" —
// the LABEL is translated per locale, the unit symbol itself is not, since
// metric abbreviations are identical across en/hu/de/es). Callers combine
// this with an i18n'd label (e.g. `t('measure.distanceLabel')`) — this
// function itself has no locale awareness and needs none.
const SUB_MM_THRESHOLD = 1;
const MM_DECIMALS = 3;
const MM_TO_UM = 1000;

/** Placeholder for a non-finite input (NaN/Infinity) — can arise from a
 * degenerate angle measurement (see ToolManager.ts's `angleDegrees`) picked
 * at coincident points; better than printing "NaN mm" in the results panel.
 * Exported so angle-value display sites (MeasurementPanel.tsx,
 * MeasurementOverlay.tsx) that DON'T route through `formatMm` — angle values
 * go through `t('measure.angleValue', ...)` instead, since "°" needs no
 * mm/µm unit-conversion logic — can still render the exact same
 * i18n-independent placeholder for a degenerate (NaN) angle, rather than
 * printing "NaN°" or duplicating this literal in three places. */
export const NOT_A_NUMBER_PLACEHOLDER = '—';

export function formatMm(valueMm: number): string {
  if (!Number.isFinite(valueMm)) {
    return NOT_A_NUMBER_PLACEHOLDER;
  }
  const fixed = valueMm.toFixed(MM_DECIMALS);
  const mmText = `${fixed} mm`;
  // Decide whether to append the µm parenthetical off the ROUNDED (3-decimal)
  // value, not the raw one: a raw value like 0.9995 is < SUB_MM_THRESHOLD but
  // `toFixed(3)` rounds it up to "1.000", which would otherwise print the
  // redundant/misleading "1.000 mm (1000 µm)" — a whole millimeter dressed up
  // as a sub-mm reading. Re-parsing `fixed` (rather than re-deriving the
  // threshold check some other way) guarantees this check sees exactly the
  // same rounding the displayed mm text went through, so the two can never
  // disagree at the boundary.
  const roundedMm = Number(fixed);
  if (Math.abs(roundedMm) < SUB_MM_THRESHOLD) {
    const microns = Math.round(valueMm * MM_TO_UM);
    return `${mmText} (${microns} µm)`;
  }
  return mmText;
}
