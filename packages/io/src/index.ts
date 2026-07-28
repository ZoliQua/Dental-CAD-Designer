// packages/io — STL/PLY parsers and writers. Pure TS, Float64.
//
// Internal relative imports in this package use literal `.ts` extensions
// (see types.ts's module doc / CLAUDE.md's "Import extension convention")
// — packages/io is node-worker-reachable starting Phase 1.

export type { RawTriangleSoup, ParseFormat, ParseDiagnostics, ParseErrorContext } from './types.ts';
export {
  IoParseError,
  TruncatedFileError,
  MalformedSyntaxError,
  IoWriteRangeError,
  IoStreamCancelledError,
} from './types.ts';
export { iterateInFixedChunks } from './stream/chunk-iterables.ts';

export {
  parseStl,
  parseStlStream,
  writeStlBinary,
  binaryStlByteLength,
  assertWriteableTriangleCount,
  STL_BINARY_MAX_TRIANGLE_COUNT,
  DEFAULT_STL_HEADER_TEXT,
  type ParseStlResult,
  type ParseStlStreamOptions,
  type WriteStlBinaryOptions,
} from './stl/index.ts';

export {
  exportStlBinary,
  exportPlyBinary,
  assertExportableSolid,
  measureF32NarrowingError,
  f32UlpAt,
  ExportMeshInvalidError,
  EXPORT_STL_HEADER_TEXT,
  EXPORT_PLY_COMMENT,
  F32_MAX_MAGNITUDE,
  MAX_EXPORT_VERTEX_COUNT,
  type ExportableMesh,
  type ExportMeshInvalidReason,
  type ExportSolidCheck,
  type ExportStlBinaryOptions,
  type ExportPlyBinaryOptions,
  type F32NarrowingReport,
} from './export/index.ts';

export {
  parsePly,
  parsePlyStream,
  writePlyBinaryLE,
  sanitizePlyComment,
  DEFAULT_PLY_COMMENT,
  parsePlyHeader,
  type WritablePlyMesh,
  type WritePlyBinaryOptions,
  type ParsePlyHeaderResult,
  type ParsePlyStreamOptions,
  type PlyMesh,
  type PlyHeader,
  type PlyHeaderComment,
  type PlyFormat,
  type PlyElementSpec,
  type PlyProperty,
  type PlyScalarProperty,
  type PlyListProperty,
  type PlyScalarType,
} from './ply/index.ts';
