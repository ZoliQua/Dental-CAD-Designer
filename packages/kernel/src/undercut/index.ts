// packages/kernel/src/undercut — insertion-axis undercut scan (Phase 2 Task
// 9). See undercutScan.ts's module doc for the sign convention, depth
// semantics, sampling policy `@errorBound`, and ray-origin epsilon policy.
export {
  undercutScan,
  undercutScanBatch,
  undercutScanRange,
  undercutScanIndices,
  undercutScanBatchIndices,
  RAY_ORIGIN_BIAS_MM,
  UNDERCUT_BOUNDARY_EPSILON,
  type UndercutSamplingPolicy,
  type UndercutScanOptions,
  type UndercutScanBatchOptions,
  type UndercutScanResult,
  type UndercutTriangleRange,
  type UndercutScanRangeOutput,
  type UndercutScanRangeStats,
  type UndercutScanIndicesOutput,
  type UndercutScanIndicesResult,
} from './undercutScan.ts';
