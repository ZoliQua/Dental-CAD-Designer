import { describe, expect, it } from 'vitest';
import { MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import { looksGrammaticalAsciiStlPrefix, parseAsciiStl } from './ascii.ts';

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
    // ONE_TRIANGLE_ASCII is 9 content lines + a trailing blank line (10
    // lines total, see its definition above); the extra leading `\n` here
    // inserts one more blank line before "solid second" lands on line 11.
    const expectedLine = text.split(/\r\n|\r|\n/).findIndex((line) => line.trim() === 'solid second') + 1;
    expect(expectedLine).toBe(11);

    let thrown: unknown;
    try {
      parseAsciiStl(text);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedSyntaxError);
    expect((thrown as MalformedSyntaxError).message).toMatch(/second "solid" block/);
    expect((thrown as MalformedSyntaxError).line).toBe(expectedLine);
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

describe(
  'parseAsciiStl: rejects non-finite (Infinity/-Infinity) numeric tokens (found by this task\'s fuzz ' +
    'suite — Number("Infinity")/Number("-Infinity") both parse successfully in JS and are not NaN, so ' +
    'the pre-fix check silently stored ±Infinity coordinates)',
  () => {
    it('throws MalformedSyntaxError for an "Infinity" vertex coordinate', () => {
      const text = [
        'solid t',
        'facet normal 0 0 1',
        'outer loop',
        'vertex Infinity 0 0',
        'vertex 1 0 0',
        'vertex 0 1 0',
        'endloop',
        'endfacet',
        'endsolid t',
      ].join('\n');
      expect(() => parseAsciiStl(text)).toThrow(MalformedSyntaxError);
    });

    it('throws MalformedSyntaxError for a "-Infinity" facet normal component', () => {
      const text = [
        'solid t',
        'facet normal 0 0 -Infinity',
        'outer loop',
        'vertex 0 0 0',
        'vertex 1 0 0',
        'vertex 0 1 0',
        'endloop',
        'endfacet',
        'endsolid t',
      ].join('\n');
      expect(() => parseAsciiStl(text)).toThrow(MalformedSyntaxError);
    });
  },
);

describe('looksGrammaticalAsciiStlPrefix: bounded fail-fast check (carry-over review item A)', () => {
  it('returns true for a genuine (small) ASCII STL', () => {
    expect(looksGrammaticalAsciiStlPrefix(new TextEncoder().encode(ONE_TRIANGLE_ASCII))).toBe(true);
  });

  it(
    'returns true (inconclusive) when the prefix bound cuts a genuinely-ASCII file mid-token, instead ' +
      'of false-rejecting it — the possibly-cut-off trailing line is dropped before validating',
    () => {
      const bytes = new TextEncoder().encode(ONE_TRIANGLE_ASCII);
      // Cut mid-way through a "vertex" line, well before the file's real
      // end — `maxPrefixBytes` forces the bound rather than relying on
      // ASCII_GRAMMAR_PREFIX_CHECK_BYTES's much larger default.
      const cutPoint = ONE_TRIANGLE_ASCII.indexOf('vertex 1 0 0') + 6; // "vertex" without its args
      expect(looksGrammaticalAsciiStlPrefix(bytes, cutPoint)).toBe(true);
    },
  );

  it(
    'returns false for content whose first line starts with "solid" but whose SECOND line is binary ' +
      'garbage that cannot match any STL grammar production — the large-binary-file fast-fail case this ' +
      'exists for (see parse.ts); a real binary file\'s triangle-record bytes reliably produce an early ' +
      'non-grammatical "line" like this once split on incidental 0x0A/0x0D bytes',
    () => {
      const header = new TextEncoder().encode('solid this-is-actually-binary\n');
      // Deterministic non-whitespace control bytes — `String.trim()` only
      // strips whitespace/line-terminator code points, so this decodes to a
      // non-blank "line" that matches none of the ASCII STL grammar's
      // keyword regexes (nothing starts with "facet"/"endsolid").
      const garbageLine = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const bytes = new Uint8Array(header.byteLength + garbageLine.byteLength);
      bytes.set(header, 0);
      bytes.set(garbageLine, header.byteLength);

      expect(looksGrammaticalAsciiStlPrefix(bytes)).toBe(false);
    },
  );

  it('returns false for content that plainly does not start with "solid" grammar at all', () => {
    const bytes = new TextEncoder().encode('not-a-keyword\nnot-a-keyword-either\n');
    expect(looksGrammaticalAsciiStlPrefix(bytes)).toBe(false);
  });
});
