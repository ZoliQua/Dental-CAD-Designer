// packages/kernel/src/bridge/index.ts — public surface of the bridge/ module
// (Phase 6). See sharedAxis.ts's module doc for the shared-insertion-axis
// assessment + suggestion (the reuse map over the P3/P4 axis+undercut
// machinery).
export {
  assessSharedAxis,
  suggestSharedAxis,
  type SharedAxisRegionReport,
  type SharedAxisAssessment,
  type AssessSharedAxisOptions,
  type SharedAxisSuggestion,
} from './sharedAxis.ts';

// Phase 6 Task 3 — the pontic gingival interface (per-style base construction +
// the blend-independent relief measurement). See ponticInterface.ts's module doc.
export {
  shapePonticBase,
  synthPonticSeatRing,
  measurePonticRelief,
  analyticCylinderSignedDistanceMm,
  crestSagittaBoundMm,
  PonticInterfaceParamError,
  type PonticInterfaceStyle,
  type RidgeCrestCylinder,
  type PonticPatch,
  type PonticInterfaceParams,
  type PonticBaseFootprint,
  type PonticBaseResolution,
  type PonticBaseSample,
  type ShapePonticBaseResult,
  type PonticReliefPatchStats,
  type PonticReliefMeasurement,
} from './ponticInterface.ts';
