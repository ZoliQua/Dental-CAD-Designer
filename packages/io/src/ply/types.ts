// packages/io/src/ply/types.ts
//
// PLY-specific structural types: the header AST produced by header.ts
// (`PlyHeader` and friends) and the parser's output shape (`PlyMesh`).
// These stay local to ply/ rather than living in the package-wide
// ../types.ts, which only holds cross-format shared types (error classes,
// `ParseDiagnostics`, `ParseFormat`) per this task's brief — PLY's own
// output shape is not shared with STL's `RawTriangleSoup`.

import type { ParseDiagnostics } from '../types.ts';
import type { PlyScalarType } from './scalars.ts';

/** The three formats a PLY header can declare via its `format` line — see
 * header.ts's module doc for the exact grammar. */
export type PlyFormat = 'ascii' | 'binary_little_endian' | 'binary_big_endian';

/** A single `property <type> <name>` line. */
export interface PlyScalarProperty {
  readonly kind: 'scalar';
  readonly name: string;
  readonly scalarType: PlyScalarType;
}

/** A single `property list <count-type> <item-type> <name>` line. Each row
 * of the owning element carries its own item count (read at parse time as
 * a `count-type` scalar), so unlike `PlyScalarProperty` this property's
 * per-row byte width is not fixed — see plan.ts / binary.ts / ascii.ts for
 * how that's handled. */
export interface PlyListProperty {
  readonly kind: 'list';
  readonly name: string;
  readonly countType: PlyScalarType;
  readonly itemType: PlyScalarType;
}

export type PlyProperty = PlyScalarProperty | PlyListProperty;

/** One `element <name> <count>` block together with the `property` lines
 * that follow it, in the exact order they appeared in the header — order
 * matters twice over: it fixes the on-disk row layout (binary and ASCII
 * both lay out a row's properties in header-declared order, never a fixed
 * order), and it fixes the order elements themselves appear in the file
 * body (see header.ts's module doc). */
export interface PlyElementSpec {
  readonly name: string;
  readonly count: number;
  readonly properties: readonly PlyProperty[];
}

/** Fully parsed PLY header — everything `header.ts` extracts before any
 * body byte is read. `comments` collects both `comment` and `obj_info`
 * lines verbatim (each tagged with which keyword produced it), in header
 * order. */
export interface PlyHeaderComment {
  readonly keyword: 'comment' | 'obj_info';
  readonly text: string;
}

export interface PlyHeader {
  readonly format: PlyFormat;
  readonly version: string;
  readonly comments: readonly PlyHeaderComment[];
  readonly elements: readonly PlyElementSpec[];
}

/**
 * Parsed PLY mesh — this package's PLY analog of STL's `RawTriangleSoup`,
 * but indexed (PLY is a shared-vertex format by construction) rather than
 * triangle-soup, and carrying optional per-vertex normals/color straight
 * from whichever properties the source header declared.
 *
 * - `positions`: Float64, 3 values per vertex, in file vertex order
 *   (length = `vertexCount * 3`).
 * - `normals`: Float64, 3 values per vertex, `null` when the source
 *   header's vertex element has no (nx, ny, nz) triple. Read as stored,
 *   never renormalized (same policy as STL's facet normals).
 * - `colors`: Float64, 3 values per vertex, normalized to `[0, 1]`
 *   regardless of the source property's on-disk integer/float type (see
 *   `plyColorNormalizationDivisor` in scalars.ts), `null` when the source
 *   header's vertex element has no (red, green, blue) triple. An `alpha`
 *   property, if present, is read and discarded — this shape carries RGB
 *   only.
 * - `indices`: Uint32, 3 values per triangle. Faces are read from the
 *   source header's face element (its `vertex_indices`/`vertex_index`
 *   list property — both spellings are accepted, see plan.ts); a
 *   3-vertex face passes through as one triangle, a 4-vertex face
 *   (quad) or larger n-gon is fan-triangulated (see binary.ts/ascii.ts's
 *   fan-triangulation comment) with a diagnostics warning. Consequently
 *   `indices.length / 3` can exceed `faceCount` when the source has any
 *   non-triangular face.
 * - `faceCount`: the face element's header-declared row count — i.e. the
 *   number of *source* faces (polygons), not the number of triangles in
 *   `indices` after fan-triangulation. `0` (with `indices` empty) when the
 *   header declares no face element at all (a valid point-cloud PLY).
 */
export interface PlyMesh {
  positions: Float64Array;
  normals: Float64Array | null;
  colors: Float64Array | null;
  indices: Uint32Array;
  vertexCount: number;
  faceCount: number;
  diagnostics: ParseDiagnostics;
}
