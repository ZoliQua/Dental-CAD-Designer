import { describe, expect, it } from 'vitest';
import { MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import { parsePlyHeader } from './header.ts';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const MINIMAL_HEADER =
  'ply\n' +
  'format ascii 1.0\n' +
  'element vertex 1\n' +
  'property float x\n' +
  'property float y\n' +
  'property float z\n' +
  'end_header\n';

describe('parsePlyHeader: magic', () => {
  it('throws MalformedSyntaxError when the first line is not exactly "ply"', () => {
    const bytes = encode('nope\nformat ascii 1.0\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for a file starting "plywood..." (prefix, not exact magic line)', () => {
    const bytes = encode('plywood\nformat ascii 1.0\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws TruncatedFileError for a 0-byte file', () => {
    expect(() => parsePlyHeader(new Uint8Array(0))).toThrow(TruncatedFileError);
  });

  it('accepts "ply" followed by a CRLF line ending', () => {
    const bytes = encode(MINIMAL_HEADER.replace(/\n/g, '\r\n'));
    const { header } = parsePlyHeader(bytes);
    expect(header.format).toBe('ascii');
  });
});

describe('parsePlyHeader: end_header / truncation', () => {
  it('throws TruncatedFileError when there is no "end_header" line', () => {
    const bytes = encode('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n');
    expect(() => parsePlyHeader(bytes)).toThrow(TruncatedFileError);
  });

  it('reports the correct bodyOffset immediately after end_header\'s newline', () => {
    const bytes = encode(MINIMAL_HEADER + 'BODY-STARTS-HERE');
    const { bodyOffset } = parsePlyHeader(bytes);
    const rest = new TextDecoder().decode(bytes.subarray(bodyOffset));
    expect(rest).toBe('BODY-STARTS-HERE');
  });
});

describe('parsePlyHeader: format line', () => {
  it('parses all three format keywords', () => {
    for (const fmt of ['ascii', 'binary_little_endian', 'binary_big_endian'] as const) {
      const bytes = encode(`ply\nformat ${fmt} 1.0\nend_header\n`);
      const { header } = parsePlyHeader(bytes);
      expect(header.format).toBe(fmt);
      expect(header.version).toBe('1.0');
    }
  });

  it('throws MalformedSyntaxError for an unrecognized format keyword', () => {
    const bytes = encode('ply\nformat weird_format 1.0\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for an unsupported version', () => {
    const bytes = encode('ply\nformat ascii 2.0\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for a duplicate format line', () => {
    const bytes = encode('ply\nformat ascii 1.0\nformat ascii 1.0\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError when the header has no format line at all', () => {
    const bytes = encode('ply\nelement vertex 0\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });
});

describe('parsePlyHeader: comment / obj_info', () => {
  it('collects comment and obj_info lines, in header order, tagged by keyword', () => {
    const bytes = encode(
      'ply\n' +
        'format ascii 1.0\n' +
        'comment anonymized\n' +
        'obj_info some info here\n' +
        'comment second comment\n' +
        'element vertex 0\n' +
        'end_header\n',
    );
    const { header } = parsePlyHeader(bytes);
    expect(header.comments).toEqual([
      { keyword: 'comment', text: 'anonymized' },
      { keyword: 'obj_info', text: 'some info here' },
      { keyword: 'comment', text: 'second comment' },
    ]);
  });
});

describe('parsePlyHeader: element / property grammar', () => {
  it('accepts every one of the eight scalar types under both spellings', () => {
    const pairs: Array<[string, string]> = [
      ['int8', 'char'],
      ['uint8', 'uchar'],
      ['int16', 'short'],
      ['uint16', 'ushort'],
      ['int32', 'int'],
      ['uint32', 'uint'],
      ['float32', 'float'],
      ['float64', 'double'],
    ];
    for (const [canonical, alias] of pairs) {
      const bytes = encode(
        `ply\nformat ascii 1.0\nelement e 1\nproperty ${canonical} a\nproperty ${alias} b\nend_header\n`,
      );
      const { header } = parsePlyHeader(bytes);
      const props = header.elements[0]!.properties;
      expect(props[0]).toEqual({ kind: 'scalar', name: 'a', scalarType: canonical });
      expect(props[1]).toEqual({ kind: 'scalar', name: 'b', scalarType: canonical });
    }
  });

  it('parses a "property list" line into countType/itemType/name', () => {
    const bytes = encode(
      'ply\nformat ascii 1.0\nelement face 2\nproperty list uchar int vertex_indices\nend_header\n',
    );
    const { header } = parsePlyHeader(bytes);
    expect(header.elements[0]!.properties[0]).toEqual({
      kind: 'list',
      name: 'vertex_indices',
      countType: 'uint8',
      itemType: 'int32',
    });
  });

  it('attaches properties to the most recently declared element (reordered elements)', () => {
    const bytes = encode(
      'ply\n' +
        'format ascii 1.0\n' +
        'element vertex 1\n' +
        'property float x\n' +
        'element face 1\n' +
        'property list uchar int vertex_indices\n' +
        'end_header\n',
    );
    const { header } = parsePlyHeader(bytes);
    expect(header.elements).toHaveLength(2);
    expect(header.elements[0]!.name).toBe('vertex');
    expect(header.elements[0]!.properties).toHaveLength(1);
    expect(header.elements[1]!.name).toBe('face');
    expect(header.elements[1]!.properties).toHaveLength(1);
  });

  it('throws MalformedSyntaxError for a property line before any element line', () => {
    const bytes = encode('ply\nformat ascii 1.0\nproperty float x\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for an unknown scalar type', () => {
    const bytes = encode('ply\nformat ascii 1.0\nelement e 1\nproperty bogus32 a\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for an unknown list item type', () => {
    const bytes = encode(
      'ply\nformat ascii 1.0\nelement e 1\nproperty list uchar bogus32 a\nend_header\n',
    );
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for an unrecognized header keyword', () => {
    const bytes = encode('ply\nformat ascii 1.0\nfrobnicate true\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('tolerates blank lines interleaved in the header', () => {
    const bytes = encode(
      'ply\n\nformat ascii 1.0\n\n\nelement vertex 0\n\nend_header\n',
    );
    const { header } = parsePlyHeader(bytes);
    expect(header.elements).toHaveLength(1);
  });
});

describe('parsePlyHeader: element count overflow', () => {
  it('throws MalformedSyntaxError for a non-numeric element count', () => {
    const bytes = encode('ply\nformat ascii 1.0\nelement vertex notanumber\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for a negative element count', () => {
    const bytes = encode('ply\nformat ascii 1.0\nelement vertex -1\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('throws MalformedSyntaxError for an element count that overflows the safe integer range', () => {
    const bytes = encode('ply\nformat ascii 1.0\nelement vertex 99999999999999999999\nend_header\n');
    expect(() => parsePlyHeader(bytes)).toThrow(MalformedSyntaxError);
  });

  it('accepts element count 0', () => {
    const bytes = encode('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n');
    const { header } = parsePlyHeader(bytes);
    expect(header.elements[0]!.count).toBe(0);
  });
});
