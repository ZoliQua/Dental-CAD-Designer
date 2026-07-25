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

// Phase 5 Task 3: the inlay/onlay inner (fit) surface — cavity two-zone offset
// + draft-close blockout + skirt-to-outline (reuses the crown intaglio
// machinery, restricted to the cavity ROI). `cavity/innerSurface.ts`.
export {
  buildCavityInnerSurface,
  type CavityInnerSurfaceParams,
  type CavityInnerSurfaceResult,
  type CavityInnerSurfaceHooks,
} from './innerSurface.ts';

// Phase 5 Task 4: the occlusal anatomy patch + G1 boundary blend (outer
// surface) — `cavity/occlusalPatch.ts` — plus the blend-independent G1
// dihedral MEASURABLE — `cavity/seamDihedral.ts`.
export {
  buildOcclusalPatch,
  SEAM_SURROUNDING_MAX_ANGLE_DEG,
  DEFAULT_PATCH_CROSS_SEGMENTS,
  OcclusalSeamPartitionError,
  SeamChainLengthMismatchError,
  SurroundingTriangleError,
  type OcclusalPatchOptions,
  type OcclusalPatchResult,
} from './occlusalPatch.ts';
export {
  measureSeamDihedral,
  SeamEdgeNotOnMeshError,
  type SeamEdge,
  type SeamDihedralSample,
  type SeamDihedralMeasurement,
  type MeasureSeamDihedralOptions,
} from './seamDihedral.ts';
