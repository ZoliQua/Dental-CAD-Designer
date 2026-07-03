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

  it(
    'detects a binary STL with trailing junk EVEN WHEN its 80-byte header starts with "solid" ' +
      '(regression: previously misrouted into the ASCII parser and threw MalformedSyntaxError, since ' +
      'the trailing-junk-tolerant binary branch was wrongly gated on the leading-bytes-only ASCII sniff)',
    () => {
      const clean = writeStlBinary(twoTriangleSoup(), {
        headerText: 'solid this-is-actually-binary',
      });
      const withJunk = new Uint8Array(clean.byteLength + 5);
      withJunk.set(clean, 0);
      withJunk.set([1, 2, 3, 4, 5], clean.byteLength);

      const { soup, diagnostics } = parseStl(withJunk);
      expect(diagnostics.format).toBe('stl-binary');
      expect(soup.triangleCount).toBe(2);
      expect(Array.from(soup.positions)).toEqual(Array.from(twoTriangleSoup().positions));
      expect(diagnostics.warnings.some((w) => w.includes('trailing'))).toBe(true);
    },
  );

  it(
    'still detects a genuine ASCII STL as ASCII when its bytes 80..83 coincidentally decode to a ' +
      'small binary triangle count that also satisfies the trailing-junk length check (the ASCII grammar ' +
      'parser is the tie-breaker, not the raw length check, once both interpretations are length-consistent)',
    () => {
      // "solid " (6 bytes) + 74 'x' bytes = 80 bytes, then 4 NUL bytes land
      // exactly at byte offset 80..83 (read as a uint32 LE binary triangle
      // count, that's 0 -> expectedLength 84, which is < this file's real
      // length, landing in the same ambiguous "trailing junk" zone as the
      // regression case above).
      const nameLine = `solid ${'x'.repeat(74)}\0\0\0\0`;
      const text = [
        nameLine,
        'facet normal 0 0 1',
        'outer loop',
        'vertex 0 0 0',
        'vertex 1 0 0',
        'vertex 0 1 0',
        'endloop',
        'endfacet',
        'endsolid',
      ].join('\n');
      const bytes = new TextEncoder().encode(text);

      // Sanity-check the byte-80..83 coincidence this test relies on.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const declaredTriangleCount = view.getUint32(80, true);
      expect(declaredTriangleCount).toBe(0);
      expect(84 + declaredTriangleCount * 50).toBeLessThan(bytes.byteLength);

      const { soup, diagnostics } = parseStl(bytes);
      expect(diagnostics.format).toBe('stl-ascii');
      expect(soup.triangleCount).toBe(1);
      expect(Array.from(soup.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    },
  );

  it('parses an exact 84-byte binary file with declared triangle count 0 as binary, 0 triangles', () => {
    const bytes = new Uint8Array(84); // all-zero header + zero count at offset 80
    const { soup, diagnostics } = parseStl(bytes);
    expect(diagnostics.format).toBe('stl-binary');
    expect(diagnostics.warnings).toHaveLength(0);
    expect(soup.triangleCount).toBe(0);
    expect(soup.positions).toHaveLength(0);
  });

  it('parses identically from a Uint8Array view with a non-zero byteOffset into a shared buffer', () => {
    const inner = writeStlBinary(twoTriangleSoup());
    const padding = 7; // arbitrary non-zero, non-word-aligned offset
    const buffer = new ArrayBuffer(padding + inner.byteLength);
    const offsetView = new Uint8Array(buffer, padding, inner.byteLength);
    offsetView.set(inner);

    const zeroOffsetResult = parseStl(inner);
    const offsetResult = parseStl(offsetView);

    expect(offsetResult.diagnostics).toEqual(zeroOffsetResult.diagnostics);
    expect(offsetResult.soup.triangleCount).toBe(zeroOffsetResult.soup.triangleCount);
    expect(Array.from(offsetResult.soup.positions)).toEqual(Array.from(zeroOffsetResult.soup.positions));
    expect(Array.from(offsetResult.soup.normals!)).toEqual(Array.from(zeroOffsetResult.soup.normals!));
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
