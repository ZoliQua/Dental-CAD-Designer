// apps/client/src/engine/materialProfileParity.test.ts
//
// Feature #3 — INVARIANT GUARD for the per-material profile fields that are
// deliberately NOT yet threaded through the selected material profile because
// they live on GEOMETRY-time / journal / UI-disclosure paths (not the QC or
// export gate context):
//   - bridgeDesign.ts framework stage: `veneeringSpaceMm`, `marginExclusionMm`
//     (the taper band) — disclosure/journal values (the stage marker is
//     `framework:${mode}`, a pure function of the mode; they ride into neither
//     the QC payload nor the export context).
//   - the bridge pontic relief `configuredReliefMm` is BUILT at geometry time
//     (engine/bridgeGeometry.ts, from the kernel/asset), and the server
//     re-derives its authority from the profile's pontic fields
//     (`ponticHygienicClearanceMm` / `ponticRidgeLapReliefMm` /
//     `ponticOvateDepthMm`, see export-profile.ts PONTIC_RELIEF_BY_STYLE).
//
// Every shipped profile AGREES on these fields today, so leaving them on the
// zirconia constant is byte-identical for the current registry. This guard makes
// that assumption LOUD: if a FUTURE profile diverges on any guarded field, CI
// fails HERE (never silently baking a wrong value into a bridge decision), which
// is the signal to wire that field to `resolveFullMaterialProfile` — exactly as
// the QC/export gate fields (occlusal/wall/framework minimums, connector target,
// margin exclusion, cusp coverage) already are.
import { describe, expect, it } from 'vitest';
import type { MaterialProfile } from '@dqcad/clinical-profiles';
import { KNOWN_PROFILES } from './materialProfile';

/** The per-material profile fields still sourced from a fixed registry constant
 * on a geometry/disclosure path (see this file's doc). If a shipped profile ever
 * diverges on one of these, it must be threaded through the selected profile
 * (and removed from here). */
const GEOMETRY_TIME_GUARDED_FIELDS = [
  'veneeringSpaceMm',
  'marginExclusionMm',
  'ponticHygienicClearanceMm',
  'ponticRidgeLapReliefMm',
  'ponticOvateDepthMm',
] as const satisfies readonly (keyof MaterialProfile)[];

/** True iff every profile carries the SAME value for `field`. */
function allAgreeOn(profiles: readonly MaterialProfile[], field: keyof MaterialProfile): boolean {
  return new Set(profiles.map((p) => p[field])).size <= 1;
}

describe('material-profile parity — geometry-time fields not yet threaded through the picker', () => {
  it('every shipped KNOWN_PROFILE agrees on each guarded field (else it MUST be wired to the selected profile)', () => {
    expect(KNOWN_PROFILES.length).toBeGreaterThanOrEqual(2); // the guard is meaningful
    for (const field of GEOMETRY_TIME_GUARDED_FIELDS) {
      const values = KNOWN_PROFILES.map((p) => p[field]);
      expect(
        allAgreeOn(KNOWN_PROFILES, field),
        `KNOWN_PROFILES diverge on '${field}' (${JSON.stringify(values)}) — a per-material value now reaches a bridge geometry/disclosure decision. ` +
          `Thread it through resolveFullMaterialProfile(document) (as the QC/export gate fields are) and drop it from GEOMETRY_TIME_GUARDED_FIELDS.`,
      ).toBe(true);
    }
  });

  it('is FALSIFIABLE: a synthetic profile diverging on a guarded field is flagged', () => {
    const base = KNOWN_PROFILES[0]!;
    const divergent: MaterialProfile = { ...base, veneeringSpaceMm: base.veneeringSpaceMm + 1 };
    // The exact check the guard runs — it must catch the divergence.
    expect(allAgreeOn([base, divergent], 'veneeringSpaceMm')).toBe(false);
    // And a non-divergent pair still agrees (no false positive).
    expect(allAgreeOn([base, { ...base }], 'veneeringSpaceMm')).toBe(true);
  });
});
