// packages/kernel/src/anatomy — anatomy-placement solver (Phase 4 Task 5).
// See placement.ts's module doc for the target-frame construction, the two
// scale factors, and the transform (Kabsch reuse).
export {
  solveAnatomyPlacement,
  buildPlacementTransform,
  placeMesh,
  translatePlacement,
  rotatePlacement,
  rescalePlacement,
  solveLandmarkHandleTranslation,
  assertFrameValid,
  DegeneratePlacementError,
  PLACEMENT_MIN_EXTENT_MM,
  FRAME_ORTHONORMAL_TOLERANCE,
  FRAME_MIN_RIGHT_HANDED_DET,
  type CanonicalFrameAxes,
  type PlacementFrame,
  type AnatomyPlacementInput,
  type AnatomyPlacementMeasurements,
  type AnatomyPlacementSolution,
} from './placement.ts';

export {
  planAnatomyMorph,
  solveAnatomyMorph,
  morphAnatomy,
  DEFAULT_MORPH_OPTIONS,
  MorphContactMeshError,
  MorphNoAnchorsError,
  type MorphContactKind,
  type MorphContactInput,
  type MorphOptions,
  type AnatomyMorphInput,
  type AnatomyMorphPlan,
  type MorphStrengths,
  type MorphContactResult,
  type AnatomyMorphResult,
} from './morph.ts';
