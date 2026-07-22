// packages/kernel/src/offset — SDF-based offset surfaces (Phase 2 Task 7):
// marching cubes over the sdf/ module's banded distance grid at iso =
// offset distance, welded and manifold-cleaned. See offsetMesh.ts for the
// pipeline, sign convention, and `@errorBound`; mcTables.ts for the cited
// marching-cubes table source and the variant's documented limitations.
export {
  marchingCubes,
  marchingCubesSlab,
  muClampEpsilon,
  MIN_PITCH_MM,
  PitchTooSmallError,
  type ScalarGrid,
  type MarchingCubesSoup,
} from './marchingCubes.ts';
export { CORNER_OFFSETS, EDGE_CORNERS, EDGE_TABLE, TRI_TABLE } from './mcTables.ts';
export {
  offsetMesh,
  offsetGridSpec,
  offsetErrorBoundMm,
  maxAbsCoordOf,
  OFFSET_BAND_MARGIN_PITCHES,
  EmptyOffsetResultError,
  type OffsetMeshOptions,
  type OffsetMeshResult,
} from './offsetMesh.ts';
