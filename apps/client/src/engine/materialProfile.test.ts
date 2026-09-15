import { describe, expect, it } from 'vitest';
import type { CaseDocument } from '@dqcad/shared-types';
import { EMAX_LITHIUM_DISILICATE_PROFILE, STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import {
  KNOWN_PROFILES,
  MATERIAL_PROFILE_OPTIONS,
  resolveFullMaterialProfile,
  resolveMaterialProfile,
  resolveProfileVersion,
} from './materialProfile';

function docWithSettings(materialProfileId: string, profileVersion = ''): CaseDocument {
  return {
    id: 'case-1',
    schemaVersion: 2,
    createdAt: '2026-07-20T00:00:00.000Z',
    meshes: [],
    scene: [],
    restorations: [],
    measurements: [],
    history: [],
    settings: { materialProfileId, profileVersion },
  };
}

describe('resolveMaterialProfile / resolveProfileVersion', () => {
  it('falls back to standard-zirconia for the empty-settings default (the fresh-case case)', () => {
    const doc = docWithSettings('');
    expect(resolveMaterialProfile(doc)).toEqual({
      id: STANDARD_ZIRCONIA_PROFILE.id,
      version: STANDARD_ZIRCONIA_PROFILE.version,
      checksum: STANDARD_ZIRCONIA_PROFILE.checksum,
    });
    // The QC stamp and the export path derive this SAME version — the Task 9
    // fix that stops the server 409-ing `export-qc-mismatch` on profileVersion.
    expect(resolveProfileVersion(doc)).toBe(STANDARD_ZIRCONIA_PROFILE.version);
  });

  it('resolves a known profile by id (e.max)', () => {
    const doc = docWithSettings(EMAX_LITHIUM_DISILICATE_PROFILE.id);
    expect(resolveMaterialProfile(doc)).toEqual({
      id: EMAX_LITHIUM_DISILICATE_PROFILE.id,
      version: EMAX_LITHIUM_DISILICATE_PROFILE.version,
      checksum: EMAX_LITHIUM_DISILICATE_PROFILE.checksum,
    });
    expect(resolveProfileVersion(doc)).toBe(EMAX_LITHIUM_DISILICATE_PROFILE.version);
  });

  it('falls back to standard-zirconia for an unknown id', () => {
    expect(resolveProfileVersion(docWithSettings('no-such-profile'))).toBe(
      STANDARD_ZIRCONIA_PROFILE.version,
    );
  });
});

describe('resolveFullMaterialProfile', () => {
  it('returns the FULL zirconia profile for the empty-settings default', () => {
    expect(resolveFullMaterialProfile(docWithSettings(''))).toBe(STANDARD_ZIRCONIA_PROFILE);
  });

  it('returns the FULL e.max profile when selected — its divergent thresholds are the ones the gates use', () => {
    const profile = resolveFullMaterialProfile(docWithSettings(EMAX_LITHIUM_DISILICATE_PROFILE.id));
    expect(profile).toBe(EMAX_LITHIUM_DISILICATE_PROFILE);
    // The fields that actually differ from zirconia (PLAN.md §3) — the reason a
    // material change must invalidate QC.
    expect(profile.occlusalMinWallThicknessMm).toBe(1.0);
    expect(profile.restorationParams.minWallThicknessMm).toBe(0.8);
    expect(profile.inlayMinThicknessMm).toBe(1.0);
    expect(profile.frameworkMinThicknessMm).toBe(1.0);
  });

  it('falls back to the full zirconia profile for an unknown id', () => {
    expect(resolveFullMaterialProfile(docWithSettings('no-such-profile'))).toBe(
      STANDARD_ZIRCONIA_PROFILE,
    );
  });
});

describe('MATERIAL_PROFILE_OPTIONS (the picker registry)', () => {
  it('lists every shipped KNOWN_PROFILES entry by its canonical id + registry label (no hardcoded labels)', () => {
    expect(MATERIAL_PROFILE_OPTIONS).toEqual(
      KNOWN_PROFILES.map((profile) => ({ id: profile.id, label: profile.label })),
    );
    // Both shipped materials are offered, zirconia first (the effective default).
    expect(MATERIAL_PROFILE_OPTIONS.map((option) => option.id)).toEqual([
      STANDARD_ZIRCONIA_PROFILE.id,
      EMAX_LITHIUM_DISILICATE_PROFILE.id,
    ]);
  });

  it('every option id resolves back to its full profile (the picker can never offer an unresolvable material)', () => {
    for (const option of MATERIAL_PROFILE_OPTIONS) {
      expect(resolveFullMaterialProfile(docWithSettings(option.id)).id).toBe(option.id);
    }
  });
});
