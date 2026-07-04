// packages/io/src/stl/binary.ts
//
// Binary STL reader + writer, written from the format spec (there is no
// official standard body for STL; this follows the de-facto binary layout
// documented at e.g. https://en.wikipedia.org/wiki/STL_(file_format) and
// implemented consistently across CAD/slicer tooling):
//
//   bytes   0..79   80-byte header, arbitrary bytes (conventionally ASCII
//                    text), never parsed for semantics.
//   bytes  80..83   uint32, little-endian: triangle (facet) count N.
//   then, N times, a 50-byte record:
//     bytes  0..11   facet normal, 3x float32 LE (nx, ny, nz)
//     bytes 12..23   vertex 1, 3x float32 LE (x, y, z)
//     bytes 24..35   vertex 2, 3x float32 LE
//     bytes 36..47   vertex 3, 3x float32 LE
//     bytes 48..49   uint16 LE "attribute byte count" — nominally always 0
//                    in the base spec; some tools (e.g. VisCAM, SolidView)
//                    stash a packed RGB565 color there. We read and
//                    tolerate it (warn, never fail) but never interpret it.
//
// Spec fact this reader leans on for format detection (see parse.ts):
// binary STL's 80-byte header is arbitrary bytes and is legal to contain
// the literal text "solid ..." (some exporters do this for
// cross-tool-compatibility reasons) — so "starts with the bytes 'solid'"
// is NOT a valid binary/ASCII discriminator. The only robust signal is
// byte-length consistency: a binary file's total length must equal
// `84 + triangleCount * 50` for the triangleCount declared at offset 80.

import { IoWriteRangeError, MalformedSyntaxError } from '../types.ts';
import type { ParseDiagnostics, RawTriangleSoup } from '../types.ts';

export const STL_BINARY_HEADER_BYTES = 80;
export const STL_BINARY_COUNT_BYTES = 4;
export const STL_BINARY_PREAMBLE_BYTES = STL_BINARY_HEADER_BYTES + STL_BINARY_COUNT_BYTES; // 84
export const STL_BINARY_RECORD_BYTES = 50;

/** The binary STL triangle count is a uint32 (see this file's module doc) —
 * `writeStlBinary` cannot represent more triangles than that field can hold
 * at byte offset 80, so `assertWriteableTriangleCount` rejects anything
 * above this before the writer allocates its output buffer. */
export const STL_BINARY_MAX_TRIANGLE_COUNT = 0xffffffff;

/** Guards `writeStlBinary`'s `triangleCount` against the uint32 field it has
 * to fit into at byte offset 80. Split out from `binaryStlByteLength` (and
 * exported) so it can be unit-tested directly without allocating the
 * multi-gigabyte buffer a real over-limit `RawTriangleSoup` would require. */
export function assertWriteableTriangleCount(triangleCount: number): void {
  if (!Number.isInteger(triangleCount) || triangleCount < 0) {
    throw new IoWriteRangeError(
      `triangleCount must be a non-negative integer, got ${triangleCount}`,
    );
  }
  if (triangleCount > STL_BINARY_MAX_TRIANGLE_COUNT) {
    throw new IoWriteRangeError(
      `triangleCount (${triangleCount}) exceeds the binary STL format's uint32 triangle-count field ` +
        `(max ${STL_BINARY_MAX_TRIANGLE_COUNT}) — this file cannot be represented as a binary STL`,
    );
  }
}

/** Binary-layout byte length for `triangleCount` triangles — the same
 * `84 + N * 50` formula used both to detect binary STL (parse.ts) and to
 * size the writer's output buffer. */
export function binaryStlByteLength(triangleCount: number): number {
  return STL_BINARY_PREAMBLE_BYTES + triangleCount * STL_BINARY_RECORD_BYTES;
}

/**
 * Decodes exactly one 50-byte binary STL triangle record (see this file's
 * module doc for the on-disk layout) starting at `recordStart` in `view`,
 * writing straight into the caller's preallocated `positions`/`normals`
 * Float64Arrays at `triangleIndex`. Returns the record's raw "attribute
 * byte count" field so callers can tally the non-zero-attribute-count
 * diagnostic themselves (this function has no `ParseDiagnostics` to push
 * into, and streaming callers need to distinguish "counted so far" from
 * "final tally" anyway).
 *
 * This is the SHARED CORE both `parseBinaryStl` (below, whole-buffer) and
 * stream.ts's `parseStlStream` (chunked) decode every triangle through —
 * extracted specifically so the two entry points can never diverge in how
 * they interpret the 50 record bytes (see stream.ts's module doc for why
 * "no logic forks" between the in-memory and streaming paths matters).
 */
