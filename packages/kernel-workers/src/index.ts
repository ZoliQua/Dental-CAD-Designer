// packages/kernel-workers — worker pool infrastructure (Comlink, transferables,
// cancellation, progress) for running geometry jobs off the UI thread, in
// both browser (Web Worker) and Node (worker_threads). See pool.ts for the
// WorkerPool implementation and jobs.ts for the job registry.
export {
  WorkerPool,
  JobCancelledError,
  PoolDestroyedError,
  WorkerCrashedError,
  type RunJobOptions,
} from './pool.js';
export {
  KERNEL_VERSION,
  type JobName,
  type JobPayloadMap,
  type JobResultMap,
  type EchoMeshPayload,
  type EchoMeshResult,
  type LongTaskPayload,
  type LongTaskResult,
  type ManifoldSmokePayload,
  type ManifoldSmokeResult,
  type ParseMeshFilePayload,
  type ParseMeshFileResult,
  type StlSoupResult,
  type PlyMeshResult,
  type IntakeMeshPayload,
  type IntakeMeshResult,
  type SerializeMeshStlPayload,
  type SerializeMeshStlResult,
  type WeldMeshSoupPayload,
  type WeldMeshSoupResult,
  type RescaleMeshPayload,
  type RescaleMeshResult,
  BvhNotCachedError,
  type BuildBvhPayload,
  type BuildBvhResult,
  type ReleaseBvhPayload,
  type ReleaseBvhResult,
  type MeasurePointToSurfacePayload,
  type MeasurePointToSurfaceResult,
  type RaycastMeshPayload,
  type RaycastMeshResult,
  type DistanceHeatmapPayload,
  type DistanceHeatmapResult,
  type RepairRemoveComponentsPayload,
  type RepairRemoveComponentsResult,
  type RepairSplitNonManifoldEdgesPayload,
  type RepairSplitNonManifoldEdgesResult,
  type RepairFillSmallHolesPayload,
  type RepairFillSmallHolesResult,
  type SectionMeshPayload,
  type SectionMeshResult,
} from './jobs.js';
export { meshBuffers, type MeshBuffersPayload, type MeshBuffersResult } from './transfer.js';
// MeshStats/IntakeReport/Bbox: re-exported here (rather than only living on
// IntakeMeshResult's field types) so apps/client/src/engine — which cannot
// depend on @dqcad/kernel directly (boundaries policy: engine ->
// kernel-workers|state|shared-types) — can name these types explicitly
// (e.g. an `EngineMeshRecord.stats: MeshStats` field in engine/meshStore.ts)
// without a `IntakeMeshResult['stats']` indexing workaround.
export type {
  MeshStats,
  IntakeReport,
  IntakeStepReport,
  IntakeStepCounts,
  Bbox,
  ComponentInfo,
  RemoveComponentsReport,
  RemoveComponentsSelector,
  RepairCounts,
  SplitNonManifoldEdgesReport,
  FillSmallHolesOptions,
  FillSmallHolesReport,
  SkippedHole,
  SkippedHoleReason,
  SectionSvgPolyline,
  SectionToSvgOptions,
} from '@dqcad/kernel';
export { DEFAULT_MAX_BOUNDARY_EDGES } from '@dqcad/kernel';
// `sectionToSvg` (Task 10): a pure, dependency-free function (see kernel's
// section/svg.ts's module doc) re-exported here so apps/client/src/engine —
// which cannot import `@dqcad/kernel` directly — can render an SVG export
// on the main thread without a worker round trip (it's cheap synchronous
// string building over an already-small polyline array, not geometry
// compute), the same "re-export what engine legitimately needs" precedent
// as the type-only re-exports above.
export { sectionToSvg } from '@dqcad/kernel';
