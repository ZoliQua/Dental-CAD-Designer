import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import type { RawTriangleSoup } from '../types.ts';
import { writeStlBinary } from './binary.ts';
import { parseStl } from './parse.ts';

function twoTriangleSoup(): RawTriangleSoup {
  return {
    positions: new Float64Array([
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0, //
      0,
      0,
      1,
      1,
      0,
      1,
      0,
      1,
      1,
    ]),
    normals: new Float64Array([0, 0, 1, 0, 0, -1]),
    triangleCount: 2,
  };
}

function hashBytes(view: Float64Array): string {
  return createHash('sha256')
    .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
    .digest('hex');
}

describe('parseStl: format detection', () => {
  it('detects a well-formed binary STL and reports diagnostics.format = "stl-binary"', () => {
    const bytes = writeStlBinary(twoTriangleSoup());
    const { soup, diagnostics } = parseStl(bytes);
    expect(diagnostics.format).toBe('stl-binary');
    expect(diagnostics.warnings).toHaveLength(0);
    expect(soup.triangleCount).toBe(2);
  });

  it(
    'detects binary STL even when its 80-byte header literally starts with "solid" — the key spec fact ' +
      '(length consistency, not the prefix, is the discriminator)',
    () => {
      const bytes = writeStlBinary(twoTriangleSoup(), {
        headerText: 'solid this-is-actually-binary',
      });
      const { soup, diagnostics } = parseStl(bytes);
      expect(diagnostics.format).toBe('stl-binary');
      expect(soup.triangleCount).toBe(2);
      expect(Array.from(soup.positions)).toEqual(Array.from(twoTriangleSoup().positions));
    },
  );

  it('detects ASCII STL and reports diagnostics.format = "stl-ascii"', () => {
    const text = [
      'solid ascii-detect',
      'facet normal 0 0 1',
      'outer loop',
      'vertex 0 0 0',
      'vertex 1 0 0',
      'vertex 0 1 0',
      'endloop',
      'endfacet',
      'endsolid ascii-detect',
    ].join('\n');
    const bytes = new TextEncoder().encode(text);
    const { soup, diagnostics } = parseStl(bytes);
    expect(diagnostics.format).toBe('stl-ascii');
    expect(soup.triangleCount).toBe(1);
  });

  it('tolerates trailing junk bytes after a valid binary STL, with a warning', () => {
    const clean = writeStlBinary(twoTriangleSoup());
    const withJunk = new Uint8Array(clean.byteLength + 5);
    withJunk.set(clean, 0);
    withJunk.set([1, 2, 3, 4, 5], clean.byteLength); // arbitrary non-ASCII-looking junk

    const { soup, diagnostics } = parseStl(withJunk);
    expect(diagnostics.format).toBe('stl-binary');
    expect(soup.triangleCount).toBe(2);
    expect(diagnostics.warnings.some((w) => w.includes('trailing'))).toBe(true);
  });
});

describe('parseStl: error cases', () => {
  it('throws TruncatedFileError for an empty (0-byte) file', () => {
    expect(() => parseStl(new Uint8Array(0))).toThrow(TruncatedFileError);
  });

  it('throws TruncatedFileError for an 83-byte file (one byte short of the 84-byte binary preamble)', () => {
    const bytes = new Uint8Array(83).fill(0x11); // arbitrary non-"solid" content
    let thrown: unknown;
    try {
      parseStl(bytes);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TruncatedFileError);
    expect((thrown as TruncatedFileError).message).toMatch(/83 byte/);
  });

  it('throws TruncatedFileError for a binary STL truncated mid-triangle-data', () => {
    const full = writeStlBinary(twoTriangleSoup());
    const truncated = full.subarray(0, full.byteLength - 10); // cuts off inside the last record
    expect(() => parseStl(truncated)).toThrow(TruncatedFileError);
  });

  it('throws MalformedSyntaxError for a bad ASCII token, surfaced through parseStl', () => {
    const text = [
      'solid bad',
      'facet normal 0 0 1',
      'outer loop',
      'vertex not-a-number 0 0',
      'vertex 1 0 0',
      'vertex 0 1 0',
      'endloop',
      'endfacet',
      'endsolid bad',
    ].join('\n');
    const bytes = new TextEncoder().encode(text);
    expect(() => parseStl(bytes)).toThrow(MalformedSyntaxError);
  });
});

describe('parseStl: determinism', () => {
  it('produces byte-identical Float64 buffers when parsing the same bytes twice', () => {
    const bytes = writeStlBinary(twoTriangleSoup());
    const first = parseStl(bytes).soup;
    const second = parseStl(bytes).soup;

    expect(hashBytes(first.positions)).toBe(hashBytes(second.positions));
    expect(hashBytes(first.normals!)).toBe(hashBytes(second.normals!));
    expect(first.triangleCount).toBe(second.triangleCount);
  });
});
