// packages/io/src/types.ts
//
// Shared types for packages/io's parsers and writers. Float64 everywhere
// (see docs/plans/phase-1-import-viewer.md's Global Constraints) — this
// package stays pure TS with zero DOM/Three.js imports (lint-enforced, see
// eslint.config.js's no-restricted-imports rule for packages/io/**).
//
// Internal relative imports in this package use literal `.ts` extensions
// (e.g. `from './types.ts'`) — packages/io becomes node-worker-reachable
// starting Phase 1, same convention as packages/kernel and
// packages/kernel-workers. See CLAUDE.md's "Import extension convention".

/**
 * Raw, unindexed triangle geometry exactly as read from a scan file — a
 * "triangle soup": every triangle owns its own three vertices, with no
 * shared-vertex indexing and no welding of coincident vertices. Welding
 * duplicate vertices into an indexed mesh is intake's job (Task 4), not
 * this parser's — this type is intentionally unindexed.
 *
 * `positions` is a flat, Float64, 9-values-per-triangle array in file
 * order: `[t0.v0.x, t0.v0.y, t0.v0.z, t0.v1.x, ..., t0.v2.z, t1.v0.x, ...]`
 * (length = triangleCount * 9). `normals`, when present, is 3 values per
 * triangle — the single facet normal literally stored in the file (STL
 * carries one normal per facet, not per vertex); `null` when the source
 * format carries no normals at all. Normals here are read-as-stored, never
 * recomputed or renormalized by the parser — callers that need guaranteed
 * outward-consistent normals should recompute geometrically downstream.
 */
export interface RawTriangleSoup {
  positions: Float64Array;
  normals: Float64Array | null;
  triangleCount: number;
}

/**
 * The concrete format a parser detected/consumed. STL only ever reports one
 * endianness (its binary layout is little-endian-only per the de-facto
 * spec — see stl/binary.ts), but PLY's binary format is explicitly
 * endianness-tagged in its own header (`format binary_little_endian 1.0` vs
 * `format binary_big_endian 1.0` — see ply/header.ts), so the PLY variants
 * are split into `'ply-binary-le' | 'ply-binary-be'` rather than a single
 * `'ply-binary'`, letting callers see which endianness a given file
 * actually declared without re-deriving it themselves.
 */
export type ParseFormat = 'stl-binary' | 'stl-ascii' | 'ply-binary-le' | 'ply-binary-be' | 'ply-ascii';

/** Non-fatal parse observations — malformed-but-recoverable input never
 * throws; it's recorded here instead (e.g. a non-zero STL attribute byte
 * count, or trailing bytes past the last binary triangle record). */
export interface ParseDiagnostics {
  warnings: string[];
  format: ParseFormat;
}

/** Where in the source a parse error occurred — a byte offset for binary
 * formats, a 1-based line number for text formats. Both are optional since
 * not every error site can pin down both (e.g. "file too short to contain
 * a header" has a byte offset but no line). */
export interface ParseErrorContext {
  byteOffset?: number;
  line?: number;
}

/**
 * Base class for every parse failure in packages/io. Carries optional
 * `byteOffset`/`line` context (see `ParseErrorContext`) so callers can
 * report exactly where in the source file parsing broke down.
 */
export class IoParseError extends Error {
  readonly byteOffset: number | undefined;
  readonly line: number | undefined;

  constructor(message: string, context: ParseErrorContext = {}) {
    super(message);
    this.name = 'IoParseError';
    this.byteOffset = context.byteOffset;
    this.line = context.line;
    // Restores `instanceof IoParseError` / `instanceof TruncatedFileError`
    // checks under the target's transpiled `Error` subclassing behavior.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The input ends before the format's grammar/layout says it should — a
 * declared binary triangle count that runs past EOF, an ASCII `solid`
 * block missing its `endsolid`, a file too small to hold even a header. */
export class TruncatedFileError extends IoParseError {
  constructor(message: string, context: ParseErrorContext = {}) {
    super(message, context);
    this.name = 'TruncatedFileError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The input has enough bytes/lines but they don't match the format's
 * grammar — an unrecognized ASCII keyword, a non-numeric coordinate token,
 * a second `solid` block in one file. */
export class MalformedSyntaxError extends IoParseError {
  constructor(message: string, context: ParseErrorContext = {}) {
    super(message, context);
    this.name = 'MalformedSyntaxError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by `parseStlStream` / `parsePlyStream` (stl/stream.ts, ply/
 * stream.ts) when the caller-supplied `AbortSignal` fires. Deliberately NOT
 * an `IoParseError` subclass — cancellation isn't a statement about the
 * bytes being malformed, so callers that specifically handle parse failures
 * (`instanceof IoParseError`) shouldn't accidentally also catch this. This
 * package stays independent of packages/kernel-workers (see the layer rule
 * in CLAUDE.md — kernel-workers depends on io, never the reverse), so this
 * is intentionally distinct from kernel-workers' `JobCancelledError`; the
 * `parseMeshFile` worker job (kernel-workers/src/jobs.ts) translates
 * between the two at that boundary.
 */
export class IoStreamCancelledError extends Error {
  constructor(message = 'stream parse cancelled') {
    super(message);
    this.name = 'IoStreamCancelledError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A *writer*-side counterpart to `IoParseError`: input to a writer (e.g.
 * `writeStlBinary`'s `RawTriangleSoup`) that is structurally valid TS but
 * out of range for the target file format's on-disk layout — e.g. more
 * triangles than binary STL's uint32 triangle-count field at byte offset 80
 * can represent. Not an `IoParseError` subclass since nothing was parsed;
 * this fires while producing bytes, not consuming them. */
export class IoWriteRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IoWriteRangeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
