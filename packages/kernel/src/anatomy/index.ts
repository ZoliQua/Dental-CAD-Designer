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
  MorphDegenerateNeighborTriangleError,
  type MorphContactKind,
  type MorphContactInput,
  type MorphOptions,
  type AnatomyMorphInput,
  type AnatomyMorphPlan,
  type MorphStrengths,
  type MorphContactResult,
  type AnatomyMorphResult,
} from './morph.ts';

// Phase 10 Task 4 (ADR-023 Decision 2): the cervical fit.
export {
  fitCervicalRing,
  emergenceLoop,
  cervicalEmergenceOffsetMm,
  CERVICAL_EMERGENCE_DESIGN_MARGIN_MM,
  closedEdgeLoopProblem,
  CervicalFitError,
  DEFAULT_CERVICAL_BLEND_MM,
  DEFAULT_CERVICAL_ANCHOR_BAND_MM,
  DEFAULT_CERVICAL_MAX_ANCHORS,
  type CervicalFitErrorReason,
  type CervicalFitInput,
  type CervicalFitOptions,
  type CervicalFitResult,
} from './cervicalFit.ts';
