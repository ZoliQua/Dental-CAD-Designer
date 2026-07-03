import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IoWriteRangeError, MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import { parsePly } from './parse.ts';
import { DEFAULT_PLY_COMMENT, sanitizePlyComment, writePlyBinaryLE } from './binary.ts';
import type { WritablePlyMesh } from './binary.ts';

/** Test-only raw byte assembler for hand-built binary PLY bodies — lets
 * these tests construct exact/malformed/unusual on-disk layouts (mixed
 * scalar types, reordered properties, deliberately truncated buffers) that
 * `writePlyBinaryLE` (which only ever emits its own fixed, well-formed
 * layout) can't produce. Not used by any production code path. */
class BinaryPlyBuilder {
  private bytes: number[] = [];
  constructor(private readonly littleEndian: boolean) {}

  private multi(size: number, write: (view: DataView) => void): this {
    const buf = new ArrayBuffer(size);
    write(new DataView(buf));
    this.bytes.push(...new Uint8Array(buf));
    return this;
  }

  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  i8(v: number): this {
    return this.multi(1, (dv) => dv.setInt8(0, v));
  }
  u16(v: number): this {
    return this.multi(2, (dv) => dv.setUint16(0, v, this.littleEndian));
  }
  u32(v: number): this {
    return this.multi(4, (dv) => dv.setUint32(0, v, this.littleEndian));
  }
  i32(v: number): this {
    return this.multi(4, (dv) => dv.setInt32(0, v, this.littleEndian));
  }
  f32(v: number): this {
    return this.multi(4, (dv) => dv.setFloat32(0, v, this.littleEndian));
  }
  f64(v: number): this {
    return this.multi(8, (dv) => dv.setFloat64(0, v, this.littleEndian));
  }

  toBytes(headerText: string): Uint8Array {
    const header = new TextEncoder().encode(headerText);
    const out = new Uint8Array(header.length + this.bytes.length);
    out.set(header, 0);
    out.set(this.bytes, header.length);
    return out;
  }
}

function hashFloat64(a: Float64Array): string {
  return createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
}

describe('parsePly (binary): endianness', () => {
  it('parses a little-endian binary vertex+face mesh', () => {
    const header =
      'ply\n' +
      'format binary_little_endian 1.0\n' +
      'element vertex 3\n' +
      'property float x\n' +
      'property float y\n' +
      'property float z\n' +
      'element face 1\n' +
      'property list uchar int vertex_indices\n' +
      'end_header\n';
    const bytes = new BinaryPlyBuilder(true)
      .f32(0).f32(0).f32(0)
      .f32(1).f32(0).f32(0)
      .f32(0).f32(1).f32(0)
      .u8(3).i32(0).i32(1).i32(2)
      .toBytes(header);

    const mesh = parsePly(bytes);
    expect(mesh.diagnostics.format).toBe('ply-binary-le');
    expect(mesh.vertexCount).toBe(3);
    expect(mesh.faceCount).toBe(1);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
  });

  it('parses the identical mesh from a big-endian binary body', () => {
    const header =
      'ply\n' +
      'format binary_big_endian 1.0\n' +
      'element vertex 3\n' +
      'property float x\n' +
      'property float y\n' +
      'property float z\n' +
      'element face 1\n' +
      'property list uchar int vertex_indices\n' +
      'end_header\n';
    const bytes = new BinaryPlyBuilder(false)
      .f32(0).f32(0).f32(0)
      .f32(1).f32(0).f32(0)
      .f32(0).f32(1).f32(0)
      .u8(3).i32(0).i32(1).i32(2)
      .toBytes(header);

    const mesh = parsePly(bytes);
    expect(mesh.diagnostics.format).toBe('ply-binary-be');
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
  });
});

