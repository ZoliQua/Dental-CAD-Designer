// packages/io/src/ply/stream.ts
//
// Chunked PLY parsing: `parsePlyStream` accepts an `AsyncIterable<Uint8Array>`
// and produces the exact same `PlyMesh` `parsePly` (parse.ts) would produce
// from the equivalent full buffer — see the determinism requirement in
// docs/plans/phase-1-import-viewer.md's Global Constraints and this task's
// guardrail ("streaming refactor must NOT change any existing parse
// result").
//
// "No logic forks" between this module and parse.ts's in-memory `parsePly`
// is enforced structurally:
//   - Header: both call the exact same, UNMODIFIED `parsePlyHeader`
//     (header.ts) — this module accumulates bytes until that function
//     stops throwing "no end_header found" (bounded by the same
//     `HEADER_SEARCH_LIMIT_BYTES` the in-memory reader is bounded by), it
//     never re-implements header grammar.
//   - Planning: both call the exact same, UNMODIFIED `planPlyHeader`
//     (plan.ts).
//   - Binary row decoding: both call the exact same `readVertexRow` /
//     `readFaceRow` / `skipRow` (binary.ts) for every row — this module
//     never re-implements a single scalar/list field's byte layout. Unlike
//     STL's fixed 50-byte record, a PLY row's byte width is per-row DATA
//     (a list property's count), so this module can't know a row's width
//     up front; `readRowWithRetry` below handles that by attempting the row
//     against a growing window and retrying on a `TruncatedFileError`
//     shortfall (see its doc) — the retry/backoff logic is streaming-only,
//     but the actual field decoding inside each attempt is 100% the same
//     function the in-memory reader calls.
//   - ASCII: this module never re-implements the ASCII grammar — it
//     accumulates the (already-past-the-header) body bytes and calls the
//     UNMODIFIED in-memory `parsePlyAsciiBody` (ascii.ts), the same
//     documented "binary streams, ASCII falls back to bounded/whole-buffer
//     accumulation" compromise stl/stream.ts makes, for the same reason
//     (ASCII PLY, like ASCII STL, is not this package's performance-
//     critical path — real >100 MB scans are binary).
//
// Progress is reported by BYTES consumed from the chunk source (0..1);
// cancellation (`options.signal`) is checked between rows (binary) or
// between drained chunks (ASCII) — never mid-row/mid-chunk.

import { IoStreamCancelledError, TruncatedFileError } from '../types.ts';
import type { ParseDiagnostics, ParseFormat } from '../types.ts';
import { ChunkReader } from '../stream/chunk-reader.ts';
import { parsePlyAsciiBody } from './ascii.ts';
import { GrowableUint32Array } from './growable-uint32-array.ts';
import { readFaceRow, readVertexRow, skipRow } from './binary.ts';
import type { ByteCursor } from './binary.ts';
import { assertPlausibleElementCount, assertSkippableElement } from './element-count-guard.ts';
import { HEADER_SEARCH_LIMIT_BYTES, parsePlyHeader } from './header.ts';
import { planPlyHeader } from './plan.ts';
import type { PlyFormat, PlyHeader, PlyMesh } from './types.ts';

export interface ParsePlyStreamOptions {
  /** Called with fractional progress in [0, 1], keyed to bytes consumed
   * from the chunk source. Requires `totalBytes` to be meaningful — when
   * omitted, progress is reported as 0 until the parse completes (1). */
  onProgress?: (fraction: number) => void;
  /** Checked between rows (binary) / between drained chunks (ASCII) — an
   * aborted signal makes `parsePlyStream` reject with
   * `IoStreamCancelledError`. */
  signal?: AbortSignal;
  /** The source's true total byte length, if known (e.g. a `File`'s
   * `.size`) — used only for progress fractions; parsing itself never
   * depends on it (unlike STL, PLY's header always states its format
   * explicitly, so there's no byte-length-consistency detection to
   * perform). Progress reports 0 throughout (then 1 on completion) when
   * omitted. */
  totalBytes?: number;
}

function toParseFormat(format: PlyFormat): ParseFormat {
  switch (format) {
    case 'ascii':
      return 'ply-ascii';
    case 'binary_little_endian':
      return 'ply-binary-le';
    case 'binary_big_endian':
      return 'ply-binary-be';
  }
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new IoStreamCancelledError();
  }
}

/** Initial per-row window-size guess, in bytes — small enough that a
 * typical fixed-width vertex row (x/y/z, maybe normal/color) succeeds on
 * the first attempt with no wasted over-fetch, large enough that the
 * common case never needs a doubling retry at all. */
const INITIAL_ROW_WINDOW_BYTES = 128;

