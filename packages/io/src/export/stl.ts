// packages/io/src/export/stl.ts
//
// `exportStlBinary` — the manufacturing-export entry for binary STL
// (Phase 7 Task 2): the certified path producing the bytes actually handed
// to a mill. It COMPOSES the existing, round-trip-proven `writeStlBinary`
// unchanged (no second serializer to drift) and adds the export-grade
// guarantees on top: solid validation (watertight + outward, derived from
// topology — validate.ts), a deterministic mm-marker header, the f32-range
// precondition, and the documented narrowing bound.
//
// ## Byte layout (normative for exports)
//
// Exactly stl/binary.ts's documented de-facto layout:
//   bytes  0..79  header: `EXPORT_STL_HEADER_TEXT` (or the caller's
//                 sanitized `headerText`) as printable ASCII, zero-padded
//                 to 80 bytes. DETERMINISTIC — never a timestamp, never
//                 environment-dependent content.
//   bytes 80..83  uint32 LE triangle count.
//   then per triangle, 50 bytes: float32 LE facet normal (3), float32 LE
//   vertices v0 v1 v2 (9), uint16 LE attribute byte count — ALWAYS 0.
//
// ## Triangle ordering rule (determinism)
//
// Record `t` IS triangle `t` of the input mesh (`indices[3t .. 3t+2]`),
// vertices emitted in stored winding order (v0, v1, v2) — the identity
// mapping from the canonical kernel mesh, no sorting or re-indexing. The
// canonical mesh is content-addressed over exactly (positions bytes,
// indices bytes), so: same mesh content hash + same options ⇒ bit-identical
// export bytes. No timestamps, no randomness, no environment reads
// anywhere in the path (byte-pinned goldens enforce this in CI).
//
// ## Units
//
// STL carries no unit field. DQ-Dental-CAD exports are ALWAYS millimetres
// (the package-wide unit); the default header text carries the documented
// `units=mm` marker so downstream tools/humans see the convention.
//
// ## Normals
//
// Facet normals are RECOMPUTED from each triangle's own winding
// (right-hand rule — `writeStlBinary`'s default; source-normal passthrough
// is deliberately not exposed here), and the winding itself is verified
// outward by `assertExportableSolid` (positive signed volume over a
// verified-consistent, SINGLE-COMPONENT closed surface) BEFORE writing —
// AND re-verified on the f32-NARROWED coordinates, because the outward
// guarantee must hold for the bytes actually shipped: a near-degenerate
// solid's signed volume can flip sign under narrowing even though the
// Float64 mesh is outward (typed rejection
// `'inward-orientation-narrowed'`; demonstrated by the Task 2 review's
// adversarial tetrahedron, now a regression test). So outward normals are
// a guarantee derived from topology, never trusted from input; an inward,
// open, or narrowing-inverted input is rejected with a typed error (see
// validate.ts's rejection-policy doc).
//
// Normal provenance: the written facet-normal fields are computed from the
// FLOAT64 vertices and then narrowed to f32. A consumer recomputing
// normals from the stored f32 vertices obtains sub-ULP-different values —
// geometrically irrelevant for well-conditioned facets; for a
// narrowing-degenerate sliver the per-facet direction can disagree
// (bounded by the narrowing itself, `@errorBound` below), while the
// GLOBAL orientation of the shipped geometry is exactly what the narrowed
// volume check above certifies.
//
// ## Header text constraints (enforced, not just documented)
//
// A caller-supplied `headerText` is REJECTED (typed `IoWriteRangeError`)
// rather than silently altered when it (a) exceeds the fixed 80-byte
// header field — silent truncation would be silent data mutation — or
// (b) starts with `solid` (after sanitization, case-insensitive, leading
// whitespace ignored): this repo's parser detects binary STL robustly by
// byte-length consistency, but many third-party mill readers still sniff
// the legacy "starts with 'solid'" heuristic and would misparse the
// binary file as ASCII.

import { IoWriteRangeError, type RawTriangleSoup } from '../types.ts';
import { STL_BINARY_HEADER_BYTES, sanitizeStlHeader, writeStlBinary } from '../stl/binary.ts';
import { ExportMeshInvalidError, type ExportableMesh } from './types.ts';
import { assertExportableSolid, f32NarrowedSignedVolumeMm3, type ExportSolidCheck } from './validate.ts';

/** Deterministic default 80-byte-header text for manufacturing exports —
 * carries the documented mm-units marker (STL itself is unitless). */
export const EXPORT_STL_HEADER_TEXT = 'DQ-Dental-CAD binary STL; units=mm';

export interface ExportStlBinaryOptions {
  /** Replaces `EXPORT_STL_HEADER_TEXT` in the 80-byte header. Sanitized to
   * printable ASCII and zero-padded (see stl/binary.ts's
   * `sanitizeStlHeader`); REJECTED with `IoWriteRangeError` when longer
   * than 80 bytes or when it starts with `solid` (see this module's
   * "Header text constraints" doc). Part of the byte-determinism contract:
   * callers passing this MUST derive it from journaled parameters only
   * (never a timestamp or environment value) or exports stop being
   * replay-identical. */
  headerText?: string;
}

/** Enforces this module's "Header text constraints" (length + `solid`
 * prefix) on a caller-supplied header text. Exported for direct unit
 * testing; `exportStlBinary` applies it to every non-default header. */
