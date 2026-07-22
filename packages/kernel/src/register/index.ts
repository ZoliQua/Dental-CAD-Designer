// packages/kernel/src/register — rigid registration/alignment: closed-form
// coarse alignment from 3 point correspondences (kabsch.ts) + point-to-plane
// ICP refinement (icpRefine.ts). See each file's module doc for the
// algorithm, determinism, and `@errorBound` notes.
export {
  coarseAlignFromPointTriples,
  DegenerateTripleError,
  COINCIDENT_POINT_EPSILON_MM,
  COLLINEAR_SIN_SQ_EPSILON,
  type CoarseAlignResult,
  type DegenerateTripleReason,
} from './kabsch.ts';
export {
  icpRefine,
  icpRefineIteration,
  ICP_ABSOLUTE_RMS_CONVERGED_FLOOR_MM,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_CONVERGENCE_REL_TOL,
  DEFAULT_OUTLIER_REJECTION_FRACTION,
  type IcpRefineOptions,
  type IcpRefineResult,
  type IcpIterationResult,
} from './icpRefine.ts';
export { samplePointsOnMesh, type SamplePointsResult } from './sampling.ts';
export { mulberry32, type Rng } from './prng.ts';
export {
  IDENTITY_MAT4,
  composeRigid,
  applyMat4ToPoint,
  multiplyMat4,
  invertRigidMat4,
  type Mat4,
  type Mat3,
} from './transform.ts';
