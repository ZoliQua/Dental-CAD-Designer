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
 * at coincident points; better than printing "NaN mm" in the results panel. */
const NOT_A_NUMBER_PLACEHOLDER = '—';

export function formatMm(valueMm: number): string {
  if (!Number.isFinite(valueMm)) {
    return NOT_A_NUMBER_PLACEHOLDER;
  }
  const mmText = `${valueMm.toFixed(MM_DECIMALS)} mm`;
  if (Math.abs(valueMm) < SUB_MM_THRESHOLD) {
    const microns = Math.round(valueMm * MM_TO_UM);
    return `${mmText} (${microns} µm)`;
  }
  return mmText;
}
