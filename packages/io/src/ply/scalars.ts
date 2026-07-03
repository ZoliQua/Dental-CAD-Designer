// packages/io/src/ply/scalars.ts
//
// The PLY spec (Turk's "PLY - Polygon File Format" description, the de
// facto standard for this format — there is no formal standards body)
// defines exactly eight scalar property types, each with two accepted
// spellings — a fixed-width name and a C-style legacy alias:
//
//   name      alias    bytes   representation
//   int8      char       1     signed integer
//   uint8     uchar      1     unsigned integer
//   int16     short      2     signed integer
//   uint16    ushort     2     unsigned integer
//   int32     int        4     signed integer
//   uint32    uint       4     unsigned integer
//   float32   float      4     IEEE-754 single precision
//   float64   double     8     IEEE-754 double precision
//
// Both spellings appear in real-world files interchangeably (the alias
// column predates the fixed-width names and is still common), so a
// from-spec reader must accept both. This module is the single place that
// resolves either spelling to one canonical `PlyScalarType` and knows each
// type's byte width and DataView accessor — every other ply/ module reads
// files purely in terms of the canonical type, never the raw header token.

/** Canonical scalar type names — always one of these eight after resolving
 * a header token through `resolvePlyScalarType`. */
export type PlyScalarType =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'float32'
  | 'float64';

const PLY_TYPE_ALIASES: Readonly<Record<string, PlyScalarType>> = {
  int8: 'int8',
  char: 'int8',
  uint8: 'uint8',
  uchar: 'uint8',
  int16: 'int16',
  short: 'int16',
  uint16: 'uint16',
  ushort: 'uint16',
  int32: 'int32',
  int: 'int32',
  uint32: 'uint32',
  uint: 'uint32',
  float32: 'float32',
  float: 'float32',
  float64: 'float64',
  double: 'float64',
};

/** Resolves a header type token (either spelling) to its canonical
 * `PlyScalarType`, or `null` if it names neither of the spec's eight
 * scalar types. */
export function resolvePlyScalarType(token: string): PlyScalarType | null {
  return PLY_TYPE_ALIASES[token] ?? null;
}

/** On-disk byte width of a scalar type — identical for the binary reader,
 * the binary writer, and every stride/skip computation in this package. */
export function plyScalarByteSize(type: PlyScalarType): number {
  switch (type) {
    case 'int8':
    case 'uint8':
      return 1;
    case 'int16':
    case 'uint16':
      return 2;
    case 'int32':
    case 'uint32':
    case 'float32':
      return 4;
    case 'float64':
      return 8;
  }
}

/** Reads one scalar of `type` from `view` at `offset`, honoring
 * `littleEndian` for the multi-byte types (irrelevant for the 1-byte
 * types, but DataView's int8/uint8 getters don't take the flag at all).
 * Returned as a plain `number` — safe for every type here since even
 * `uint32`'s max value (2^32 - 1) is well inside `Number.MAX_SAFE_INTEGER`. */
export function readPlyScalar(
  view: DataView,
  offset: number,
  type: PlyScalarType,
  littleEndian: boolean,
): number {
  switch (type) {
    case 'int8':
      return view.getInt8(offset);
    case 'uint8':
      return view.getUint8(offset);
    case 'int16':
      return view.getInt16(offset, littleEndian);
    case 'uint16':
      return view.getUint16(offset, littleEndian);
    case 'int32':
      return view.getInt32(offset, littleEndian);
    case 'uint32':
      return view.getUint32(offset, littleEndian);
    case 'float32':
      return view.getFloat32(offset, littleEndian);
    case 'float64':
      return view.getFloat64(offset, littleEndian);
  }
}

/** Writes one scalar of `type` into `view` at `offset`. Only used by the
 * writer, which always writes little-endian (`writePlyBinaryLE`), but
 * takes `littleEndian` anyway to mirror `readPlyScalar`'s signature. */
export function writePlyScalar(
  view: DataView,
  offset: number,
  type: PlyScalarType,
  value: number,
  littleEndian: boolean,
): void {
  switch (type) {
    case 'int8':
      view.setInt8(offset, value);
      return;
    case 'uint8':
      view.setUint8(offset, value);
      return;
    case 'int16':
      view.setInt16(offset, value, littleEndian);
      return;
    case 'uint16':
      view.setUint16(offset, value, littleEndian);
      return;
    case 'int32':
      view.setInt32(offset, value, littleEndian);
      return;
    case 'uint32':
      view.setUint32(offset, value, littleEndian);
      return;
    case 'float32':
      view.setFloat32(offset, value, littleEndian);
      return;
    case 'float64':
      view.setFloat64(offset, value, littleEndian);
      return;
  }
}

/** Divisor used to normalize an integer-typed color channel to PLY-mesh's
 * `[0, 1]` `colors` convention (see ply/types.ts's `PlyMesh` doc). Spec
 * fact this leans on: color properties are conventionally written as
 * `uchar` (0-255) by virtually every PLY-producing tool, but the spec
 * itself never restricts color to `uchar` — some tools use `ushort` for
 * higher precision, and floating-point color properties are, by the same
 * unwritten convention, already stored pre-normalized in `[0, 1]` (so they
 * get a divisor of 1, i.e. read verbatim). This derives the divisor from
 * the property's actual declared type rather than assuming `uchar`, so a
 * `ushort`-color file is normalized correctly instead of coming out 256x
 * too dark.
 */
export function plyColorNormalizationDivisor(type: PlyScalarType): number {
  switch (type) {
    case 'int8':
    case 'uint8':
      return 255;
    case 'int16':
    case 'uint16':
      return 65535;
    case 'int32':
    case 'uint32':
      return 4294967295;
    case 'float32':
    case 'float64':
      return 1;
  }
}