describe('parsePly (binary): list count/item type variants', () => {
  it('reads a face list declared "list uchar int vertex_indices" (the real-fixture convention)', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\n' +
      'property float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n';
    const bytes = new BinaryPlyBuilder(true)
      .f32(0).f32(0).f32(0)
      .f32(1).f32(0).f32(0)
      .f32(0).f32(1).f32(0)
      .u8(3).i32(2).i32(0).i32(1)
      .toBytes(header);
    const mesh = parsePly(bytes);
    expect(Array.from(mesh.indices)).toEqual([2, 0, 1]);
  });

  it('reads a face list declared "list uint uint vertex_indices" (wider count and item types)', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\n' +
      'property float z\nelement face 1\nproperty list uint uint vertex_indices\nend_header\n';
    const bytes = new BinaryPlyBuilder(true)
      .f32(0).f32(0).f32(0)
      .f32(1).f32(0).f32(0)
      .f32(0).f32(1).f32(0)
      .u32(3).u32(1).u32(2).u32(0)
      .toBytes(header);
    const mesh = parsePly(bytes);
    expect(Array.from(mesh.indices)).toEqual([1, 2, 0]);
  });
});

describe('parsePly (binary): header-driven property order', () => {
  it('places x/y/z correctly regardless of declared order (z y x)', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float z\nproperty float y\n' +
      'property float x\nend_header\n';
    const bytes = new BinaryPlyBuilder(true).f32(7).f32(8).f32(9).toBytes(header);
    const mesh = parsePly(bytes);
    expect(Array.from(mesh.positions)).toEqual([9, 8, 7]); // x=9, y=8, z=7
  });

  it('reads double (float64)-typed positions exactly', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty double x\nproperty double y\n' +
      'property double z\nend_header\n';
    const value = 0.1 + 0.2; // a value that is NOT float32-representable, to prove no float32 narrowing
    const bytes = new BinaryPlyBuilder(true).f64(value).f64(value).f64(value).toBytes(header);
    const mesh = parsePly(bytes);
    expect(mesh.positions[0]).toBe(value);
    expect(mesh.positions[1]).toBe(value);
    expect(mesh.positions[2]).toBe(value);
  });

  it('reads per-vertex uchar color, normalized to [0, 1]', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\n' +
      'property float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
    const bytes = new BinaryPlyBuilder(true).f32(0).f32(0).f32(0).u8(255).u8(128).u8(0).toBytes(header);
    const mesh = parsePly(bytes);
    expect(mesh.colors).not.toBeNull();
    expect(mesh.colors![0]).toBeCloseTo(1, 10);
    expect(mesh.colors![1]).toBeCloseTo(128 / 255, 10);
    expect(mesh.colors![2]).toBe(0);
  });
});

describe('parsePly (binary): fan triangulation', () => {
  function meshWithFaces(faceRows: (b: BinaryPlyBuilder) => void, faceCount: number): Uint8Array {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 5\nproperty float x\nproperty float y\n' +
      `property float z\nelement face ${faceCount}\nproperty list uchar int vertex_indices\nend_header\n`;
    const b = new BinaryPlyBuilder(true);
    for (let i = 0; i < 5; i++) {
      b.f32(i).f32(i).f32(i);
    }
    faceRows(b);
    return b.toBytes(header);
  }

  it('passes a triangle (n=3) through as a single triangle, no warning', () => {
    const bytes = meshWithFaces((b) => b.u8(3).i32(0).i32(1).i32(2), 1);
    const mesh = parsePly(bytes);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('fan-triangulated'))).toBe(false);
  });

  it('fan-triangulates a quad (n=4) into 2 triangles, with a warning', () => {
    const bytes = meshWithFaces((b) => b.u8(4).i32(0).i32(1).i32(2).i32(3), 1);
    const mesh = parsePly(bytes);
    expect(mesh.faceCount).toBe(1);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('quad'))).toBe(true);
  });

  it('fan-triangulates a pentagon (n=5, >4-gon) into 3 triangles, with a warning', () => {
    const bytes = meshWithFaces((b) => b.u8(5).i32(0).i32(1).i32(2).i32(3).i32(4), 1);
    const mesh = parsePly(bytes);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 4]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('more than 4'))).toBe(true);
  });

  it('handles mixed per-face vertex counts (triangle, quad, pentagon) in one file', () => {
    const bytes = meshWithFaces(
      (b) =>
        b
          .u8(3).i32(0).i32(1).i32(2)
          .u8(4).i32(0).i32(1).i32(2).i32(3)
          .u8(5).i32(0).i32(1).i32(2).i32(3).i32(4),
      3,
    );
    const mesh = parsePly(bytes);
    expect(mesh.faceCount).toBe(3);
    // 1 triangle + 2 (quad) + 3 (pentagon) = 6 output triangles.
    expect(mesh.indices).toHaveLength(6 * 3);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('1 face(s)') && w.includes('quad'))).toBe(
      true,
    );
    expect(
      mesh.diagnostics.warnings.some((w) => w.includes('1 face(s)') && w.includes('more than 4')),
    ).toBe(true);
  });

  it('throws MalformedSyntaxError for a face with fewer than 3 vertex indices', () => {
    const bytes = meshWithFaces((b) => b.u8(2).i32(0).i32(1), 1);
    expect(() => parsePly(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for a face vertex index out of range', () => {
    const bytes = meshWithFaces((b) => b.u8(3).i32(0).i32(1).i32(99), 1);
    expect(() => parsePly(bytes)).toThrow(MalformedSyntaxError);
  });
});

