// packages/io/src/stl/index.ts — public surface of the STL parser/writer.
export { parseStl, type ParseStlResult } from './parse.ts';
export {
  writeStlBinary,
  binaryStlByteLength,
  DEFAULT_STL_HEADER_TEXT,
  type WriteStlBinaryOptions,
} from './binary.ts';
