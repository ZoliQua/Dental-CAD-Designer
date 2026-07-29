import { describe, expect, it } from 'vitest';
import type { CaseDocument } from '@dqcad/shared-types';
import { EMAX_LITHIUM_DISILICATE_PROFILE, STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import { resolveMaterialProfile, resolveProfileVersion } from './materialProfile';

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
