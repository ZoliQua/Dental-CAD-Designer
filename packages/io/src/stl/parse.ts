// packages/io/src/stl/parse.ts
//
// Format detection + dispatch for `parseStl`. The one subtle spec fact
// this file exists to encode (see binary.ts's module doc for the full
// citation): a binary STL's 80-byte header is arbitrary bytes and some
// exporters legally put the literal text "solid ..." there for
// cross-tool compatibility, so "starts with 'solid'" is NOT a valid
// binary-vs-ASCII discriminator. The only robust signal is byte-length
// consistency — does the file's total length match `84 + N * 50` for the
// triangle count `N` declared at offset 80? That check is tried FIRST,
// unconditionally, before any text-based ASCII sniffing.
//
// `classifyStlFormat` below is the actual detection algorithm, extracted
// as its own pure function (no I/O, no parsing) so both this module's
// synchronous `parseStl` AND stream.ts's chunked `parseStlStream` decide
// the format through the exact same logic — see stream.ts's module doc for
// why "no logic forks" between the in-memory and streaming entry points is
// a hard requirement, not just tidiness: it's what guarantees a streamed
// parse can never disagree with an in-memory parse of the same bytes.

import { IoParseError, TruncatedFileError } from '../types.ts';
import type { ParseDiagnostics, RawTriangleSoup } from '../types.ts';
import {
  STL_BINARY_HEADER_BYTES,
  STL_BINARY_PREAMBLE_BYTES,
  binaryStlByteLength,
  parseBinaryStl,
} from './binary.ts';
import { ASCII_GRAMMAR_PREFIX_CHECK_BYTES, looksGrammaticalAsciiStlPrefix, parseAsciiStl } from './ascii.ts';

/** How many leading bytes we sniff/decode when checking for an ASCII
 * "solid" start — generous enough to skip leading whitespace/BOM before
 * the keyword in any real file without having to decode the whole buffer
 * just to answer a yes/no question. */
const ASCII_SNIFF_PREFIX_BYTES = 512;
// TextDecoder strips a leading UTF-8 BOM by default (`ignoreBOM: false`),
// so this pattern only needs to account for ordinary leading whitespace.
const ASCII_SOLID_START_RE = /^\s*solid(\s|$)/i;

function looksLikeAsciiStl(bytes: Uint8Array): boolean {
  const prefix = bytes.subarray(0, Math.min(ASCII_SNIFF_PREFIX_BYTES, bytes.byteLength));
  const text = new TextDecoder('utf-8', { fatal: false }).decode(prefix);
  return ASCII_SOLID_START_RE.test(text);
}

/**
 * How many leading bytes `classifyStlFormat` needs to see in order to
 * classify ANY file correctly, regardless of the file's real total length
 * — callers (parse.ts's `parseStl`, stream.ts's `parseStlStream`) must
 * pass a `prefix` of at least `Math.min(totalBytes, this constant)` bytes.
 *
 * This is `looksGrammaticalAsciiStlPrefix`'s own bound
 * (`ASCII_GRAMMAR_PREFIX_CHECK_BYTES`) PLUS ONE — the "+1" is not
 * arbitrary: `looksGrammaticalAsciiStlPrefix` infers "was this prefix cut
 * off mid-file" purely from `maxPrefixBytes < prefix.byteLength` (see its
 * doc in ascii.ts), so a caller with a genuinely larger total file must
 * hand it a prefix STRICTLY LONGER than its `maxPrefixBytes` bound for
 * that inference to fire correctly — otherwise a prefix that happens to be
 * exactly `ASCII_GRAMMAR_PREFIX_CHECK_BYTES` long looks, from that
 * function's point of view, indistinguishable from "this IS the whole
 * file", and it would skip the possibly-cut-off-trailing-line protection
 * that exists specifically to avoid false-rejecting a real ASCII file cut
 * mid-token at a chunk boundary.
 */
export const STL_FORMAT_CLASSIFICATION_PREFIX_BYTES = ASCII_GRAMMAR_PREFIX_CHECK_BYTES + 1;

