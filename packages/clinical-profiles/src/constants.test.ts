import { describe, expect, it } from 'vitest';
import {
  CERVICAL_FIT_MAX_RESIDUAL_MM,
  DEFAULT_RESTORATION_PARAMS,
  DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM,
  PROXIMAL_CONTACT_BAND_ANTERIOR,
  PROXIMAL_CONTACT_BAND_POSTERIOR,
  proximalContactBand,
} from './constants.ts';
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

describe('CERVICAL_FIT_MAX_RESIDUAL_MM', () => {
  it('is 50 µm, the cited value', () => {
    expect(CERVICAL_FIT_MAX_RESIDUAL_MM).toBe(0.05);
  });
});

describe('proximalContactBand (ADR-027 Decision 3)', () => {
  it('is the anterior band for incisors and canines and the posterior band otherwise, in every quadrant', () => {
    expect(PROXIMAL_CONTACT_BAND_ANTERIOR).toEqual([0.6, 0.95]);
    expect(PROXIMAL_CONTACT_BAND_POSTERIOR).toEqual([0.45, 0.9]);
    for (const q of [1, 2, 3, 4]) {
      for (const p of [1, 2, 3]) expect(proximalContactBand(q * 10 + p)).toBe(PROXIMAL_CONTACT_BAND_ANTERIOR);
      for (const p of [4, 5, 6, 7, 8]) expect(proximalContactBand(q * 10 + p)).toBe(PROXIMAL_CONTACT_BAND_POSTERIOR);
    }
  });

  it('rejects a number that is not an FDI permanent tooth', () => {
    for (const bad of [0, 10, 19, 49, 51, 11.5, -11]) expect(() => proximalContactBand(bad)).toThrow(RangeError);
  });
});
