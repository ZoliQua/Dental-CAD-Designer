// packages/kernel/src/die — Phase 10 Task 1: the closed prep die extracted
// from the case's own (usually open) scan (ADR-023 Decision 1). See
// extractPrepDie.ts for the kept region, the closure, the clearance
// certificate and `@errorBound`. `die.test-fixtures.ts` is deliberately NOT
// exported.
export {
  extractPrepDie,
  PREP_DIE_DEFAULT_RADIAL_SKIRT_MM,
  PREP_DIE_DEFAULT_DEPTH_SKIRT_MM,
  PREP_DIE_DEFAULT_PROTECT_BAND_MM,
  PREP_DIE_DEFAULT_FLOOR_GAP_MM,
  PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM,
  PREP_DIE_MARGIN_ON_SURFACE_TOLERANCE_MM,
  PREP_DIE_MAX_FOLD_REPAIR_ROUNDS,
  PrepDieRegionError,
  PrepDieInvalidError,
  PrepDieClearanceError,
  type PrepDieOptions,
  type PrepDieResult,
} from './extractPrepDie.ts';