describe('parsePly (binary): unknown/extra property and element skipping', () => {
  it('skips an unrecognized scalar vertex property ("confidence") and still reads x/y/z correctly', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\n' +
      'property float z\nproperty float confidence\nend_header\n';
    const bytes = new BinaryPlyBuilder(true).f32(1).f32(2).f32(3).f32(0.9).toBytes(header);
    const mesh = parsePly(bytes);
    expect(Array.from(mesh.positions)).toEqual([1, 2, 3]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('confidence'))).toBe(true);
  });

  it(
    'skips an unrecognized list property on the face element ("texcoord", the real-fixture case) and ' +
      'still reads vertex_indices correctly — the classic PLY skip trap: the skip width is per-row, ' +
      'driven by that row\'s own list count, not a fixed stride',
    () => {
      const header =
        'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\n' +
        'property float z\nelement face 2\nproperty list uchar int vertex_indices\n' +
        'property list uchar float texcoord\nend_header\n';
      const bytes = new BinaryPlyBuilder(true)
        .f32(0).f32(0).f32(0)
        .f32(1).f32(0).f32(0)
        .f32(0).f32(1).f32(0)
        // face 0: 3 indices, then a 6-float texcoord list (varies in length per real files)
        .u8(3).i32(0).i32(1).i32(2).u8(6).f32(0).f32(0).f32(1).f32(0).f32(0).f32(1)
        // face 1: 3 indices (reordered), then a DIFFERENT-length (4-float) texcoord list
        .u8(3).i32(2).i32(1).i32(0).u8(4).f32(1).f32(1).f32(0).f32(1)
        .toBytes(header);
      const mesh = parsePly(bytes);
      expect(mesh.faceCount).toBe(2);
      expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 2, 1, 0]);
      expect(mesh.diagnostics.warnings.some((w) => w.includes('texcoord'))).toBe(true);
    },
  );

  it('skips an unrecognized SCALAR property on the face element (e.g. a per-face "quality" flag)', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\n' +
      'property float z\nelement face 1\nproperty list uchar int vertex_indices\n' +
      'property uchar quality\nend_header\n';
    const bytes = new BinaryPlyBuilder(true)
      .f32(0).f32(0).f32(0)
      .f32(1).f32(0).f32(0)
      .f32(0).f32(1).f32(0)
      .u8(3).i32(0).i32(1).i32(2).u8(9)
      .toBytes(header);
    const mesh = parsePly(bytes);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('quality'))).toBe(true);
  });

  it('skips an unrecognized LIST property on the vertex element (unusual but spec-legal)', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\n' +
      'property float z\nproperty list uchar int adjacent_faces\nend_header\n';
    const bytes = new BinaryPlyBuilder(true)
      .f32(0).f32(0).f32(0).u8(2).i32(5).i32(6)
      .f32(1).f32(1).f32(1).u8(0)
      .toBytes(header);
    const mesh = parsePly(bytes);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('adjacent_faces'))).toBe(true);
  });

  it('skips an entire unrecognized element ("edge") sitting between vertex and face in header order', () => {
    const header =
      'ply\n' +
      'format binary_little_endian 1.0\n' +
      'element vertex 3\n' +
      'property float x\nproperty float y\nproperty float z\n' +
      'element edge 2\n' +
      'property int vertex1\nproperty int vertex2\n' +
      'element face 1\n' +
      'property list uchar int vertex_indices\n' +
      'end_header\n';
    const bytes = new BinaryPlyBuilder(true)
      .f32(0).f32(0).f32(0)
      .f32(1).f32(0).f32(0)
      .f32(0).f32(1).f32(0)
      .i32(0).i32(1) // edge 0
      .i32(1).i32(2) // edge 1
      .u8(3).i32(0).i32(1).i32(2)
      .toBytes(header);
    const mesh = parsePly(bytes);
    expect(mesh.vertexCount).toBe(3);
    expect(mesh.faceCount).toBe(1);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('"edge"'))).toBe(true);
  });
});

