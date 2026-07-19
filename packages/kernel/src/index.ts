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
 * unchanged. */
export const KERNEL_VERSION = '0.2.2';

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
  offsetGridSpec,
  offsetErrorBoundMm,
  maxAbsCoordOf,
  OFFSET_BAND_MARGIN_PITCHES,
  EmptyOffsetResultError,
  type ScalarGrid,
  type MarchingCubesSoup,
  type OffsetMeshOptions,
  type OffsetMeshResult,
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
  type ArcLengthTable,
  type CatmullRomFitResult,
  type CatmullRomSpan,
  type SurfaceSpline,
  type SurfaceSplineOptions,
  type SurfaceSplineSpan,
  type MarginAnchorLike,
  type MarginLineLike,
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
  RAY_ORIGIN_BIAS_MM,
  UNDERCUT_BOUNDARY_EPSILON,
  type UndercutSamplingPolicy,
  type UndercutScanOptions,
  type UndercutScanBatchOptions,
  type UndercutScanResult,
  type UndercutTriangleRange,
  type UndercutScanRangeOutput,
  type UndercutScanRangeStats,
} from './undercut/index.ts';
