import { describe, expect, it } from 'vitest';
import type { FdiTooth } from '@dqcad/shared-types';
import {
  applyBridgeToothClick,
  applySingleToothClick,
  archOf,
  checkBridgeContiguity,
  fdiChartLayout,
  LOWER_ARCH_ORDER,
  toothStateFor,
  UPPER_ARCH_ORDER,
} from './fdiChart';

describe('fdiChartLayout', () => {
  it('lays out the upper row quadrant 1 (18->11) then quadrant 2 (21->28), 16 teeth', () => {
    const { upperRow } = fdiChartLayout();
    expect(upperRow).toEqual([18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28]);
    expect(upperRow).toHaveLength(16);
  });

  it('lays out the lower row quadrant 4 (48->41) then quadrant 3 (31->38), 16 teeth', () => {
    const { lowerRow } = fdiChartLayout();
    expect(lowerRow).toEqual([48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38]);
    expect(lowerRow).toHaveLength(16);
  });

  it('covers exactly the 32 valid FDI codes with no duplicates across both rows', () => {
    const all = [...UPPER_ARCH_ORDER, ...LOWER_ARCH_ORDER];
    expect(new Set(all).size).toBe(32);
    for (const tooth of all) {
      expect(tooth).toBeGreaterThanOrEqual(11);
      expect(tooth).toBeLessThanOrEqual(48);
    }
  });
});

describe('archOf', () => {
  it('classifies quadrants 1 and 2 as upper', () => {
    expect(archOf(11)).toBe('upper');
    expect(archOf(18)).toBe('upper');
    expect(archOf(21)).toBe('upper');
    expect(archOf(28)).toBe('upper');
  });

  it('classifies quadrants 3 and 4 as lower', () => {
    expect(archOf(31)).toBe('lower');
    expect(archOf(38)).toBe('lower');
    expect(archOf(41)).toBe('lower');
    expect(archOf(48)).toBe('lower');
  });
});

describe('checkBridgeContiguity', () => {
  it('reports insufficient-teeth for 0 or 1 tooth', () => {
    expect(checkBridgeContiguity([])).toEqual({ contiguous: false, reason: 'insufficient-teeth' });
    expect(checkBridgeContiguity([11])).toEqual({ contiguous: false, reason: 'insufficient-teeth' });
  });

  // The real case this task is built for: arch-case-01's four prepped upper
  // teeth 12, 11, 21, 22 — straddling the midline (11|21 boundary), must be
  // recognized as one contiguous run.
  it('recognizes the real arch-case-01 span (12, 11, 21, 22) as contiguous', () => {
    const teeth: FdiTooth[] = [12, 11, 21, 22];
    expect(checkBridgeContiguity(teeth)).toEqual({ contiguous: true });
  });

  it('is order-independent (unsorted input still recognized as contiguous)', () => {
    const teeth: FdiTooth[] = [22, 12, 21, 11];
    expect(checkBridgeContiguity(teeth)).toEqual({ contiguous: true });
  });

  it('tolerates duplicate entries without treating them as a gap', () => {
    const teeth: FdiTooth[] = [11, 11, 21];
    expect(checkBridgeContiguity(teeth)).toEqual({ contiguous: true });
  });

  it('reports a gap when a tooth in the middle of the span is missing', () => {
    // 11, 22 with 21 skipped.
    const teeth: FdiTooth[] = [11, 22];
    expect(checkBridgeContiguity(teeth)).toEqual({ contiguous: false, reason: 'gap' });
  });

  it('reports mixed-arch when teeth span upper and lower jaws', () => {
    const teeth: FdiTooth[] = [11, 41];
    expect(checkBridgeContiguity(teeth)).toEqual({ contiguous: false, reason: 'mixed-arch' });
  });

  it('recognizes a same-quadrant contiguous run', () => {
    const teeth: FdiTooth[] = [36, 37, 38];
    expect(checkBridgeContiguity(teeth)).toEqual({ contiguous: true });
  });
});

describe('toothStateFor', () => {
  it('is "none" when the tooth is not in teeth', () => {
    expect(toothStateFor(11, [], [])).toBe('none');
  });

  it('is "abutment" when the tooth is in teeth but not pontics', () => {
    expect(toothStateFor(11, [11], [])).toBe('abutment');
  });

  it('is "pontic" when the tooth is in both teeth and pontics', () => {
    expect(toothStateFor(11, [11], [11])).toBe('pontic');
  });
});

describe('applySingleToothClick (crown/inlay/onlay interaction)', () => {
  it('selects the clicked tooth, replacing any previous selection', () => {
    expect(applySingleToothClick([], 11)).toEqual([11]);
    expect(applySingleToothClick([12], 11)).toEqual([11]);
  });

  it('deselects when clicking the already-sole-selected tooth', () => {
    expect(applySingleToothClick([11], 11)).toEqual([]);
  });
});

describe('applyBridgeToothClick (bridge interaction: none -> abutment -> pontic -> none)', () => {
  it('first click on an unselected tooth marks it an abutment', () => {
    const result = applyBridgeToothClick([], [], 11);
    expect(result.teeth).toEqual([11]);
    expect(result.pontics).toEqual([]);
  });

  it('second click on an abutment marks it a pontic (stays in teeth)', () => {
    const result = applyBridgeToothClick([11], [], 11);
    expect(result.teeth).toEqual([11]);
    expect(result.pontics).toEqual([11]);
  });

  it('third click on a pontic clears it entirely', () => {
    const result = applyBridgeToothClick([11], [11], 11);
    expect(result.teeth).toEqual([]);
    expect(result.pontics).toEqual([]);
  });

  it('leaves every OTHER tooth untouched (additive, multi-select)', () => {
    const result = applyBridgeToothClick([12, 21], [12], 11);
    expect(result.teeth.slice().sort()).toEqual([11, 12, 21]);
    expect(result.pontics).toEqual([12]);
  });

  it('builds the real arch-case-01 bridge (12,11,21,22 with 12,22 pontic) via 8 clicks total', () => {
    let teeth: readonly FdiTooth[] = [];
    let pontics: readonly FdiTooth[] = [];
    // 11 and 21 -> abutment (1 click each); 12 and 22 -> pontic (2 clicks each).
    for (const tooth of [11, 21] as const) {
      ({ teeth, pontics } = applyBridgeToothClick(teeth, pontics, tooth));
    }
    for (const tooth of [12, 22] as const) {
      ({ teeth, pontics } = applyBridgeToothClick(teeth, pontics, tooth));
      ({ teeth, pontics } = applyBridgeToothClick(teeth, pontics, tooth));
    }
    expect(teeth.slice().sort()).toEqual([11, 12, 21, 22]);
    expect(pontics.slice().sort()).toEqual([12, 22]);
    expect(checkBridgeContiguity(teeth)).toEqual({ contiguous: true });
  });
});
