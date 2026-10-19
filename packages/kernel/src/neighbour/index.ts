// packages/kernel/src/neighbour — Phase 9 Task 3: proximal neighbour capture
// from the case's own arch scan (ADR-022 Decision 3). See
// extractNeighbourRegion.ts for the window rules, the closure and
// `@errorBound`. `neighbour.test-fixtures.ts` is deliberately NOT exported.
export {
  extractNeighbourRegion,
  NEIGHBOUR_REGION_DEFAULT_RADIUS_MM,
  NEIGHBOUR_REGION_DEFAULT_MIN_FACING_COS,
  NEIGHBOUR_REGION_DEFAULT_CERVICAL_OFFSET_MM,
  NEIGHBOUR_REGION_DEFAULT_CLOSURE_DEPTH_MM,
  NeighbourSeedTooCloseError,
  NeighbourRegionEmptyError,
  NeighbourRegionInvalidError,
  type NeighbourApproach,
  type NeighbourRegionOptions,
  type NeighbourRegionResult,
} from './extractNeighbourRegion.ts';
