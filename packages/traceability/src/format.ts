// packages/traceability/src/format.ts
//
// Deterministic, locale-INDEPENDENT value formatting for the traceability
// renderer. Numbers never go through `Intl`/`toLocaleString` — the render
// function must produce identical bytes regardless of the environment's
// locale (purity requirement), and metric unit symbols are identical across
// EN/HU/DE/ES anyway (the apps/client formatMm.ts precedent).

/** Escapes a string for safe interpolation into HTML text/attributes. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** `{name}` template interpolation (values are escaped by the caller when
 * they are user-influenced; the templates themselves are trusted table
 * strings). */
export function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

const MM_DECIMALS = 3;
const MM_TO_UM = 1000;

/**
 * Millimeter display per the project convention (CLAUDE.md: "display
 * formats µm where clinically meaningful", 1 µm resolution; mirrors
 * apps/client/src/engine/formatMm.ts, which this package cannot import —
 * layer rule): 3-decimal mm, with a whole-µm parenthetical for sub-mm
 * magnitudes (decided off the ROUNDED value, exactly like formatMm.ts).
 */
export function formatMmValue(valueMm: number): string {
  if (!Number.isFinite(valueMm)) return '—';
  const fixed = valueMm.toFixed(MM_DECIMALS);
  const mmText = `${fixed} mm`;
  if (Math.abs(Number(fixed)) < 1) {
    return `${mmText} (${Math.round(valueMm * MM_TO_UM)} µm)`;
  }
  return mmText;
}

/** Trims trailing fraction zeros from a fixed/precision rendering. */
function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/\.?0+$/, '');
}

/**
 * A measured/threshold gate value with its unit: `mm` uses the clinical
 * mm+µm convention above; integers print exactly; other finite values print
 * to 6 significant digits (enough to reproduce every gate measurement at
 * display level without locale dependence). `null` → the not-available
 * marker (a gate with no numeric measurement, e.g. a pure boolean check).
 */
export function formatGateValue(
  value: number | null,
  unit: string | null,
  notAvailable: string,
): string {
  if (value === null) return notAvailable;
  if (!Number.isFinite(value)) return notAvailable;
  if (unit === 'mm') return formatMmValue(value);
  const text = Number.isInteger(value) ? String(value) : trimZeros(value.toPrecision(6));
  return unit === null ? text : `${text} ${unit}`;
}