export function assertExportableStlHeaderText(text: string): void {
  if (text.length > STL_BINARY_HEADER_BYTES) {
    throw new IoWriteRangeError(
      `headerText is ${text.length} characters — the binary STL header field is fixed at ` +
        `${STL_BINARY_HEADER_BYTES} bytes and export refuses to silently truncate`,
    );
  }
  // Compare on the SANITIZED bytes (what actually lands in the file),
  // case-insensitively, ignoring leading whitespace — the shapes legacy
  // "starts with 'solid'" binary/ASCII sniffers match on.
  const sanitized = String.fromCharCode(...sanitizeStlHeader(text)).replace(/\0+$/, '');
  if (/^\s*solid/i.test(sanitized)) {
    throw new IoWriteRangeError(
      "headerText starts with 'solid' — many third-party STL readers sniff that prefix as ASCII " +
        'format and would misparse this binary export; choose a header not beginning with it',
    );
  }
}

/** Largest finite float32 magnitude — coordinates beyond this narrow to
 * ±Infinity and cannot appear in a valid binary STL (the parser side
 * rejects non-finite fields for the same reason). */
export const F32_MAX_MAGNITUDE = 3.4028234663852886e38;

/** Expands an indexed mesh into per-triangle soup order — triangle `t`'s
 * corners at `positions[9t ..)` in stored winding order. A structural twin
 * of kernel's `indexedToSoup` (the layer rule bars importing it; see
 * types.ts's `ExportableMesh` doc), with `normals: null` so the writer
 * recomputes facet normals from winding. */
function expandToSoup(mesh: ExportableMesh): RawTriangleSoup {
  const triangleCount = mesh.indices.length / 3;
  const positions = new Float64Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const src = mesh.indices[t * 3 + corner]! * 3;
      const dst = t * 9 + corner * 3;
      positions[dst] = mesh.positions[src]!;
      positions[dst + 1] = mesh.positions[src + 1]!;
      positions[dst + 2] = mesh.positions[src + 2]!;
    }
  }
  return { positions, normals: null, triangleCount };
}

/**
 * Serializes a canonical kernel mesh as a manufacturing-grade binary STL.
 * See this module's doc for the byte layout, ordering rule, units, and
 * normals guarantee. Throws `ExportMeshInvalidError` (typed `reason`) on
 * any input that is not a single-component, watertight, consistently-wound
 * solid that is outward-oriented BOTH in Float64 and after f32 narrowing,
 * with float32-representable coordinates — never writes a "best effort"
 * file. A caller-supplied `headerText` violating the header constraints
 * throws `IoWriteRangeError` (see the module doc).
 *
 * @errorBound Float64 → float32 narrowing at the byte boundary is the
 * format's precision floor and the ONLY geometric error this path
 * introduces: per coordinate, `|x - fround(x)| <= f32UlpAt(x)/2`
 * (relative error `<= 2^-24`; `< 2^-17 mm ≈ 0.0076 µm` for |x| < 256 mm —
 * see narrowing.ts, which also measures the exact error per export for the
 * QC traceability document). Re-import equivalence up to exactly this
 * narrowing is proven by test/golden/export-serialization.test.ts.
 */
export function exportStlBinary(
  mesh: ExportableMesh,
  options: ExportStlBinaryOptions = {},
): Uint8Array {
  // f32-range precondition first (STL-specific — PLY has no such limit):
  // checked before solid validation so an unrepresentable coordinate is
  // reported as such regardless of what it does to the solid's volume.
  if (mesh.positions instanceof Float64Array) {
    for (let i = 0; i < mesh.positions.length; i++) {
      const x = mesh.positions[i]!;
      if (Number.isFinite(x) && Math.abs(x) > F32_MAX_MAGNITUDE) {
        throw new ExportMeshInvalidError(
          'structural',
          `positions[${i}] (${x}) exceeds float32 range — binary STL stores float32 coordinates ` +
            'and cannot represent this value finitely',
        );
      }
    }
  }
  assertExportableSolid(mesh);

  // The outward guarantee must hold for the SHIPPED bytes, not just the
  // Float64 mesh: re-check orientation on the f32-narrowed geometry (see
  // this module's Normals doc; review finding 2).
  const narrowedVolumeMm3 = f32NarrowedSignedVolumeMm3(mesh);
  if (narrowedVolumeMm3 <= 0) {
    throw new ExportMeshInvalidError(
      'inward-orientation-narrowed',
      `the f32-narrowed geometry's signed volume is ${narrowedVolumeMm3} mm³ (<= 0): the Float64 mesh ` +
        'is outward, but the solid a binary STL reader decodes from the written float32 bytes would ' +
        'not be — a near-degenerate solid whose orientation does not survive the format\'s precision ' +
        'floor. Export refuses to ship bytes that violate its own outward guarantee; export as PLY ' +
        '(lossless float64) or fix the geometry upstream.',
    );
  }

  const headerText = options.headerText ?? EXPORT_STL_HEADER_TEXT;
  if (headerText !== EXPORT_STL_HEADER_TEXT) {
    assertExportableStlHeaderText(headerText);
  }
  return writeStlBinary(expandToSoup(mesh), { headerText });
}

export type { ExportSolidCheck };
