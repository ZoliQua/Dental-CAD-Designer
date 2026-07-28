// packages/io/src/export/stl.export.test.ts
//
// Unit tests for `exportStlBinary` — the manufacturing-grade STL export
// entry (Phase 7 Task 2). The centerpiece is an ANALYTIC BYTE GOLDEN: the
// expected 684-byte export of the closed-form cube is constructed
// INDEPENDENTLY (by hand, straight from the binary STL layout spec) and
// compared byte-for-byte, so header content, triangle ordering, narrowing,
// normals, and the attribute-byte-count field are all pinned against a
// second implementation, not against the writer itself.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseStl } from '../stl/parse.ts';
import {
  STL_BINARY_HEADER_BYTES,
  STL_BINARY_PREAMBLE_BYTES,
  STL_BINARY_RECORD_BYTES,
} from '../stl/binary.ts';
import { ExportMeshInvalidError } from './types.ts';
import { EXPORT_STL_HEADER_TEXT, exportStlBinary } from './stl.ts';
import {
  UNIT_CUBE2_FACET_NORMALS,
  cornerTetrahedron,
  unitCube2,
  windingReversed,
  withTrianglesDropped,
} from './export.test-fixtures.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Independent (non-writer) reimplementation of the documented facet-normal
 * spec — "right-hand rule over v0→v1→v2, cross(v1-v0, v2-v0) normalized" —
 * so the byte golden pins the normal fields to the FORMULA, not to the
 * writer's code. Note the bytes legitimately contain IEEE-754 SIGNED zeros
 * (e.g. a component like `(-2)*0 - 0*0 = -0`): the expected value is the
 * formula's exact IEEE arithmetic result, which `UNIT_CUBE2_FACET_NORMALS`
 * (a sign-of-zero-agnostic closed-form table) deliberately does not encode. */
function specFacetNormal(
  positions: Float64Array,
  indices: Uint32Array,
  t: number,
): readonly [number, number, number] {
  const a = indices[t * 3]! * 3;
  const b = indices[t * 3 + 1]! * 3;
  const c = indices[t * 3 + 2]! * 3;
  const ux = positions[b]! - positions[a]!;
  const uy = positions[b + 1]! - positions[a + 1]!;
  const uz = positions[b + 2]! - positions[a + 2]!;
  const vx = positions[c]! - positions[a]!;
  const vy = positions[c + 1]! - positions[a + 1]!;
  const vz = positions[c + 2]! - positions[a + 2]!;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return [nx / length, ny / length, nz / length];
}

/** Independent (non-writer) construction of the expected cube export —
 * straight from the documented byte layout. */
