// packages/io/src/stream/chunk-reader.ts
//
// `ChunkReader` wraps an `AsyncIterable<Uint8Array>` (the chunked-parsing
// entry points' input — see stl/stream.ts / ply/stream.ts) with a small
// buffered, forward-only cursor: `ensure(n)` pulls more chunks until at
// least `n` unconsumed bytes are buffered (or the source is exhausted),
// `peek(n)` returns a contiguous view of the next `n` bytes (copying across
// a chunk boundary only when one actually falls inside the requested span),
// and `consume(n)` drops bytes off the front. Memory is bounded by
// "currently buffered but not yet consumed" — at most one caller-requested
// span's worth plus whatever's left of the chunks that produced it — never
// the whole source, which is the whole point of streaming (see this
// package's Task 3 brief: "O(chunk) scanning memory").
//
// This is the ONE place both stl/stream.ts and ply/stream.ts get bytes from
// their `AsyncIterable<Uint8Array>` input — neither format-specific module
// re-implements chunk buffering/boundary-crossing itself.

export class ChunkReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkReaderError';
  }
}

export class ChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly queue: Uint8Array[] = [];
  private queueHeadOffset = 0; // consumed offset within queue[0]
  private buffered = 0; // total unconsumed bytes currently held across `queue`
  private sourceDone = false;
  private consumedTotal = 0;

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.iterator = chunks[Symbol.asyncIterator]();
  }

  /** Absolute count of bytes handed out via `consume()` so far — the
   * streaming parsers use this (against a known or hinted total byte
   * count) to report byte-based progress. */
  get position(): number {
    return this.consumedTotal;
  }

  /** `true` once the underlying source is fully drained AND every buffered
   * byte has been consumed — i.e. there is genuinely nothing left to read,
   * ever. */
  get exhausted(): boolean {
    return this.sourceDone && this.buffered === 0;
  }

  /** Bytes currently buffered (pulled from the source but not yet
   * `consume()`d) — exposed for `drainToEnd()` and for callers that want to
   * size a final `peek()` without an extra `ensure()` round trip. */
  get bufferedBytes(): number {
    return this.buffered;
  }

  private async pullOne(): Promise<boolean> {
    if (this.sourceDone) {
      return false;
    }
    const { value, done } = await this.iterator.next();
    if (done) {
      this.sourceDone = true;
      return false;
    }
    if (value.byteLength > 0) {
      this.queue.push(value);
      this.buffered += value.byteLength;
    }
    return true;
  }

  /**
   * Pulls more chunks until at least `n` bytes are buffered from the
   * current position, or the source is exhausted. Returns `true` iff `n`
   * bytes are now available (i.e. `peek(n)`/`consume(n)` are safe to call).
   */
  async ensure(n: number): Promise<boolean> {
    while (this.buffered < n) {
      const pulled = await this.pullOne();
      if (!pulled) {
        return this.buffered >= n;
      }
    }
    return true;
  }

  /**
   * Returns a contiguous view of the next `n` bytes without consuming them.
   * Caller must have already resolved `ensure(n)` to `true`. Zero-copy when
   * `n` fits entirely within the first queued chunk (the common case once
   * chunk sizes are reasonable relative to per-record/per-row spans);
   * otherwise copies at most `n` bytes to splice across the boundary.
   */
  peek(n: number): Uint8Array {
    if (n === 0) {
      return new Uint8Array(0);
    }
    if (this.buffered < n) {
      throw new ChunkReaderError(
        `ChunkReader.peek(${n}): only ${this.buffered} byte(s) buffered — call and await ensure(${n}) first`,
      );
    }
    const first = this.queue[0];
    if (first !== undefined && first.byteLength - this.queueHeadOffset >= n) {
      return first.subarray(this.queueHeadOffset, this.queueHeadOffset + n);
    }
    const out = new Uint8Array(n);
    let filled = 0;
    let qi = 0;
    let off = this.queueHeadOffset;
    while (filled < n) {
      const chunk = this.queue[qi];
      if (chunk === undefined) {
        // Unreachable given the `this.buffered < n` guard above, but keeps
        // this loop provably terminating for a strict TS reader.
        throw new ChunkReaderError('ChunkReader.peek: internal buffer bookkeeping desync');
      }
      const available = chunk.byteLength - off;
      const take = Math.min(available, n - filled);
      out.set(chunk.subarray(off, off + take), filled);
      filled += take;
      off += take;
      if (off >= chunk.byteLength) {
        qi++;
        off = 0;
      }
    }
    return out;
  }

  /** Drops the next `n` bytes from the front of the buffer, advancing
   * `position` by `n`. Fully-consumed queued chunks are dropped (not just
   * marked) so they become garbage-collectable immediately — this is what
   * keeps steady-state memory bounded to "unconsumed tail" rather than
   * "everything ever pulled". */
  consume(n: number): void {
    if (n > this.buffered) {
      throw new ChunkReaderError(
        `ChunkReader.consume(${n}): only ${this.buffered} byte(s) buffered`,
      );
    }
    let remaining = n;
    while (remaining > 0) {
      const chunk = this.queue[0];
      if (chunk === undefined) {
        throw new ChunkReaderError('ChunkReader.consume: internal buffer bookkeeping desync');
      }
      const available = chunk.byteLength - this.queueHeadOffset;
      if (available > remaining) {
        this.queueHeadOffset += remaining;
        remaining = 0;
      } else {
        this.queue.shift();
        this.queueHeadOffset = 0;
        remaining -= available;
      }
    }
    this.buffered -= n;
    this.consumedTotal += n;
  }

  /** Reads and consumes exactly `n` bytes in one call (`ensure` + `peek` +
   * `consume`, copying only when `n` truly spans a chunk boundary). Returns
   * `null` (consuming nothing) if the source is exhausted before `n` bytes
   * become available — the genuine-truncation signal streaming callers
   * check for. */
  async take(n: number): Promise<Uint8Array | null> {
    if (!(await this.ensure(n))) {
      return null;
    }
    const bytes = this.peek(n);
    this.consume(n);
    return bytes;
  }

  /**
   * Pulls every remaining chunk from the source and returns it all as one
   * concatenated `Uint8Array`, consuming everything. This is the bounded
   * ASCII-fallback compromise's primitive (see stl/stream.ts's and
   * ply/stream.ts's module docs for why ASCII streaming falls back to
   * "accumulate, then delegate to the existing in-memory grammar walk"
   * rather than a true per-line state machine) — memory here IS
   * O(remaining file size), by design, and only ever used on the ASCII
   * path, never the binary streaming path the >100 MB perf fixture
   * exercises. `onChunkPulled`, when given, is invoked synchronously after
   * each underlying chunk is pulled (before the next `await`) — callers use
   * it to report incremental progress (via `this.bufferedBytes`) and to
   * check cancellation between chunks; throwing from it aborts the drain.
   */
  async drainToEnd(onChunkPulled?: () => void): Promise<Uint8Array> {
    for (;;) {
      const pulled = await this.pullOne();
      if (!pulled) {
        break;
      }
      onChunkPulled?.();
    }
    const all = this.peek(this.buffered);
    this.consume(this.buffered);
    return all;
  }
}
