// packages/kernel/src/bvh — static triangle BVH + Float64 exact queries
// (closestPoint, raycast). See build.ts's module doc for the median-split
// vs. SAH tradeoff and the determinism argument, and geometry.ts for the
// point-triangle / ray-triangle primitives' documented epsilon policy.
export { buildBvh, DEFAULT_MAX_LEAF_TRIANGLES, type BuildBvhOptions } from './build.ts';
export { closestPoint, closestPointBatch } from './closestPoint.ts';
export { raycast } from './raycast.ts';
export type { Bvh, ClosestPointResult, RaycastHit } from './types.ts';
export {
  closestPointOnTriangle,
  rayTriangleIntersect,
  distanceSquared,
  RAY_PARALLEL_EPSILON,
  BARYCENTRIC_EPSILON,
  type Vec3,
  type TriangleClosestPoint,
  type RayTriangleHit,
} from './geometry.ts';