export type StlFormatClassification =
  /** Byte-length-consistent binary STL (exactly, or with `trailingJunkBytes`
   * tolerated junk after the last triangle record) — decode directly, no
   * ASCII attempt. */
  | { kind: 'binary'; triangleCount: number; trailingJunkBytes: number }
  /** Ambiguous: byte-length-consistent as binary-with-trailing-junk, but the
   * content ALSO looks ASCII-shaped and passed the bounded grammar
   * pre-check — the caller should attempt a full ASCII parse and, only if
   * THAT throws an `IoParseError`, fall back to the binary interpretation
   * described by `triangleCount`/`trailingJunkBytes` (see parse.ts's
   * `parseStl` for the canonical example of this fallback dance). */
  | { kind: 'try-ascii-else-binary'; triangleCount: number; trailingJunkBytes: number }
  /** Definitely ASCII: either too short to be binary, or the declared
   * binary triangle count needs more bytes than the file has — and the
   * content looks ASCII-shaped. No binary fallback is offered for this
   * case (see `parseStl`'s module doc history — a genuinely truncated
   * binary file that also happens to sniff as ASCII-shaped is vanishingly
   * unlikely, and offering a fallback here would risk masking a real
   * truncated-binary error behind a confusing ASCII syntax error instead). */
  | { kind: 'ascii' }
  /** No valid interpretation — `error` is ready to `throw`. */
  | { kind: 'error'; error: TruncatedFileError };

/**
 * Pure classification: decides binary vs ASCII vs error from `prefix` (the
 * file's leading bytes — see `STL_FORMAT_CLASSIFICATION_PREFIX_BYTES` for
 * how many a caller must supply) and `totalBytes` (the file's true total
 * length, which the classification's byte-length-consistency check needs
 * even though the actual triangle bytes beyond `prefix` are never touched
 * here). Never reads or writes triangle data — see `parseBinaryStl` /
 * `parseAsciiStl` (called by `parseStl` below, and by stream.ts's chunked
 * equivalent) for that.
 */
export function classifyStlFormat(prefix: Uint8Array, totalBytes: number): StlFormatClassification {
  if (totalBytes === 0) {
    return {
      kind: 'error',
      error: new TruncatedFileError('empty file: 0 bytes is not a valid STL (ASCII or binary)', {
        byteOffset: 0,
      }),
    };
  }

  if (totalBytes >= STL_BINARY_PREAMBLE_BYTES) {
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    const declaredTriangleCount = view.getUint32(STL_BINARY_HEADER_BYTES, true);
    const expectedLength = binaryStlByteLength(declaredTriangleCount);

    if (expectedLength === totalBytes) {
      // Exact length match — the strongest possible binary signal, and
      // deliberately trusted even if the 80-byte header happens to start
      // with "solid" (see module doc).
      return { kind: 'binary', triangleCount: declaredTriangleCount, trailingJunkBytes: 0 };
    }

    if (expectedLength < totalBytes) {
      // Declared count leaves trailing bytes. This is ambiguous by itself:
      // it's consistent both with a genuinely binary file that has extra
      // junk after its last triangle record (a real-world exporter quirk),
      // AND — since a binary header is legal to start with "solid ..." per
      // the module doc — with that same junk-tolerant binary file merely
      // *looking* ASCII-shaped at a glance.
      //
      // Do NOT gate the binary interpretation on `!looksLikeAsciiStl` (a
      // leading-bytes-only sniff) — a genuinely binary file whose header
      // starts with "solid" would then get misrouted straight into
      // `parseAsciiStl` and throw, even though it's valid binary-with-junk.
      // Instead, when the content also looks ASCII-shaped, let the ASCII
      // grammar parser itself be the tie-breaker: it's a full validator, so
      // a genuinely ASCII file (even one whose bytes 80..83 coincidentally
      // decode to a small triangle count satisfying this length check)
      // parses successfully and wins. A genuinely binary file only
      // *resembles* ASCII in its header bytes — the rest is binary data
      // that fails the ASCII grammar — so on that failure the caller falls
      // back to the binary-with-junk-warning interpretation instead of
      // surfacing a confusing ASCII syntax error.
      //
      // Before paying for that full attempt (a `TextDecoder.decode` of the
      // ENTIRE file plus a two-pass grammar walk — expensive for a >100 MB
      // file), `looksGrammaticalAsciiStlPrefix` fail-fasts on a bounded
      // prefix (see its doc in ascii.ts): a genuinely binary file's data
      // reliably diverges from the ASCII grammar within the first few KB,
      // so this catches the common "large binary STL with a `solid`-
      // prefixed header" case without ever decoding the rest of the file.
      const trailingJunkBytes = totalBytes - expectedLength;
      if (
        looksLikeAsciiStl(prefix) &&
        looksGrammaticalAsciiStlPrefix(prefix, ASCII_GRAMMAR_PREFIX_CHECK_BYTES)
      ) {
        return { kind: 'try-ascii-else-binary', triangleCount: declaredTriangleCount, trailingJunkBytes };
      }
      return { kind: 'binary', triangleCount: declaredTriangleCount, trailingJunkBytes };
    }
    // expectedLength > totalBytes falls through to the ASCII/error checks
    // below — handled uniformly with the byteLength < PREAMBLE case.
  }

  if (looksLikeAsciiStl(prefix)) {
    return { kind: 'ascii' };
  }

  if (totalBytes < STL_BINARY_PREAMBLE_BYTES) {
    return {
      kind: 'error',
      error: new TruncatedFileError(
        `file is ${totalBytes} byte(s), too small to be a binary STL (needs at least ` +
          `${STL_BINARY_PREAMBLE_BYTES} bytes for the 80-byte header + 4-byte triangle count) and does not ` +
          'start with the ASCII "solid" keyword either',
        { byteOffset: 0 },
      ),
    };
  }

  // Reached only when totalBytes >= 84 and the offset-80 triangle count
  // declares MORE bytes than the file actually has — i.e. a binary STL
  // truncated partway through its triangle records — and the content
  // isn't ASCII-shaped either, so there's no fallback interpretation.
  return {
    kind: 'error',
    error: new TruncatedFileError(
      'file declares (via its binary triangle count at byte offset 80) more triangle data than its byte ' +
        'length can hold, and it does not start with the ASCII "solid" keyword either — truncated binary STL',
      { byteOffset: STL_BINARY_HEADER_BYTES },
    ),
  };
}

