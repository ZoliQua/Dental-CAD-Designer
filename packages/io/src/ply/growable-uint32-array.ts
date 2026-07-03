// packages/io/src/ply/growable-uint32-array.ts
//
// A minimal amortized-doubling growable Uint32Array, used by the face
// readers to accumulate triangle indices. Why this exists instead of a
// `number[]`: this package's hard Float64/typed-array invariant (see
// ../types.ts's module doc and docs/plans/phase-1-import-viewer.md's
// Global Constraints) bars `number[]` staging for bulk data — but the
// final index count isn't known upfront the way `positions`' is, because
// fan-triangulating a quad or n-gon face (see binary.ts/ascii.ts) can
// produce more triangles than the face element's row count. Reading the
// face element twice (once to size, once to fill) would avoid this, but
// at the cost of duplicating every property-skip and list-count read; a
// growable typed array is the simpler, still-invariant-respecting choice
// — the staging buffer is a Uint32Array throughout, never a JS array.

export class GrowableUint32Array {
  private buffer: Uint32Array;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buffer = new Uint32Array(Math.max(initialCapacity, 1));
  }

  push(value: number): void {
    if (this.len >= this.buffer.length) {
      const grown = new Uint32Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.len] = value;
    this.len++;
  }

  get length(): number {
    return this.len;
  }

  /** Returns exactly the written prefix — a copy, so further `push` calls
   * on this instance never mutate a previously-returned array. */
  toArray(): Uint32Array {
    return this.buffer.slice(0, this.len);
  }
}
