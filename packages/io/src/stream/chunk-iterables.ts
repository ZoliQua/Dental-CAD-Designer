// packages/io/src/stream/chunk-iterables.ts
//
// Small helpers for building the `AsyncIterable<Uint8Array>` chunk sources
// `parseStlStream`/`parsePlyStream` (stl/stream.ts, ply/stream.ts) consume.
// `iterateInFixedChunks` is deliberately simple (splits an in-memory buffer
// into fixed-size slices) — it exists mainly so tests can exercise the
// streaming parsers at adversarial chunk sizes (1 byte, 7 bytes, a single
// huge chunk — see this task's chunk-boundary-invariance requirement)
// without every test hand-rolling a generator, but it's also a legitimate
// way for a real caller to wrap an already-in-memory buffer as a chunk
// source (e.g. exercising the streaming code path in a context where the
// bytes happen to already be fully loaded).

/**
 * Yields `bytes` as consecutive `chunkSize`-byte (or smaller, for the final
 * chunk) `Uint8Array` VIEWS (via `subarray` — no copying) in order.
 * `chunkSize` must be a positive integer; a 0-byte `bytes` yields no
 * chunks at all (an empty async iterable), matching how a genuinely empty
 * file would stream.
 */
export async function* iterateInFixedChunks(
  bytes: Uint8Array,
  chunkSize: number,
): AsyncGenerator<Uint8Array, void, void> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new TypeError(`iterateInFixedChunks: chunkSize must be a positive integer, got ${chunkSize}`);
  }
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
  }
}
