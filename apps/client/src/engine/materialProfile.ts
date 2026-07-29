// apps/client/src/engine/materialProfile.ts
//
// The ONE material-profile resolver the client shares across BOTH paths that
// name a profile — so they can never disagree (Phase 7 Task 9 fix round):
//   - the QC STAMP: the crown/cavity/bridge design engines write
//     `QcReport.profileVersion` from `resolveProfileVersion(document)`;
//   - the EXPORT REQUEST + traceability preview: `resolveMaterialProfile(
//     document)` supplies `{id, version, checksum}`.
//
// Before this module existed the QC stamp wrote the literal `'unversioned'`
// (`document.settings.profileVersion || 'unversioned'`) while the export path
// resolved empty settings to STANDARD_ZIRCONIA_PROFILE (version 1.4.0) — so the
// SERVER's independent re-validation honestly 409'd `export-qc-mismatch` on the
// `profileVersion` field for EVERY real, freshly-created case, even though the
// thresholds were already zirconia 1.4.0's (the design engines source every QC
// threshold from STANDARD_ZIRCONIA_PROFILE until the live material picker lands
// — tracked, NOT this phase). Extracted here as a leaf module (imports only
// clinical-profiles + shared-types) so exportFlow.ts CAN'T introduce a cycle
// with the three design engines it already imports for their finalMesh getters.
//
// This is a DEFAULT single-material (zirconia) fallback, not a picker: it maps a
// case's `settings.materialProfileId` to the registry profile, falling back to
// standard-zirconia for the empty/unknown default. A live MULTI-material picker
// (choosing e.max etc. from the UI) remains the tracked carry-in — see
// docs/demos/phase-7.md open item 3.
import type { CaseDocument } from '@dqcad/shared-types';
import { EMAX_LITHIUM_DISILICATE_PROFILE, STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';

const KNOWN_PROFILES = [STANDARD_ZIRCONIA_PROFILE, EMAX_LITHIUM_DISILICATE_PROFILE] as const;

/** Resolves the case's material-profile identity from
 * `settings.materialProfileId`, falling back to STANDARD_ZIRCONIA_PROFILE for
 * the empty/unknown default — the honest identity of the thresholds the design
 * engines actually use (see this module's doc). */
export function resolveMaterialProfile(document: CaseDocument): {
  id: string;
  version: string;
  checksum: string;
} {
  const byId = KNOWN_PROFILES.find((p) => p.id === document.settings.materialProfileId);
  const profile = byId ?? STANDARD_ZIRCONIA_PROFILE;
  return { id: profile.id, version: profile.version, checksum: profile.checksum };
}

/** The profile version a QcReport stamps — the SAME resolution the export
 * request uses (`resolveMaterialProfile(document).version`), so the client QC
 * and the server's re-validated report can never disagree on `profileVersion`
 * for the default single-material case. */
export function resolveProfileVersion(document: CaseDocument): string {
  return resolveMaterialProfile(document).version;
}
