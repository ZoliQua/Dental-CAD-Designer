// packages/kernel/src/geodesic — shortest surface paths between arbitrary
// surface points (triangle + barycentric) and geodesic polyline snapping.
// Phase 2 Task 4 (docs/plans/phase-2-kernel-core.md). See geodesicPath.ts's
// module doc for the method, `@errorBound`, determinism, and boundary
// behavior.
export type { SurfacePoint, GeodesicPathResult, GeodesicOptions } from './types.ts';
export {
  evaluateSurfacePoint,
  surfacePointFromClosestPoint,
  snapToSurface,
  surfacePointDistanceSquared,
  triangleVertexIndices,
} from './surfacePoint.ts';
export { NoCorridorError, dualGraphDijkstra } from './corridor.ts';
export { geodesicPath, GEODESIC_MAX_ITERATIONS, GEODESIC_REL_TOL } from './geodesicPath.ts';
export { snapPolylineGeodesic, resnapPolylineAnchor, type SnappedPolyline } from './snapPolyline.ts';
