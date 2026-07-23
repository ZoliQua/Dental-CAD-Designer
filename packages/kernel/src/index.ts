// packages/kernel — Float64 geometry core (halfedge mesh, curvature, offsets, booleans).
// Pure TS. No DOM, no Three.js. Populated starting Phase 2.
//
// `.ts`-extension re-exports below: see boolean/manifold.ts's module doc —
// this file is reachable via native Node module resolution (through
// kernel-workers' manifoldSmoke job), which requires literal `.ts`
// specifiers rather than this repo's usual `.js` suffix.

/** Kernel package version, surfaced through the server health check. Bumped as the kernel evolves.
 * See docs/CHANGELOG-kernel.md for what changed at each bump — 0.2.0
 * (Phase 2 Task 11): fillSmallHoles' curvature-continuity upgrade. 0.2.1
 * (Fix batch, post-Task-12): metadata-only — golden file gained a recorded
 * manifoldVersion field; no kernel-ops hash changed. 0.2.2 (Phase 3 Task 1
 * housekeeping): metadata-only again — the standalone intake/curvature/
 * offset goldens (test-fixtures/{intake,curvature,offset}/*.golden.json)
 * gained kernelVersion (+manifoldVersion for offset) fields; every hash
 * unchanged. 0.3.0 (Phase 3 Task 3): NEW op — the register/ module
 * (coarseAlignFromPointTriples + icpRefine/icpRefineIteration) — minor
 * bump per the undercutScan (0.0.0 -> 0.1.0) precedent for a brand-new op;
 * the kernel-ops golden gained one new pinned entry ("icpRegister"), every
 * other entry unchanged. 0.4.0 (Phase 3 Task 4): NEW op — the margin/
 * module (proposeMarginLoop: curvature-ridge (k2) bidirectional crest walk
 * + curvature-adaptive anchor simplification) — same "brand-new op, minor
 * bump" precedent; the kernel-ops golden gained one new pinned entry
 * ("proposeMargin"), every other entry unchanged. 0.4.1 (Phase 3 Task 7):
 * dentist hand-traced reference margins committed (acceptance inputs) — no
 * kernel change. 0.5.0 (Phase 3 Task 8 tuning): `margin/marginRidge.ts` gains
 * `MARGIN_MIN_RIDGE_COMPONENT_SIZE` — `findRidgeStart` now ignores isolated
 * curvature-noise components below this size when picking the "nearest
 * ridge locus" to a seed (measured necessary for the Task 8 acceptance
 * harness's reference-derived seeds; see that constant's own doc). Verified
 * a NO-OP for every existing kernel-ops.json entry (byte-identical
 * regeneration diff) — bumped anyway per this repo's tuning-discipline
 * convention (a real algorithm change, even where currently a no-op for
 * pinned seeds, goes through the same bump+changelog workflow). 0.6.0
 * (Phase 3 Task 9): NEW op — the axis/ module (`suggestInsertionAxis`/
 * `suggestInsertionAxisForRegions`: ROI extraction via a multi-source
 * Dijkstra vertex ball around a margin loop, deterministic coarse->fine
 * Fibonacci-hemisphere direction search scored by `undercutScanBatch`
 * restricted to the ROI — see axis/suggestInsertionAxis.ts for the full
 * method, objective, and tie-break) — same "brand-new op, minor bump"
 * precedent as undercutScan/icpRegister/proposeMargin; the kernel-ops
 * golden gained one new pinned entry ("suggestAxis"), every other entry
 * unchanged. 0.7.0 (Phase 3 Task 10): NEW op — the blockout/ module
 * (`blockoutPreview`: display-only undercut blockout preview, "virtual
 * wax" — per-region triangle SELECTION via `undercutScanIndices`, then a
 * FRESH, independent per-vertex `sampleDepthAlongAxis` horizon sample for
 * every selected triangle's vertex, displacing it to
 * `original + axis * depth` — see blockoutPreview.ts for the full
 * derivation, scope boundary, and `@errorBound`) — same "brand-new op,
 * minor bump" precedent as undercutScan/icpRegister/proposeMargin/
 * suggestAxis; the kernel-ops golden gained one new pinned entry
 * ("blockoutPreview"), every other entry unchanged. Also adds
 * `undercut/undercutScan.ts`'s `sampleDepthAlongAxis` — the existing
 * `depthFromSample` internal made public, no behavior change to any
 * existing function. */
