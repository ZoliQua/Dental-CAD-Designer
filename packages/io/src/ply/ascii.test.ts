import { describe, expect, it } from 'vitest';
import { MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import { parsePly } from './parse.ts';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('parsePly (ASCII): baseline', () => {
  it('parses an ASCII vertex+face mesh', () => {
    const text =
      'ply\n' +
      'format ascii 1.0\n' +
      'element vertex 3\n' +
      'property float x\n' +
      'property float y\n' +
      'property float z\n' +
      'element face 1\n' +
      'property list uchar int vertex_indices\n' +
      'end_header\n' +
      '0 0 0\n' +
      '1 0 0\n' +
      '0 1 0\n' +
      '3 0 1 2\n';
    const mesh = parsePly(encode(text));
    expect(mesh.diagnostics.format).toBe('ply-ascii');
    expect(mesh.vertexCount).toBe(3);
    expect(mesh.faceCount).toBe(1);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
  });

  it('accepts scientific-notation and signed numeric tokens', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\n' +
      'property float z\nend_header\n' +
      '-1.5e+02 2.5E-3 +0\n';
    const mesh = parsePly(encode(text));
    expect(mesh.positions[0]).toBeCloseTo(-150, 10);
    expect(mesh.positions[1]).toBeCloseTo(0.0025, 10);
    expect(mesh.positions[2]).toBe(0);
  });
});

describe('parsePly (ASCII): header-driven property order', () => {
  it('places x/y/z correctly regardless of declared order (z y x)', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float z\nproperty float y\n' +
      'property float x\nend_header\n' +
      '7 8 9\n';
    const mesh = parsePly(encode(text));
    expect(Array.from(mesh.positions)).toEqual([9, 8, 7]);
  });

  it('reads double (float64)-typed positions', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty double x\nproperty double y\n' +
      'property double z\nend_header\n' +
      '0.30000000000000004 1 2\n';
    const mesh = parsePly(encode(text));
    expect(mesh.positions[0]).toBe(0.30000000000000004);
  });

  it('reads per-vertex uchar color, normalized to [0, 1]', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\n' +
      'property float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n' +
      '0 0 0 255 128 0\n';
    const mesh = parsePly(encode(text));
    expect(mesh.colors).not.toBeNull();
    expect(mesh.colors![0]).toBeCloseTo(1, 10);
    expect(mesh.colors![1]).toBeCloseTo(128 / 255, 10);
    expect(mesh.colors![2]).toBe(0);
  });
});

describe('parsePly (ASCII): list count/item type variants', () => {
  it('reads "list uchar int vertex_indices" (the real-fixture convention)', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
      'element face 1\nproperty list uchar int vertex_indices\nend_header\n' +
      '0 0 0\n1 0 0\n0 1 0\n3 2 0 1\n';
    const mesh = parsePly(encode(text));
    expect(Array.from(mesh.indices)).toEqual([2, 0, 1]);
  });

  it('reads "list uint uint vertex_indices" (wider count and item types)', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
      'element face 1\nproperty list uint uint vertex_indices\nend_header\n' +
      '0 0 0\n1 0 0\n0 1 0\n3 1 2 0\n';
    const mesh = parsePly(encode(text));
    expect(Array.from(mesh.indices)).toEqual([1, 2, 0]);
  });
});

describe('parsePly (ASCII): fan triangulation', () => {
  const vertexBlock = '0 0 0\n1 0 0\n2 0 0\n3 0 0\n4 0 0\n';
  const header =
    'ply\nformat ascii 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\n';

  it('fan-triangulates a quad (n=4) into 2 triangles, with a warning', () => {
    const text = `${header}element face 1\nproperty list uchar int vertex_indices\nend_header\n${vertexBlock}4 0 1 2 3\n`;
    const mesh = parsePly(encode(text));
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('quad'))).toBe(true);
  });

  it('fan-triangulates a pentagon (n=5) into 3 triangles, with a warning', () => {
    const text = `${header}element face 1\nproperty list uchar int vertex_indices\nend_header\n${vertexBlock}5 0 1 2 3 4\n`;
    const mesh = parsePly(encode(text));
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 4]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('more than 4'))).toBe(true);
  });

  it('throws MalformedSyntaxError for a face with fewer than 3 vertex indices', () => {
    const text = `${header}element face 1\nproperty list uchar int vertex_indices\nend_header\n${vertexBlock}2 0 1\n`;
    expect(() => parsePly(encode(text))).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for an out-of-range vertex index', () => {
    const text = `${header}element face 1\nproperty list uchar int vertex_indices\nend_header\n${vertexBlock}3 0 1 99\n`;
    expect(() => parsePly(encode(text))).toThrow(MalformedSyntaxError);
  });
});

describe('parsePly (ASCII): unknown/extra property and element skipping', () => {
  it('skips an unrecognized scalar vertex property ("confidence")', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n' +
      'property float confidence\nend_header\n' +
      '1 2 3 0.9\n';
    const mesh = parsePly(encode(text));
    expect(Array.from(mesh.positions)).toEqual([1, 2, 3]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('confidence'))).toBe(true);
  });

  it('skips an unrecognized list property on the face element ("texcoord")', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
      'element face 1\nproperty list uchar int vertex_indices\nproperty list uchar float texcoord\n' +
      'end_header\n' +
      '0 0 0\n1 0 0\n0 1 0\n' +
      '3 0 1 2 6 0 0 1 0 0 1\n';
    const mesh = parsePly(encode(text));
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('texcoord'))).toBe(true);
  });

  it('skips an entire unrecognized element ("edge") between vertex and face', () => {
    const text =
      'ply\n' +
      'format ascii 1.0\n' +
      'element vertex 3\n' +
      'property float x\nproperty float y\nproperty float z\n' +
      'element edge 2\n' +
      'property int vertex1\nproperty int vertex2\n' +
      'element face 1\n' +
      'property list uchar int vertex_indices\n' +
      'end_header\n' +
      '0 0 0\n1 0 0\n0 1 0\n' +
      '0 1\n1 2\n' +
      '3 0 1 2\n';
    const mesh = parsePly(encode(text));
    expect(mesh.vertexCount).toBe(3);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(mesh.diagnostics.warnings.some((w) => w.includes('"edge"'))).toBe(true);
  });
});

describe('parsePly (ASCII): error cases', () => {
  it('throws TruncatedFileError when the body ends before all vertex rows are present', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\n' +
      'end_header\n0 0 0\n';
    expect(() => parsePly(encode(text))).toThrow(TruncatedFileError);
  });

  it('throws MalformedSyntaxError for a non-numeric coordinate token', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n' +
      'end_header\nnot-a-number 0 0\n';
    expect(() => parsePly(encode(text))).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError when a list declares more items than tokens remain on the line', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
      'element face 1\nproperty list uchar int vertex_indices\nend_header\n' +
      '0 0 0\n1 0 0\n0 1 0\n5 0 1\n'; // declares 5 items, only 2 given
    expect(() => parsePly(encode(text))).toThrow(MalformedSyntaxError);
  });
});

describe('parsePly (ASCII): determinism', () => {
  it('produces identical output when parsing the same bytes twice', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
      'element face 1\nproperty list uchar int vertex_indices\nend_header\n' +
      '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
    const bytes = encode(text);
    const first = parsePly(bytes);
    const second = parsePly(bytes);
    expect(Array.from(first.positions)).toEqual(Array.from(second.positions));
    expect(Array.from(first.indices)).toEqual(Array.from(second.indices));
  });
});
