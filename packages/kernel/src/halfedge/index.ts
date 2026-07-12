// packages/kernel/src/halfedge — lazily-built halfedge overlay over an
// IndexedMesh: construction (build.ts), full invariant checking
// (validate.ts), and allocation-light traversal (iterate.ts). See each
// file's module doc for the construction algorithm, boundary convention,
// and cursor pattern. Phase 2 Task 2 (docs/plans/phase-2-kernel-core.md).
export {
  buildHalfedge,
  prevHalfedge,
  findNonManifoldVertices,
  NonManifoldEdgeError,
  type NonManifoldEdgeInfo,
  type NonManifoldVertexReport,
} from './build.ts';
export {
  assertValidTopology,
  debugAssertValidTopology,
  halfedgeDebugAssertionsEnabled,
} from './validate.ts';
export {
  destinationVertex,
  nextOutgoingHalfedge,
  forEachOutgoingHalfedge,
  oneRingOutgoingHalfedges,
  oneRingVertices,
  oneRingFaces,
  forEachFaceHalfedge,
  faceVertices,
  faceNeighbors,
  findBoundaryLoops,
  computeEulerCharacteristic,
  computeGenus,
  type EulerCharacteristic,
} from './iterate.ts';
export type { HalfedgeMesh } from './types.ts';
