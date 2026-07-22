import { describe, expect, it } from 'vitest';
import { DEFAULT_RESTORATION_PARAMS, DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM } from './constants.ts';
import { STANDARD_ZIRCONIA_PROFILE } from './profiles.ts';

describe('DEFAULT_RESTORATION_PARAMS', () => {
  it("matches PLAN.md §3's cited default values", () => {
    expect(DEFAULT_RESTORATION_PARAMS).toEqual({
      cementGapMm: 0.05,
      marginalGapMm: 0.02,
      spacerStartMm: 0.8,
      minWallThicknessMm: 0.5,
      proximalContactPenetrationMm: 0.02,
      occlusalContactMm: 0,
    });
  });

  it('stays in sync with STANDARD_ZIRCONIA_PROFILE.restorationParams (single source of truth)', () => {
    expect(DEFAULT_RESTORATION_PARAMS).toBe(STANDARD_ZIRCONIA_PROFILE.restorationParams);
  });
});

describe('DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM', () => {
  it("matches PLAN.md §3's cited default value (0 mm / 0 µm)", () => {
    expect(DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM).toBe(0);
  });

  it('stays in sync with STANDARD_ZIRCONIA_PROFILE.undercutBlockoutThresholdMm (single source of truth)', () => {
    expect(DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM).toBe(STANDARD_ZIRCONIA_PROFILE.undercutBlockoutThresholdMm);
  });
});