describe('parsePly (binary): error cases', () => {
  it('throws TruncatedFileError when the body is cut off exactly mid-vertex-row', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\n' +
      'property float z\nend_header\n';
    const full = new BinaryPlyBuilder(true).f32(1).f32(2).f32(3).f32(4).f32(5).f32(6).toBytes(header);
    // Cut off 5 bytes into the second vertex's 12-byte row (after x, partway through y).
    const headerLen = full.byteLength - 24;
    const truncated = full.subarray(0, headerLen + 12 + 5);
    let thrown: unknown;
    try {
      parsePly(truncated);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TruncatedFileError);
    expect((thrown as TruncatedFileError).byteOffset).toBe(truncated.byteLength - 1);
  });

  it('throws TruncatedFileError when a list count declares more items than remain in the buffer', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\n' +
      'property float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n';
    const full = new BinaryPlyBuilder(true)
      .f32(0).f32(0).f32(0)
      .f32(1).f32(0).f32(0)
      .f32(0).f32(1).f32(0)
      .u8(3).i32(0).i32(1).i32(2)
      .toBytes(header);
    // Truncate right after the list count byte (declares 3 indices, 0 bytes follow).
    const truncated = full.subarray(0, full.byteLength - 12);
    expect(() => parsePly(truncated)).toThrow(TruncatedFileError);
  });
});

describe('parsePly (binary): determinism', () => {
  it('produces byte-identical Float64 buffers when parsing the same bytes twice', () => {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\n' +
      'property float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n';
    const bytes = new BinaryPlyBuilder(true)
      .f32(0).f32(0).f32(0)
      .f32(1).f32(0).f32(0)
      .f32(0).f32(1).f32(0)
      .u8(3).i32(0).i32(1).i32(2)
      .toBytes(header);
    const first = parsePly(bytes);
    const second = parsePly(bytes);
    expect(hashFloat64(first.positions)).toBe(hashFloat64(second.positions));
    expect(Array.from(first.indices)).toEqual(Array.from(second.indices));
  });
});

function tetrahedronMesh(): WritablePlyMesh {
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    normals: null,
    colors: null,
    indices: new Uint32Array([0, 1, 2, 0, 1, 3, 1, 2, 3, 0, 2, 3]),
    vertexCount: 4,
    faceCount: 4,
  };
}

