// packages/io/src/ply/parser-hardening.test.ts
//
// Security regressions for the PLY parser, from the io-workers adversarial
// review. Each test is FALSIFIABLE against the pre-fix parser:
//
//   - The DoS tests use a low per-test timeout: the pre-fix parser SPINS
//     (`for (r < count) skipRow()` with a zero-byte row) uncancellably, so on
//     the old code these time out and fail; the fixed parser rejects
//     synchronously/immediately with a typed IoParseError, well under the
//     bound.
//   - The negative-list-count test asserts a typed MalformedSyntaxError: the
//     pre-fix parser threw an UNTYPED `RangeError` ("Offset is outside the
//     bounds of the DataView") from a backward cursor rewind.

import { describe, expect, it } from 'vitest';
import { IoParseError, MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import { iterateInFixedChunks } from '../stream/chunk-iterables.ts';
import { parsePly } from './parse.ts';
import { parsePlyStream } from './stream.ts';
import { MAX_PLAUSIBLE_ELEMENT_COUNT } from './element-count-guard.ts';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * The reviewer's EXACT hostile file: a skipped element (`junk`) with ZERO
 * property lines and an implausibly huge declared count, placed BEFORE the
 * real vertex element. `skipElement`/the stream skip-branch would loop
 * `count` times over a row that consumes no bytes → a pure CPU spin that
 * never runs out of bytes to trip `requireBytes`, and (on the streaming
 * worker path) is uncancellable once the tiny source drains.
 */
function hostileSpinPly(junkCount: number | string): Uint8Array {
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    `element junk ${junkCount}\n` + // <- skipped, 0 properties, huge count
    'element vertex 1\n' +
    'property float64 x\n' +
    'property float64 y\n' +
    'property float64 z\n' +
    'end_header\n';
  const headerBytes = encode(header);
  const body = new Uint8Array(24); // one real float64 x/y/z vertex row
  const out = new Uint8Array(headerBytes.byteLength + body.byteLength);
  out.set(headerBytes, 0);
  out.set(body, headerBytes.byteLength);
  return out;
}

async function collectStream(bytes: Uint8Array, chunkSize: number): Promise<unknown> {
  // Drive the ACTUAL production streaming entry point the worker uses.
  return parsePlyStream(iterateInFixedChunks(bytes, chunkSize));
}

describe('PLY parser DoS: skipped element with huge/zero-byte row count (BLOCKER regression)', () => {
  it("is the reviewer's exact 169-byte file", () => {
    // Fidelity check on the repro so a future edit can't silently defang it.
    expect(hostileSpinPly(5_000_000_000).byteLength).toBe(169);
  });

  it('parsePly (sync) rejects the 169-byte hostile file FAST with a typed IoParseError (no hang)', () => {
    let thrown: unknown;
    try {
      parsePly(hostileSpinPly(5_000_000_000));
    } catch (error) {
      thrown = error;
    }
    // Huge count trips the plausibility ceiling → TruncatedFileError.
    expect(thrown).toBeInstanceOf(TruncatedFileError);
    expect(thrown).toBeInstanceOf(IoParseError);
  }, 2000);

  it('parsePly (sync) also rejects with the count at Number.MAX_SAFE_INTEGER', () => {
    let thrown: unknown;
    try {
      parsePly(hostileSpinPly(String(Number.MAX_SAFE_INTEGER)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IoParseError);
  }, 2000);

  it.each([1, 7, 4096])(
    'parsePlyStream (production worker path) rejects the hostile file FAST at chunk size %i (no hang)',
    async (chunkSize) => {
      await expect(collectStream(hostileSpinPly(5_000_000_000), chunkSize)).rejects.toBeInstanceOf(
        IoParseError,
      );
    },
    2000,
  );

  it('rejects a ZERO-PROPERTY element with a positive count UNDER the plausibility ceiling ' +
    '(the zero-byte-row guard is independent of the count ceiling)', () => {
    // count well under MAX_PLAUSIBLE_ELEMENT_COUNT, so the ceiling guard does
    // NOT fire — only the zero-byte-row guard can reject this.
    const belowCeiling = 1_000_000;
    expect(belowCeiling).toBeLessThan(MAX_PLAUSIBLE_ELEMENT_COUNT);
    let thrown: unknown;
    try {
      parsePly(hostileSpinPly(belowCeiling));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedSyntaxError);
    expect(thrown).toBeInstanceOf(IoParseError);
  }, 2000);

  it('rejects the zero-property/under-ceiling element on the streaming path too', async () => {
    await expect(collectStream(hostileSpinPly(1_000_000), 7)).rejects.toBeInstanceOf(MalformedSyntaxError);
  }, 2000);
});

describe('binary PLY negative list-count → typed rejection, not an untyped RangeError (MEDIUM regression)', () => {
  /**
   * A vertex element whose first property is a SKIPPED `property list int32
   * float64 pad` before x/y/z. The list count is written as a negative int32
   * (-1000000) → pre-fix `need = count * itemSize` is negative, slips past
   * `requireBytes` (upper-bound-only), rewinds `cursor.pos` backward, and a
   * later read lands at a negative DataView offset → untyped RangeError.
   */
  function negativeListCountPly(): Uint8Array {
    const header =
      'ply\n' +
      'format binary_little_endian 1.0\n' +
      'element vertex 1\n' +
      'property list int32 float64 pad\n' + // skipped list, signed count type
      'property float64 x\n' +
      'property float64 y\n' +
      'property float64 z\n' +
      'end_header\n';
    const headerBytes = encode(header);
    // body: int32 list count = -1000000, then (nominal) x/y/z float64s.
    const body = new ArrayBuffer(4 + 24);
    const view = new DataView(body);
    view.setInt32(0, -1_000_000, true);
    view.setFloat64(4, 1, true);
    view.setFloat64(12, 2, true);
    view.setFloat64(20, 3, true);
    const bodyBytes = new Uint8Array(body);
    const out = new Uint8Array(headerBytes.byteLength + bodyBytes.byteLength);
    out.set(headerBytes, 0);
    out.set(bodyBytes, headerBytes.byteLength);
    return out;
  }

  it('parsePly rejects a negative list count with MalformedSyntaxError (an IoParseError), not RangeError', () => {
    let thrown: unknown;
    try {
      parsePly(negativeListCountPly());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedSyntaxError);
    expect(thrown).toBeInstanceOf(IoParseError);
    expect(thrown).not.toBeInstanceOf(RangeError);
  });

  it('parsePlyStream rejects the same file with the same typed error', async () => {
    await expect(collectStream(negativeListCountPly(), 7)).rejects.toBeInstanceOf(MalformedSyntaxError);
  });
});
