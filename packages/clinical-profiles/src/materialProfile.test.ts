import { describe, expect, it } from 'vitest';
import { canonicalStringify } from './canonicalJson.ts';
import {
  MaterialProfileValidationError,
  computeProfileChecksum,
  loadMaterialProfile,
  validateMaterialProfileShape,
} from './materialProfile.ts';
import standardZirconiaJson from './profiles/standard-zirconia.json';

// A structurally valid profile object, matching the shipped
// standard-zirconia.json's values exactly (so `computeProfileChecksum`
// reproduces its real checksum) — used as a base to mutate per test rather
// than re-deriving the checksum by hand every time.
function validRawProfile(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(standardZirconiaJson)) as Record<string, unknown>;
}

describe('validateMaterialProfileShape', () => {
  it('accepts the shipped standard-zirconia profile', () => {
    const profile = validateMaterialProfileShape(validRawProfile());
    expect(profile.id).toBe('standard-zirconia');
    expect(profile.restorationParams.cementGapMm).toBe(0.05);
  });

  it('rejects a non-object', () => {
    expect(() => validateMaterialProfileShape(null)).toThrow(MaterialProfileValidationError);
    expect(() => validateMaterialProfileShape('nope')).toThrow(MaterialProfileValidationError);
    expect(() => validateMaterialProfileShape(42)).toThrow(MaterialProfileValidationError);
  });

  it('rejects a missing required field', () => {
    const raw = validRawProfile();
    delete raw['label'];
    expect(() => validateMaterialProfileShape(raw)).toThrow(/profile\.label/);
  });

  it('rejects a wrong-type field', () => {
    const raw = validRawProfile();
    raw['id'] = 42;
    expect(() => validateMaterialProfileShape(raw)).toThrow(/profile\.id/);
  });

  it('rejects an unrecognized extra field', () => {
    const raw = validRawProfile();
    raw['notARealField'] = true;
    expect(() => validateMaterialProfileShape(raw)).toThrow(/unrecognized field/);
  });

  it('rejects a malformed checksum (not 64 lowercase hex chars)', () => {
    const raw = validRawProfile();
    raw['checksum'] = 'not-a-real-hash';
    expect(() => validateMaterialProfileShape(raw)).toThrow(/checksum/);
  });

  // PLAN.md §3 range enforcement — one representative case per bounded field.
  it.each([
    ['cementGapMm', 0.5], // way outside 0.02–0.12
    ['marginalGapMm', -0.01], // outside 0–0.05
    ['spacerStartMm', 0.2], // outside 0.5–1.0
    ['minWallThicknessMm', 0.1], // below 0.4
    ['proximalContactPenetrationMm', 1], // outside -0.05..0.1
    ['occlusalContactMm', -5], // outside -0.2..0.1
  ])('rejects restorationParams.%s outside its PLAN.md §3 range', (field, badValue) => {
    const raw = validRawProfile();
    (raw['restorationParams'] as Record<string, unknown>)[field] = badValue;
    expect(() => validateMaterialProfileShape(raw)).toThrow(MaterialProfileValidationError);
  });

  it('rejects connectorAreaMm2.posteriorMm2 outside the 7–16 mm² PLAN.md §3 range', () => {
    const raw = validRawProfile();
    (raw['connectorAreaMm2'] as Record<string, unknown>)['posteriorMm2'] = 100;
    expect(() => validateMaterialProfileShape(raw)).toThrow(MaterialProfileValidationError);
  });

  // Phase 4 Task 1: occlusalMinWallThicknessMm / maxChordDeviationMm.
  it('accepts the shipped standard-zirconia profile\'s occlusalMinWallThicknessMm/maxChordDeviationMm', () => {
    const profile = validateMaterialProfileShape(validRawProfile());
    expect(profile.occlusalMinWallThicknessMm).toBe(0.5);
    expect(profile.maxChordDeviationMm).toBe(0.005);
  });

  it('rejects a missing occlusalMinWallThicknessMm', () => {
    const raw = validRawProfile();
    delete raw['occlusalMinWallThicknessMm'];
    expect(() => validateMaterialProfileShape(raw)).toThrow(/occlusalMinWallThicknessMm/);
  });

  it('rejects occlusalMinWallThicknessMm below 0.3mm', () => {
    const raw = validRawProfile();
    raw['occlusalMinWallThicknessMm'] = 0.1;
    expect(() => validateMaterialProfileShape(raw)).toThrow(MaterialProfileValidationError);
  });

  it('rejects maxChordDeviationMm outside the 1-20 µm PLAN.md §3 range', () => {
    const raw = validRawProfile();
    raw['maxChordDeviationMm'] = 0.05; // 50 µm, way outside 1-20 µm
    expect(() => validateMaterialProfileShape(raw)).toThrow(MaterialProfileValidationError);
    const raw2 = validRawProfile();
    raw2['maxChordDeviationMm'] = 0.0001; // 0.1 µm, below the 1 µm floor
    expect(() => validateMaterialProfileShape(raw2)).toThrow(MaterialProfileValidationError);
  });

  // Phase 5 Task 1: inlay/onlay thickness minimums + marginExclusionMm.
  it('accepts the shipped standard-zirconia profile\'s Phase 5 inlay/onlay fields', () => {
    const profile = validateMaterialProfileShape(validRawProfile());
    expect(profile.inlayMinThicknessMm).toBe(0.5);
    expect(profile.onlayMinThicknessMm).toBe(0.5);
    expect(profile.cuspCoverageMinThicknessMm).toBe(0.7);
    expect(profile.marginExclusionMm).toBe(0.2);
  });

  it.each([
    'inlayMinThicknessMm',
    'onlayMinThicknessMm',
    'cuspCoverageMinThicknessMm',
    'marginExclusionMm',
  ])('rejects a missing %s', (field) => {
    const raw = validRawProfile();
    delete raw[field];
    expect(() => validateMaterialProfileShape(raw)).toThrow(new RegExp(field));
  });

  it.each([
    ['inlayMinThicknessMm', 0.1], // below the 0.3 mm floor
    ['onlayMinThicknessMm', 6], // above the 5 mm ceiling
    ['cuspCoverageMinThicknessMm', 0.1], // below 0.3 mm
    ['marginExclusionMm', 1.5], // above the 1.0 mm feather-band ceiling
    ['marginExclusionMm', -0.1], // below 0
  ])('rejects %s = %s (outside its documented range)', (field, badValue) => {
    const raw = validRawProfile();
    raw[field] = badValue;
    expect(() => validateMaterialProfileShape(raw)).toThrow(MaterialProfileValidationError);
  });

  it('accepts marginExclusionMm = 0 (no exclusion is a valid choice)', () => {
    const raw = validRawProfile();
    raw['marginExclusionMm'] = 0;
    // Checksum is recomputed by callers; shape validation alone must accept it.
    expect(() => validateMaterialProfileShape(raw)).not.toThrow();
  });

  // Phase 6 Task 1: bridge/pontic/framework fields + the P5 marginExclusion promotion.
  it("accepts the shipped standard-zirconia profile's Phase 6 fields", () => {
    const profile = validateMaterialProfileShape(validRawProfile());
    expect(profile.inlayMarginExclusionMm).toBe(1.3);
    expect(profile.onlayMarginExclusionMm).toBe(1.8);
    expect(profile.frameworkMinThicknessMm).toBe(0.5); // PLAN.md §3 zirconia framework 0.5
    expect(profile.ponticHygienicClearanceMm).toBe(2.0);
    expect(profile.ponticRidgeLapReliefMm).toBe(0.05);
    expect(profile.ponticOvateDepthMm).toBe(1.0);
    // Phase 6 Task 5: the framework veneering-space cutback depth.
    expect(profile.veneeringSpaceMm).toBe(1.0);
  });

  it.each([
    'inlayMarginExclusionMm',
    'onlayMarginExclusionMm',
    'frameworkMinThicknessMm',
    'ponticHygienicClearanceMm',
    'ponticRidgeLapReliefMm',
    'ponticOvateDepthMm',
    'veneeringSpaceMm',
  ])('rejects a missing %s', (field) => {
    const raw = validRawProfile();
    delete raw[field];
    expect(() => validateMaterialProfileShape(raw)).toThrow(new RegExp(field));
  });

  it.each([
    ['inlayMarginExclusionMm', 3.5], // above the 3.0 mm band ceiling
    ['inlayMarginExclusionMm', -0.1], // below 0
    ['onlayMarginExclusionMm', 3.5],
    ['frameworkMinThicknessMm', 0.1], // below the 0.3 mm floor
    ['frameworkMinThicknessMm', 6], // above the 5 mm ceiling
    ['ponticHygienicClearanceMm', 6], // above the 5 mm sanity ceiling
    ['ponticRidgeLapReliefMm', 1.5], // above the 1 mm ceiling
    ['ponticOvateDepthMm', -0.1], // below 0
    ['veneeringSpaceMm', 2.5], // above the 2.0 mm ceiling
    ['veneeringSpaceMm', -0.1], // below 0
  ])('rejects %s = %s (outside its documented range)', (field, badValue) => {
    const raw = validRawProfile();
    raw[field] = badValue;
    expect(() => validateMaterialProfileShape(raw)).toThrow(MaterialProfileValidationError);
  });
});