/**
 * Attempts to decode one row via `decode` against a growing window of
 * buffered-but-not-yet-consumed bytes from `reader`, starting at
 * `reader`'s current position. `decode` is called with `(bytes, view,
 * cursor)` — the SAME shape `readVertexRow`/`readFaceRow`/`skipRow`
 * (binary.ts) already take, called with `cursor.pos` starting at 0 (i.e.
 * relative to the start of the CURRENT attempt's window, not the file) —
 * and is expected to throw a `TruncatedFileError` (via `requireBytes` /
 * `skipListField`, binary.ts) if the window doesn't hold the row's full
 * width. On that specific failure, IF more bytes might still arrive (the
 * reader isn't exhausted at a larger window), the window is doubled and
 * the row is retried FROM SCRATCH — safe because `decode` only ever writes
 * into caller-owned output arrays keyed by row index, so a discarded
 * partial attempt's writes are simply overwritten by the eventual
 * successful attempt. Once `decode` returns without throwing, exactly the
 * bytes it consumed (per its own final `cursor.pos`) are consumed from
 * `reader`, and `windowSizeHint` is updated to speed up the next row.
 *
 * A `TruncatedFileError` that persists even once the reader is exhausted
 * (no more bytes will ever arrive) is genuine — rethrown with its
 * `byteOffset` corrected from window-local to absolute file position (the
 * window always starts at the reader's un-consumed current position, so
 * `reader.position + localOffset` is exact).
 */
async function readRowWithRetry(
  reader: ChunkReader,
  windowSizeHint: { bytes: number },
  decode: (bytes: Uint8Array, view: DataView, cursor: ByteCursor) => void,
): Promise<void> {
  let need = windowSizeHint.bytes;
  for (;;) {
    const ok = await reader.ensure(need);
    const available = Math.min(need, reader.bufferedBytes);
    const windowBytes = reader.peek(available);
    const view = new DataView(windowBytes.buffer, windowBytes.byteOffset, windowBytes.byteLength);
    const cursor: ByteCursor = { pos: 0 };
    try {
      decode(windowBytes, view, cursor);
      reader.consume(cursor.pos);
      windowSizeHint.bytes = Math.max(INITIAL_ROW_WINDOW_BYTES, cursor.pos);
      return;
    } catch (error) {
      if (error instanceof TruncatedFileError) {
        if (!ok) {
          // `ensure(need)` could not reach `need` because the source is
          // exhausted — no amount of retrying will produce more bytes, so
          // this is a genuine truncation. Correct the offset from
          // window-local (0 = reader.position at attempt start) to
          // absolute before rethrowing.
          throw new TruncatedFileError(error.message, {
            byteOffset: reader.position + (error.byteOffset ?? 0),
            line: error.line,
          });
        }
        need *= 2; // window was big enough to fetch, just not big enough for this row — grow and retry.
        continue;
      }
      throw error; // MalformedSyntaxError etc. — a real error, not a shortfall.
    }
  }
}

/**
 * Accumulates chunks until `parsePlyHeader` stops complaining about a
 * missing "end_header" (or a genuine, non-truncation error occurs), then
 * consumes exactly the header's bytes from `reader` so it's left
 * positioned at the first body byte. Reuses `parsePlyHeader` UNCHANGED —
 * see module doc.
 */
