// packages/kernel — Float64 geometry core (halfedge mesh, curvature, offsets, booleans).
// Pure TS. No DOM, no Three.js. Populated starting Phase 2.
//
// `.ts`-extension re-exports below: see boolean/manifold.ts's module doc —
// this file is reachable via native Node module resolution (through
// kernel-workers' manifoldSmoke job), which requires literal `.ts`
// specifiers rather than this repo's usual `.js` suffix.

/** Kernel package version, surfaced through the server health check. Bumped as the kernel evolves. */
export const KERNEL_VERSION = '0.0.0';

export type { IndexedMesh } from './mesh/types.ts';
export {
  initManifold,
  union,
  subtract,
  intersect,
  volume,
  surfaceArea,
  NonManifoldInputError,
} from './boolean/manifold.ts';
