// packages/kernel-workers/src/base64.test.ts — the pure, environment-
// agnostic base64 encoder behind `RestorationExportRequest.bytesBase64`
// (Phase 7 Task 3; moved from the client engine into the worker package in
// the review fix round — see base64.ts's module doc). Verified byte-for-
// byte against Node's reference implementation (RFC 4648 standard alphabet,
// padded) across lengths covering every padding case and a deterministic
// pseudo-random sweep.
import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from './base64';

describe('bytesToBase64', () => {
  it('matches the RFC 4648 reference (Buffer) for all padding classes', () => {
    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.from([0]),
      Uint8Array.from([255]),
      Uint8Array.from([1, 2]),
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([1, 2, 3, 4]),
      new TextEncoder().encode('DQ-Dental-CAD binary STL; units=mm'),
    ]) {
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('matches the reference on a deterministic pseudo-random sweep (every length 0..257)', () => {
    let seed = 0x2f6e2b1;
    const next = () => {
      // xorshift32 — deterministic, no Math.random (CLAUDE.md determinism).
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) & 0xff;
    };
    for (let length = 0; length <= 257; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = next();
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('respects a subarray view (byteOffset ≠ 0) rather than encoding the whole backing buffer', () => {
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    expect(bytesToBase64(view)).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });
});
