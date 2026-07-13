// packages/kernel/src/curvature — per-vertex discrete curvature (mean H,
// Gaussian K, principal κ1/κ2) over a HalfedgeMesh; see curvature.ts's
// module doc for every formula/sign-convention/error-bound. cotan.ts's
// `computeCotanWeights` is ALSO reused by Task 11's thin-plate solve (see
// that file's module doc) — kept as its own exported, separately-testable
// function for that reason. Phase 2 Task 3
// (docs/plans/phase-2-kernel-core.md).
export { cotangentAtVertex, cotangentOpposite, computeCotanWeights } from './cotan.ts';
export { triangleVoronoiAreas, computeMixedVoronoiAreas } from './mixedArea.ts';
export { computeVertexNormals } from './normals.ts';
export { computeCurvature, type CurvatureResult } from './curvature.ts';
