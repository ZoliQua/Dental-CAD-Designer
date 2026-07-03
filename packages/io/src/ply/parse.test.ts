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