export interface ParseStlResult {
  soup: RawTriangleSoup;
  diagnostics: ParseDiagnostics;
}

/**
 * Parses `bytes` as either binary or ASCII STL, auto-detecting the format.
 * See the module doc above for why detection is byte-length-consistency
 * based rather than a "starts with 'solid'" prefix check.
 */
export function parseStl(bytes: Uint8Array): ParseStlResult {
  const classification = classifyStlFormat(bytes, bytes.byteLength);

  switch (classification.kind) {
    case 'error':
      throw classification.error;

    case 'binary': {
      const diagnostics: ParseDiagnostics = {
        warnings:
          classification.trailingJunkBytes > 0
            ? [
                `${classification.trailingJunkBytes} trailing byte(s) after the last binary triangle ` +
                  'record were present and ignored.',
              ]
            : [],
        format: 'stl-binary',
      };
      const soup = parseBinaryStl(bytes, classification.triangleCount, diagnostics);
      return { soup, diagnostics };
    }

    case 'ascii': {
      const diagnostics: ParseDiagnostics = { warnings: [], format: 'stl-ascii' };
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const soup = parseAsciiStl(text);
      return { soup, diagnostics };
    }

    case 'try-ascii-else-binary': {
      try {
        const diagnostics: ParseDiagnostics = { warnings: [], format: 'stl-ascii' };
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        const soup = parseAsciiStl(text);
        return { soup, diagnostics };
      } catch (error) {
        if (!(error instanceof IoParseError)) {
          throw error;
        }
        // Fall through to the binary-with-junk-warning interpretation.
      }
      const diagnostics: ParseDiagnostics = {
        warnings: [
          `${classification.trailingJunkBytes} trailing byte(s) after the last binary triangle record ` +
            'were present and ignored.',
        ],
        format: 'stl-binary',
      };
      const soup = parseBinaryStl(bytes, classification.triangleCount, diagnostics);
      return { soup, diagnostics };
    }
  }
}
