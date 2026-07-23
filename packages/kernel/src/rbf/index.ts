// packages/kernel/src/rbf — deterministic dense linear solver + radial-basis-
// function displacement interpolant (Phase 4 Task 6). See solve.ts (the direct
// LU-with-partial-pivoting solver + why it is byte-reproducible) and rbf.ts
// (the φ(r)=r biharmonic formulation + degree-1 polynomial term + saddle
// system). The anatomy morph (anatomy/morph.ts) is the consumer.
export {
  solveDense,
  solveDenseSingle,
  distanceVec3,
  SingularMatrixError,
  SOLVE_SINGULAR_PIVOT_EPSILON,
} from './solve.ts';

export {
  fitRbf,
  evaluateRbf,
  applyRbfDisplacement,
  rbfPhi,
  RBF_POLY_TERMS,
  type RbfControlPoint,
  type RbfField,
} from './rbf.ts';

export type { Vec3 } from '../bvh/geometry.ts';