describe('EMAX_LITHIUM_DISILICATE_PROFILE — Phase 5 inlay/onlay IFU values', () => {
  it('carries the e.max IFU inlay/onlay thickness minimums', async () => {
    const { EMAX_LITHIUM_DISILICATE_PROFILE } = await import('./profiles.ts');
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.inlayMinThicknessMm).toBe(1.0);
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.onlayMinThicknessMm).toBe(1.0);
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.cuspCoverageMinThicknessMm).toBe(1.5);
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.marginExclusionMm).toBe(0.2);
  });

  it('has a stricter cusp-coverage minimum than zirconia (1.5 vs 0.7 mm)', async () => {
    const { EMAX_LITHIUM_DISILICATE_PROFILE, STANDARD_ZIRCONIA_PROFILE } = await import('./profiles.ts');
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.cuspCoverageMinThicknessMm).toBeGreaterThan(
      STANDARD_ZIRCONIA_PROFILE.cuspCoverageMinThicknessMm,
    );
  });

  it('carries the Phase 6 bridge/pontic/framework fields with the honest e.max framework placeholder', async () => {
    const { EMAX_LITHIUM_DISILICATE_PROFILE, STANDARD_ZIRCONIA_PROFILE } = await import('./profiles.ts');
    // The margin-exclusion bands are geometry-derived → material-independent (same values).
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.inlayMarginExclusionMm).toBe(1.3);
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.onlayMarginExclusionMm).toBe(1.8);
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.inlayMarginExclusionMm).toBe(STANDARD_ZIRCONIA_PROFILE.inlayMarginExclusionMm);
    // e.max framework is the documented occlusal-min placeholder (1.0), distinct from zirconia's 0.5.
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.frameworkMinThicknessMm).toBe(1.0);
    expect(STANDARD_ZIRCONIA_PROFILE.frameworkMinThicknessMm).toBe(0.5);
    // Phase 6 Task 5: veneering space is the same documented hand-layering
    // placeholder on both profiles.
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.veneeringSpaceMm).toBe(1.0);
    expect(STANDARD_ZIRCONIA_PROFILE.veneeringSpaceMm).toBe(1.0);
  });
});

