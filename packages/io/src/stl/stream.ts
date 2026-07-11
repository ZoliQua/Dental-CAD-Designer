// packages/io/src/stl/stream.ts
//
// Chunked STL parsing: `parseStlStream` accepts an `AsyncIterable<Uint8Array>`
// (e.g. chunks read from a large file without ever holding the whole file
// in memory) plus the file's total byte length, and produces the exact same
// `ParseStlResult` `parseStl` (parse.ts) would produce from the equivalent
// full buffer — see the determinism requirement in docs/plans/
// phase-1-import-viewer.md's Global Constraints and this task's guardrail
// ("streaming refactor must NOT change any existing parse result").
//
// "No logic forks" between this module and parse.ts's in-memory `parseStl`
// is enforced structurally, not just by convention:
//   - Format detection: both call the exact same `classifyStlFormat`
//     (parse.ts) — this module never re-implements the byte-length-
//     consistency / ASCII-sniff / bounded-grammar-check algorithm.
//   - Binary triangle decoding: both call the exact same
//     `decodeStlBinaryRecord` (binary.ts) for every 50-byte record — this
//     module never re-implements the field-offset/float32 decode.
//   - ASCII: this module never re-implements the ASCII grammar at all — on
//     the 'ascii' / 'try-ascii-else-binary' classifications it accumulates
//     the full byte stream (see ChunkReader.drainToEnd) and calls the
//     UNMODIFIED in-memory `parseAsciiStl` (ascii.ts), exactly as parse.ts
//     does. This is the documented "binary streams, ASCII falls back to
//     bounded/whole-buffer accumulation" compromise this task's guardrail
//     explicitly sanctions — real-world STL files at the >100 MB scale this
//     streaming path targets are binary (ASCII STL is not this package's
//     performance-critical path even in the non-streaming reader, see
//     ascii.ts's module doc), and the 'ascii'/'try-ascii-else-binary'
//     classifications are, by construction, the cases where the format
//     itself can't be known without examining content beyond a bounded
//     prefix — genuine streaming would require a full ASCII token-level
//     state machine with backtracking for the "else binary" tie-break,
//     which is a substantially larger undertaking for a format this
//     package already documents as non-performance-critical.
//
// Progress is reported by BYTES consumed from the chunk source (0..1);
// cancellation (`options.signal`) is checked between processing batches —
// never mid-batch — so an abort lands within one batch of the call, the
// same "cooperative, chunk-boundary" cancellation contract kernel-workers'
// jobs.ts documents for `longTask`.

import { IoParseError, IoStreamCancelledError, TruncatedFileError } from '../types.ts';
import type { ParseDiagnostics, RawTriangleSoup } from '../types.ts';
import { ChunkReader } from '../stream/chunk-reader.ts';
import {
  STL_BINARY_PREAMBLE_BYTES,
  STL_BINARY_RECORD_BYTES,
  decodeStlBinaryRecord,
  parseBinaryStl,
} from './binary.ts';
import { parseAsciiStl } from './ascii.ts';
import { STL_FORMAT_CLASSIFICATION_PREFIX_BYTES, classifyStlFormat } from './parse.ts';
import type { ParseStlResult } from './parse.ts';

export interface ParseStlStreamOptions {
  /** Called with fractional progress in [0, 1], keyed to bytes consumed
   * from the chunk source — not triangle count, since the binary format's
   * per-triangle byte cost is fixed but this also covers the ASCII
   * fallback path where it isn't. */
  onProgress?: (fraction: number) => void;
  /** Checked between processing batches (see module doc) — an aborted
   * signal makes `parseStlStream` reject with `IoStreamCancelledError`. */
  signal?: AbortSignal;
}

/** Batch size for the binary streaming loop: how many triangle-record bytes
 * are decoded per `ensure`/`peek`/`consume` round trip. A larger batch means
 * fewer (cheaper) round trips through the chunk reader at the cost of a
 * larger transient `peek()` copy when a batch happens to straddle chunk
 * boundaries — 1 MiB is a deliberately small, bounded constant relative to
 * a >100 MB file (see this task's "O(chunk) scanning memory" requirement),
 * not a fraction of the file size. */
const BINARY_BATCH_BYTES = 1 << 20; // 1 MiB
const BINARY_BATCH_RECORDS = Math.max(1, Math.floor(BINARY_BATCH_BYTES / STL_BINARY_RECORD_BYTES));

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new IoStreamCancelledError();
  }
}

/**
 * Streams `triangleCount` binary triangle records from `reader` (already
 * positioned immediately after the 84-byte preamble) directly into
 * preallocated `positions`/`normals` — the streaming counterpart of
 * binary.ts's `parseBinaryStl`'s loop, decoding via the exact same
 * `decodeStlBinaryRecord` per record (see module doc's "no logic forks").
 */
