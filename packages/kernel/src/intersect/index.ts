// packages/kernel/src/intersect — geometric intersection predicates + the
// BVH-accelerated whole-mesh self-intersection scan. See triangleTriangle.ts
// (the Möller 1997 tri-tri predicate + its @errorBound) and selfIntersect.ts
// (the scan, its broad/narrow-phase split, determinism, and adjacency
// exclusion).
export {
  triangleTriangleIntersect,
  readTriangle,
  DegenerateTriangleError,
  TRIANGLE_INTERSECTION_EPSILON,
  type Vec3,
  type MutableVec3,
} from './triangleTriangle.ts';
export {
  findSelfIntersections,
  type SelfIntersectionScanResult,
  type SelfIntersectionScanOptions,
  type SelfIntersectionLocus,
} from './selfIntersect.ts';
