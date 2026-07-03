import { describe, expect, it } from 'vitest';
import { MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import { parseAsciiStl } from './ascii.ts';

const ONE_TRIANGLE_ASCII = [
  'solid test-solid',
  '  facet normal 0 0 1',
  '    outer loop',
  '      vertex 0 0 0',
  '      vertex 1 0 0',
  '      vertex 0 1 0',
  '    endloop',
  '  endfacet',
  'endsolid test-solid',
  '',
].join('\n');

describe('parseAsciiStl: happy path', () => {
  it('parses a single-facet ASCII STL into a 1-triangle soup', () => {
    const soup = parseAsciiStl(ONE_TRIANGLE_ASCII);
    expect(soup.triangleCount).toBe(1);
    expect(Array.from(soup.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(soup.normals).not.toBeNull();
    expect(Array.from(soup.normals!)).toEqual([0, 0, 1]);
  });

  it('is tolerant of keyword case, extra whitespace, CRLF line endings, and blank lines', () => {
    const text = [
      'SOLID Test',
      '',
      '  FACET   NORMAL   0   0   1  ',
      '\touter\tloop',
      '',
      '  Vertex 0 0 0',
      '  VERTEX 1 0 0',
      '  vertex 0 1 0',
      '  EndLoop',
      'EndFacet',
      'ENDSOLID Test',
    ].join('\r\n');
    const soup = parseAsciiStl(text);
    expect(soup.triangleCount).toBe(1);
    expect(Array.from(soup.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('parses scientific notation and signed numeric tokens', () => {
    const text = [
      'solid sci',
      'facet normal 1e0 -0.0 +0',
      'outer loop',
      'vertex 1.5e+02 -2.5E-3 0',
      'vertex 0 0 0',
      'vertex 1 1 1',
      'endloop',
      'endfacet',
      'endsolid sci',
    ].join('\n');
    const soup = parseAsciiStl(text);
    expect(soup.positions[0]).toBeCloseTo(150, 9);
    expect(soup.positions[1]).toBeCloseTo(-0.0025, 9);
  });

  it('parses multiple facets in triangle order', () => {
    const text = [
      'solid multi',
      'facet normal 0 0 1',
      'outer loop',
      'vertex 0 0 0',
      'vertex 1 0 0',
      'vertex 0 1 0',
      'endloop',
      'endfacet',
      'facet normal 0 0 -1',
      'outer loop',
      'vertex 0 0 1',
      'vertex 1 0 1',
      'vertex 0 1 1',
      'endloop',
      'endfacet',
      'endsolid multi',
    ].join('\n');
    const soup = parseAsciiStl(text);
    expect(soup.triangleCount).toBe(2);
    expect(Array.from(soup.positions.subarray(9, 18))).toEqual([0, 0, 1, 1, 0, 1, 0, 1, 1]);
    expect(Array.from(soup.normals!.subarray(3, 6))).toEqual([0, 0, -1]);
  });

  it('parses a zero-triangle solid (solid immediately followed by endsolid)', () => {
    const soup = parseAsciiStl('solid empty\nendsolid empty\n');
    expect(soup.triangleCount).toBe(0);
    expect(soup.positions).toHaveLength(0);
  });
});

describe('parseAsciiStl: error cases', () => {
  it('throws MalformedSyntaxError with a line number for a non-numeric vertex token', () => {
    const text = [
      'solid bad',
      'facet normal 0 0 1',
      'outer loop',
      'vertex abc 0 0',
      'vertex 1 0 0',
      'vertex 0 1 0',
      'endloop',
      'endfacet',
      'endsolid bad',
    ].join('\n');
    let thrown: unknown;
    try {
      parseAsciiStl(text);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedSyntaxError);
    expect((thrown as MalformedSyntaxError).line).toBe(4);
  });

  it('throws TruncatedFileError when "endsolid" is missing', () => {
    const text = ['solid unterminated', 'facet normal 0 0 1', 'outer loop', 'vertex 0 0 0'].join(
      '\n',
    );
    expect(() => parseAsciiStl(text)).toThrow(TruncatedFileError);
  });

  it('throws MalformedSyntaxError with a line number for a second "solid" block', () => {
    const text = `${ONE_TRIANGLE_ASCII}\nsolid second\nendsolid second\n`;
    let thrown: unknown;
    try {
      parseAsciiStl(text);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedSyntaxError);
    expect((thrown as MalformedSyntaxError).message).toMatch(/second "solid" block/);
  });

  it('throws MalformedSyntaxError when the file does not start with "solid"', () => {
    expect(() => parseAsciiStl('not a valid stl file\n')).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for an unexpected token where "facet" or "endsolid" is expected', () => {
    const text = ['solid bad', 'not-a-keyword', 'endsolid bad'].join('\n');
    expect(() => parseAsciiStl(text)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError when "outer loop" is missing', () => {
    const text = [
      'solid bad',
      'facet normal 0 0 1',
      'vertex 0 0 0',
      'vertex 1 0 0',
      'vertex 0 1 0',
      'endloop',
      'endfacet',
      'endsolid bad',
    ].join('\n');
    expect(() => parseAsciiStl(text)).toThrow(MalformedSyntaxError);
  });
});
