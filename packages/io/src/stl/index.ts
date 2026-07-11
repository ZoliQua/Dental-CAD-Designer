// packages/io/src/stl/index.ts — public surface of the STL parser/writer.
export { parseStl, type ParseStlResult } from './parse.ts';
export {
  writeStlBinary,
  binaryStlByteLength,
  assertWriteableTriangleCount,
  STL_BINARY_MAX_TRIANGLE_COUNT,
  DEFAULT_STL_HEADER_TEXT,
  type WriteStlBinaryOptions,
} from './binary.ts';
export { parseStlStream, type ParseStlStreamOptions } from './stream.ts';
