// packages/kernel/src/margin/index.ts — public surface of the margin/
// module (Phase 3 Task 4). See marginRidge.ts's module doc for the method.
export {
  proposeMarginLoop,
  boundedVertexRegion,
  walkRidge,
  simplifyRidgeLoopIndices,
  segmentConfidence,
  surfacePointAtVertex,
  NoRidgeFoundError,
  NoClosureError,
  MARGIN_SEARCH_RADIUS_MM,
  MARGIN_WALK_RADIUS_MM,
  MARGIN_MIN_RIDGE_STRENGTH,
  MARGIN_MIN_RIDGE_COMPONENT_SIZE,
  MARGIN_CLOSURE_TOLERANCE_MM,
  MARGIN_MIN_DIRECTION_SCORE,
  MARGIN_TANGENT_EMA_WEIGHT,
  MARGIN_LOOKAHEAD_STEPS,
  MARGIN_MAX_WALK_STEPS,
  MARGIN_ANCHOR_ANGLE_BUDGET_RAD,
  MARGIN_ANCHOR_MAX_SPACING_MM,
  type ProposeMarginLoopOptions,
  type ProposeMarginLoopResult,
  type RidgeWalkResult,
} from './marginRidge.ts';

// Phase 3 Task 6: margin-line validation. See validate.ts's module doc.
export {
  validateMarginLine,
  classifyMarginValidation,
  MARGIN_SELF_INTERSECTION_TOLERANCE_MM,
  MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV,
  MARGIN_VALIDATE_ZERO_LENGTH_EPSILON_MM,
  MARGIN_VALIDATE_MIN_ANCHOR_COUNT,
  type MarginValidationReport,
  type MarginValidationClassification,
  type MarginValidationHardFailureKind,
  type MarginSelfIntersectionLocation,
  type MarginOffSurfacePoint,
  type MarginSmoothnessWarning,
  type ValidateMarginLineOptions,
} from './validate.ts';
