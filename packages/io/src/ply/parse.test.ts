import { describe, expect, it } from 'vitest';
import { MalformedSyntaxError } from '../types.ts';
import { parsePly } from './parse.ts';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('parsePly: format dispatch', () => {
  it('dispatches ascii/binary_little_endian/binary_big_endian to diagnostics.format ply-ascii/-le/-be', () => {
    const asciiText =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n' +
      'end_header\n0 0 0\n';
    expect(parsePly(encode(asciiText)).diagnostics.format).toBe('ply-ascii');
  });
});

describe('parsePly: comments collected into diagnostics', () => {
  it('pushes comment/obj_info lines, tagged, into diagnostics.warnings', () => {
    const text =
      'ply\nformat ascii 1.0\ncomment anonymized\nobj_info scanner=foo\n' +
      'element vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n';
    const mesh = parsePly(encode(text));
    expect(mesh.diagnostics.warnings).toContain('comment: anonymized');
    expect(mesh.diagnostics.warnings).toContain('obj_info: scanner=foo');
  });
});

describe('parsePly: point-cloud (no face element)', () => {
  it('returns faceCount 0 and empty indices when the header declares no face element', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\n' +
      'end_header\n0 0 0\n1 1 1\n';
    const mesh = parsePly(encode(text));
    expect(mesh.vertexCount).toBe(2);
    expect(mesh.faceCount).toBe(0);
    expect(mesh.indices).toHaveLength(0);
  });
});

describe('parsePly: duplicate property names on one element (carry-over review item C)', () => {
  it(
    'warns (does not reject) when a vertex element declares a property name twice, and the LAST ' +
      'occurrence in header order wins for the role it resolves to (last-write-wins, documented)',
    () => {
      const text =
        'ply\nformat ascii 1.0\nelement vertex 1\n' +
        'property float x\nproperty float x\nproperty float y\nproperty float z\n' +
        'end_header\n1 2 3 4\n';
      const mesh = parsePly(encode(text));
      // Both "x" properties are read (positionally, to stay correctly
      // aligned within the row) but only the LAST one's value survives.
      expect(Array.from(mesh.positions)).toEqual([2, 3, 4]);
      expect(
        mesh.diagnostics.warnings.some(
          (w) => w.includes('declared more than once') && w.includes('"x" x2'),
        ),
      ).toBe(true);
    },
  );

  it('warns once per element with duplicates, listing every duplicated name in that element', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\n' +
      'property float x\nproperty float y\nproperty float y\nproperty float z\nproperty float z\n' +
      'end_header\n1 2 3 4 5\n';
    const mesh = parsePly(encode(text));
    const warning = mesh.diagnostics.warnings.find((w) => w.includes('declared more than once'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"y" x2');
    expect(warning).toContain('"z" x2');
  });

  it('does not warn when an element has no duplicate property names', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n' +
      'end_header\n1 2 3\n';
    const mesh = parsePly(encode(text));
    expect(mesh.diagnostics.warnings.some((w) => w.includes('declared more than once'))).toBe(false);
  });
});

describe(
  'parsePly: rejects non-finite (Infinity/-Infinity) values in CONSUMED roles, but tolerates them in ' +
    'unrecognized/skipped properties (found by this task\'s fuzz suite — Number("Infinity") parses ' +
    'successfully in JS and is not NaN, so the pre-fix ASCII reader silently stored ±Infinity ' +
    'coordinates; the fix is scoped to consumed roles only, matching how a skipped property already ' +
    'tolerates arbitrary garbage values)',
  () => {
    it('throws MalformedSyntaxError for an "Infinity" x coordinate', () => {
      const text =
        'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n' +
        'end_header\nInfinity 0 0\n';
      expect(() => parsePly(encode(text))).toThrow(MalformedSyntaxError);
    });

    it('throws MalformedSyntaxError for a "-Infinity" normal component', () => {
      const text =
        'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n' +
        'property float nx\nproperty float ny\nproperty float nz\nend_header\n0 0 0 -Infinity 0 1\n';
      expect(() => parsePly(encode(text))).toThrow(MalformedSyntaxError);
    });

    it('tolerates "Infinity" in an unrecognized (skipped) scalar property', () => {
      const text =
        'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n' +
        'property float confidence\nend_header\n0 0 0 Infinity\n';
      const mesh = parsePly(encode(text));
      expect(Array.from(mesh.positions)).toEqual([0, 0, 0]);
    });
  },
);

describe('parsePly: structural error cases', () => {
  it('throws MalformedSyntaxError when the header has no vertex element', () => {
    const text = 'ply\nformat ascii 1.0\nelement face 0\nproperty list uchar int vertex_indices\nend_header\n';
    expect(() => parsePly(encode(text))).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError when the vertex element is missing x/y/z', () => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n';
    expect(() => parsePly(encode(text))).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError when a face element has no vertex_indices/vertex_index property', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n' +
      'element face 1\nproperty list uchar float texcoord\nend_header\n0 0 0\n6 0 0 1 0 0 1\n';
    expect(() => parsePly(encode(text))).toThrow(MalformedSyntaxError);
  });

  it('accepts the legacy "vertex_index" (singular) spelling for the face index list', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
      'element face 1\nproperty list uchar int vertex_index\nend_header\n' +
      '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
    const mesh = parsePly(encode(text));
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
  });
});
