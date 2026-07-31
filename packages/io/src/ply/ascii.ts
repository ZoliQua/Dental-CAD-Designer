// packages/io/src/ply/ascii.ts
//
// ASCII PLY body reader. Spec fact (Turk's PLY description): in the ASCII
// format, each element instance ("row") is written on its own line — a
// row's properties (scalars, and for a list property its count followed
// by that many items) are whitespace-separated decimal ASCII numbers on
// that single line, in the exact order the header declared them (never a
// fixed order — same header-driven-layout rule as binary.ts). This is
// what makes "one row = one line" a spec fact rather than just a
// convention: unlike the binary formats, ASCII bodies have no other
// mechanism for delimiting where one row ends and the next begins.
//
// Mirrors binary.ts's structure closely (vertex/face/skip element
// readers, fan-triangulation) — the two differ only in their low-level
// value-extraction mechanics (byte cursor + DataView here vs.
// line/token cursor + `Number()`), never in property-to-role logic
// (shared via plan.ts).

import { MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import type { ParseDiagnostics } from '../types.ts';
import { GrowableUint32Array } from './growable-uint32-array.ts';
import { assertPlausibleElementCount, assertSkippableElement } from './element-count-guard.ts';
import { plyColorNormalizationDivisor } from './scalars.ts';
import type { FacePlan, PlyPlan, VertexPlan } from './plan.ts';
import type { PlyElementSpec, PlyHeader, PlyMesh } from './types.ts';

/**
 * Lazy, forward-only line reader over a byte range — the ASCII body's
 * counterpart to header.ts's byte-level line-terminator scan
 * (`findLineEnd`), reused here for the same reason: scanning for `\n`/`\r`
 * at the byte level is valid even for UTF-8 text (0x0A/0x0D never appear as
 * a UTF-8 continuation byte, only ever as the literal ASCII line
 * terminators), so each line's bytes can be decoded independently without
 * ever materializing every line of a (potentially huge) ASCII body into one
 * JS array up front. `ascii.ts`'s body reader only ever reads forward,
 * never re-reads an earlier row, so a pull-based one-line-at-a-time cursor
 * is a strict memory improvement over the array-of-all-lines this class
 * replaces, with identical line-numbering behavior (1-based, relative to
 * the body's first line) and identical EOF/line-number semantics in error
 * messages.
 */
class LineSource {
  // Plain field declarations, not TS constructor parameter properties —
  // parameter properties aren't supported by Node's native TypeScript
  // strip-only loader (`node:worker_threads` loading this file's compiled
  // form of packages/io directly, per this package's Phase 1 "node-worker-
  // reachable" requirement — see types.ts's module doc and CLAUDE.md's
  // "Import extension convention"). Confirmed empirically: a parameter-
  // property constructor here broke kernel-workers' Node worker with
  // `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]` once jobs.ts started
  // importing packages/io for the `parseMeshFile` job (Task 3).
  private readonly bytes: Uint8Array;
  private pos: number;
  private lineNo = 1;

  constructor(bytes: Uint8Array, startOffset: number) {
    this.bytes = bytes;
    this.pos = startOffset;
  }

  /** The line number that the NEXT call to `next()` would return, or —
   * once the source is exhausted — the line number one past the last real
   * line (matches the prior array-cursor implementation's EOF line-number
   * arithmetic, `firstLineNumber + idx` after `idx` has advanced past every
   * real and skipped-blank line). */
  get nextLineNumber(): number {
    return this.lineNo;
  }

  /** Returns the next line's raw (untrimmed) text and its 1-based line
   * number, or `null` once every byte has been consumed. */
  next(): { text: string; lineNumber: number } | null {
    if (this.pos >= this.bytes.byteLength) {
      return null;
    }
    let end = this.pos;
    while (end < this.bytes.byteLength && this.bytes[end] !== 0x0a && this.bytes[end] !== 0x0d) {
      end++;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(this.bytes.subarray(this.pos, end));
    let next = end;
    if (next < this.bytes.byteLength) {
      next = this.bytes[next] === 0x0d && this.bytes[next + 1] === 0x0a ? next + 2 : next + 1;
    }
    const result = { text, lineNumber: this.lineNo };
    this.pos = next;
    this.lineNo++;
    return result;
  }
}

/** Returns the next non-blank row's whitespace-split tokens, advancing the
 * source past it. Blank lines between rows are tolerated (skipped) — real
 * PLY bodies don't contain them, but skipping is harmless and matches this
 * package's STL ASCII reader's general leniency about incidental blank
 * lines. */
function nextRowTokens(source: LineSource, context: string): { tokens: string[]; lineNumber: number } {
  for (;;) {
    const line = source.next();
    if (line === null) {
      throw new TruncatedFileError(`unexpected end of file: expected a row for ${context}`, {
        line: source.nextLineNumber,
      });
    }
    const trimmed = line.text.trim();
    if (trimmed.length === 0) {
      continue; // skip a blank line and keep pulling
    }
    return { tokens: trimmed.split(/\s+/), lineNumber: line.lineNumber };
  }
}

function parseNumberToken(token: string | undefined, lineNumber: number, context: string): number {
  if (token === undefined) {
    throw new MalformedSyntaxError(`line ${lineNumber}: ${context} is missing a value token`, {
      line: lineNumber,
    });
  }
  const value = Number(token);
  if (Number.isNaN(value)) {
    throw new MalformedSyntaxError(`line ${lineNumber}: invalid ${context} value "${token}"`, {
      line: lineNumber,
    });
  }
  return value;
}

/** Consumes one list field (count token + that many item tokens) from
 * `tokens` starting at `pos`, returning the parsed item values and the
 * next unconsumed token position. Used both to read a face's vertex
 * indices and to skip an unrecognized list property (skip still has to
 * parse the count — and validate enough tokens exist — even though the
 * item values themselves are then discarded; this is ASCII's equivalent
 * of binary.ts's per-row count-driven skip). */
function readListField(
  tokens: readonly string[],
  pos: number,
  lineNumber: number,
  context: string,
): { count: number; items: readonly string[]; nextPos: number } {
  const countToken = tokens[pos];
  const count = parseNumberToken(countToken, lineNumber, `${context} list count`);
  if (!Number.isInteger(count) || count < 0) {
    throw new MalformedSyntaxError(
      `line ${lineNumber}: ${context} list count "${countToken}" must be a non-negative integer`,
      { line: lineNumber },
    );
  }
  const itemsStart = pos + 1;
  const itemsEnd = itemsStart + count;
  if (itemsEnd > tokens.length) {
    throw new MalformedSyntaxError(
      `line ${lineNumber}: ${context} declares ${count} list item(s) but only ` +
        `${tokens.length - itemsStart} token(s) remain on the line`,
      { line: lineNumber },
    );
  }
  return { count, items: tokens.slice(itemsStart, itemsEnd), nextPos: itemsEnd };
}

function readVertexElement(
  source: LineSource,
  element: PlyElementSpec,
  plan: VertexPlan,
): { positions: Float64Array; normals: Float64Array | null; colors: Float64Array | null } {
  const vertexCount = element.count;
  assertPlausibleElementCount(element.name, vertexCount);
  const positions = new Float64Array(vertexCount * 3);
  const normals = plan.hasNormals ? new Float64Array(vertexCount * 3) : null;
  const colors = plan.hasColors ? new Float64Array(vertexCount * 3) : null;

  for (let v = 0; v < vertexCount; v++) {
    const { tokens, lineNumber } = nextRowTokens(source, `vertex[${v}]`);
    let pos = 0;
    for (let p = 0; p < element.properties.length; p++) {
      const prop = element.properties[p]!;
      const role = plan.roleByPropertyIndex[p]!;
      const context = `vertex[${v}].${prop.name}`;

      if (prop.kind === 'list') {
        const { nextPos } = readListField(tokens, pos, lineNumber, context);
        pos = nextPos;
        continue;
      }

      const value = parseNumberToken(tokens[pos], lineNumber, context);
      pos++;
      if (role === null) {
        continue;
      }
      // Scoped to roles this parser actually STORES (x/y/z/normal/color) —
      // deliberately NOT applied to skipped/unrecognized properties (those
      // already tolerate arbitrary garbage values, matching how a skipped
      // list property's items are consumed but never validated as
      // sensible). `Number("Infinity")`/`Number("-Infinity")` both parse
      // successfully in JS and are NOT NaN, so `parseNumberToken`'s own
      // check doesn't catch them — this is this package's "never return
      // NaN/Infinity coordinates silently" invariant (found via this
      // task's fuzz suite, see packages/io/fuzz/ and
      // test-fixtures/fuzz-corpus/).
      if (!Number.isFinite(value)) {
        throw new MalformedSyntaxError(
          `line ${lineNumber}: ${context} is ${value} — this parser rejects non-finite (NaN/Infinity) ` +
            'coordinate/normal/color values rather than propagating them silently',
          { line: lineNumber },
        );
      }
      const base = v * 3;
      switch (role) {
        case 'x':
          positions[base] = value;
          break;
        case 'y':
          positions[base + 1] = value;
          break;
        case 'z':
          positions[base + 2] = value;
          break;
        case 'nx':
          normals![base] = value;
          break;
        case 'ny':
          normals![base + 1] = value;
          break;
        case 'nz':
          normals![base + 2] = value;
          break;
        case 'red':
          colors![base] = value / plyColorNormalizationDivisor(prop.scalarType);
          break;
        case 'green':
          colors![base + 1] = value / plyColorNormalizationDivisor(prop.scalarType);
          break;
        case 'blue':
          colors![base + 2] = value / plyColorNormalizationDivisor(prop.scalarType);
          break;
      }
    }
  }

  return { positions, normals, colors };
}

/** ASCII counterpart of binary.ts's `readAndFanTriangulateFace` — same
 * fan-triangulation scheme, reading from already-tokenized list items
 * instead of a byte cursor. */
function fanTriangulateFace(
  items: readonly string[],
  lineNumber: number,
  faceIndex: number,
  vertexCount: number,
  indices: GrowableUint32Array,
): void {
  const n = items.length;
  if (n < 3) {
    throw new MalformedSyntaxError(`line ${lineNumber}: face[${faceIndex}] has ${n} vertex indices — a face needs at least 3`, {
      line: lineNumber,
    });
  }
  let idx0 = 0;
  let prevIdx = 0;
  for (let k = 0; k < n; k++) {
    const raw = parseNumberToken(items[k], lineNumber, `face[${faceIndex}] vertex index ${k}`);
    if (!Number.isInteger(raw) || raw < 0 || raw >= vertexCount) {
      throw new MalformedSyntaxError(
        `line ${lineNumber}: face[${faceIndex}] references vertex index ${raw}, out of range ` +
          `[0, ${vertexCount})`,
        { line: lineNumber },
      );
    }
    if (k === 0) {
      idx0 = raw;
    } else if (k === 1) {
      prevIdx = raw;
    } else {
      indices.push(idx0);
      indices.push(prevIdx);
      indices.push(raw);
      prevIdx = raw;
    }
  }
}

function readFaceElement(
  source: LineSource,
  element: PlyElementSpec,
  plan: FacePlan,
  vertexCount: number,
  diagnostics: ParseDiagnostics,
): Uint32Array {
  const faceCount = element.count;
  assertPlausibleElementCount(element.name, faceCount);
  const indices = new GrowableUint32Array(faceCount * 3);
  let quadCount = 0;
  let ngonCount = 0;

  for (let f = 0; f < faceCount; f++) {
    const { tokens, lineNumber } = nextRowTokens(source, `face[${f}]`);
    let pos = 0;
    for (let p = 0; p < element.properties.length; p++) {
      const prop = element.properties[p]!;
      const context = `face[${f}].${prop.name}`;
      if (p === plan.indicesPropertyIndex) {
        if (prop.kind !== 'list') {
          throw new MalformedSyntaxError(
            `internal: face element's planned vertex-index property "${prop.name}" is not a list property`,
          );
        }
        const { count, items, nextPos } = readListField(tokens, pos, lineNumber, context);
        pos = nextPos;
        fanTriangulateFace(items, lineNumber, f, vertexCount, indices);
        if (count === 4) {
          quadCount++;
        } else if (count > 4) {
          ngonCount++;
        }
        continue;
      }
      if (prop.kind === 'list') {
        const { nextPos } = readListField(tokens, pos, lineNumber, context);
        pos = nextPos;
      } else {
        parseNumberToken(tokens[pos], lineNumber, context);
        pos++;
      }
    }
  }

  if (quadCount > 0) {
    diagnostics.warnings.push(
      `${quadCount} face(s) had 4 vertex indices (quads) and were fan-triangulated into 2 triangles each`,
    );
  }
  if (ngonCount > 0) {
    diagnostics.warnings.push(
      `${ngonCount} face(s) had more than 4 vertex indices and were fan-triangulated`,
    );
  }

  return indices.toArray();
}

function skipElement(source: LineSource, element: PlyElementSpec): void {
  // Same pre-loop guard the binary/streaming skip paths use — an
  // implausibly huge or zero-property declared count is rejected before the
  // row loop. The ASCII sync reader is not itself vulnerable to the unbounded
  // spin (its `nextRowTokens` hits EOF and throws), but applying the identical
  // guard here keeps all three skip paths consistent and rejects the hostile
  // header with the SAME typed error regardless of format/entry point.
  assertSkippableElement(element);
  for (let r = 0; r < element.count; r++) {
    const { tokens, lineNumber } = nextRowTokens(source, `${element.name}[${r}]`);
    let pos = 0;
    for (const prop of element.properties) {
      const context = `${element.name}[${r}].${prop.name}`;
      if (prop.kind === 'list') {
        const { nextPos } = readListField(tokens, pos, lineNumber, context);
        pos = nextPos;
      } else {
        parseNumberToken(tokens[pos], lineNumber, context);
        pos++;
      }
    }
  }
}

/**
 * Parses the ASCII body of `bytes` (from `bodyOffset` to EOF) per
 * `header`/`plan`. Reads the body lazily, one line at a time, via
 * `LineSource` — no full-body decode and no array-of-every-line
 * materialization, so this scales to a large ASCII body in O(1) lines held
 * in memory at once rather than O(body line count).
 */
export function parsePlyAsciiBody(
  bytes: Uint8Array,
  header: PlyHeader,
  plan: PlyPlan,
  bodyOffset: number,
  diagnostics: ParseDiagnostics,
): PlyMesh {
  const source = new LineSource(bytes, bodyOffset);

  let positions: Float64Array = new Float64Array(0);
  let normals: Float64Array | null = null;
  let colors: Float64Array | null = null;
  let indices: Uint32Array = new Uint32Array(0);
  let vertexCount = 0;
  let faceCount = 0;

  header.elements.forEach((element, elementIndex) => {
    if (elementIndex === plan.vertex.elementIndex) {
      const result = readVertexElement(source, element, plan.vertex);
      positions = result.positions;
      normals = result.normals;
      colors = result.colors;
      vertexCount = element.count;
    } else if (plan.face !== null && elementIndex === plan.face.elementIndex) {
      indices = readFaceElement(
        source,
        element,
        plan.face,
        header.elements[plan.vertex.elementIndex]!.count,
        diagnostics,
      );
      faceCount = element.count;
    } else {
      skipElement(source, element);
    }
  });

  return { positions, normals, colors, indices, vertexCount, faceCount, diagnostics };
}
