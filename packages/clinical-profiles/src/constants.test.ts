import { describe, expect, it } from 'vitest';
import { DEFAULT_RESTORATION_PARAMS } from './constants.ts';
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
