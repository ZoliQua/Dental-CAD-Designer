import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256HexOfString } from './sha256.ts';

// FIPS 180-4 / NIST published SHA-256 test vectors (Appendix B) — the
// standard correctness check for a from-scratch implementation.
describe('sha256HexOfString — FIPS 180-4 published vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256HexOfString('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes "abc" (one-block message)', () => {
    expect(sha256HexOfString('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the standard two-block message', () => {
    expect(sha256HexOfString('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
});

// Cross-check against Node's own `node:crypto` (a fully independent, trusted
// implementation) for a range of inputs specifically chosen to straddle this
// hand-rolled implementation's padding-boundary arithmetic (55/56/57/63/64/
// 65 UTF-8 bytes — the lengths most likely to expose an off-by-one in
// `padMessage`), plus a couple of longer, multi-block, non-ASCII inputs
// (checksum inputs are canonical JSON, which is always ASCII-safe via
// `JSON.stringify`'s `\uXXXX` string escaping — but the hash function itself
// makes no such assumption, so this still exercises real UTF-8 multi-byte
// encoding).
describe('sha256HexOfString — cross-checked against node:crypto', () => {
  const inputs = [
    'x'.repeat(0),
    'x'.repeat(54),
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(57),
    'x'.repeat(63),
    'x'.repeat(64),
    'x'.repeat(65),
    'x'.repeat(1000),
    JSON.stringify({ z: 1, a: [1, 2, 3], m: { nested: true, s: 'héllo wörld — µm 20°' } }),
  ];

  it.each(inputs.map((input) => [input.length, input] as const))(
    'matches node:crypto for a %i-char input',
    (_length, input) => {
      const expected = createHash('sha256').update(input, 'utf8').digest('hex');
      expect(sha256HexOfString(input)).toBe(expected);
    },
  );
});