async function readHeaderStreaming(
  reader: ChunkReader,
): Promise<{ header: PlyHeader; bodyOffset: number }> {
  let probe = 4096;
  for (;;) {
    const ok = await reader.ensure(Math.min(probe, HEADER_SEARCH_LIMIT_BYTES));
    const available = Math.min(probe, reader.bufferedBytes);
    const prefix = reader.peek(available);
    try {
      const result = parsePlyHeader(prefix);
      reader.consume(result.bodyOffset);
      return result;
    } catch (error) {
      const stillRoom = available < HEADER_SEARCH_LIMIT_BYTES;
      if (error instanceof TruncatedFileError && ok && stillRoom) {
        probe = Math.min(probe * 2, HEADER_SEARCH_LIMIT_BYTES);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Parses a PLY file from a chunked byte source, producing an identical
 * `PlyMesh` to `parsePly(fullBytes)` (parse.ts) for the same bytes — see
 * module doc.
 */
export async function parsePlyStream(
  chunks: AsyncIterable<Uint8Array>,
  options: ParsePlyStreamOptions = {},
): Promise<PlyMesh> {
  checkCancelled(options.signal);
  const { onProgress, signal, totalBytes } = options;
  const reportProgress = (position: number): void => {
    if (onProgress === undefined) {
      return;
    }
    onProgress(totalBytes && totalBytes > 0 ? Math.min(1, position / totalBytes) : 0);
  };

  const reader = new ChunkReader(chunks);
  // `readHeaderStreaming` already consumes exactly the header's bytes from
  // `reader` (see its doc) — the reader is left positioned at the first
  // body byte, so only `header` itself is needed from here on.
  const { header } = await readHeaderStreaming(reader);

  const diagnostics: ParseDiagnostics = { warnings: [], format: toParseFormat(header.format) };
  for (const comment of header.comments) {
    diagnostics.warnings.push(`${comment.keyword}: ${comment.text}`);
  }
  const plan = planPlyHeader(header, diagnostics);

  if (header.format === 'ascii') {
    // Bounded-accumulate compromise (see module doc): drain the rest of the
    // body and delegate to the exact in-memory ASCII reader, exactly as
    // parse.ts's synchronous `parsePly` does for the binary formats' shared
    // core.
    const bodyBytes = await reader.drainToEnd(() => {
      checkCancelled(signal);
      reportProgress(reader.position + reader.bufferedBytes);
    });
    const mesh = parsePlyAsciiBody(bodyBytes, header, plan, 0, diagnostics);
    onProgress?.(1);
    return mesh;
  }

  const littleEndian = header.format === 'binary_little_endian';

  let positions: Float64Array = new Float64Array(0);
  let normals: Float64Array | null = null;
  let colors: Float64Array | null = null;
  let indices: Uint32Array = new Uint32Array(0);
  let vertexCount = 0;
  let faceCount = 0;

  const windowSizeHint = { bytes: INITIAL_ROW_WINDOW_BYTES };

  for (let elementIndex = 0; elementIndex < header.elements.length; elementIndex++) {
    const element = header.elements[elementIndex]!;

    if (elementIndex === plan.vertex.elementIndex) {
      const rowCount = element.count;
      assertPlausibleElementCount(element.name, rowCount);
      positions = new Float64Array(rowCount * 3);
      normals = plan.vertex.hasNormals ? new Float64Array(rowCount * 3) : null;
      colors = plan.vertex.hasColors ? new Float64Array(rowCount * 3) : null;
      for (let v = 0; v < rowCount; v++) {
        checkCancelled(signal);
        const capturedV = v;
        const capturedPositions = positions;
        const capturedNormals = normals;
        const capturedColors = colors;
        await readRowWithRetry(reader, windowSizeHint, (bytes, view, cursor) => {
          readVertexRow(
            bytes,
            view,
            cursor,
            element,
            plan.vertex,
            littleEndian,
            capturedV,
            capturedPositions,
            capturedNormals,
            capturedColors,
          );
        });
        reportProgress(reader.position);
      }
      vertexCount = rowCount;
    } else if (plan.face !== null && elementIndex === plan.face.elementIndex) {
      const rowCount = element.count;
      assertPlausibleElementCount(element.name, rowCount);
      const growable = new GrowableUint32Array(rowCount * 3);
      let quadCount = 0;
      let ngonCount = 0;
      for (let f = 0; f < rowCount; f++) {
        checkCancelled(signal);
        let polygonSize = 0;
        const capturedF = f;
        await readRowWithRetry(reader, windowSizeHint, (bytes, view, cursor) => {
          polygonSize = readFaceRow(bytes, view, cursor, element, plan.face!, littleEndian, capturedF, vertexCount, growable);
        });
        if (polygonSize === 4) {
          quadCount++;
        } else if (polygonSize > 4) {
          ngonCount++;
        }
        reportProgress(reader.position);
      }
      if (quadCount > 0) {
        diagnostics.warnings.push(
          `${quadCount} face(s) had 4 vertex indices (quads) and were fan-triangulated into 2 triangles each`,
        );
      }
      if (ngonCount > 0) {
        diagnostics.warnings.push(
          `${ngonCount} face(s) had more than 4 vertex indices and were fan-triangulated`,
        );
      }
      indices = growable.toArray();
      faceCount = rowCount;
    } else {
      // Guard BEFORE the loop — the streaming skip path had NO count guard at
      // all (unlike the vertex/face branches above), so a huge count spun the
      // loop, and a zero-property element made `readRowWithRetry` consume zero
      // bytes per row and never drain the reader: an uncancellable-on-drain
      // 100% CPU hang. Rejecting up front closes both. (The per-row
      // `checkCancelled(signal)` below still keeps a legitimately large skip
      // cancellable on a bounded, per-row cadence once a signal is threaded in.)
      assertSkippableElement(element);
      for (let r = 0; r < element.count; r++) {
        checkCancelled(signal);
        const capturedR = r;
        await readRowWithRetry(reader, windowSizeHint, (bytes, view, cursor) => {
          skipRow(bytes, view, cursor, element, littleEndian, capturedR);
        });
        reportProgress(reader.position);
      }
    }
  }

  onProgress?.(1);
  return { positions, normals, colors, indices, vertexCount, faceCount, diagnostics };
}
