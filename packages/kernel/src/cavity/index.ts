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
export { type ProximalFaceBoundary } from './occlusalPatch.ts';

// Phase 5 Task 5: Class II proximal box contact adaptation —
// `cavity/proximalContact.ts` (the per-box bump adaptation of the patch's
// proximal faces toward the neighbours; outline + seam pinned byte-exactly).
export {
  adaptProximalContacts,
  DEFAULT_PROXIMAL_MAX_TRAVEL_MM,
  DEFAULT_SEAM_ANCHOR_BAND_MM,
  PROXIMAL_CONTACT_REFINEMENT_ITERATIONS,
  ProximalColumnNotOnPatchError,
  ProximalColumnOverlapError,
  ProximalNeighborMeshError,
  ProximalDegenerateNeighborError,
  ProximalBandTooWideError,
  type ProximalAdaptationInput,
  type ProximalContactOptions,
  type ProximalBoxContactResult,
  type ProximalContactResult,
} from './proximalContact.ts';

// Phase 5 Task 6: the inlay/onlay SHELL — assemble the fit surface (T3) + the
// occlusal patch/adapted proximal faces (T4/T5) into a single watertight solid,
// welded along the shared cavity-outline ring — `cavity/inlayShell.ts`.
export {
  constructInlayShell,
  InlayShellOpenBoundaryError,
  InlayShellRingMismatchError,
  InlayShellNotWatertightError,
  type ConstructInlayShellHooks,
  type ConstructInlayShellResult,
} from './inlayShell.ts';

// Phase 5 Task 7: onlay cusp coverage — cusp identification + outline extension
// over the covered cusp — `cavity/cuspCoverage.ts`.
export {
  identifyCuspRegions,
  extendOutlineOverCusp,
  CUSP_OCCLUSAL_MAX_ANGLE_DEG,
  CUSP_MIN_PROMINENCE_MM,
  NoCuspFoundError,
  CoverageBoundaryError,
  type CuspRegion,
  type CuspRegionsResult,
  type IdentifyCuspRegionsOptions,
  type ExtendOutlineOverCuspResult,
} from './cuspCoverage.ts';
