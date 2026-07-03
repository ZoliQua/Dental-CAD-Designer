import { describe, expect, it } from 'vitest';
import type { RawTriangleSoup } from '../types.ts';
import { DEFAULT_STL_HEADER_TEXT, binaryStlByteLength, writeStlBinary } from './binary.ts';
import { parseStl } from './parse.ts';

/** A single right triangle in the XY plane: v0=(0,0,0), v1=(1,0,0),
 * v2=(0,1,0) — its geometric normal (right-hand rule, v0→v1→v2) is +Z. */
function rightTriangleSoup(
  storedNormal: readonly [number, number, number] = [0, 0, -1],
): RawTriangleSoup {
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float64Array(storedNormal),
    triangleCount: 1,
  };
}

describe('binaryStlByteLength', () => {
  it('is 84 bytes (header + count) for zero triangles', () => {
    expect(binaryStlByteLength(0)).toBe(84);
  });

  it('adds 50 bytes per triangle', () => {
    expect(binaryStlByteLength(3)).toBe(84 + 3 * 50);
  });
});

describe('writeStlBinary: header', () => {
  it('writes the default header text zero-padded to 80 bytes', () => {
    const bytes = writeStlBinary(rightTriangleSoup());
    const headerBytes = bytes.subarray(0, 80);
    const decoded = new TextDecoder('ascii').decode(headerBytes).replace(/\0+$/, '');
    expect(decoded).toBe(DEFAULT_STL_HEADER_TEXT);
    // Rest of the 80-byte header is zero-padded.
    for (let i = DEFAULT_STL_HEADER_TEXT.length; i < 80; i++) {
      expect(headerBytes[i]).toBe(0);
    }
  });

  it('sanitizes non-printable-ASCII characters to "?" and truncates past 80 bytes', () => {
    const longHeader = `café ${'x'.repeat(90)}`; // é is non-ASCII; body overruns 80 bytes
    const bytes = writeStlBinary(rightTriangleSoup(), { headerText: longHeader });
    const headerText = new TextDecoder('ascii').decode(bytes.subarray(0, 80));
    expect(headerText).toHaveLength(80);
    expect(headerText.startsWith('caf?')).toBe(true);
    expect(headerText).not.toContain('é');
  });

  it('writes the correct triangle count as a uint32 LE at byte offset 80', () => {
    const soup = rightTriangleSoup();
    const bytes = writeStlBinary(soup);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(80, true)).toBe(soup.triangleCount);
  });
});

describe('writeStlBinary: normals', () => {
  it('defaults to writing the recomputed geometric (right-hand-rule) normal, not the stored one', () => {
    const soup = rightTriangleSoup([0, 0, -1]); // deliberately "wrong" stored normal
    const bytes = writeStlBinary(soup);
    const { soup: parsed } = parseStl(bytes);
    expect(parsed.normals).not.toBeNull();
    const [nx, ny, nz] = [parsed.normals![0], parsed.normals![1], parsed.normals![2]];
    expect(nx).toBeCloseTo(0, 6);
    expect(ny).toBeCloseTo(0, 6);
    expect(nz).toBeCloseTo(1, 6); // geometric normal of v0->v1->v2 is +Z
  });

  it('writes the stored normal verbatim when useSourceNormals is true', () => {
    const soup = rightTriangleSoup([0, 0, -1]);
    const bytes = writeStlBinary(soup, { useSourceNormals: true });
    const { soup: parsed } = parseStl(bytes);
    expect(parsed.normals![0]).toBeCloseTo(0, 6);
    expect(parsed.normals![1]).toBeCloseTo(0, 6);
    expect(parsed.normals![2]).toBeCloseTo(-1, 6);
  });

  it('falls back to the geometric normal when useSourceNormals is true but soup.normals is null', () => {
    const soup: RawTriangleSoup = { ...rightTriangleSoup(), normals: null };
    const bytes = writeStlBinary(soup, { useSourceNormals: true });
    const { soup: parsed } = parseStl(bytes);
    expect(parsed.normals![2]).toBeCloseTo(1, 6);
  });

  it('writes (0,0,0) for a degenerate (zero-area) triangle instead of producing NaN', () => {
    const soup: RawTriangleSoup = {
      positions: new Float64Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      normals: null,
      triangleCount: 1,
    };
    const bytes = writeStlBinary(soup);
    const { soup: parsed } = parseStl(bytes);
    expect(Array.from(parsed.normals!)).toEqual([0, 0, 0]);
  });
});

describe('parseBinaryStl (via parseStl): attribute byte count', () => {
  it('warns (does not fail) when a triangle record has a non-zero attribute byte count', () => {
    const soup = rightTriangleSoup();
    const bytes = writeStlBinary(soup);
    // Patch the attribute-byte-count uint16 at the end of the (only) 50-byte
    // record — offset 84 + 48 — from 0 to a non-zero packed-color value, a
    // documented real-world extension some STL writers use (see binary.ts's
    // module doc).
    const view = new DataView(bytes.buffer);
    view.setUint16(84 + 48, 0xabcd, true);

    const { soup: parsed, diagnostics } = parseStl(bytes);
    expect(parsed.triangleCount).toBe(1);
    expect(diagnostics.warnings.some((w) => w.includes('attribute byte'))).toBe(true);
  });
});
