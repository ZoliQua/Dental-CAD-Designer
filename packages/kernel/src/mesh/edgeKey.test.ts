// packages/kernel/src/mesh/edgeKey.test.ts
import { describe, expect, it } from 'vitest';
import {
  MAX_SAFE_EDGE_KEY_VERTEX_COUNT,
  assertSafeVertexCountForEdgeKey,
  decodeEdgeKey,
  edgeKey,
} from './edgeKey.ts';

describe('edgeKey', () => {
  it('is injective and round-trips via decodeEdgeKey for a range of (a, b, vertexCount)', () => {
    const vertexCount = 1000;
    for (let a = 0; a < 20; a++) {
      for (let b = a + 1; b < 20; b++) {
        const key = edgeKey(a, b, vertexCount);
        expect(decodeEdgeKey(key, vertexCount)).toEqual({ a, b });
      }
    }
  });

  it('never collides two distinct (a, b) pairs under the same vertexCount', () => {
    const vertexCount = 50;
    const seen = new Set<number>();
    for (let a = 0; a < vertexCount; a++) {
      for (let b = a + 1; b < vertexCount; b++) {
        const key = edgeKey(a, b, vertexCount);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('stays within Number.MAX_SAFE_INTEGER at the documented bound', () => {
    const v = MAX_SAFE_EDGE_KEY_VERTEX_COUNT;
    const worstCase = edgeKey(v - 2, v - 1, v);
    expect(Number.isSafeInteger(worstCase)).toBe(true);
  });

  it('assertSafeVertexCountForEdgeKey accepts values at/under the bound and rejects values over it', () => {
    expect(() =>
      assertSafeVertexCountForEdgeKey(MAX_SAFE_EDGE_KEY_VERTEX_COUNT, 'test'),
    ).not.toThrow();
    expect(() => assertSafeVertexCountForEdgeKey(1, 'test')).not.toThrow();
    expect(() =>
      assertSafeVertexCountForEdgeKey(MAX_SAFE_EDGE_KEY_VERTEX_COUNT + 1, 'test'),
    ).toThrow(RangeError);
    expect(() =>
      assertSafeVertexCountForEdgeKey(MAX_SAFE_EDGE_KEY_VERTEX_COUNT + 1, 'myFn'),
    ).toThrow(/myFn/);
  });
});
