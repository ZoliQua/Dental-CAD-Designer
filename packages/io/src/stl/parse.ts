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

import { TruncatedFileError } from '../types.ts';
import type { ParseDiagnostics, RawTriangleSoup } from '../types.ts';
import {
  STL_BINARY_HEADER_BYTES,
  STL_BINARY_PREAMBLE_BYTES,
  binaryStlByteLength,
  parseBinaryStl,
} from './binary.ts';
import { parseAsciiStl } from './ascii.ts';

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
  if (bytes.byteLength === 0) {
    throw new TruncatedFileError('empty file: 0 bytes is not a valid STL (ASCII or binary)', {
      byteOffset: 0,
    });
  }

  if (bytes.byteLength >= STL_BINARY_PREAMBLE_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const declaredTriangleCount = view.getUint32(STL_BINARY_HEADER_BYTES, true);
    const expectedLength = binaryStlByteLength(declaredTriangleCount);

    if (expectedLength === bytes.byteLength) {
      // Exact length match — the strongest possible binary signal, and
      // deliberately trusted even if the 80-byte header happens to start
      // with "solid" (see module doc).
      const diagnostics: ParseDiagnostics = { warnings: [], format: 'stl-binary' };
      const soup = parseBinaryStl(bytes, declaredTriangleCount, diagnostics);
      return { soup, diagnostics };
    }

    if (expectedLength < bytes.byteLength && !looksLikeAsciiStl(bytes)) {
      // Declared count leaves trailing bytes, but the content isn't
      // ASCII-shaped either — tolerate it as binary with extra junk after
      // the last triangle record (a real-world exporter quirk), per the
      // brief's "tolerates trailing junk with warning".
      const diagnostics: ParseDiagnostics = {
        warnings: [
          `${bytes.byteLength - expectedLength} trailing byte(s) after the last binary triangle record ` +
            'were present and ignored.',
        ],
        format: 'stl-binary',
      };
      const soup = parseBinaryStl(bytes, declaredTriangleCount, diagnostics);
      return { soup, diagnostics };
    }
  }

  if (looksLikeAsciiStl(bytes)) {
    const diagnostics: ParseDiagnostics = { warnings: [], format: 'stl-ascii' };
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const soup = parseAsciiStl(text);
    return { soup, diagnostics };
  }

  if (bytes.byteLength < STL_BINARY_PREAMBLE_BYTES) {
    throw new TruncatedFileError(
      `file is ${bytes.byteLength} byte(s), too small to be a binary STL (needs at least ` +
        `${STL_BINARY_PREAMBLE_BYTES} bytes for the 80-byte header + 4-byte triangle count) and does not ` +
        'start with the ASCII "solid" keyword either',
      { byteOffset: 0 },
    );
  }

  // Reached only when byteLength >= 84 and the offset-80 triangle count
  // declares MORE bytes than the buffer actually has — i.e. a binary STL
  // truncated partway through its triangle records — and the content
  // isn't ASCII-shaped either, so there's no fallback interpretation.
  throw new TruncatedFileError(
    'file declares (via its binary triangle count at byte offset 80) more triangle data than its byte ' +
      'length can hold, and it does not start with the ASCII "solid" keyword either — truncated binary STL',
    { byteOffset: STL_BINARY_HEADER_BYTES },
  );
}
