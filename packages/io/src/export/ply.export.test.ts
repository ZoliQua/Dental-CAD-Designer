// packages/io/src/export/ply.export.test.ts
//
// Unit tests for `exportPlyBinary` — the PLY-with-optional-color export
// entry (Phase 7 Task 2 deliverable 5). PLY stores float64 positions, so —
// unlike STL — the export/re-parse round trip is BIT-LOSSLESS for
// geometry; colors are the one documented lossy field (uchar quantization,
// the writer's established convention).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parsePly } from '../ply/parse.ts';
import { ExportMeshInvalidError } from './types.ts';
import { EXPORT_PLY_COMMENT, exportPlyBinary } from './ply.ts';
import { cornerTetrahedron, unitCube2, windingReversed } from './export.test-fixtures.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Uniform mid-gray per-vertex colors for the cube (8 vertices). 0.5
 * quantizes to round(127.5) = 128 — an exact, closed-form expectation. */
function cubeColors(): Float64Array {
  return new Float64Array(24).fill(0.5);
}

describe('exportPlyBinary: lossless geometry round trip', () => {
  it('re-parses to BIT-IDENTICAL positions and indices (float64 on disk)', () => {
    const cube = unitCube2();
    const mesh = parsePly(exportPlyBinary(cube));
    expect(mesh.diagnostics.format).toBe('ply-binary-le');
    // The parser surfaces header comments as diagnostics entries — the
    // deterministic units marker is the only one present.
    expect(mesh.diagnostics.warnings).toEqual([`comment: ${EXPORT_PLY_COMMENT}`]);
    expect(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength)
      .equals(Buffer.from(cube.positions.buffer, cube.positions.byteOffset, cube.positions.byteLength)))
      .toBe(true);
    expect(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength)
      .equals(Buffer.from(cube.indices.buffer, cube.indices.byteOffset, cube.indices.byteLength)))
      .toBe(true);
    expect(mesh.normals).toBeNull();
    expect(mesh.colors).toBeNull();
  });

  it('carries optional per-vertex colors, quantized to uchar exactly as documented', () => {
    const cube = unitCube2();
    const mesh = parsePly(exportPlyBinary(cube, { colors: cubeColors() }));
    expect(mesh.colors).not.toBeNull();
    expect(mesh.colors).toHaveLength(24);
    for (let i = 0; i < 24; i++) {
      // 0.5 -> round(0.5 * 255) = 128 on disk -> 128/255 back.
      expect(mesh.colors![i]).toBe(128 / 255);
    }
  });
});

describe('exportPlyBinary: determinism', () => {
  it('is bit-identical across repeated calls (with and without colors)', () => {
    const plain = [exportPlyBinary(unitCube2()), exportPlyBinary(unitCube2())];
    expect(Buffer.from(plain[0]!).equals(Buffer.from(plain[1]!))).toBe(true);
    const colored = [
      exportPlyBinary(unitCube2(), { colors: cubeColors() }),
      exportPlyBinary(unitCube2(), { colors: cubeColors() }),
    ];
    expect(Buffer.from(colored[0]!).equals(Buffer.from(colored[1]!))).toBe(true);
  });

  it('matches the pinned SHA-256 for the analytic cube (plain and colored)', () => {
    expect(sha256(exportPlyBinary(unitCube2()))).toBe(
      'f65fffaf919780f0fe63e80b1ba649e2b0e952a4eac910252a2ccaa33700aadf',
    );
    expect(sha256(exportPlyBinary(unitCube2(), { colors: cubeColors() }))).toBe(
      '3b1a1a69e139c6acdd91b308765f67217af7f039a63fd48770581e9637db5617',
    );
  });

  it('writes the deterministic mm-units comment into the header', () => {
    const bytes = exportPlyBinary(cornerTetrahedron());
    const headerEnd = Buffer.from(bytes).indexOf('end_header');
    const header = new TextDecoder('ascii').decode(bytes.subarray(0, headerEnd));
    expect(header).toContain(`comment ${EXPORT_PLY_COMMENT}`);
    expect(EXPORT_PLY_COMMENT).toContain('units=mm');
  });
});

describe('exportPlyBinary: invalid input is rejected with typed errors', () => {
  it('rejects an inward-oriented solid (same solid gate as STL export)', () => {
    try {
      exportPlyBinary(windingReversed(unitCube2()));
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ExportMeshInvalidError);
      expect((error as ExportMeshInvalidError).reason).toBe('inward-orientation');
    }
  });

  it('rejects colors of the wrong length', () => {
    expect(() => exportPlyBinary(unitCube2(), { colors: new Float64Array(23) })).toThrowError(
      ExportMeshInvalidError,
    );
  });

  it('rejects non-finite or out-of-[0,1] colors instead of silently clamping', () => {
    const bad = cubeColors();
    bad[3] = 1.5;
    expect(() => exportPlyBinary(unitCube2(), { colors: bad })).toThrowError(ExportMeshInvalidError);
    const nan = cubeColors();
    nan[0] = Number.NaN;
    expect(() => exportPlyBinary(unitCube2(), { colors: nan })).toThrowError(ExportMeshInvalidError);
  });

  it('rejects non-Float64Array colors', () => {
    expect(() =>
      exportPlyBinary(unitCube2(), { colors: new Float32Array(24).fill(0.5) as unknown as Float64Array }),
    ).toThrowError(ExportMeshInvalidError);
  });
});
