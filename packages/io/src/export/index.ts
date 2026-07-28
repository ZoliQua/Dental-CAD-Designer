// packages/io/src/export/index.ts — manufacturing-export entries (Phase 7
// Task 2). See stl.ts / ply.ts / validate.ts / narrowing.ts module docs.

export {
  ExportMeshInvalidError,
  type ExportMeshInvalidReason,
  type ExportableMesh,
} from './types.ts';
export {
  assertExportableSolid,
  assertExportVertexCountWithinEdgeKeyRange,
  MAX_EXPORT_VERTEX_COUNT,
  type ExportSolidCheck,
} from './validate.ts';
export {
  exportStlBinary,
  EXPORT_STL_HEADER_TEXT,
  F32_MAX_MAGNITUDE,
  type ExportStlBinaryOptions,
} from './stl.ts';
export { exportPlyBinary, EXPORT_PLY_COMMENT, type ExportPlyBinaryOptions } from './ply.ts';
export { f32UlpAt, measureF32NarrowingError, type F32NarrowingReport } from './narrowing.ts';
