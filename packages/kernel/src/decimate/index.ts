// packages/kernel/src/decimate — QEM edge-collapse decimation for RENDER
// LODs (Phase 2 Task 10). See decimate.ts's top-of-file doc for the full
// algorithm, determinism argument, boundary policy, and `@errorBound`. HARD
// INVARIANT (this task's brief / Global Constraints): the kernel's Float64
// data of record is NEVER decimated implicitly — every consumer of
// `decimateMesh` must treat its output as a separate, render-only copy.
export {
  decimateMesh,
  beginDecimation,
  toRenderOnlyMesh,
  type DecimateMeshOptions,
  type DecimateMeshResult,
  type DecimationSession,
  type RenderOnlyMesh,
} from './decimate.ts';
export {
  zeroQuadric,
  planeQuadric,
  triangleQuadric,
  addQuadric,
  addQuadricInPlace,
  quadricError,
  solveOptimalPosition,
  DEGENERATE_NORMAL_LENGTH_SQ_EPSILON,
  QUADRIC_SOLVE_SINGULARITY_EPSILON,
  type Quadric,
} from './quadric.ts';
export {
  edgeCollapseIsManifoldSafe,
  collapseWouldDuplicateTriangle,
  oneRingNeighbors,
} from './linkCondition.ts';
