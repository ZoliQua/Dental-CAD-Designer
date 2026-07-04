// packages/io/src/ply/index.ts — public surface of the PLY parser/writer.
export { parsePly } from './parse.ts';
export {
  writePlyBinaryLE,
  sanitizePlyComment,
  DEFAULT_PLY_COMMENT,
  type WritablePlyMesh,
  type WritePlyBinaryOptions,
} from './binary.ts';
export { parsePlyHeader, type ParsePlyHeaderResult } from './header.ts';
export { parsePlyStream, type ParsePlyStreamOptions } from './stream.ts';
export type {
  PlyMesh,
  PlyHeader,
  PlyHeaderComment,
  PlyFormat,
  PlyElementSpec,
  PlyProperty,
  PlyScalarProperty,
  PlyListProperty,
} from './types.ts';
export type { PlyScalarType } from './scalars.ts';