function expectedCubeBytes(): Uint8Array {
  const cube = unitCube2();
  const triangleCount = cube.indices.length / 3;
  const bytes = new Uint8Array(STL_BINARY_PREAMBLE_BYTES + triangleCount * STL_BINARY_RECORD_BYTES);
  // 80-byte header: the deterministic mm-marker text, ASCII, zero-padded.
  for (let i = 0; i < EXPORT_STL_HEADER_TEXT.length; i++) {
    bytes[i] = EXPORT_STL_HEADER_TEXT.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  view.setUint32(STL_BINARY_HEADER_BYTES, triangleCount, true);
  for (let t = 0; t < triangleCount; t++) {
    const recordStart = STL_BINARY_PREAMBLE_BYTES + t * STL_BINARY_RECORD_BYTES;
    const [nx, ny, nz] = specFacetNormal(cube.positions, cube.indices, t);
    view.setFloat32(recordStart, nx, true);
    view.setFloat32(recordStart + 4, ny, true);
    view.setFloat32(recordStart + 8, nz, true);
    for (let corner = 0; corner < 3; corner++) {
      const vertexIndex = cube.indices[t * 3 + corner]!;
      const offset = recordStart + 12 + corner * 12;
      view.setFloat32(offset, cube.positions[vertexIndex * 3]!, true);
      view.setFloat32(offset + 4, cube.positions[vertexIndex * 3 + 1]!, true);
      view.setFloat32(offset + 8, cube.positions[vertexIndex * 3 + 2]!, true);
    }
    view.setUint16(recordStart + 48, 0, true); // attribute byte count: always 0
  }
  return bytes;
}

describe('exportStlBinary: analytic byte golden (closed-form cube)', () => {
  it('produces byte-for-byte the independently-constructed expected layout', () => {
    const actual = exportStlBinary(unitCube2());
    const expected = expectedCubeBytes();
    expect(actual.byteLength).toBe(84 + 12 * 50);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  });

  it('matches the pinned SHA-256 (byte-pinned golden — the io-level determinism anchor)', () => {
    // Pin over the analytic cube export. This hash changes ONLY with a
    // deliberate, documented change to the export byte format (header text,
    // ordering rule, narrowing, or record layout) — never silently.
    expect(sha256(exportStlBinary(unitCube2()))).toBe(
      '6fdb0a7e778937d506d76e4f061de66f4f3ce84ce69d3a876c02044ee7767433',
    );
  });

  it('writes triangle records in canonical mesh triangle order with winding preserved', () => {
    // Ordering rule: record t IS triangle t of the input's indices array,
    // vertices in stored (v0, v1, v2) winding order. Proven by the byte
    // golden above; re-proven here structurally through the parser.
    const { soup } = parseStl(exportStlBinary(unitCube2()));
    const cube = unitCube2();
    expect(soup.triangleCount).toBe(12);
    for (let t = 0; t < 12; t++) {
      for (let corner = 0; corner < 3; corner++) {
        const vertexIndex = cube.indices[t * 3 + corner]!;
        for (let axis = 0; axis < 3; axis++) {
          expect(soup.positions[t * 9 + corner * 3 + axis]).toBe(
            Math.fround(cube.positions[vertexIndex * 3 + axis]!),
          );
        }
      }
    }
  });

  it('writes outward facet normals derived from the verified winding (closed-form check)', () => {
    const { soup } = parseStl(exportStlBinary(unitCube2()));
    expect(soup.normals).not.toBeNull();
    for (let t = 0; t < 12; t++) {
      const [nx, ny, nz] = UNIT_CUBE2_FACET_NORMALS[t]!;
      // `===` (not Object.is): the closed-form table is sign-of-zero
      // agnostic — the bytes may carry IEEE -0 components where the table
      // says 0 (see specFacetNormal's doc); geometrically identical.
      expect(soup.normals![t * 3] === nx).toBe(true);
      expect(soup.normals![t * 3 + 1] === ny).toBe(true);
      expect(soup.normals![t * 3 + 2] === nz).toBe(true);
    }
  });
});

describe('exportStlBinary: determinism', () => {
  it('is bit-identical across repeated calls and across cloned input buffers', () => {
    const a = exportStlBinary(unitCube2());
    const b = exportStlBinary(unitCube2());
    const cube = unitCube2();
    const c = exportStlBinary({ positions: cube.positions.slice(), indices: cube.indices.slice() });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(true);
  });

  it('carries the documented mm-units marker in the deterministic header', () => {
    const bytes = exportStlBinary(cornerTetrahedron());
    const header = new TextDecoder('ascii').decode(bytes.subarray(0, STL_BINARY_HEADER_BYTES));
    expect(header).toContain('units=mm');
    expect(EXPORT_STL_HEADER_TEXT).toContain('units=mm');
  });

  it('a custom headerText is sanitized, deterministic, and never changes the layout', () => {
    const a = exportStlBinary(unitCube2(), { headerText: 'case-42 tooth-11\nüñí' });
    const b = exportStlBinary(unitCube2(), { headerText: 'case-42 tooth-11\nüñí' });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(a.byteLength).toBe(84 + 12 * 50);
    const header = new TextDecoder('ascii').decode(a.subarray(0, STL_BINARY_HEADER_BYTES));
    expect(header.startsWith('case-42 tooth-11')).toBe(true);
    // Non-printable-ASCII replaced with '?' by sanitizeStlHeader.
    expect(header).not.toContain('\n');
  });
});

describe('exportStlBinary: invalid solids are rejected with typed errors (never silent)', () => {
  it('rejects an inward-oriented solid (the falsifiable outward-normals guarantee)', () => {
    expect(() => exportStlBinary(windingReversed(unitCube2()))).toThrowError(ExportMeshInvalidError);
    try {
      exportStlBinary(windingReversed(unitCube2()));
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ExportMeshInvalidError).reason).toBe('inward-orientation');
    }
  });

  it('rejects a non-watertight solid', () => {
    try {
      exportStlBinary(withTrianglesDropped(unitCube2(), 1));
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ExportMeshInvalidError);
      expect((error as ExportMeshInvalidError).reason).toBe('boundary-edge');
    }
  });

  it('rejects an empty mesh', () => {
    expect(() =>
      exportStlBinary({ positions: new Float64Array(0), indices: new Uint32Array(0) }),
    ).toThrowError(ExportMeshInvalidError);
  });

  it('rejects coordinates outside float32 range (STL cannot represent them finitely)', () => {
    const tet = cornerTetrahedron();
    const positions = tet.positions.slice();
    positions[0] = 1e39; // finite in f64, Infinity after f32 narrowing
    try {
      exportStlBinary({ positions, indices: tet.indices });
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ExportMeshInvalidError);
      expect((error as ExportMeshInvalidError).reason).toBe('structural');
    }
  });
});
