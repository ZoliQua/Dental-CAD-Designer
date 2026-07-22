// packages/clinical-profiles/src/sha256.ts
//
// A synchronous, pure-TS, dependency-free SHA-256 implementation (FIPS
// 180-4) — used ONLY as a corruption-detection checksum over material
// profile JSON (materialProfile.ts's `computeProfileChecksum`), never as a
// security primitive (no secret material, no signatures). Deliberately NOT
// `node:crypto` (Node-only, unavailable when this package is bundled into
// the browser client) and NOT `crypto.subtle.digest` (Web Crypto's only
// digest API is ASYNC everywhere, including modern Node — this package
// needs to validate a profile SYNCHRONOUSLY at module-import time, i.e. "at
// startup" per this task's brief, in BOTH the Node test/server runtime and
// the bundled browser client, with byte-identical output on both — a pure,
// platform-agnostic implementation is the only way to get all three
// properties (sync + Node + browser) at once). This mirrors the kernel's own
// "pure TS over native/WASM where determinism and portability matter more
// than raw speed" bias (CLAUDE.md invariant 2).
//
// Verified against Node's `node:crypto` SHA-256 and the FIPS 180-4 published
// test vectors in sha256.test.ts (including the standard two-block "abcdbcd…"
// vector, and inputs straddling the 55/56/64-byte padding-boundary cases a
// hand-rolled padder is most likely to get wrong).

/** 64 round constants — first 32 bits of the fractional parts of the cube
 * roots of the first 64 primes (FIPS 180-4 §4.2.2). */
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Initial hash values — first 32 bits of the fractional parts of the square
 * roots of the first 8 primes (FIPS 180-4 §5.3.3). */
const H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rightRotate(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** FIPS 180-4 §5.1.1 padding: append a single `1` bit, then zero bits until
 * the length ≡ 448 (mod 512) bits (56 mod 64 bytes), then the original
 * message length as a 64-bit big-endian bit count. */
function padMessage(messageBytes: Uint8Array): Uint8Array {
  const bitLength = BigInt(messageBytes.length) * 8n;
  const withOneBit = new Uint8Array(messageBytes.length + 1);
  withOneBit.set(messageBytes);
  withOneBit[messageBytes.length] = 0x80;

  const remainder = withOneBit.length % 64;
  const zeroPadLength = remainder <= 56 ? 56 - remainder : 56 + (64 - remainder);
  const padded = new Uint8Array(withOneBit.length + zeroPadLength + 8);
  padded.set(withOneBit);
  new DataView(padded.buffer).setBigUint64(padded.length - 8, bitLength, false);
  return padded;
}

/** Raw 32-byte SHA-256 digest of `messageBytes`. */
export function sha256Bytes(messageBytes: Uint8Array): Uint8Array {
  const padded = padMessage(messageBytes);
  const hash = H0.slice();
  const w = new Uint32Array(64);

  for (let chunkStart = 0; chunkStart < padded.length; chunkStart += 64) {
    const chunkView = new DataView(padded.buffer, padded.byteOffset + chunkStart, 64);
    for (let i = 0; i < 16; i++) {
      w[i] = chunkView.getUint32(i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const s1 = rightRotate(e!, 6) ^ rightRotate(e!, 11) ^ rightRotate(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rightRotate(a!, 2) ^ rightRotate(a!, 13) ^ rightRotate(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) {
    digestView.setUint32(i * 4, hash[i]!, false);
  }
  return digest;
}

/** Lowercase hex SHA-256 digest of the UTF-8 encoding of `text`. */
export function sha256HexOfString(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return Array.from(sha256Bytes(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
