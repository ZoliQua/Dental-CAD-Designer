// packages/io/src/ply/binary.ts
//
// Binary PLY body reader (both `binary_little_endian` and
// `binary_big_endian` — see header.ts's module doc for the header
// grammar shared by all three formats) and the `writePlyBinaryLE` writer.
//
// Body layout, once the header is known (Turk's PLY spec): elements
// appear in the body in EXACTLY the order they were declared in the
// header, each element's rows back-to-back with no padding, and each
// row's properties back-to-back in the exact order declared for that
// element — never a fixed/assumed order (see header.ts's module doc point
// 3). A `property list <count-type> <item-type> <name>` row-field is
// `<count-type> count` followed by `count` `<item-type>` values — its
// byte width is therefore per-row data, not a header-time constant, which
// is why every read below is done via a running byte cursor rather than a
// precomputed fixed stride.
//
// Endianness: `littleEndian` is threaded through every DataView
// get/set call (via scalars.ts's `readPlyScalar`/`writePlyScalar`) rather
// than ever byte-swapping a typed array view — DataView is the correct
// per-spec tool for this, exactly as this package's Global Constraints
// require ("big-endian path via DataView, no byte-swap hacks").

import { IoWriteRangeError, TruncatedFileError, MalformedSyntaxError } from '../types.ts';
import type { ParseDiagnostics } from '../types.ts';
import { GrowableUint32Array } from './growable-uint32-array.ts';
import { plyColorNormalizationDivisor, plyScalarByteSize, readPlyScalar, writePlyScalar } from './scalars.ts';
import type { PlyScalarType } from './scalars.ts';
import type { FacePlan, PlyPlan, VertexPlan } from './plan.ts';
import type { PlyElementSpec, PlyHeader, PlyMesh } from './types.ts';

/** Mutable read cursor shared across the helper functions below — a plain
 * object (rather than a closure-captured `let`) so `requireBytes` and the
 * per-element readers can all advance the same position by reference. */
interface ByteCursor {
  pos: number;
}

function requireBytes(bytes: Uint8Array, cursor: ByteCursor, need: number, context: string): void {
  if (cursor.pos + need > bytes.byteLength) {
    throw new TruncatedFileError(
      `unexpected end of file while reading ${context}: need ${need} more byte(s) at offset ` +
        `${cursor.pos} but only ${bytes.byteLength - cursor.pos} remain`,
      { byteOffset: cursor.pos },
    );
  }
}

function readScalarAdvance(
  bytes: Uint8Array,
  view: DataView,
  cursor: ByteCursor,
  type: PlyScalarType,
  littleEndian: boolean,
  context: string,
): number {
  const size = plyScalarByteSize(type);
  requireBytes(bytes, cursor, size, context);
  const value = readPlyScalar(view, cursor.pos, type, littleEndian);
  cursor.pos += size;
  return value;
}

/** Skips one list property's row-field (count + that many items),
 * validating the count-declared byte span actually fits in `bytes` before
 * advancing — this is the "classic PLY trap" mechanic called out in this
 * package's brief: an unrecognized list property can only be skipped by
 * reading its per-row count, never by a fixed stride. */
function skipListField(
  bytes: Uint8Array,
  view: DataView,
  cursor: ByteCursor,
  countType: PlyScalarType,
  itemType: PlyScalarType,
  littleEndian: boolean,
  context: string,
): void {
  const count = readScalarAdvance(bytes, view, cursor, countType, littleEndian, `${context} list count`);
  const itemSize = plyScalarByteSize(itemType);
  const need = count * itemSize;
  requireBytes(bytes, cursor, need, `${context} list items (count=${count})`);
  cursor.pos += need;
}