/** Reads one little-endian float32 at `offset` and rejects it if it isn't
 * finite — IEEE-754 float32 can legally encode ±Infinity/NaN bit patterns,
 * so a corrupted or adversarial binary STL can genuinely contain them; this
 * parser refuses to propagate them into `positions`/`normals` silently
 * (this package's "never return NaN/Infinity coordinates silently"
 * invariant — found via this task's fuzz suite, see packages/io/fuzz/ and
 * test-fixtures/fuzz-corpus/). `fieldLabel`/`triangleIndex` are only used
 * to build the error message on the (rare) failure path. */
function readFiniteFloat32(
  view: DataView,
  offset: number,
  fieldLabel: string,
  triangleIndex: number,
): number {
  const value = view.getFloat32(offset, true);
  if (!Number.isFinite(value)) {
    throw new MalformedSyntaxError(
      `triangle ${triangleIndex}'s ${fieldLabel} is ${value} at byte offset ${offset} — binary STL ` +
        'floats must be finite; this parser rejects NaN/Infinity bit patterns rather than propagating ' +
        'them silently',
      { byteOffset: offset },
    );
  }
  return value;
}

export function decodeStlBinaryRecord(
  view: DataView,
  recordStart: number,
  positions: Float64Array,
  normals: Float64Array,
  triangleIndex: number,
): number {
  const normalBase = triangleIndex * 3;
  normals[normalBase] = readFiniteFloat32(view, recordStart, 'normal.x', triangleIndex);
  normals[normalBase + 1] = readFiniteFloat32(view, recordStart + 4, 'normal.y', triangleIndex);
  normals[normalBase + 2] = readFiniteFloat32(view, recordStart + 8, 'normal.z', triangleIndex);

  const positionBase = triangleIndex * 9;
  const AXIS_LABELS = ['x', 'y', 'z'] as const;
  for (let v = 0; v < 3; v++) {
    const vertexOffset = recordStart + 12 + v * 12;
    const outBase = positionBase + v * 3;
    for (let axis = 0; axis < 3; axis++) {
      positions[outBase + axis] = readFiniteFloat32(
        view,
        vertexOffset + axis * 4,
        `vertex${v}.${AXIS_LABELS[axis]}`,
        triangleIndex,
      );
    }
  }

  return view.getUint16(recordStart + 48, true);
}

/**
 * Parses `bytes` as a binary STL, given that the caller (parse.ts) has
 * already established the declared triangle count fits the buffer length
 * (exactly, or with tolerated trailing junk). Reads straight into
 * preallocated Float64Arrays — no `number[]` staging for the bulk
 * coordinate/normal data (Float64 hard invariant, see
 * docs/plans/phase-1-import-viewer.md's Global Constraints).
 */
export function parseBinaryStl(
  bytes: Uint8Array,
  triangleCount: number,
  diagnostics: ParseDiagnostics,
): RawTriangleSoup {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = new Float64Array(triangleCount * 9);
  const normals = new Float64Array(triangleCount * 3);

  let trianglesWithNonzeroAttribute = 0;

  for (let i = 0; i < triangleCount; i++) {
    const recordStart = STL_BINARY_PREAMBLE_BYTES + i * STL_BINARY_RECORD_BYTES;
    const attributeByteCount = decodeStlBinaryRecord(view, recordStart, positions, normals, i);
    if (attributeByteCount !== 0) {
      trianglesWithNonzeroAttribute++;
    }
  }

  if (trianglesWithNonzeroAttribute > 0) {
    diagnostics.warnings.push(
      `${trianglesWithNonzeroAttribute} of ${triangleCount} triangle(s) had a non-zero attribute byte ` +
        'count (e.g. a packed-color extension some tools write there) — value read but discarded; ' +
        'this parser does not interpret the base STL spec\'s "attribute byte count" field.',
    );
  }

  return { positions, normals, triangleCount };
}

/** Zero-padded 80-byte ASCII header. Non-printable-ASCII (< 0x20 or >
 * 0x7e) characters are replaced with `?` — the header is byte-fixed at 80
 * bytes and has no encoding negotiation, so it is restricted to printable
 * ASCII rather than risking multi-byte UTF-8 sequences getting truncated
 * mid-codepoint. Text longer than 80 bytes is truncated. */
