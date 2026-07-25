// packages/kernel/src/cavity — Phase 5 cavity (inlay/onlay) domain: region
// analysis relative to the insertion axis + the cavity-scoped undercut
// suitability scan. `cavity.test-fixtures.ts` is deliberately NOT exported
// (test-fixture convention, same as margin/marginRidge.test-fixtures.ts).
export {
  classifyCavityRegions,
  scanCavityUndercut,
  proximalDirectionUnit,
  CAVITY_FLOOR_MAX_ANGLE_DEG,
  CAVITY_FLOOR_STEP_MIN_MM,
  CAVITY_ZONE_BOUNDARY_EPSILON_MM,
  CAVITY_SIDE_MIN_MEAN_PROJECTION,
  CavityOutlineNotOnMeshError,
  CavityOutlineNotEdgeConnectedError,
  CavityPartitionError,
  AmbiguousCavitySideError,
  type ClassifyCavityRegionsOptions,
  type CavityBoxRegion,
  type CavityRegionsResult,
  type CavityUndercutScanResult,
} from './regions.ts';
