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
import { loadMaterialProfile, type MaterialProfile } from './materialProfile.ts';

/**
 * The first real material profile (Phase 3 Task 2's brief) — PLAN.md §3's
 * parameter table, "Zirconia default" column. See
 * `profiles/standard-zirconia.json` for the raw, checksummed data and
 * `materialProfile.ts`'s `validateMaterialProfileShape` for each field's
 * PLAN.md §3 citation.
 */
export const STANDARD_ZIRCONIA_PROFILE: MaterialProfile = loadMaterialProfile(standardZirconiaJson);
