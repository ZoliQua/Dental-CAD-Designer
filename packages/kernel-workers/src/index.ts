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
} from './jobs.js';
export { meshBuffers, type MeshBuffersPayload, type MeshBuffersResult } from './transfer.js';
