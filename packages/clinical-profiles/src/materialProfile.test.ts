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