describe('EMAX_LITHIUM_DISILICATE_PROFILE — the second real material profile (Phase 4 Task 1)', () => {
  it('loads with a material-aware occlusal/axial thickness split per PLAN.md §3', async () => {
    const { EMAX_LITHIUM_DISILICATE_PROFILE } = await import('./profiles.ts');
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.id).toBe('emax-lithium-disilicate');
    // "1.0 mm occlusal / 0.8 mm axial" — axial lives on restorationParams
    // (this profile's OWN convention, see materialProfile.ts's
    // occlusalMinWallThicknessMm doc), occlusal is the new field.
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.restorationParams.minWallThicknessMm).toBe(0.8);
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.occlusalMinWallThicknessMm).toBe(1.0);
    // Distinct from zirconia's (equal axial/occlusal, monolithic) profile.
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.occlusalMinWallThicknessMm).not.toBe(
      EMAX_LITHIUM_DISILICATE_PROFILE.restorationParams.minWallThicknessMm,
    );
  });

  it('is a real, independently checksum-verified profile (not sharing zirconia\'s checksum)', async () => {
    const { EMAX_LITHIUM_DISILICATE_PROFILE, STANDARD_ZIRCONIA_PROFILE } = await import('./profiles.ts');
    expect(EMAX_LITHIUM_DISILICATE_PROFILE.checksum).not.toBe(STANDARD_ZIRCONIA_PROFILE.checksum);
  });
});

describe('loadMaterialProfile — checksum verification', () => {
  it('loads the shipped standard-zirconia profile (real checksum) without error', () => {
    const profile = loadMaterialProfile(validRawProfile());
    expect(profile.checksum).toBe((standardZirconiaJson as { checksum: string }).checksum);
  });

  it('recomputes the exact checksum shipped in standard-zirconia.json', () => {
    const raw = validRawProfile();
    const { checksum, ...rest } = raw;
    expect(computeProfileChecksum(rest as Parameters<typeof computeProfileChecksum>[0])).toBe(
      checksum,
    );
  });

  // The corruption-detection contract this task's brief asks for: a value
  // changed WITHOUT re-deriving the checksum must be caught loudly, not
  // silently accepted.
  it('throws MaterialProfileValidationError when a value is tampered with but the checksum is left stale', () => {
    const raw = validRawProfile();
    (raw['restorationParams'] as Record<string, unknown>)['cementGapMm'] = 0.06; // still in-range, so only the checksum catches this
    expect(() => loadMaterialProfile(raw)).toThrow(MaterialProfileValidationError);
    expect(() => loadMaterialProfile(raw)).toThrow(/checksum/);
  });

  it('throws when the checksum field itself is corrupted (valid hex, wrong value)', () => {
    const raw = validRawProfile();
    raw['checksum'] = '0'.repeat(64);
    expect(() => loadMaterialProfile(raw)).toThrow(/checksum/);
  });

  it('returns a deep-frozen profile (no accidental in-place mutation downstream)', () => {
    const profile = loadMaterialProfile(validRawProfile());
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.restorationParams)).toBe(true);
    expect(Object.isFrozen(profile.connectorAreaMm2)).toBe(true);
  });
});

describe('canonicalStringify', () => {
  it('is independent of object key order', () => {
    const a = { z: 1, a: { y: 2, x: 3 } };
    const b = { a: { x: 3, y: 2 }, z: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it('preserves array order (arrays are NOT sorted)', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});
