// Case-level material picker (Feature #3 — live multi-material picker).
//
// A thin ui/ control: it lists the shipped registry profiles
// (`MATERIAL_PROFILE_OPTIONS`, derived from clinical-profiles' KNOWN_PROFILES —
// never a hardcoded label list, invariant 7), reflects the case's persisted
// `settings.materialProfileId`, and on change hands the chosen id to the
// engine (`caseStore.setMaterialProfile`). ZERO geometry/gate logic lives here
// (the layer rule) — the engine writes the settings, keeps the profile version
// consistent from the registry, and invalidates every existing restoration's
// QC (a different material's thresholds differ, so a prior report is no longer
// authoritative). The invalidation surfaces in the design panels (they return
// to their "run QC" state); nothing is silently mutated (invariant 5).
//
// The material is a CASE-level setting (all restorations use it), so this sits
// above the per-restoration wizard rather than inside its per-tooth grid.
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { caseStore } from '../engine/caseStore';
import { MATERIAL_PROFILE_OPTIONS } from '../engine/materialProfile';
import { useCaseStore } from '../state/caseStore';

/** The effective default option (index 0 of the registry) — the material a
 * fresh case (empty `materialProfileId`) resolves to, matching
 * `resolveMaterialProfile`'s zirconia fallback. Guaranteed present: the shipped
 * registry always carries at least one profile. */
const DEFAULT_OPTION_ID = MATERIAL_PROFILE_OPTIONS[0]?.id ?? '';

export function MaterialPicker() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  // "A case is open" = geometry has been imported into the session — the same
  // has-content boundary the scene tree uses for its empty state. With no case
  // the control is present but disabled (discoverable, never a silent gap).
  const hasCase = document.scene.length > 0;
  const currentId = document.settings.materialProfileId;
  // Show the effective material: an unset/unknown id resolves to the default
  // (zirconia), so the select reflects what QC/export actually use — honest,
  // never a blank or phantom selection.
  const selectedId = MATERIAL_PROFILE_OPTIONS.some((option) => option.id === currentId)
    ? currentId
    : DEFAULT_OPTION_ID;

  function handleChange(event: ChangeEvent<HTMLSelectElement>): void {
    caseStore.setMaterialProfile(event.target.value);
  }

  return (
    <section className="material-picker" data-testid="material-picker">
      <label className="material-picker__label" htmlFor="material-picker-select">
        {t('material.label')}
      </label>
      <select
        id="material-picker-select"
        className="material-picker__select"
        data-testid="material-picker-select"
        value={selectedId}
        disabled={!hasCase}
        onChange={handleChange}
        aria-label={t('material.label')}
      >
        {MATERIAL_PROFILE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </section>
  );
}