describe('writePlyBinaryLE: header content', () => {
  it('writes "ply" / "format binary_little_endian 1.0" and the default comment', () => {
    const bytes = writePlyBinaryLE(tetrahedronMesh());
    const text = new TextDecoder('ascii').decode(bytes.subarray(0, 200));
    expect(text.startsWith('ply\nformat binary_little_endian 1.0\n')).toBe(true);
    expect(text).toContain(`comment ${DEFAULT_PLY_COMMENT}`);
    expect(text).toContain('element vertex 4');
    expect(text).toContain('element face 4');
    expect(text).toContain('property list uint8 uint32 vertex_indices');
    expect(text).toContain('end_header\n');
  });

  it('sanitizes comment text (strips newlines, maps non-ASCII to "?")', () => {
    const bytes = writePlyBinaryLE(tetrahedronMesh(), { comments: ['line one\nline two café'] });
    const text = new TextDecoder('ascii').decode(bytes.subarray(0, 300));
    expect(text).toContain('comment line one line two caf?');
    expect(text).not.toContain('\ncomment line one\n'); // the embedded \n must not split into two lines
  });

  it('writes normals/color property lines only when the mesh carries them', () => {
    const withExtras: WritablePlyMesh = {
      ...tetrahedronMesh(),
      normals: new Float64Array(12),
      colors: new Float64Array(12),
    };
    const bytes = writePlyBinaryLE(withExtras);
    const text = new TextDecoder('ascii').decode(bytes.subarray(0, 400));
    expect(text).toContain('property float64 nx');
    expect(text).toContain('property uint8 red');

    const bare = writePlyBinaryLE(tetrahedronMesh());
    const bareText = new TextDecoder('ascii').decode(bare.subarray(0, 400));
    expect(bareText).not.toContain('nx');
    expect(bareText).not.toContain('red');
  });
});

describe('writePlyBinaryLE -> parsePly round trip', () => {
  it('reproduces vertexCount, positions, and indices exactly', () => {
    const mesh = tetrahedronMesh();
    const bytes = writePlyBinaryLE(mesh);
    const parsed = parsePly(bytes);
    expect(parsed.vertexCount).toBe(mesh.vertexCount);
    expect(Array.from(parsed.positions)).toEqual(Array.from(mesh.positions));
    expect(Array.from(parsed.indices)).toEqual(Array.from(mesh.indices));
    expect(parsed.diagnostics.format).toBe('ply-binary-le');
  });

  it('round-trips normals exactly and colors within uchar quantization', () => {
    const mesh: WritablePlyMesh = {
      ...tetrahedronMesh(),
      normals: new Float64Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      colors: new Float64Array([1, 0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1, 0, 0.5]),
    };
    const bytes = writePlyBinaryLE(mesh);
    const parsed = parsePly(bytes);
    expect(Array.from(parsed.normals!)).toEqual(Array.from(mesh.normals!));
    for (let i = 0; i < parsed.colors!.length; i++) {
      expect(parsed.colors![i]).toBeCloseTo(mesh.colors![i]!, 2); // uchar quantization, see binary.ts doc
    }
  });
});

describe('writePlyBinaryLE: validation', () => {
  it('throws IoWriteRangeError when indices.length is not a multiple of 3', () => {
    const mesh: WritablePlyMesh = { ...tetrahedronMesh(), indices: new Uint32Array([0, 1]) };
    expect(() => writePlyBinaryLE(mesh)).toThrow(IoWriteRangeError);
  });

  it('throws IoWriteRangeError when an index is out of range for vertexCount', () => {
    const mesh: WritablePlyMesh = { ...tetrahedronMesh(), indices: new Uint32Array([0, 1, 99]) };
    expect(() => writePlyBinaryLE(mesh)).toThrow(IoWriteRangeError);
  });

  it('throws IoWriteRangeError when positions.length does not match vertexCount * 3', () => {
    const mesh: WritablePlyMesh = { ...tetrahedronMesh(), positions: new Float64Array([0, 0, 0]) };
    expect(() => writePlyBinaryLE(mesh)).toThrow(IoWriteRangeError);
  });
});

describe('sanitizePlyComment', () => {
  it('replaces embedded newlines with a space and trims', () => {
    expect(sanitizePlyComment('a\nb\r\nc')).toBe('a b  c');
  });

  it('maps non-printable/non-ASCII characters to "?" (surrounding whitespace is then trimmed)', () => {
    expect(sanitizePlyComment('café ')).toBe('caf?');
  });
});