export function sanitizeStlHeader(text: string): Uint8Array {
  const header = new Uint8Array(STL_BINARY_HEADER_BYTES);
  for (let i = 0; i < text.length && i < STL_BINARY_HEADER_BYTES; i++) {
    const code = text.charCodeAt(i);
    header[i] = code >= 0x20 && code <= 0x7e ? code : 0x3f; // '?'
  }
  return header;
}

export const DEFAULT_STL_HEADER_TEXT = 'DQCAD export';

export interface WriteStlBinaryOptions {
  /** Defaults to `DEFAULT_STL_HEADER_TEXT`. Sanitized to printable ASCII
   * and truncated/zero-padded to 80 bytes — see `sanitizeStlHeader`. */
  headerText?: string;
  /** When `true` and `soup.normals` is present, writes the triangle
   * normals exactly as stored in `soup` instead of recomputing them.
   * Defaults to `false`: this writer recomputes each facet's outward
   * normal from its own vertex winding (right-hand rule over v0→v1→v2),
   * which is what most downstream STL consumers expect and is robust to
   * `soup.normals` being absent, stale, or (0,0,0) placeholders — a common
   * pattern in scanner output that some tools then silently mis-render. */
  useSourceNormals?: boolean;
}

/** Cross product of (b - a) and (c - a), normalized — the geometric facet
 * normal implied by a triangle's own vertex winding. Returns (0, 0, 0) for
 * a degenerate (zero-area) triangle rather than dividing by zero, matching
 * how such triangles are conventionally written by other STL tools. */
function geometricFacetNormal(
  positions: Float64Array,
  triangleIndex: number,
): readonly [number, number, number] {
  const base = triangleIndex * 9;
  const ax = positions[base]!;
  const ay = positions[base + 1]!;
  const az = positions[base + 2]!;
  const bx = positions[base + 3]!;
  const by = positions[base + 4]!;
  const bz = positions[base + 5]!;
  const cx = positions[base + 6]!;
  const cy = positions[base + 7]!;
  const cz = positions[base + 8]!;

  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;

  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length === 0) {
    return [0, 0, 0];
  }
  return [nx / length, ny / length, nz / length];
}

/**
 * Writes `soup` as a binary STL. The STL binary format stores IEEE-754
 * single-precision (float32) coordinates and normals — writing narrows
 * from the kernel's Float64 down to float32 here, an inherent, documented
 * lossy boundary of the file format itself (comparable to the manifold-3d
 * WASM float32 boundary in packages/kernel/src/boolean/manifold.ts), not a
 * violation of the Float64-everywhere invariant, which governs in-memory
 * representation.
 */
export function writeStlBinary(
  soup: RawTriangleSoup,
  options: WriteStlBinaryOptions = {},
): Uint8Array {
  const { positions, normals, triangleCount } = soup;
  assertWriteableTriangleCount(triangleCount);
  const useSourceNormals = options.useSourceNormals ?? false;
  const headerText = options.headerText ?? DEFAULT_STL_HEADER_TEXT;

  const bytes = new Uint8Array(binaryStlByteLength(triangleCount));
  bytes.set(sanitizeStlHeader(headerText), 0);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(STL_BINARY_HEADER_BYTES, triangleCount, true);

  for (let i = 0; i < triangleCount; i++) {
    const recordStart = STL_BINARY_PREAMBLE_BYTES + i * STL_BINARY_RECORD_BYTES;

    let nx: number;
    let ny: number;
    let nz: number;
    if (useSourceNormals && normals !== null) {
      const normalBase = i * 3;
      nx = normals[normalBase]!;
      ny = normals[normalBase + 1]!;
      nz = normals[normalBase + 2]!;
    } else {
      [nx, ny, nz] = geometricFacetNormal(positions, i);
    }
    view.setFloat32(recordStart, nx, true);
    view.setFloat32(recordStart + 4, ny, true);
    view.setFloat32(recordStart + 8, nz, true);

    const positionBase = i * 9;
    for (let v = 0; v < 3; v++) {
      const inBase = positionBase + v * 3;
      const outOffset = recordStart + 12 + v * 12;
      view.setFloat32(outOffset, positions[inBase]!, true);
      view.setFloat32(outOffset + 4, positions[inBase + 1]!, true);
      view.setFloat32(outOffset + 8, positions[inBase + 2]!, true);
    }

    view.setUint16(recordStart + 48, 0, true); // attribute byte count — always 0 on write
  }

  return bytes;
}