function readVertexElement(
  bytes: Uint8Array,
  view: DataView,
  cursor: ByteCursor,
  element: PlyElementSpec,
  plan: VertexPlan,
  littleEndian: boolean,
): { positions: Float64Array; normals: Float64Array | null; colors: Float64Array | null } {
  const vertexCount = element.count;
  const positions = new Float64Array(vertexCount * 3);
  const normals = plan.hasNormals ? new Float64Array(vertexCount * 3) : null;
  const colors = plan.hasColors ? new Float64Array(vertexCount * 3) : null;

  for (let v = 0; v < vertexCount; v++) {
    for (let p = 0; p < element.properties.length; p++) {
      const prop = element.properties[p]!;
      const role = plan.roleByPropertyIndex[p]!;
      const context = `vertex[${v}].${prop.name}`;

      if (prop.kind === 'list') {
        // A list property on the vertex element is unusual but legal per
        // spec (e.g. a per-vertex list of adjacent-face indices) — no role
        // supports it, so it's always skipped.
        skipListField(bytes, view, cursor, prop.countType, prop.itemType, littleEndian, context);
        continue;
      }

      const value = readScalarAdvance(bytes, view, cursor, prop.scalarType, littleEndian, context);
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

/** Fan-triangulates one face's already-read vertex index list, reading
 * indices one at a time (no per-face staging array) and pushing triangles
 * as soon as a third corner is available — the standard fan: for an
 * n-gon `v0 v1 v2 ... v(n-1)`, triangles are `(v0, v1, v2), (v0, v2, v3),
 * ..., (v0, v(n-2), v(n-1))`. `n === 3` naturally yields exactly the one
 * triangle. Returns the polygon size `n` so the caller can tally
 * quad/n-gon counts for the diagnostics summary (see readFaceElement). */
function readAndFanTriangulateFace(
  bytes: Uint8Array,
  view: DataView,
  cursor: ByteCursor,
  countType: PlyScalarType,
  itemType: PlyScalarType,
  littleEndian: boolean,
  faceIndex: number,
  vertexCount: number,
  indices: GrowableUint32Array,
): number {
  const context = `face[${faceIndex}].vertex_indices`;
  const n = readScalarAdvance(bytes, view, cursor, countType, littleEndian, `${context} list count`);
  if (n < 3) {
    throw new MalformedSyntaxError(
      `face[${faceIndex}] has ${n} vertex indices — a face needs at least 3`,
      { byteOffset: cursor.pos },
    );
  }
  const itemSize = plyScalarByteSize(itemType);
  requireBytes(bytes, cursor, n * itemSize, `${context} list items (count=${n})`);

  let idx0 = 0;
  let prevIdx = 0;
  for (let k = 0; k < n; k++) {
    const raw = readPlyScalar(view, cursor.pos, itemType, littleEndian);
    cursor.pos += itemSize;
    if (!Number.isInteger(raw) || raw < 0 || raw >= vertexCount) {
      throw new MalformedSyntaxError(
        `face[${faceIndex}] references vertex index ${raw}, out of range [0, ${vertexCount})`,
        { byteOffset: cursor.pos - itemSize },
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
  return n;
}

function readFaceElement(
  bytes: Uint8Array,
  view: DataView,
  cursor: ByteCursor,
  element: PlyElementSpec,
  plan: FacePlan,
  littleEndian: boolean,
  vertexCount: number,
  diagnostics: ParseDiagnostics,
): Uint32Array {
  const faceCount = element.count;
  const indices = new GrowableUint32Array(faceCount * 3);
  let quadCount = 0;
  let ngonCount = 0;

  for (let f = 0; f < faceCount; f++) {
    for (let p = 0; p < element.properties.length; p++) {
      const prop = element.properties[p]!;
      if (p === plan.indicesPropertyIndex) {
        // plan.ts only ever sets indicesPropertyIndex to a list property's
        // index (see planFaceElement) — this narrows the union for TS.
        if (prop.kind !== 'list') {
          throw new MalformedSyntaxError(
            `internal: face element's planned vertex-index property "${prop.name}" is not a list property`,
          );
        }
        const n = readAndFanTriangulateFace(
          bytes,
          view,
          cursor,
          prop.countType,
          prop.itemType,
          littleEndian,
          f,
          vertexCount,
          indices,
        );
        if (n === 4) {
          quadCount++;
        } else if (n > 4) {
          ngonCount++;
        }
        continue;
      }
      // Any other property on the face row (e.g. a texcoord list, or a
      // per-face scalar flag) — skipped via the same count-driven
      // mechanic as skipListField, generalized to scalars too.
      if (prop.kind === 'list') {
        skipListField(
          bytes,
          view,
          cursor,
          prop.countType,
          prop.itemType,
          littleEndian,
          `face[${f}].${prop.name}`,
        );
      } else {
        readScalarAdvance(bytes, view, cursor, prop.scalarType, littleEndian, `face[${f}].${prop.name}`);
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

function skipElement(
  bytes: Uint8Array,
  view: DataView,
  cursor: ByteCursor,
  element: PlyElementSpec,
  littleEndian: boolean,
): void {
  for (let r = 0; r < element.count; r++) {
    for (const prop of element.properties) {
      const context = `${element.name}[${r}].${prop.name}`;
      if (prop.kind === 'list') {
        skipListField(bytes, view, cursor, prop.countType, prop.itemType, littleEndian, context);
      } else {
        readScalarAdvance(bytes, view, cursor, prop.scalarType, littleEndian, context);
      }
    }
  }
}

/**
 * Parses the binary body of `bytes` (from `bodyOffset` to EOF) per
 * `header`/`plan`. `littleEndian` selects `binary_little_endian` vs
 * `binary_big_endian` — the only difference between the two binary
 * formats (see module doc).
 */
export function parsePlyBinaryBody(
  bytes: Uint8Array,
  header: PlyHeader,
  plan: PlyPlan,
  bodyOffset: number,
  littleEndian: boolean,
  diagnostics: ParseDiagnostics,
): PlyMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cursor: ByteCursor = { pos: bodyOffset };

  let positions: Float64Array = new Float64Array(0);
  let normals: Float64Array | null = null;
  let colors: Float64Array | null = null;
  let indices: Uint32Array = new Uint32Array(0);
  let vertexCount = 0;
  let faceCount = 0;

  header.elements.forEach((element, elementIndex) => {
    if (elementIndex === plan.vertex.elementIndex) {
      const result = readVertexElement(bytes, view, cursor, element, plan.vertex, littleEndian);
      positions = result.positions;
      normals = result.normals;
      colors = result.colors;
      vertexCount = element.count;
    } else if (plan.face !== null && elementIndex === plan.face.elementIndex) {
      indices = readFaceElement(
        bytes,
        view,
        cursor,
        element,
        plan.face,
        littleEndian,
        header.elements[plan.vertex.elementIndex]!.count,
        diagnostics,
      );
      faceCount = element.count;
    } else {
      skipElement(bytes, view, cursor, element, littleEndian);
    }
  });

  return { positions, normals, colors, indices, vertexCount, faceCount, diagnostics };
}

// ---------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------

/** The subset of `PlyMesh` the writer needs — everything except
 * `diagnostics`, which is a parser-only concern (a mesh assembled purely
 * for writing, e.g. in a property test, has no diagnostics to report). */
export type WritablePlyMesh = Omit<PlyMesh, 'diagnostics'>;

export interface WritePlyBinaryOptions {
  /** Header `comment` lines to emit, in order. Each is sanitized (see
   * `sanitizePlyComment`) and written as its own `comment <text>` line.
   * Defaults to a single `DEFAULT_PLY_COMMENT` line when omitted. */
  comments?: readonly string[];
}

export const DEFAULT_PLY_COMMENT = 'DQCAD export';

/** Strips embedded line terminators (which would corrupt the header
 * grammar — a comment is, per spec, exactly one line) and maps
 * non-printable/non-ASCII characters to `?`, mirroring
 * `stl/binary.ts`'s `sanitizeStlHeader` policy: the PLY header, like
 * STL's, is conventionally restricted to printable ASCII text, and this
 * keeps output maximally portable across PLY-reading tools without a
 * character-encoding negotiation the format has no header field for. */
export function sanitizePlyComment(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x0d) {
      out += ' ';
    } else if (code >= 0x20 && code <= 0x7e) {
      out += text[i];
    } else {
      out += '?';
    }
  }
  return out.trim();
}

function assertWritableMesh(mesh: WritablePlyMesh): void {
  if (!Number.isInteger(mesh.vertexCount) || mesh.vertexCount < 0) {
    throw new IoWriteRangeError(`vertexCount must be a non-negative integer, got ${mesh.vertexCount}`);
  }
  if (mesh.positions.length !== mesh.vertexCount * 3) {
    throw new IoWriteRangeError(
      `positions.length (${mesh.positions.length}) does not match vertexCount * 3 ` +
        `(${mesh.vertexCount * 3})`,
    );
  }
  if (mesh.normals !== null && mesh.normals.length !== mesh.vertexCount * 3) {
    throw new IoWriteRangeError(
      `normals.length (${mesh.normals.length}) does not match vertexCount * 3 (${mesh.vertexCount * 3})`,
    );
  }
  if (mesh.colors !== null && mesh.colors.length !== mesh.vertexCount * 3) {
    throw new IoWriteRangeError(
      `colors.length (${mesh.colors.length}) does not match vertexCount * 3 (${mesh.vertexCount * 3})`,
    );
  }
  if (mesh.indices.length % 3 !== 0) {
    throw new IoWriteRangeError(
      `indices.length (${mesh.indices.length}) is not a multiple of 3 — writePlyBinaryLE only writes ` +
        'triangle faces',
    );
  }
  for (let i = 0; i < mesh.indices.length; i++) {
    const idx = mesh.indices[i]!;
    if (!Number.isInteger(idx) || idx < 0 || idx >= mesh.vertexCount) {
      throw new IoWriteRangeError(
        `indices[${i}] (${idx}) is out of range [0, ${mesh.vertexCount}) for vertexCount ` +
          `${mesh.vertexCount}`,
      );
    }
  }
}

/**
 * Writes `mesh` as a binary-little-endian PLY. Positions (and normals /
 * colors, when present) are written as `float64` — unlike STL's inherent
 * float32 boundary, PLY's spec has no such restriction, and this package's
 * Float64-everywhere invariant means the roundtrip through this writer is
 * lossless for positions/normals (verified by roundtrip.property.test.ts).
 * Colors ARE lossy on write: they're quantized to `uchar` (0-255), the
 * overwhelming real-world convention for PLY color properties (see
 * scalars.ts's `plyColorNormalizationDivisor` doc) — this is a
 * documented, format-convention boundary, not a violation of the
 * Float64-in-memory invariant (which governs representation, not this
 * on-disk convention).
 *
 * Faces are always written as triangles (`property list uint8 uint32
 * vertex_indices`, count fixed at 3 per row) — `mesh.indices` is already
 * a flat triangle list by the time it reaches a writer (any source
 * quad/n-gon was fan-triangulated by the reader that produced it), so
 * there is no polygon type to preserve here.
 */
export function writePlyBinaryLE(mesh: WritablePlyMesh, options: WritePlyBinaryOptions = {}): Uint8Array {
  assertWritableMesh(mesh);
  const { positions, normals, colors, indices, vertexCount } = mesh;
  const triangleCount = indices.length / 3;
  const comments = options.comments ?? [DEFAULT_PLY_COMMENT];

  const headerLines: string[] = ['ply', 'format binary_little_endian 1.0'];
  for (const comment of comments) {
    const sanitized = sanitizePlyComment(comment);
    if (sanitized.length > 0) {
      headerLines.push(`comment ${sanitized}`);
    }
  }
  headerLines.push(`element vertex ${vertexCount}`);
  headerLines.push('property float64 x', 'property float64 y', 'property float64 z');
  if (normals !== null) {
    headerLines.push('property float64 nx', 'property float64 ny', 'property float64 nz');
  }
  if (colors !== null) {
    headerLines.push('property uint8 red', 'property uint8 green', 'property uint8 blue');
  }
  headerLines.push(`element face ${triangleCount}`);
  headerLines.push('property list uint8 uint32 vertex_indices');
  headerLines.push('end_header');
  const headerText = headerLines.join('\n') + '\n';
  const headerBytes = new TextEncoder().encode(headerText);

  const vertexRowSize = 24 + (normals !== null ? 24 : 0) + (colors !== null ? 3 : 0);
  const faceRowSize = 1 + 3 * 4; // uint8 count + 3x uint32 index
  const bodySize = vertexCount * vertexRowSize + triangleCount * faceRowSize;

  const bytes = new Uint8Array(headerBytes.byteLength + bodySize);
  bytes.set(headerBytes, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = headerBytes.byteLength;
  for (let v = 0; v < vertexCount; v++) {
    const base = v * 3;
    writePlyScalar(view, offset, 'float64', positions[base]!, true);
    writePlyScalar(view, offset + 8, 'float64', positions[base + 1]!, true);
    writePlyScalar(view, offset + 16, 'float64', positions[base + 2]!, true);
    offset += 24;
    if (normals !== null) {
      writePlyScalar(view, offset, 'float64', normals[base]!, true);
      writePlyScalar(view, offset + 8, 'float64', normals[base + 1]!, true);
      writePlyScalar(view, offset + 16, 'float64', normals[base + 2]!, true);
      offset += 24;
    }
    if (colors !== null) {
      const r = Math.round(Math.min(1, Math.max(0, colors[base]!)) * 255);
      const g = Math.round(Math.min(1, Math.max(0, colors[base + 1]!)) * 255);
      const b = Math.round(Math.min(1, Math.max(0, colors[base + 2]!)) * 255);
      writePlyScalar(view, offset, 'uint8', r, true);
      writePlyScalar(view, offset + 1, 'uint8', g, true);
      writePlyScalar(view, offset + 2, 'uint8', b, true);
      offset += 3;
    }
  }

  for (let t = 0; t < triangleCount; t++) {
    writePlyScalar(view, offset, 'uint8', 3, true);
    offset += 1;
    const base = t * 3;
    writePlyScalar(view, offset, 'uint32', indices[base]!, true);
    writePlyScalar(view, offset + 4, 'uint32', indices[base + 1]!, true);
    writePlyScalar(view, offset + 8, 'uint32', indices[base + 2]!, true);
    offset += 12;
  }

  return bytes;
}
