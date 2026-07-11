import { describe, expect, it } from 'vitest';
import { TruncatedFileError } from '../types.ts';
import { parsePly } from './parse.ts';
import { MAX_PLAUSIBLE_ELEMENT_COUNT, assertPlausibleElementCount } from './element-count-guard.ts';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('assertPlausibleElementCount', () => {
  it('does not throw for a count within the ceiling', () => {
    expect(() => assertPlausibleElementCount('vertex', 1_000_000)).not.toThrow();
    expect(() => assertPlausibleElementCount('vertex', MAX_PLAUSIBLE_ELEMENT_COUNT)).not.toThrow();
  });

  it('does not throw for a count of 0', () => {
    expect(() => assertPlausibleElementCount('vertex', 0)).not.toThrow();
  });

  it('throws TruncatedFileError for a count above the ceiling', () => {
    expect(() => assertPlausibleElementCount('vertex', MAX_PLAUSIBLE_ELEMENT_COUNT + 1)).toThrow(
      TruncatedFileError,
    );
  });

  it('accepts a caller-supplied ceiling override', () => {
    expect(() => assertPlausibleElementCount('vertex', 101, 100)).toThrow(TruncatedFileError);
    expect(() => assertPlausibleElementCount('vertex', 100, 100)).not.toThrow();
  });
});

describe(
  'parsePly: corrupted/adversarial header element count is rejected before any large allocation ' +
    '(regression: a header-declared row count was previously trusted unconditionally, so a single ' +
    'corrupted digit in "element vertex <N>" could request a multi-gigabyte allocation on a tiny file)',
  () => {
    it('throws TruncatedFileError (not a RangeError, hang, or OOM attempt) for a wildly-implausible ' +
      'declared vertex count on a tiny ASCII file', () => {
      const text =
        'ply\nformat ascii 1.0\nelement vertex 99999999999\nproperty float x\nproperty float y\n' +
        'property float z\nend_header\n0 0 0\n';
      let thrown: unknown;
      try {
        parsePly(encode(text));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TruncatedFileError);
    });

    it('throws TruncatedFileError for a wildly-implausible declared vertex count on a tiny binary file', () => {
      const header =
        'ply\nformat binary_little_endian 1.0\nelement vertex 99999999999\nproperty float x\n' +
        'property float y\nproperty float z\nend_header\n';
      const bytes = new Uint8Array(encode(header).byteLength + 12); // room for exactly one real row
      bytes.set(encode(header), 0);
      let thrown: unknown;
      try {
        parsePly(bytes);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TruncatedFileError);
    });

    it(
      'still reports the ORIGINAL, more precise per-row truncation error (not this guard) for an ' +
        'ordinary, plausible file merely cut short by a few bytes',
      () => {
        // 2 legitimately-declared vertices, file cut off 5 bytes into the
        // second row — well within MAX_PLAUSIBLE_ELEMENT_COUNT, so this
        // must fall through to the normal per-row TruncatedFileError with
        // an exact byteOffset, not this guard's coarser message.
        const header =
          'ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\n' +
          'property float z\nend_header\n';
        const headerBytes = encode(header);
        const bytes = new Uint8Array(headerBytes.byteLength + 12 + 5);
        bytes.set(headerBytes, 0);
        let thrown: unknown;
        try {
          parsePly(bytes);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(TruncatedFileError);
        expect((thrown as TruncatedFileError).byteOffset).toBe(bytes.byteLength - 1);
      },
    );
  },
);
