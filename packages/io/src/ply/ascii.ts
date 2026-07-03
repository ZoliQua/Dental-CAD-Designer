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
import { plyColorNormalizationDivisor } from './scalars.ts';
import type { FacePlan, PlyPlan, VertexPlan } from './plan.ts';
import type { PlyElementSpec, PlyHeader, PlyMesh } from './types.ts';

interface LineCursor {
  readonly lines: readonly string[];
  idx: number; // 0-based index into `lines`
  readonly firstLineNumber: number; // 1-based file line number of lines[0]
}

/** Returns the next non-blank row's whitespace-split tokens, advancing the
 * cursor past it. Blank lines between rows are tolerated (skipped) — real
 * PLY bodies don't contain them, but skipping is harmless and matches this
 * package's STL ASCII reader's general leniency about incidental blank
 * lines. */
function nextRowTokens(cursor: LineCursor, context: string): { tokens: string[]; lineNumber: number } {
  while (cursor.idx < cursor.lines.length && cursor.lines[cursor.idx]!.trim().length === 0) {
    cursor.idx++;
  }
  if (cursor.idx >= cursor.lines.length) {
    throw new TruncatedFileError(`unexpected end of file: expected a row for ${context}`, {
      line: cursor.firstLineNumber + cursor.idx,
    });
  }
  const lineNumber = cursor.firstLineNumber + cursor.idx;
  const trimmed = cursor.lines[cursor.idx]!.trim();
  cursor.idx++;
  return { tokens: trimmed.split(/\s+/), lineNumber };
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
  cursor: LineCursor,
  element: PlyElementSpec,
  plan: VertexPlan,
): { positions: Float64Array; normals: Float64Array | null; colors: Float64Array | null } {
  const vertexCount = element.count;
  const positions = new Float64Array(vertexCount * 3);
  const normals = plan.hasNormals ? new Float64Array(vertexCount * 3) : null;
  const colors = plan.hasColors ? new Float64Array(vertexCount * 3) : null;

  for (let v = 0; v < vertexCount; v++) {
    const { tokens, lineNumber } = nextRowTokens(cursor, `vertex[${v}]`);
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
  cursor: LineCursor,
  element: PlyElementSpec,
  plan: FacePlan,
  vertexCount: number,
  diagnostics: ParseDiagnostics,
): Uint32Array {
  const faceCount = element.count;
  const indices = new GrowableUint32Array(faceCount * 3);
  let quadCount = 0;
  let ngonCount = 0;

  for (let f = 0; f < faceCount; f++) {
    const { tokens, lineNumber } = nextRowTokens(cursor, `face[${f}]`);
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

function skipElement(cursor: LineCursor, element: PlyElementSpec): void {
  for (let r = 0; r < element.count; r++) {
    const { tokens, lineNumber } = nextRowTokens(cursor, `${element.name}[${r}]`);
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
 * `header`/`plan`.
 */
export function parsePlyAsciiBody(
  bytes: Uint8Array,
  header: PlyHeader,
  plan: PlyPlan,
  bodyOffset: number,
  diagnostics: ParseDiagnostics,
): PlyMesh {
  const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(bodyOffset));
  const lines = bodyText.split(/\r\n|\r|\n/);
  const cursor: LineCursor = { lines, idx: 0, firstLineNumber: 1 };

  let positions: Float64Array = new Float64Array(0);
  let normals: Float64Array | null = null;
  let colors: Float64Array | null = null;
  let indices: Uint32Array = new Uint32Array(0);
  let vertexCount = 0;
  let faceCount = 0;

  header.elements.forEach((element, elementIndex) => {
    if (elementIndex === plan.vertex.elementIndex) {
      const result = readVertexElement(cursor, element, plan.vertex);
      positions = result.positions;
      normals = result.normals;
      colors = result.colors;
      vertexCount = element.count;
    } else if (plan.face !== null && elementIndex === plan.face.elementIndex) {
      indices = readFaceElement(
        cursor,
        element,
        plan.face,
        header.elements[plan.vertex.elementIndex]!.count,
        diagnostics,
      );
      faceCount = element.count;
    } else {
      skipElement(cursor, element);
    }
  });

  return { positions, normals, colors, indices, vertexCount, faceCount, diagnostics };
}
