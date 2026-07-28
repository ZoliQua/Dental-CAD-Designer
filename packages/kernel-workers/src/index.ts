// packages/kernel-workers — worker pool infrastructure (Comlink, transferables,
// cancellation, progress) for running geometry jobs off the UI thread, in
// both browser (Web Worker) and Node (worker_threads). See pool.ts for the
// WorkerPool implementation and jobs/registry.ts for the job registry (split
// into jobs/*.ts per-domain modules — see that file's module doc).
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
  SdfNotCachedError,
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
  type ComputeCurvaturePayload,
  type ComputeCurvatureResult,
  type RepairRemoveComponentsPayload,
  type RepairRemoveComponentsResult,
  type RepairSplitNonManifoldEdgesPayload,
  type RepairSplitNonManifoldEdgesResult,
  type RepairSplitNonManifoldVerticesPayload,
  type RepairSplitNonManifoldVerticesResult,
  type RepairFillSmallHolesPayload,
  type RepairFillSmallHolesResult,
  type SectionMeshPayload,
  type SectionMeshResult,
  type HashMeshPayload,
  type HashMeshResult,
  type GeodesicPathPayload,
  type GeodesicPathResult,
  type SnapPolylinePayload,
  type SnapPolylineResult,
  type SurfacePointPayload,
  DegenerateTripleError,
  type CoarsePointPair,
  type IcpRegisterPayload,
  type IcpRegisterResult,
  NoRidgeFoundError,
  NoClosureError,
  MARGIN_SEARCH_RADIUS_MM,
  type MarginSurfacePointPayload,
  type ProposeMarginPayload,
  type ProposeMarginResult,
  type MarginAnchorPayload,
  type MarginLinePayload,
  type ValidateMarginPayload,
  type ValidateMarginResult,
  EmptyRegionError,
  DegenerateRegionNormalError,
  AXIS_DEFAULT_ROI_RADIUS_MM,
  AXIS_SEARCH_PRESETS,
  type AxisSearchPresetName,
  type SuggestAxisPayload,
  type SuggestAxisResult,
  type SuggestAxisCandidatePayload,
  type AxisHeatmapPayload,
  type AxisHeatmapResult,
  type AxisHeatmapAbutmentStats,
  type BlockoutPreviewPayload,
  type BlockoutPreviewJobResult,
  type ExportRestorationMeshPayload,
  type ExportRestorationMeshResult,
} from './jobs/registry.js';
// Case-journal hash (Phase 7 Task 3) — the shared client/server definition
// of `RestorationExportRequest.caseJournalHash` (see journalHash.ts's module
// doc). Exported from the main entry (engine → kernel-workers is the allowed
// path for apps/client) AND via the `./journal-hash` package subpath (like
// `./hash`) so the Task 4 server can import the exact same implementation
// without pulling the worker-pool machinery.
export {
  canonicalJournalJson,
  hashCaseJournal,
  JournalHashUnserializableError,
} from './journalHash.js';
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
  SplitNonManifoldVerticesReport,
  FillSmallHolesOptions,
  FillSmallHolesReport,
  SkippedHole,
  SkippedHoleReason,
  SectionSvgPolyline,
  SectionToSvgOptions,
} from '@dqcad/kernel';
export { DEFAULT_MAX_BOUNDARY_EDGES } from '@dqcad/kernel';
// `IDENTITY_MAT4` (Phase 3 Task 3): the register/ module's identity
// column-major 4x4 (SceneNode.transform convention) — re-exported so
// apps/client/src/engine/alignment.ts can pass it as `icpRegister`'s
// `initialTransform` (the "both scans already share a coordinate frame"
// case — see @dqcad/kernel's icpRefine.ts module doc) without importing
// `@dqcad/kernel` itself. A plain constant, not geometry compute — same
// "re-export what engine legitimately needs" precedent as `sectionToSvg`.
export { IDENTITY_MAT4 } from '@dqcad/kernel';
// `sectionToSvg` (Task 10): a pure, dependency-free function (see kernel's
// section/svg.ts's module doc) re-exported here so apps/client/src/engine —
// which cannot import `@dqcad/kernel` directly — can render an SVG export
// on the main thread without a worker round trip (it's cheap synchronous
// string building over an already-small polyline array, not geometry
// compute), the same "re-export what engine legitimately needs" precedent
// as the type-only re-exports above.
export { sectionToSvg } from '@dqcad/kernel';
