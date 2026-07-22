// apps/client/src/engine/fdiChart.ts
//
// Pure FDI-numbering chart logic for Phase 3 Task 2's restoration wizard
// (docs/plans/phase-3-margin-axis.md) — quadrant-correct 2-row layout +
// bridge contiguity validation. Zero React, zero DOM: `ui/FdiToothChart.tsx`
// only renders these arrays and calls `checkBridgeContiguity`; every branch
// here is unit-testable at the node lane (fdiChart.test.ts), per this
// package's "ui → engine" layering (CLAUDE.md).
//
// ## Layout convention (React-Odontogram-Modul style, per this task's brief)
//
// Two rows of 16 teeth each, walked in on-screen left-to-right visual order
// (NOT ascending FDI numeric order — 11 and 21 sit adjacent at the midline,
// even though "21" > "11" numerically jumps by 10):
//   upper row: 18 17 16 15 14 13 12 11 | 21 22 23 24 25 26 27 28
//   lower row: 48 47 46 45 44 43 42 41 | 31 32 33 34 35 36 37 38
// (Quadrant 1 = upper right, 2 = upper left, 3 = lower left, 4 = lower
// right — standard FDI/ISO-3950 numbering; a patient's "right"/"left" is
// mirrored from the viewer's on-screen left/right in a conventional dental
// chart, which is why quadrant 1 is drawn on the chart's LEFT.)
import type { FdiTooth } from '@dqcad/shared-types';

/** Upper arch, drawn left-to-right: quadrant 1 (18→11) then quadrant 2 (21→28). */
export const UPPER_ARCH_ORDER: readonly FdiTooth[] = [
  18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
];

/** Lower arch, drawn left-to-right: quadrant 4 (48→41) then quadrant 3 (31→38). */
export const LOWER_ARCH_ORDER: readonly FdiTooth[] = [
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
];

/** The full 2×16 chart layout `ui/FdiToothChart.tsx` renders directly. */
export function fdiChartLayout(): { upperRow: readonly FdiTooth[]; lowerRow: readonly FdiTooth[] } {
  return { upperRow: UPPER_ARCH_ORDER, lowerRow: LOWER_ARCH_ORDER };
}

export type FdiArch = 'upper' | 'lower';

/** The arch (`upper`/`lower`) a tooth belongs to — quadrants 1–2 are upper,
 * 3–4 are lower (FDI numbering: the tens digit is the quadrant). */
export function archOf(tooth: FdiTooth): FdiArch {
  const quadrant = Math.floor(tooth / 10);
  return quadrant === 1 || quadrant === 2 ? 'upper' : 'lower';
}

function archOrderOf(arch: FdiArch): readonly FdiTooth[] {
  return arch === 'upper' ? UPPER_ARCH_ORDER : LOWER_ARCH_ORDER;
}

export type ContiguityResult =
  { contiguous: true } | { contiguous: false; reason: 'insufficient-teeth' | 'mixed-arch' | 'gap' };

/**
 * Validates that `teeth` forms a CONTIGUOUS run within a single arch's
 * on-screen chart order (docs/plans/phase-3-margin-axis.md Task 2: "Bridge:
 * teeth list validated contiguous within an arch (warning otherwise)") —
 * "contiguous" means every tooth between the lowest- and highest-chart-
 * position member of `teeth` is itself present in `teeth` (no gaps), all
 * within the SAME arch (a bridge cannot span upper and lower jaws).
 *
 * Order-independent (`teeth` need not be pre-sorted) and duplicate-tolerant
 * (a repeated tooth doesn't by itself create a "gap"). Fewer than 2 teeth is
 * reported as `insufficient-teeth` (a bridge needs at least 2 — a single
 * tooth is a crown, not a bridge) rather than vacuously "contiguous".
 */
export function checkBridgeContiguity(teeth: readonly FdiTooth[]): ContiguityResult {
  const distinct = Array.from(new Set(teeth));
  if (distinct.length < 2) {
    return { contiguous: false, reason: 'insufficient-teeth' };
  }

  const arch = archOf(distinct[0]!);
  if (!distinct.every((tooth) => archOf(tooth) === arch)) {
    return { contiguous: false, reason: 'mixed-arch' };
  }

  const order = archOrderOf(arch);
  const indices = distinct.map((tooth) => order.indexOf(tooth)).sort((a, b) => a - b);
  const span = indices[indices.length - 1]! - indices[0]! + 1;
  if (span !== indices.length) {
    return { contiguous: false, reason: 'gap' };
  }
  return { contiguous: true };
}

// ---------------------------------------------------------------------------
// Tooth-click interaction (ui/FdiToothChart.tsx calls these; kept here, pure
// and React-free, so the interaction itself is unit-testable without
// mounting a component — docs/plans/phase-3-margin-axis.md Task 2: "clicks
// cycle state; document the interaction").
// ---------------------------------------------------------------------------

/** A tooth's selection state within the chart: not part of the restoration,
 * a prepped abutment, or a pontic (bridge-only — see `Restoration.pontics`'
 * doc, shared-types). */
export type ToothSelectionState = 'none' | 'abutment' | 'pontic';

/** Derives a tooth's current chart state from a restoration-in-progress's
 * `teeth`/`pontics` arrays. */
export function toothStateFor(
  tooth: FdiTooth,
  teeth: readonly FdiTooth[],
  pontics: readonly FdiTooth[],
): ToothSelectionState {
  if (!teeth.includes(tooth)) return 'none';
  return pontics.includes(tooth) ? 'pontic' : 'abutment';
}

/**
 * `crown`/`inlay`/`onlay` interaction: these are single-tooth restorations
 * in this wizard (Phase 3 Task 2's UI — the `Restoration.teeth` type
 * technically allows more, but this task's wizard only ever builds a
 * one-tooth selection for non-bridge types). Clicking the ALREADY-selected
 * tooth deselects it (clears the chart); clicking any other tooth REPLACES
 * the selection (at most one tooth highlighted at a time — never additive).
 */
export function applySingleToothClick(
  currentTeeth: readonly FdiTooth[],
  tooth: FdiTooth,
): readonly FdiTooth[] {
  return currentTeeth.length === 1 && currentTeeth[0] === tooth ? [] : [tooth];
}

/**
 * `bridge` interaction: each click CYCLES the clicked tooth through
 * `none → abutment → pontic → none` (multi-select and additive — every OTHER
 * tooth's state is left untouched). This is the "abutment + pontic marked
 * distinctly" multi-select this task's brief asks for: a dentist builds a
 * bridge by clicking each tooth once to mark it an abutment (prepped) and,
 * for a tooth that's spanned but NOT prepped, clicking it again to mark it a
 * pontic.
 */
export function applyBridgeToothClick(
  teeth: readonly FdiTooth[],
  pontics: readonly FdiTooth[],
  tooth: FdiTooth,
): { teeth: readonly FdiTooth[]; pontics: readonly FdiTooth[] } {
  const current = toothStateFor(tooth, teeth, pontics);
  const next: ToothSelectionState =
    current === 'none' ? 'abutment' : current === 'abutment' ? 'pontic' : 'none';

  const teethSet = new Set(teeth);
  const ponticsSet = new Set(pontics);
  teethSet.delete(tooth);
  ponticsSet.delete(tooth);
  if (next === 'abutment') {
    teethSet.add(tooth);
  } else if (next === 'pontic') {
    teethSet.add(tooth);
    ponticsSet.add(tooth);
  }
  return { teeth: Array.from(teethSet), pontics: Array.from(ponticsSet) };
}