async function streamBinaryTriangles(
  reader: ChunkReader,
  triangleCount: number,
  totalBytes: number,
  options: ParseStlStreamOptions,
): Promise<{ positions: Float64Array; normals: Float64Array; trianglesWithNonzeroAttribute: number }> {
  const positions = new Float64Array(triangleCount * 9);
  const normals = new Float64Array(triangleCount * 3);
  let trianglesWithNonzeroAttribute = 0;

  let i = 0;
  while (i < triangleCount) {
    checkCancelled(options.signal);

    const recordsRemaining = triangleCount - i;
    const recordsWanted = Math.min(BINARY_BATCH_RECORDS, recordsRemaining);
    const bytesWanted = recordsWanted * STL_BINARY_RECORD_BYTES;
    await reader.ensure(bytesWanted);
    const availableBytes = Math.min(bytesWanted, reader.bufferedBytes);
    const availableRecords = Math.floor(availableBytes / STL_BINARY_RECORD_BYTES);

    if (availableRecords === 0) {
      throw new TruncatedFileError(
        `binary STL truncated: expected triangle record ${i} of ${triangleCount} but the chunk source ` +
          `ended after ${reader.position} byte(s)`,
        { byteOffset: STL_BINARY_PREAMBLE_BYTES + i * STL_BINARY_RECORD_BYTES },
      );
    }

    const batch = reader.peek(availableRecords * STL_BINARY_RECORD_BYTES);
    const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
    for (let k = 0; k < availableRecords; k++) {
      const attributeByteCount = decodeStlBinaryRecord(
        view,
        k * STL_BINARY_RECORD_BYTES,
        positions,
        normals,
        i + k,
      );
      if (attributeByteCount !== 0) {
        trianglesWithNonzeroAttribute++;
      }
    }
    reader.consume(availableRecords * STL_BINARY_RECORD_BYTES);
    i += availableRecords;

    options.onProgress?.(Math.min(1, reader.position / totalBytes));
  }

  return { positions, normals, trianglesWithNonzeroAttribute };
}

/**
 * Parses an STL file from a chunked byte source, producing an identical
 * `ParseStlResult` to `parseStl(fullBytes)` (parse.ts) for the same bytes
 * — see module doc. `totalBytes` MUST equal the source's true total byte
 * length (analogous to a `File`'s `.size`, known upfront for any real file
 * this streams from) — the STL format's binary/ASCII detection is a
 * byte-length-consistency check (see parse.ts's module doc) that
 * fundamentally needs the total length, not just what's been read so far.
 */
export async function parseStlStream(
  chunks: AsyncIterable<Uint8Array>,
  totalBytes: number,
  options: ParseStlStreamOptions = {},
): Promise<ParseStlResult> {
  if (!Number.isInteger(totalBytes) || totalBytes < 0) {
    throw new TypeError(`parseStlStream: totalBytes must be a non-negative integer, got ${totalBytes}`);
  }
  checkCancelled(options.signal);

  const reader = new ChunkReader(chunks);

  const prefixBudget = Math.min(totalBytes, STL_FORMAT_CLASSIFICATION_PREFIX_BYTES);
  await reader.ensure(prefixBudget);
  const availablePrefixBytes = Math.min(prefixBudget, reader.bufferedBytes);
  if (totalBytes >= STL_BINARY_PREAMBLE_BYTES && availablePrefixBytes < STL_BINARY_PREAMBLE_BYTES) {
    throw new TruncatedFileError(
      `parseStlStream: totalBytes (${totalBytes}) implies at least ${STL_BINARY_PREAMBLE_BYTES} byte(s), ` +
        `but the chunk source produced only ${availablePrefixBytes} before ending — totalBytes must match ` +
        "the chunk source's true total length",
      { byteOffset: availablePrefixBytes },
    );
  }
  const prefixBytes = reader.peek(availablePrefixBytes);
  const classification = classifyStlFormat(prefixBytes, totalBytes);

  switch (classification.kind) {
    case 'error':
      throw classification.error;

    case 'binary': {
      reader.consume(STL_BINARY_PREAMBLE_BYTES);
      const { positions, normals, trianglesWithNonzeroAttribute } = await streamBinaryTriangles(
        reader,
        classification.triangleCount,
        totalBytes,
        options,
      );
      const warnings: string[] = [];
      if (classification.trailingJunkBytes > 0) {
        warnings.push(
          `${classification.trailingJunkBytes} trailing byte(s) after the last binary triangle record ` +
            'were present and ignored.',
        );
      }
      if (trianglesWithNonzeroAttribute > 0) {
        warnings.push(
          `${trianglesWithNonzeroAttribute} of ${classification.triangleCount} triangle(s) had a ` +
            'non-zero attribute byte count (e.g. a packed-color extension some tools write there) — ' +
            "value read but discarded; this parser does not interpret the base STL spec's \"attribute " +
            'byte count" field.',
        );
      }
      options.onProgress?.(1);
      const diagnostics: ParseDiagnostics = { warnings, format: 'stl-binary' };
      const soup: RawTriangleSoup = { positions, normals, triangleCount: classification.triangleCount };
      return { soup, diagnostics };
    }

    case 'ascii': {
      const allBytes = await reader.drainToEnd(() => {
        checkCancelled(options.signal);
        options.onProgress?.(Math.min(1, reader.bufferedBytes / totalBytes));
      });
      const diagnostics: ParseDiagnostics = { warnings: [], format: 'stl-ascii' };
      const text = new TextDecoder('utf-8', { fatal: false }).decode(allBytes);
      const soup = parseAsciiStl(text);
      options.onProgress?.(1);
      return { soup, diagnostics };
    }

    case 'try-ascii-else-binary': {
      // The ambiguous case inherently needs to see the FULL ASCII attempt
      // through before it can decide — see module doc — so this drains the
      // whole source once, then hands the already-fully-buffered bytes to
      // whichever interpretation wins, exactly mirroring parse.ts's
      // synchronous fallback (same functions, same order, same catch).
      const allBytes = await reader.drainToEnd(() => {
        checkCancelled(options.signal);
        options.onProgress?.(Math.min(1, reader.bufferedBytes / totalBytes));
      });
      try {
        const diagnostics: ParseDiagnostics = { warnings: [], format: 'stl-ascii' };
        const text = new TextDecoder('utf-8', { fatal: false }).decode(allBytes);
        const soup = parseAsciiStl(text);
        options.onProgress?.(1);
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
      const soup = parseBinaryStl(allBytes, classification.triangleCount, diagnostics);
      options.onProgress?.(1);
      return { soup, diagnostics };
    }
  }
}
