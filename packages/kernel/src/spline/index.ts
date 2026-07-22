// packages/kernel/src/spline — centripetal Catmull-Rom splines on a mesh
// surface (Phase 2 Task 5, docs/plans/phase-2-kernel-core.md): the margin-
// line data structure Phase 3 edits interactively. See catmullRom.ts's
// module doc for the pure ambient-space method (open + closed, arc-length
// resampling, locality) and surfaceSpline.ts's module doc for the surface-
// constraint layer (iterative re-projection, `@errorBound`, locality API).
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
  type ArcLengthTable,
  type CatmullRomFitResult,
  type CatmullRomSpan,
} from './catmullRom.ts';

export {
  SURFACE_SPLINE_MAX_ITERATIONS,
  SURFACE_SPLINE_REL_TOL,
  fitSurfaceSpline,
  fitSurfaceSplineSpan,
  refitSurfaceSplineControlPoint,
  resampleSurfaceSpline,
  type SurfaceSpline,
  type SurfaceSplineOptions,
  type SurfaceSplineSpan,
} from './surfaceSpline.ts';

export {
  fromMarginLine,
  toMarginLine,
  MarginAnchorMismatchError,
  MARGIN_ANCHOR_AGREEMENT_TOLERANCE_MM,
  type MarginAnchorLike,
  type MarginLineLike,
  type MarginAnchorMismatchKind,
} from './marginLine.ts';
