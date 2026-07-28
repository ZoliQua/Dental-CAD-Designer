// packages/io/src/export/ply.ts
//
// `exportPlyBinary` — the PLY-with-optional-color manufacturing-export
// entry (Phase 7 Task 2, minimal scope per the plan): composes the
// round-trip-proven `writePlyBinaryLE` unchanged and adds the same
// export-grade solid gate as the STL entry, plus strict color validation.
// PLY stores float64 positions, so — unlike STL — the geometry round trip
// is BIT-LOSSLESS: export → parse reproduces `positions`/`indices`
// byte-identically (no narrowing, no re-indexing). Colors are the one
// lossy field: quantized to uchar 0..255 on write (the writer's documented
// real-world PLY convention); out-of-range/non-finite colors are REJECTED
// here rather than silently clamped (no-silent-mutation invariant — the
// low-level writer's clamp remains for non-export callers).
//
// Determinism: same mesh + same colors + same comments ⇒ bit-identical
// bytes. The default header comment is fixed text with the documented
// `units=mm` marker — never a timestamp or environment value.

import { writePlyBinaryLE } from '../ply/binary.ts';
import { ExportMeshInvalidError, type ExportableMesh } from './types.ts';
import { assertExportableSolid } from './validate.ts';

/** Deterministic default header comment — carries the mm-units marker
 * (PLY, like STL, has no unit field; DQ-Dental-CAD exports are always mm). */
export const EXPORT_PLY_COMMENT = 'DQ-Dental-CAD binary PLY; units=mm';

export interface ExportPlyBinaryOptions {
  /** Optional per-vertex RGB colors, `vertexCount * 3` Float64 values in
   * [0, 1] (e.g. a QC heatmap baked by the caller — baking itself is NOT
   * this layer's job). Quantized to uchar on write (round(v * 255)); values
   * outside [0, 1] or non-finite are rejected, never clamped. */
  colors?: Float64Array;
  /** Header `comment` lines (sanitized by the writer). Defaults to the
   * single deterministic `EXPORT_PLY_COMMENT`. Same determinism contract
   * as `ExportStlBinaryOptions.headerText`: derive from journaled params
   * only. */
  comments?: readonly string[];
}

/**
 * Serializes a canonical kernel mesh (with optional per-vertex color) as a
 * manufacturing-grade binary-little-endian PLY. Same solid gate as
 * `exportStlBinary` (watertight + consistently wound + outward — typed
 * `ExportMeshInvalidError` otherwise); geometry is written lossless
 * float64. See this module's doc for determinism and the color-quantization
 * boundary.
 */
export function exportPlyBinary(
  mesh: ExportableMesh,
  options: ExportPlyBinaryOptions = {},
): Uint8Array {
  const check = assertExportableSolid(mesh);

  const colors = options.colors ?? null;
  if (colors !== null) {
    if (!(colors instanceof Float64Array)) {
      throw new ExportMeshInvalidError('structural', 'colors must be a Float64Array (kernel Float64 rule)');
    }
    if (colors.length !== check.vertexCount * 3) {
      throw new ExportMeshInvalidError(
        'structural',
        `colors.length (${colors.length}) does not match vertexCount * 3 (${check.vertexCount * 3})`,
      );
    }
    for (let i = 0; i < colors.length; i++) {
      const value = colors[i]!;
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new ExportMeshInvalidError(
          'structural',
          `colors[${i}] (${value}) is outside [0, 1] — export rejects out-of-range colors instead of ` +
            'silently clamping them',
        );
      }
    }
  }

  return writePlyBinaryLE(
    {
      positions: mesh.positions,
      normals: null,
      colors,
      indices: mesh.indices,
      vertexCount: check.vertexCount,
      faceCount: check.triangleCount,
    },
    { comments: options.comments ?? [EXPORT_PLY_COMMENT] },
  );
}
