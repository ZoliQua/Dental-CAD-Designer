// packages/clinical-profiles/src/profiles.ts
//
// Loads/validates every shipped material profile JSON at MODULE IMPORT TIME
// — "loaded/validated at startup" per this task's brief: any code that
// imports `@dqcad/clinical-profiles` (directly or transitively) triggers
// `loadMaterialProfile` synchronously before it can observe any exported
// profile value, so a corrupted profile fails loudly (`MaterialProfileValidationError`
// thrown) at the earliest possible point rather than lazily, on first use,
// deep inside a wizard flow.
// Plain JSON import (no import-attribute syntax) — `resolveJsonModule`
// (tsconfig.base.json) plus this repo's `moduleResolution: "bundler"` is
// enough, same convention `apps/client/src/i18n/index.ts` already uses for
// its locale JSON files.
import standardZirconiaJson from './profiles/standard-zirconia.json';
import emaxLithiumDisilicateJson from './profiles/emax-lithium-disilicate.json';
import { loadMaterialProfile, type MaterialProfile } from './materialProfile.ts';

/**
 * The first real material profile (Phase 3 Task 2's brief) — PLAN.md §3's
 * parameter table, "Zirconia default" column. See
 * `profiles/standard-zirconia.json` for the raw, checksummed data and
 * `materialProfile.ts`'s `validateMaterialProfileShape` for each field's
 * PLAN.md §3 citation. Version 1.1.0 (Phase 4 Task 1): gained
 * `occlusalMinWallThicknessMm` (== `restorationParams.minWallThicknessMm`
 * for zirconia's monolithic single-value case — PLAN.md §3's "Monolithic;
 * framework 0.5") and `maxChordDeviationMm` (5 µm, PLAN.md §3's "Export max
 * chord deviation" row); checksum bumped accordingly. Version 1.2.0 (Phase 5
 * Task 1): gained the inlay/onlay thickness minimums
 * (`inlayMinThicknessMm`/`onlayMinThicknessMm` = 0.5, `cuspCoverageMinThicknessMm`
 * = 0.7 — monolithic-zirconia norms) and `marginExclusionMm` (0.2, the Phase 4
 * feather-band carry-in); see each field's `materialProfile.ts` TSDoc for the
 * source note; checksum bumped accordingly. Version 1.3.0 (Phase 6 Task 1):
 * gained the bridge/pontic/framework fields (`frameworkMinThicknessMm` = 0.5 per
 * PLAN.md §3's "framework 0.5"; the pontic-interface placeholders
 * `ponticHygienicClearanceMm`/`ponticRidgeLapReliefMm`/`ponticOvateDepthMm`) and
 * the P5 marginExclusion promotion (`inlayMarginExclusionMm` = 1.3 /
 * `onlayMarginExclusionMm` = 1.8, geometry-derived bands moved off the engine
 * constant); checksum bumped accordingly. Version 1.4.0 (Phase 6 Task 5): gained
 * `veneeringSpaceMm` (1.0 — the framework-cutback depth, a documented
 * hand-layering placeholder; see materialProfile.ts's TSDoc); checksum bumped
 * accordingly.
 */
export const STANDARD_ZIRCONIA_PROFILE: MaterialProfile = loadMaterialProfile(standardZirconiaJson);

/**
 * Phase 4 Task 1: the second real material profile — PLAN.md §3's "Min wall
 * thickness — lithium disilicate (e.max): 1.0 mm occlusal / 0.8 mm axial"
 * row is what motivates this profile's existence (thickness gates are
 * material-aware starting Phase 4 Task 7): `restorationParams.
 * minWallThicknessMm` (treated as the AXIAL minimum, see
 * `materialProfile.ts`'s `occlusalMinWallThicknessMm` doc) is 0.8, and
 * `occlusalMinWallThicknessMm` is 1.0. Every OTHER field reuses
 * `STANDARD_ZIRCONIA_PROFILE`'s own values (cement/marginal gap, spacer
 * start, proximal/occlusal contact, connector areas, undercut blockout
 * threshold, max chord deviation) — PLAN.md §3's table gives no
 * e.max-specific values for those rows; reusing the zirconia defaults is an
 * honest, documented placeholder (not a silent guess — see
 * `profiles/emax-lithium-disilicate.json`), revisit if a real per-material
 * value becomes available. Version 1.1.0 (Phase 5 Task 1): gained the
 * inlay/onlay thickness minimums (`inlayMinThicknessMm`/`onlayMinThicknessMm`
 * = 1.0, `cuspCoverageMinThicknessMm` = 1.5 — Ivoclar IPS e.max IFU values,
 * the first genuinely e.max-specific numbers this profile carries beyond the
 * occlusal/axial split) and `marginExclusionMm` (0.2, the Phase 4 feather-band
 * carry-in); checksum bumped accordingly. Version 1.2.0 (Phase 6 Task 1): gained
 * the bridge/pontic/framework fields (`frameworkMinThicknessMm` = 1.0 — e.max is
 * predominantly monolithic/full-contour, so this is the documented occlusal-min
 * PLACEHOLDER pending a real framework figure, see materialProfile.ts's TSDoc;
 * the pontic-interface placeholders) and the P5 marginExclusion promotion
 * (`inlayMarginExclusionMm` = 1.3 / `onlayMarginExclusionMm` = 1.8 — the bands
 * are geometry-derived, hence material-independent = the same values as
 * zirconia); checksum bumped accordingly. Version 1.3.0 (Phase 6 Task 5): gained
 * `veneeringSpaceMm` (1.0 — same documented hand-layering placeholder as
 * zirconia; e.max is predominantly monolithic so this is a placeholder pending a
 * genuine layered-e.max figure); checksum bumped accordingly.
 */
export const EMAX_LITHIUM_DISILICATE_PROFILE: MaterialProfile = loadMaterialProfile(
  emaxLithiumDisilicateJson,
);