/** Fix batch (Important 13): drops the WALL-CLOCK `elapsedMs` field from the
 * kernel-ops golden's `suggestAxis` `meta` — the timing was never a
 * kernel-algorithm output (no hash depended on it), only a diagnostic
 * embedded in the committed golden file, which made every regeneration
 * byte-non-reproducible for no numerical reason. No kernel algorithm or
 * output hash changes — see docs/CHANGELOG-kernel.md's `[0.7.1]` entry.
 * 0.8.0 (Phase 4 Task 1): two NEW ops, `offset/offsetMesh.ts`'s
 * `offsetMeshRoi` (die-offset ROI-band perf fix) and `margin/band.ts` (the
 * margin-band primitive) — see docs/CHANGELOG-kernel.md's `[0.8.0]` entry
 * for the full writeup, including why neither gained a `kernel-ops.json`
 * pin yet. Every existing golden hash is byte-identical to 0.7.1.
 * 0.9.0 (Phase 4 Task 3): NEW op — `offset/innerSurfaceOffset.ts`'s
 * `innerSurfaceOffsetRoi` (the crown two-zone cement-gap inner surface: a
 * spatially-varying outward offset F(x) = signedDistance(x) - gap(h(x)) = 0
 * with a C1 smoothstep blend between the marginal-gap and cement-gap zones,
 * height field `h` = Euclidean distance to the margin loop, extracted by
 * SDF -> marching cubes restricted to the prep ROI — see that module's doc
 * for the height-field design decision and `@errorBound`). Same "brand-new
 * op, minor bump" precedent as `offsetMeshRoi`/`margin/band.ts` (0.8.0):
 * every existing golden hash is byte-identical to 0.8.0 (no `kernel-ops.json`
 * pin added — the op is regression-pinned by its own analytic determinism/
 * hash tests, matching the 0.8.0 precedent). See docs/CHANGELOG-kernel.md's
 * `[0.9.0]` entry. */
export const KERNEL_VERSION = '0.9.0';

export type { IndexedMesh } from './mesh/types.ts';
export {
  initManifold,
  union,
  subtract,
  intersect,
  volume,
  surfaceArea,
  sectionCap,
  cleanupMesh,
  NonManifoldInputError,
} from './boolean/manifold.ts';

export {
  MESH_WELD_EPSILON_MM,
  weldVertices,
  indexedToSoup,
  DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4,
  checkDegenerateTriangle,
  dropDegenerateTriangles,
  orientNormalsConsistently,
  analyzeMesh,
  countsOf,
  makeStepReport,
  intake,
  type DegenerateCheck,
  type DropDegenerateResult,
  type OrientComponentReport,
  type OrientNormalsResult,
  type Bbox,
  type IntakeInput,
  type IntakeOptions,
  type IntakeReport,
  type IntakeResult,
  type IntakeStepCounts,
  type IntakeStepReport,
  type MeshStats,
  type TriangleSoup,
} from './intake/index.ts';

export {
  buildBvh,
  DEFAULT_MAX_LEAF_TRIANGLES,
  closestPoint,
  closestPointBatch,
  raycast,
  closestPointOnTriangle,
  rayTriangleIntersect,
  distanceSquared,
  RAY_PARALLEL_EPSILON,
  BARYCENTRIC_EPSILON,
  type BuildBvhOptions,
  type Bvh,
  type ClosestPointResult,
  type RaycastHit,
  type Vec3,
  type TriangleClosestPoint,
  type RayTriangleHit,
} from './bvh/index.ts';

export {
  buildHalfedge,
  prevHalfedge,
  findNonManifoldVertices,
  NonManifoldEdgeError,
  assertValidTopology,
  debugAssertValidTopology,
  halfedgeDebugAssertionsEnabled,
  destinationVertex,
  nextOutgoingHalfedge,
  forEachOutgoingHalfedge,
  oneRingOutgoingHalfedges,
  oneRingVertices,
  oneRingFaces,
  forEachFaceHalfedge,
  faceVertices,
  faceNeighbors,
  findBoundaryLoops,
  computeEulerCharacteristic,
  computeGenus,
  type NonManifoldEdgeInfo,
  type NonManifoldVertexReport,
  type EulerCharacteristic,
  type HalfedgeMesh,
} from './halfedge/index.ts';

export {
  cotangentAtVertex,
  cotangentOpposite,
  computeCotanWeights,
  triangleVoronoiAreas,
  computeMixedVoronoiAreas,
  computeVertexNormals,
  computeCurvature,
  type CurvatureResult,
} from './curvature/index.ts';

