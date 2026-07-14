// packages/kernel/src/geodesic/heap.ts
//
// A small binary min-heap of (priority, id) pairs, specialized for
// `corridor.ts`'s Dijkstra over the triangle dual graph. Needed (rather than
// e.g. a sorted array) for performance on real-scan meshes: this task's
// guardrail targets < 100 ms per re-snapped margin segment on a ~250k-
// triangle mesh, and a binary heap keeps Dijkstra at O((V+E) log V) instead
// of the O(V^2) a linear-scan "find min" would cost.
//
// Deterministic tie-break: `id` (lower wins) breaks exact-`priority` ties —
// see corridor.ts's module doc for why this matters for this project's
// determinism invariant (two equal-length candidate routes must always
// resolve the same way).

interface HeapEntry {
  priority: number;
  id: number;
}

export class MinHeap {
  private readonly items: HeapEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(priority: number, id: number): void {
    this.items.push({ priority, id });
    this.siftUp(this.items.length - 1);
  }

  /** Removes and returns the entry with the lowest `(priority, id)` (ties
   * broken by lower `id` — see module doc), or `null` if empty. */
  pop(): HeapEntry | null {
    const items = this.items;
    if (items.length === 0) return null;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private less(a: HeapEntry, b: HeapEntry): boolean {
    return a.priority < b.priority || (a.priority === b.priority && a.id < b.id);
  }

  private siftUp(startIndex: number): void {
    const items = this.items;
    let i = startIndex;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i]!, items[parent]!)) {
        [items[i], items[parent]] = [items[parent]!, items[i]!];
        i = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(startIndex: number): void {
    const items = this.items;
    let i = startIndex;
    const n = items.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      let smallest = i;
      if (left < n && this.less(items[left]!, items[smallest]!)) smallest = left;
      if (right < n && this.less(items[right]!, items[smallest]!)) smallest = right;
      if (smallest === i) break;
      [items[i], items[smallest]] = [items[smallest]!, items[i]!];
      i = smallest;
    }
  }
}
