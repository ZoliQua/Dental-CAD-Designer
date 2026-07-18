// packages/kernel/src/sdf — signed distance & SDF sampling (Phase 2 Task 6):
// angle-weighted pseudonormals (pseudonormals.ts), exact signed
// closest-point queries built on the Phase 1 BVH (signedDistance.ts), and
// regular-grid SDF sampling (grid.ts) — the scalar field Task 7's
// offset-surface extraction (out of this task's scope) consumes.
export {
  computePseudonormals,
  NonWatertightMeshError,
  type Pseudonormals,
} from './pseudonormals.ts';

export {
  signedClosestPoint,
  classifyBarycentricFeature,
  SDF_BARYCENTRIC_EPSILON,
  type SignedClosestPointResult,
  type BarycentricFeature,
} from './signedDistance.ts';

export {
  sdfGridDims,
  markCandidateCells,
  computeSdfGridSlice,
  sampleSdfGrid,
  MAX_SDF_GRID_CELLS,
  SdfGridTooLargeError,
  type SdfGridBbox,
  type SdfGridOptions,
  type SdfGridDims,
  type SampleSdfGridOptions,
  type SampleSdfGridResult,
} from './grid.ts';