export {
  computePseudonormals,
  NonWatertightMeshError,
  signedClosestPoint,
  classifyBarycentricFeature,
  SDF_BARYCENTRIC_EPSILON,
  sdfGridDims,
  markCandidateCells,
  computeSdfGridSlice,
  sampleSdfGrid,
  MAX_SDF_GRID_CELLS,
  SdfGridTooLargeError,
  type Pseudonormals,
  type SignedClosestPointResult,
  type BarycentricFeature,
  type SdfGridBbox,
  type SdfGridOptions,
  type SdfGridDims,
  type SampleSdfGridOptions,
  type SampleSdfGridResult,
} from './sdf/index.ts';

export {
  marchingCubes,
  marchingCubesSlab,
  muClampEpsilon,
  MIN_PITCH_MM,
  PitchTooSmallError,
  offsetMesh,
  offsetMeshRoi,
  offsetGridSpec,
  offsetErrorBoundMm,
  maxAbsCoordOf,
  OFFSET_BAND_MARGIN_PITCHES,
  EmptyOffsetResultError,
  innerSurfaceOffsetRoi,
  computeTwoZoneSdfGridSlice,
  twoZoneGapField,
  smoothstep,
  distanceToClosedPolyline,
  blendZoneLipschitz,
  INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM,
  BlendWidthTooNarrowError,
  type ScalarGrid,
  type MarchingCubesSoup,
  type OffsetMeshOptions,
  type OffsetMeshResult,
  type OffsetMeshRoiOptions,
  type OffsetMeshRoiResult,
  type InnerSurfaceGapParams,
  type InnerSurfaceOffsetParams,
  type InnerSurfaceOffsetResult,
} from './offset/index.ts';

export {
  removeComponents,
  splitNonManifoldEdges,
  splitNonManifoldVertices,
  fillSmallHoles,
  DEFAULT_MAX_BOUNDARY_EDGES,
  type ComponentInfo,
  type FillSmallHolesOptions,
  type FillSmallHolesReport,
  type FillSmallHolesResult,
  type RemoveComponentsReport,
  type RemoveComponentsResult,
  type RemoveComponentsSelector,
  type RepairCounts,
  type SkippedHole,
  type SkippedHoleReason,
  type SplitNonManifoldEdgesReport,
  type SplitNonManifoldEdgesResult,
  type SplitNonManifoldVerticesReport,
  type SplitNonManifoldVerticesResult,
} from './repair/index.ts';

export {
  DegeneratePlaneError,
  normalizePlane,
  projectToPlaneXY,
  signedDistance,
  ON_PLANE_EPSILON_MM,
  sectionMesh,
  extractLocalSubmesh,
  projectPolylinesToPlaneXY,
  sectionToSvg,
  type Plane,
  type PlaneBasis,
  type SectionMeshResult,
  type SectionPolyline,
  type SectionSvgPolyline,
  type SectionToSvgOptions,
} from './section/index.ts';

export {
  evaluateSurfacePoint,
  surfacePointFromClosestPoint,
  snapToSurface,
  surfacePointDistanceSquared,
  triangleVertexIndices,
  vertexIndexIfExact,
  VERTEX_EXACT_BARYCENTRIC_EPSILON,
  NoCorridorError,
  dualGraphDijkstra,
  geodesicPath,
  GEODESIC_MAX_ITERATIONS,
  GEODESIC_REL_TOL,
  snapPolylineGeodesic,
  resnapPolylineAnchor,
  type SurfacePoint,
  type GeodesicPathResult,
  type GeodesicOptions,
  type SnappedPolyline,
} from './geodesic/index.ts';

export {
  ARC_LENGTH_SUBSTEPS,
  MIN_CONTROL_POINT_SEPARATION_MM,
  affectedSpanIndices,
  centripetalKnots,
  evaluateSpan,
  evenlySpacedPoints,
  fitCatmullRomSpline,
  integrateArcLength,
  lerpVec3,
  polylineLength,
  resampleCatmullRomSpan,
  spanCountOf,
  spanRole,
  validateControlPoints,
  SURFACE_SPLINE_MAX_ITERATIONS,
  SURFACE_SPLINE_REL_TOL,
  fitSurfaceSpline,
  fitSurfaceSplineSpan,
  refitSurfaceSplineControlPoint,
  resampleSurfaceSpline,
  fromMarginLine,
  toMarginLine,
  MarginAnchorMismatchError,
  MARGIN_ANCHOR_AGREEMENT_TOLERANCE_MM,
  type ArcLengthTable,
  type CatmullRomFitResult,
  type CatmullRomSpan,
  type SurfaceSpline,
  type SurfaceSplineOptions,
  type SurfaceSplineSpan,
  type MarginAnchorLike,
  type MarginLineLike,
  type MarginAnchorMismatchKind,
} from './spline/index.ts';

