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
} from '@dqcad/kernel';
