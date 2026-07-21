// packages/kernel/src/axis/index.ts — public surface of the axis/ module
// (Phase 3 Task 9). See suggestInsertionAxis.ts's module doc for the method.
export {
  extractMarginRegion,
  marginRegionVertexBall,
  unionRegions,
  regionTriangleAreasMm2,
  regionAreaWeightedNormalSum,
  AXIS_DEFAULT_ROI_RADIUS_MM,
  type AxisRegion,
} from './roi.ts';

export {
  fibonacciHemisphereDirections,
  fibonacciCapDirections,
  orthonormalBasis,
  GOLDEN_ANGLE_RAD,
} from './hemisphere.ts';

export {
  suggestInsertionAxis,
  suggestInsertionAxisForRegions,
  deriveHemispherePole,
  defaultRefineCapAngleRad,
  AXIS_COARSE_SAMPLE_COUNT,
  AXIS_REFINE_SAMPLE_COUNT,
  AXIS_SEARCH_PRESETS,
  DEGENERATE_POLE_RELATIVE_EPSILON,
  EmptyRegionError,
  DegenerateRegionNormalError,
  type AxisCandidate,
  type SuggestInsertionAxisOptions,
  type SuggestInsertionAxisResult,
  type SuggestInsertionAxisForRegionsResult,
} from './suggestInsertionAxis.ts';
