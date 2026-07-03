// packages/io — STL/PLY parsers and writers. Pure TS, Float64.
//
// Internal relative imports in this package use literal `.ts` extensions
// (see types.ts's module doc / CLAUDE.md's "Import extension convention")
// — packages/io is node-worker-reachable starting Phase 1.

export type { RawTriangleSoup, ParseFormat, ParseDiagnostics, ParseErrorContext } from './types.ts';
export { IoParseError, TruncatedFileError, MalformedSyntaxError } from './types.ts';

export {
  parseStl,
  writeStlBinary,
  binaryStlByteLength,
  DEFAULT_STL_HEADER_TEXT,
  type ParseStlResult,
  type WriteStlBinaryOptions,
} from './stl/index.ts';