export {
  decimateMesh,
  beginDecimation,
  toRenderOnlyMesh,
  zeroQuadric,
  planeQuadric,
  triangleQuadric,
  addQuadric,
  addQuadricInPlace,
  quadricError,
  solveOptimalPosition,
  DEGENERATE_NORMAL_LENGTH_SQ_EPSILON,
  QUADRIC_SOLVE_SINGULARITY_EPSILON,
  edgeCollapseIsManifoldSafe,
  collapseWouldDuplicateTriangle,
  oneRingNeighbors,
  type DecimateMeshOptions,
  type DecimateMeshResult,
  type DecimationSession,
  type RenderOnlyMesh,
  type Quadric,
} from './decimate/index.ts';

export {
  undercutScan,
  undercutScanBatch,
  undercutScanRange,
  undercutScanIndices,
  undercutScanBatchIndices,
  sampleDepthAlongAxis,
  RAY_ORIGIN_BIAS_MM,
  UNDERCUT_BOUNDARY_EPSILON,
  type UndercutSamplingPolicy,
  type UndercutScanOptions,
  type UndercutScanBatchOptions,
  type UndercutScanResult,
  type UndercutTriangleRange,
  type UndercutScanRangeOutput,
  type UndercutScanRangeStats,
  type UndercutScanIndicesOutput,
  type UndercutScanIndicesResult,
} from './undercut/index.ts';

export {
  coarseAlignFromPointTriples,
  DegenerateTripleError,
  COINCIDENT_POINT_EPSILON_MM,
  COLLINEAR_SIN_SQ_EPSILON,
  icpRefine,
  icpRefineIteration,
  ICP_ABSOLUTE_RMS_CONVERGED_FLOOR_MM,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_CONVERGENCE_REL_TOL,
  DEFAULT_OUTLIER_REJECTION_FRACTION,
  samplePointsOnMesh,
  mulberry32,
  IDENTITY_MAT4,
  composeRigid,
  applyMat4ToPoint,
  multiplyMat4,
  invertRigidMat4,
  type CoarseAlignResult,
  type DegenerateTripleReason,
  type IcpRefineOptions,
  type IcpRefineResult,
  type IcpIterationResult,
  type SamplePointsResult,
  type Rng,
  type Mat4,
  type Mat3,
} from './register/index.ts';

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
  validateMarginLine,
  classifyMarginValidation,
  MARGIN_SELF_INTERSECTION_TOLERANCE_MM,
  MARGIN_SELF_INTERSECTION_LENGTH_SCALE_FACTOR,
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
  marginLoopPolyline,
  computeMarginLoopFrame,
  marginLoopMesh,
  MARGIN_BAND_MIN_POINT_COUNT,
  MARGIN_BAND_DEFAULT_HALF_THICKNESS_MM,
  MarginBandChordCapError,
  DegenerateMarginBandError,
  DegenerateMarginLoopNormalError,
  type MarginBandInput,
  type MarginLoopFrame,
  type MarginLoopMeshOptions,
  type MarginLoopMeshResult,
} from './margin/index.ts';

export {
  extractMarginRegion,
  marginRegionVertexBall,
  unionRegions,
  regionTriangleAreasMm2,
  regionAreaWeightedNormalSum,
  AXIS_DEFAULT_ROI_RADIUS_MM,
  fibonacciHemisphereDirections,
  fibonacciCapDirections,
  orthonormalBasis,
  GOLDEN_ANGLE_RAD,
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
  type AxisRegion,
  type AxisCandidate,
  type SuggestInsertionAxisOptions,
  type SuggestInsertionAxisResult,
  type SuggestInsertionAxisForRegionsResult,
} from './axis/index.ts';

export {
  blockoutPreview,
  toBlockoutPreviewMesh,
  type BlockoutRegion,
  type BlockoutPreviewMesh,
  type BlockoutPreviewOptions,
  type BlockoutPreviewResult,
} from './blockout/index.ts';
