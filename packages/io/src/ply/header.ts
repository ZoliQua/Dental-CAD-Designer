// packages/io/src/ply/header.ts
//
// PLY header parser, written from Turk's "PLY - Polygon File Format"
// description (the de facto spec for this format; there is no formal
// standards body). Grammar (all header lines are `\n`- or `\r\n`-terminated
// ASCII text, even for the two binary body formats — only the *body* is
// binary):
//
//   ply
//   format <ascii | binary_little_endian | binary_big_endian> 1.0
//   (comment <text> | obj_info <text>)*
//   ( element <name> <count>
//     ( property <type> <name>
//     | property list <count-type> <item-type> <name> )*
//   )*
//   end_header
//
// Subtle spec facts this parser leans on:
//
// 1. The magic line is the literal 3-byte word "ply" — nothing else is a
//    valid PLY file, regardless of what follows. Checked first, before
//    even attempting to locate `end_header`, so a non-PLY file gets a
//    clear "bad magic" MalformedSyntaxError instead of a confusing
//    "no end_header found" TruncatedFileError.
// 2. `comment`/`obj_info` lines may appear *interleaved* with `element`/
//    `property` lines per the grammar above (not only at the very top) —
//    this parser accepts them anywhere between `format` and `end_header`.
// 3. A `property` line (scalar or list) always belongs to the most
//    recently declared `element` — property order is NEVER assumed by
//    file type; it's read from the header and carried through in
//    `PlyElementSpec.properties`, in header order, for every downstream
//    reader (plan.ts / binary.ts / ascii.ts) to consume positionally
//    within a row.
// 4. `end_header` is immediately followed by exactly one newline
//    (`\n` or `\r\n`), and the body starts on the very next byte — no
//    blank line, no extra whitespace. This parser locates that exact byte
//    offset (`bodyOffset`) rather than assuming any particular header
//    length.
// 5. This reader locates `end_header` via a bounded raw byte scan (never
//    decoding the (potentially huge, binary) body as text) — a real
//    header is at most a few KB; `HEADER_SEARCH_LIMIT_BYTES` below is a
//    generous 1 MiB upper bound so a malformed file with no `end_header`
//    fails fast with a clear error instead of scanning gigabytes.

import { MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import { resolvePlyScalarType } from './scalars.ts';
import type {
  PlyElementSpec,
  PlyFormat,
  PlyHeader,
  PlyHeaderComment,
  PlyProperty,
} from './types.ts';

const HEADER_SEARCH_LIMIT_BYTES = 1_048_576; // 1 MiB — see module doc point 5.
const END_HEADER_TOKEN = 'end_header';
const SUPPORTED_VERSION = '1.0'; // the only version the PLY 1.0 spec defines.

const FORMAT_KEYWORDS: ReadonlySet<PlyFormat> = new Set([
  'ascii',
  'binary_little_endian',
  'binary_big_endian',
]);

function isPlyFormat(token: string): token is PlyFormat {
  return FORMAT_KEYWORDS.has(token as PlyFormat);
}

/** Finds the first byte offset of `needle` (an ASCII string) within
 * `bytes`, scanning at most `searchLimit` bytes. Deliberately a raw byte
 * comparison, not a decode-then-`indexOf` — see module doc point 5 for
 * why decoding the body is avoided. */
function findAsciiNeedle(bytes: Uint8Array, needle: string, searchLimit: number): number {
  const needleBytes: number[] = [];
  for (let i = 0; i < needle.length; i++) {
    needleBytes.push(needle.charCodeAt(i));
  }
  const limit = Math.min(bytes.byteLength, searchLimit);
  const lastStart = limit - needleBytes.length;
  outer: for (let i = 0; i <= lastStart; i++) {
    for (let j = 0; j < needleBytes.length; j++) {
      if (bytes[i + j] !== needleBytes[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

/** Returns the byte offset just past the first line terminator (`\n`,
 * `\r\n`, or a lone `\r`) starting at `from`, or `-1` if `bytes` has no
 * terminator at/after `from` within `searchLimit`. */
function findLineEnd(bytes: Uint8Array, from: number, searchLimit: number): number {
  const limit = Math.min(bytes.byteLength, searchLimit);
  for (let i = from; i < limit; i++) {
    if (bytes[i] === 0x0a) {
      return i + 1; // "\n"
    }
    if (bytes[i] === 0x0d) {
      return bytes[i + 1] === 0x0a ? i + 2 : i + 1; // "\r\n" or lone "\r"
    }
  }
  return -1;
}

function parseHeaderCount(token: string, lineNumber: number): number {
  // Strictly `\d+` — no sign, no decimal point, no exponent. A PLY element
  // count is a row count; anything else is malformed, and an unbounded
  // digit string that overflows Number.MAX_SAFE_INTEGER is rejected
  // explicitly (a 2^53+-row element cannot exist in an actually-readable
  // file, so trusting `Number()`'s silent precision loss there would only
  // manufacture a wrong-but-plausible-looking count).
  if (!/^\d+$/.test(token)) {
    throw new MalformedSyntaxError(
      `invalid element count "${token}" on line ${lineNumber}: expected a non-negative integer`,
      { line: lineNumber },
    );
  }
  const value = Number(token);
  if (!Number.isSafeInteger(value)) {
    throw new MalformedSyntaxError(
      `element count "${token}" on line ${lineNumber} overflows the safe integer range ` +
        `(max ${Number.MAX_SAFE_INTEGER}) — this header cannot be represented`,
      { line: lineNumber },
    );
  }
  return value;
}

function parsePropertyLine(
  tokens: readonly string[],
  lineNumber: number,
  currentElement: { name: string; count: number; properties: PlyProperty[] } | null,
): void {
  if (currentElement === null) {
    throw new MalformedSyntaxError(
      `"property" line ${lineNumber} appears before any "element" line — a property always belongs ` +
        'to the most recently declared element',
      { line: lineNumber },
    );
  }

  if (tokens[1] === 'list') {
    const countTypeToken = tokens[2];
    const itemTypeToken = tokens[3];
    const name = tokens[4];
    if (countTypeToken === undefined || itemTypeToken === undefined || name === undefined) {
      throw new MalformedSyntaxError(
        `malformed "property list" line ${lineNumber}: expected ` +
          '"property list <count-type> <item-type> <name>"',
        { line: lineNumber },
      );
    }
    const countType = resolvePlyScalarType(countTypeToken);
    const itemType = resolvePlyScalarType(itemTypeToken);
    if (countType === null) {
      throw new MalformedSyntaxError(
        `unknown PLY scalar type "${countTypeToken}" (list count type) on line ${lineNumber}`,
        { line: lineNumber },
      );
    }
    if (itemType === null) {
      throw new MalformedSyntaxError(
        `unknown PLY scalar type "${itemTypeToken}" (list item type) on line ${lineNumber}`,
        { line: lineNumber },
      );
    }
    currentElement.properties.push({ kind: 'list', name, countType, itemType });
    return;
  }

  const typeToken = tokens[1];
  const name = tokens[2];
  if (typeToken === undefined || name === undefined) {
    throw new MalformedSyntaxError(
      `malformed "property" line ${lineNumber}: expected "property <type> <name>" or ` +
        '"property list <count-type> <item-type> <name>"',
      { line: lineNumber },
    );
  }
  const scalarType = resolvePlyScalarType(typeToken);
  if (scalarType === null) {
    throw new MalformedSyntaxError(`unknown PLY scalar type "${typeToken}" on line ${lineNumber}`, {
      line: lineNumber,
    });
  }
  currentElement.properties.push({ kind: 'scalar', name, scalarType });
}

export interface ParsePlyHeaderResult {
  header: PlyHeader;
  /** Byte offset of the first body byte — immediately after the single
   * newline that terminates `end_header` (see module doc point 4). */
  bodyOffset: number;
}

/**
 * Parses the header of `bytes` (a full PLY file, of any of the three body
 * formats — the header itself is always ASCII text). Reads no body bytes;
 * callers dispatch to the binary or ASCII body reader using
 * `header.format`.
 */
export function parsePlyHeader(bytes: Uint8Array): ParsePlyHeaderResult {
  if (bytes.byteLength === 0) {
    throw new TruncatedFileError('empty file: 0 bytes is not a valid PLY file', { byteOffset: 0 });
  }

  // Magic check first (module doc point 1) — a byte-for-byte match against
  // "ply" as its own line, not merely a "starts with ply" prefix check
  // (which would, e.g., wrongly accept a file starting "plywood...").
  const firstLineEnd = findLineEnd(bytes, 0, Math.min(bytes.byteLength, 256));
  const magicLineBytes = bytes.subarray(0, firstLineEnd === -1 ? bytes.byteLength : firstLineEnd);
  const magicLine = new TextDecoder('utf-8', { fatal: false }).decode(magicLineBytes).trim();
  if (magicLine !== 'ply') {
    throw new MalformedSyntaxError(
      `bad PLY magic: expected the file's first line to be exactly "ply", got ${JSON.stringify(
        magicLine.slice(0, 40),
      )}`,
      { byteOffset: 0, line: 1 },
    );
  }

  const endHeaderIndex = findAsciiNeedle(bytes, END_HEADER_TOKEN, HEADER_SEARCH_LIMIT_BYTES);
  if (endHeaderIndex === -1) {
    throw new TruncatedFileError(
      `no "end_header" found within the first ${HEADER_SEARCH_LIMIT_BYTES} byte(s) — truncated or ` +
        'malformed PLY header',
      { byteOffset: 0 },
    );
  }
  const afterEndHeaderToken = endHeaderIndex + END_HEADER_TOKEN.length;
  let bodyOffset: number;
  if (bytes[afterEndHeaderToken] === 0x0d && bytes[afterEndHeaderToken + 1] === 0x0a) {
    bodyOffset = afterEndHeaderToken + 2;
  } else if (bytes[afterEndHeaderToken] === 0x0a || bytes[afterEndHeaderToken] === 0x0d) {
    bodyOffset = afterEndHeaderToken + 1;
  } else {
    throw new MalformedSyntaxError('"end_header" is not followed by a newline', {
      byteOffset: afterEndHeaderToken,
    });
  }

  const headerText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, bodyOffset));
  const rawLines = headerText.split(/\r\n|\r|\n/);

  let format: PlyFormat | null = null;
  let version: string | null = null;
  const comments: PlyHeaderComment[] = [];
  const elements: PlyElementSpec[] = [];
  let current: { name: string; count: number; properties: PlyProperty[] } | null = null;

  // Line 0 is the already-validated "ply" magic line; line indices below
  // are 1-based to match the 1-based line numbers real files are authored
  // with (matches STL's error-reporting convention in this package).
  for (let i = 1; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const line = rawLines[i]!.trim();
    if (line.length === 0) {
      continue; // tolerated (module doc doesn't forbid blank lines in the header)
    }
    if (line === END_HEADER_TOKEN) {
      break;
    }

    const tokens = line.split(/\s+/);
    const keyword = tokens[0];

    if (keyword === 'format') {
      if (format !== null) {
        throw new MalformedSyntaxError(`duplicate "format" line ${lineNumber}`, { line: lineNumber });
      }
      const formatToken = tokens[1];
      const versionToken = tokens[2];
      if (formatToken === undefined || versionToken === undefined || !isPlyFormat(formatToken)) {
        throw new MalformedSyntaxError(
          `malformed "format" line ${lineNumber}: expected "format ` +
            '<ascii|binary_little_endian|binary_big_endian> 1.0"',
          { line: lineNumber },
        );
      }
      if (versionToken !== SUPPORTED_VERSION) {
        throw new MalformedSyntaxError(
          `unsupported PLY version "${versionToken}" on line ${lineNumber} — only ` +
            `${SUPPORTED_VERSION} is defined by the spec this parser implements`,
          { line: lineNumber },
        );
      }
      format = formatToken;
      version = versionToken;
      continue;
    }

    if (keyword === 'comment' || keyword === 'obj_info') {
      const text = line.slice(keyword.length).trim();
      comments.push({ keyword, text });
      continue;
    }

    if (keyword === 'element') {
      const name = tokens[1];
      const countToken = tokens[2];
      if (name === undefined || countToken === undefined) {
        throw new MalformedSyntaxError(
          `malformed "element" line ${lineNumber}: expected "element <name> <count>"`,
          { line: lineNumber },
        );
      }
      const count = parseHeaderCount(countToken, lineNumber);
      current = { name, count, properties: [] };
      elements.push(current);
      continue;
    }

    if (keyword === 'property') {
      parsePropertyLine(tokens, lineNumber, current);
      continue;
    }

    throw new MalformedSyntaxError(`unrecognized header line ${lineNumber}: "${line}"`, {
      line: lineNumber,
    });
  }

  if (format === null || version === null) {
    throw new MalformedSyntaxError('PLY header has no "format" line', { line: 2 });
  }

  return {
    header: { format, version, comments, elements },
    bodyOffset,
  };
}
