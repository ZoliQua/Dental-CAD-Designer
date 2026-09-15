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
// It maps a case's `settings.materialProfileId` to the registry profile,
// falling back to standard-zirconia for the empty/unknown default. Feature #3
// (live multi-material picker) makes this the SINGLE source the whole client
// resolves the material from: the picker (ui/MaterialPicker.tsx) lists
// `MATERIAL_PROFILE_OPTIONS` (derived from `KNOWN_PROFILES`) and writes the
// chosen id back via `caseStore.setMaterialProfile`; the crown/cavity/bridge
// QC + export builders resolve the FULL profile (`resolveFullMaterialProfile`)
// so their thresholds are the selected material's — no longer hardcoded to
// zirconia. Because the empty-settings default still resolves to
// STANDARD_ZIRCONIA_PROFILE, every pre-existing (unset-material) case behaves
// bit-identically; only an explicit e.max selection changes the thresholds.
import type { CaseDocument } from '@dqcad/shared-types';
import {
  EMAX_LITHIUM_DISILICATE_PROFILE,
  STANDARD_ZIRCONIA_PROFILE,
  type MaterialProfile,
} from '@dqcad/clinical-profiles';

/** The shipped, selectable material profiles — the client-side registry the
 * picker lists and every resolver here maps `settings.materialProfileId`
 * against. Mirrors the server's `KNOWN_MATERIAL_PROFILES` (export-profile.ts):
 * both sides must know the same set so a client-selected profile always
 * resolves server-side (else export 409s `export-material-profile-unknown`).
 * Order is display order; index 0 is the effective default. */
export const KNOWN_PROFILES: readonly MaterialProfile[] = [
  STANDARD_ZIRCONIA_PROFILE,
  EMAX_LITHIUM_DISILICATE_PROFILE,
];

/** The picker's option list — the human `label` (English; NOT i18n'd, see
 * `MaterialProfile.label`'s doc — PLAN.md has no per-locale material-name
 * requirement) plus the canonical `id` each option writes. Derived from
 * `KNOWN_PROFILES` so a new shipped profile appears in the picker with no UI
 * change (invariant 7: the material set comes from clinical-profiles, never a
 * hardcoded UI list). */
export const MATERIAL_PROFILE_OPTIONS: readonly { id: string; label: string }[] =
  KNOWN_PROFILES.map((p) => ({ id: p.id, label: p.label }));

/** Resolves the case's FULL material profile from `settings.materialProfileId`,
 * falling back to STANDARD_ZIRCONIA_PROFILE for the empty/unknown default. This
 * is the profile whose thresholds the crown/cavity/bridge QC + export builders
 * feed their gates — so choosing e.max makes QC run e.max's minimums and the
 * export request carry e.max's identity, matching the server's independent
 * profile resolution field-for-field. */
export function resolveFullMaterialProfile(document: CaseDocument): MaterialProfile {
  return KNOWN_PROFILES.find((p) => p.id === document.settings.materialProfileId) ?? STANDARD_ZIRCONIA_PROFILE;
}

/** Resolves the case's material-profile identity from
 * `settings.materialProfileId`, falling back to STANDARD_ZIRCONIA_PROFILE for
 * the empty/unknown default — the honest identity of the thresholds the design
 * engines actually use (see this module's doc). The export request carries this
 * `{id, version, checksum}`; the server re-resolves it and verifies the
 * checksum (export-profile.ts). */
export function resolveMaterialProfile(document: CaseDocument): {
  id: string;
  version: string;
  checksum: string;
} {
  const profile = resolveFullMaterialProfile(document);
  return { id: profile.id, version: profile.version, checksum: profile.checksum };
}

/** The profile version a QcReport stamps — the SAME resolution the export
 * request uses (`resolveMaterialProfile(document).version`), so the client QC
 * and the server's re-validated report can never disagree on `profileVersion`
 * for the default single-material case. */
export function resolveProfileVersion(document: CaseDocument): string {
  return resolveMaterialProfile(document).version;
}
