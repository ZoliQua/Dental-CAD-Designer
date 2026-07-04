// packages/io/src/stl/ascii.ts
//
// ASCII STL reader, written from the de-facto ASCII STL grammar (same
// source family as binary.ts's module doc):
//
//   solid <name>
//   ( facet normal <ni> <nj> <nk>
//       outer loop
//         vertex <v1x> <v1y> <v1z>
//         vertex <v2x> <v2y> <v2z>
//         vertex <v3x> <v3y> <v3z>
//       endloop
//     endfacet )*
//   endsolid <name>
//
// Tolerant per the brief: keywords are matched case-insensitively, runs of
// whitespace (spaces/tabs) between tokens are accepted, blank lines are
// skipped, and numeric tokens accept the full `Number()` grammar including
// scientific notation (`1.5e+02`) and a leading sign.
//
// Two-pass walk: `walkAsciiStl` fully validates the grammar and (via an
// optional per-triangle callback) can also extract values, but the parsed
// numbers themselves are never accumulated into a JS array — the first
// call (no callback) only counts triangles and validates; the second call
// (with a callback) writes straight into the caller's preallocated
// Float64Arrays. This keeps bulk coordinate data out of `number[]`
// entirely (Float64 hard invariant — see docs/plans/phase-1-import-viewer.md
// Global Constraints), at the cost of walking the token stream twice,
// which is acceptable here since ASCII STL is not this package's
// performance-critical path (all golden/real-scan fixtures are binary).

import { MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import type { RawTriangleSoup } from '../types.ts';

interface Line {
  readonly number: number; // 1-based
  readonly trimmed: string;
}

export function splitLines(text: string): readonly Line[] {
  return text.split(/\r\n|\r|\n/).map((raw, index) => ({ number: index + 1, trimmed: raw.trim() }));
}

function nextMeaningfulIndex(lines: readonly Line[], from: number): number {
  let i = from;
  while (i < lines.length && lines[i]!.trimmed.length === 0) {
    i++;
  }
  return i;
}

function parseFloatToken(token: string, line: Line, fieldLabel: string): number {
  const value = Number(token);
  // `!Number.isFinite` (not just `Number.isNaN`) is deliberate: every
  // numeric token in STL's ASCII grammar feeds directly into a stored
  // coordinate/normal (there is no "unrecognized, skipped" concept in this
  // format, unlike PLY's optional properties), so `Number("Infinity")` /
  // `Number("-Infinity")` — both of which parse successfully in plain JS,
  // and are NOT caught by `Number.isNaN` — must be rejected here too, not
  // just literal "NaN"/empty/non-numeric tokens. Silently storing ±Infinity
  // into `positions`/`normals` would violate this package's "never return
  // NaN/Infinity coordinates silently" invariant (found via this task's
  // fuzz suite — see packages/io/fuzz/ and test-fixtures/fuzz-corpus/).
  if (token.length === 0 || !Number.isFinite(value)) {
    throw new MalformedSyntaxError(
      `invalid ${fieldLabel} value "${token}" on line ${line.number}: expected a finite number`,
      { line: line.number },
    );
  }
  return value;
}

const SOLID_RE = /^solid(?:\s+.*)?$/i;
const ENDSOLID_RE = /^endsolid(?:\s+.*)?$/i;
const FACET_NORMAL_RE = /^facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i;
const OUTER_LOOP_RE = /^outer\s+loop$/i;
const VERTEX_RE = /^vertex\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i;
const ENDLOOP_RE = /^endloop$/i;
const ENDFACET_RE = /^endfacet$/i;

type Vec3 = readonly [number, number, number];

interface TriangleSink {
  (index: number, normal: Vec3, v0: Vec3, v1: Vec3, v2: Vec3): void;
}

function expectLine(
  lines: readonly Line[],
  index: number,
  pattern: RegExp,
  expectedDescription: string,
): { line: Line; nextIndex: number } {
  const i = nextMeaningfulIndex(lines, index);
  if (i >= lines.length) {
    throw new TruncatedFileError(`unexpected end of file: expected ${expectedDescription}`, {
      line: (lines[lines.length - 1]?.number ?? 0) + 1,
    });
  }
  const line = lines[i]!;
  if (!pattern.test(line.trimmed)) {
    throw new MalformedSyntaxError(
      `unexpected content on line ${line.number}: expected ${expectedDescription}, got "${line.trimmed}"`,
      { line: line.number },
    );
  }
  return { line, nextIndex: i + 1 };
}

function parseVec3FromMatch(match: RegExpExecArray, line: Line, fieldLabel: string): Vec3 {
  const x = parseFloatToken(match[1]!, line, `${fieldLabel}.x`);
  const y = parseFloatToken(match[2]!, line, `${fieldLabel}.y`);
  const z = parseFloatToken(match[3]!, line, `${fieldLabel}.z`);
  return [x, y, z];
}

/** Validates the full ASCII grammar and returns the triangle count.
 * `sink`, when given, is invoked once per triangle with its parsed
 * normal/vertices (see the module doc for why this is a two-pass design).
 * Exported (in addition to `parseAsciiStl`) so parse.ts's bounded prefix
 * check (`looksGrammaticalAsciiStlPrefix` below) can reuse this exact
 * grammar walk against a deliberately truncated line array — see that
 * function's doc for why a `TruncatedFileError` from a bounded prefix is
 * inconclusive rather than a real rejection. */
export function walkAsciiStl(lines: readonly Line[], sink?: TriangleSink): number {
  const firstIndex = nextMeaningfulIndex(lines, 0);
  if (firstIndex >= lines.length) {
    throw new TruncatedFileError('empty ASCII STL: no "solid" line found', { line: 1 });
  }
  const { nextIndex: afterSolid } = expectLine(lines, firstIndex, SOLID_RE, '"solid <name>"');

  let cursor = afterSolid;
  let triangleIndex = 0;

  for (;;) {
    const i = nextMeaningfulIndex(lines, cursor);
    if (i >= lines.length) {
      throw new TruncatedFileError('unexpected end of file: expected "facet" or "endsolid"', {
        line: (lines[lines.length - 1]?.number ?? 0) + 1,
      });
    }
    const line = lines[i]!;

    if (ENDSOLID_RE.test(line.trimmed)) {
      cursor = i + 1;
      break;
    }

    const facetMatch = FACET_NORMAL_RE.exec(line.trimmed);
    if (facetMatch === null) {
      throw new MalformedSyntaxError(
        `unexpected content on line ${line.number}: expected "facet normal <nx> <ny> <nz>" or "endsolid", ` +
          `got "${line.trimmed}"`,
        { line: line.number },
      );
    }
    const normal = parseVec3FromMatch(facetMatch, line, 'facet normal');
    cursor = i + 1;

    ({ nextIndex: cursor } = expectLine(lines, cursor, OUTER_LOOP_RE, '"outer loop"'));

    const vertices: Vec3[] = [];
    for (let v = 0; v < 3; v++) {
      const { line: vertexLine, nextIndex } = expectLine(
        lines,
        cursor,
        VERTEX_RE,
        '"vertex <x> <y> <z>"',
      );
      const match = VERTEX_RE.exec(vertexLine.trimmed)!;
      vertices.push(parseVec3FromMatch(match, vertexLine, `vertex ${v}`));
      cursor = nextIndex;
    }

    ({ nextIndex: cursor } = expectLine(lines, cursor, ENDLOOP_RE, '"endloop"'));
    ({ nextIndex: cursor } = expectLine(lines, cursor, ENDFACET_RE, '"endfacet"'));

    if (sink) {
      const [v0, v1, v2] = vertices as [Vec3, Vec3, Vec3];
      sink(triangleIndex, normal, v0, v1, v2);
    }
    triangleIndex++;
  }

  // Trailing-content check: a second "solid" block is explicitly out of
  // scope for this parser (merging two independently-named triangle soups
  // into one RawTriangleSoup is a policy decision that belongs to a
  // caller, not this reader) — reject with a clear, line-numbered error
  // rather than silently dropping or silently merging it.
  const trailingIndex = nextMeaningfulIndex(lines, cursor);
  if (trailingIndex < lines.length) {
    const trailingLine = lines[trailingIndex]!;
    if (SOLID_RE.test(trailingLine.trimmed)) {
      throw new MalformedSyntaxError(
        `line ${trailingLine.number}: a second "solid" block was found — multiple solid blocks per ASCII ` +
          'STL file are not supported by this parser; split the file into one file per solid',
        { line: trailingLine.number },
      );
    }
    throw new MalformedSyntaxError(
      `unexpected content on line ${trailingLine.number} after "endsolid": "${trailingLine.trimmed}"`,
      { line: trailingLine.number },
    );
  }

  return triangleIndex;
}

export function parseAsciiStl(text: string): RawTriangleSoup {
  const lines = splitLines(text);

  const triangleCount = walkAsciiStl(lines);

  const positions = new Float64Array(triangleCount * 9);
  const normals = new Float64Array(triangleCount * 3);

  walkAsciiStl(lines, (index, normal, v0, v1, v2) => {
    const normalBase = index * 3;
    normals[normalBase] = normal[0];
    normals[normalBase + 1] = normal[1];
    normals[normalBase + 2] = normal[2];

    const positionBase = index * 9;
    positions[positionBase] = v0[0];
    positions[positionBase + 1] = v0[1];
    positions[positionBase + 2] = v0[2];
    positions[positionBase + 3] = v1[0];
    positions[positionBase + 4] = v1[1];
    positions[positionBase + 5] = v1[2];
    positions[positionBase + 6] = v2[0];
    positions[positionBase + 7] = v2[1];
    positions[positionBase + 8] = v2[2];
  });

  return { positions, normals, triangleCount };
}

/** How many leading bytes `looksGrammaticalAsciiStlPrefix` decodes and
 * grammar-checks — generous enough to cover a real file's opening lines
 * (header + several facets) many times over, small enough to bound the
 * cost of the check itself for a multi-hundred-MB file. */
export const ASCII_GRAMMAR_PREFIX_CHECK_BYTES = 64 * 1024; // 64 KiB

/**
 * Bounded, fail-fast ASCII-grammar sanity check used by parse.ts before it
 * commits to a FULL `TextDecoder.decode` + `parseAsciiStl` attempt on an
 * ambiguous (length-consistent-with-both-binary-and-ASCII) file — see
 * parse.ts's module doc. Without this, a large binary STL whose 80-byte
 * header happens to start with "solid" (legal per the format — see
 * binary.ts's module doc) pays a full decode + two-pass grammar walk of the
 * ENTIRE file before that attempt predictably fails and falls back to the
 * binary interpretation; for a >100 MB file that's a real, avoidable cost
 * on every load.
 *
 * Only decodes/walks the first `maxPrefixBytes` bytes (default
 * `ASCII_GRAMMAR_PREFIX_CHECK_BYTES`) — a real binary file's bytes
 * essentially always diverge from the ASCII grammar within the first few
 * KB (float-encoded geometry data forms "lines", split on incidental 0x0A/
 * 0x0D bytes, that essentially never happen to also read as valid "facet
 * normal ..." / "vertex ..." tokens), so this bounds the check's cost
 * independent of file size while still reliably rejecting non-ASCII
 * content early.
 *
 * If the prefix was truncated mid-file (`maxPrefixBytes < bytes.byteLength`),
 * the LAST decoded line is dropped before validating — it may be a real
 * line cut off mid-token by the byte bound, and validating a partial token
 * would produce a false rejection of genuinely-ASCII content. Whatever
 * remains is walked with the exact same grammar (`walkAsciiStl`, in its
 * counting/no-sink mode) used by the real parse:
 *   - a `TruncatedFileError` (ran out of the lines we deliberately gave it)
 *     is INCONCLUSIVE by construction — this function only ever saw a
 *     slice, so "ran out" proves nothing about the rest of the file —  and
 *     returns `true` (proceed to the real, unbounded attempt).
 *   - a `MalformedSyntaxError` (content that doesn't match the grammar at
 *     all, within bytes we were confident were complete lines) is a
 *     DEFINITIVE rejection and returns `false`.
 */
export function looksGrammaticalAsciiStlPrefix(
  bytes: Uint8Array,
  maxPrefixBytes: number = ASCII_GRAMMAR_PREFIX_CHECK_BYTES,
): boolean {
  const limit = Math.min(bytes.byteLength, maxPrefixBytes);
  const truncatedMidFile = limit < bytes.byteLength;
  const prefixText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, limit));
  let lines = splitLines(prefixText);
  if (truncatedMidFile && lines.length > 0) {
    lines = lines.slice(0, -1); // drop the possibly-cut-off trailing partial line
  }
  try {
    walkAsciiStl(lines);
    return true;
  } catch (error) {
    if (error instanceof TruncatedFileError) {
      return true;
    }
    if (error instanceof MalformedSyntaxError) {
      return false;
    }
    throw error;
  }
}
