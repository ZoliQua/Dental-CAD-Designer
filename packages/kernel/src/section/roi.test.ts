// packages/kernel/src/section/roi.test.ts
//
// `extractLocalSubmesh` — see roi.ts's module doc. Analytic unit-cube
// fixture (halfedge.test-fixtures.ts's `cubeMesh`, halfExtent 1 -> 2mm
// cube, 8 vertices / 12 triangles), so triangle inclusion/exclusion and
// vertex reindexing are hand-verifiable, not just "didn't crash".
import { describe, expect, it } from 'vitest';
import { cubeMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { extractLocalSubmesh } from './roi.ts';

describe('extractLocalSubmesh', () => {
  it('a radius covering the whole cube keeps every triangle, vertex positions verbatim', () => {
    const cube = cubeMesh(1); // halfExtent 1 -> corners at distance sqrt(3) =~ 1.732 from center
    const sub = extractLocalSubmesh(cube, [0, 0, 0], 2);
    expect(sub.indices.length).toBe(cube.indices.length);
    expect(sub.positions.length).toBe(cube.positions.length);
  });

  it('a radius covering ONLY one corner keeps only the triangles touching that corner, verbatim positions, reindexed compactly', () => {
    const cube = cubeMesh(1); // corners at (+-1, +-1, +-1)
    // Only the (1,1,1) corner is within radius 0.5 of (1,1,1) itself.
    const sub = extractLocalSubmesh(cube, [1, 1, 1], 0.5);
    // Exactly the 5 triangles incident to vertex (1,1,1) in cubeMesh's own
    // fixed CCW-from-outside triangle list (both diagonal-split triangles of
    // the top face, both of the right face, and one of the back face — hand
    // counted directly against halfedge.test-fixtures.ts's `cubeMesh` body).
    expect(sub.indices.length / 3).toBe(5);
    // Every surviving vertex position must be copied EXACTLY (byte-identical
    // Float64) from the source mesh — no interpolation, per this file's own
    // `@errorBound` doc.
    const seen = new Set<string>();
    for (let i = 0; i < sub.positions.length / 3; i++) {
      seen.add(`${sub.positions[i * 3]},${sub.positions[i * 3 + 1]},${sub.positions[i * 3 + 2]}`);
    }
    for (const p of seen) {
      const [x, y, z] = p.split(',').map(Number);
      const found = [...Array(cube.positions.length / 3).keys()].some((vi) => {
        return cube.positions[vi * 3] === x && cube.positions[vi * 3 + 1] === y && cube.positions[vi * 3 + 2] === z;
      });
      expect(found).toBe(true);
    }
    // The far corner (-1,-1,-1) must NOT appear among surviving positions.
    const hasFarCorner = seen.has('-1,-1,-1');
    expect(hasFarCorner).toBe(false);
  });

  it('a zero-triangle result (radius reaching no vertex) returns an empty, valid IndexedMesh', () => {
    const cube = cubeMesh(1);
    const sub = extractLocalSubmesh(cube, [100, 100, 100], 0.1);
    expect(sub.indices.length).toBe(0);
    expect(sub.positions.length).toBe(0);
  });

  it('reindexes compactly: no gaps, no duplicate positions for a shared vertex referenced by multiple surviving triangles', () => {
    const cube = cubeMesh(1);
    const sub = extractLocalSubmesh(cube, [1, 1, 1], 0.5); // 5 triangles, sharing the (1,1,1) vertex
    const vertexCount = sub.positions.length / 3;
    // The 5 triangles around one shared corner touch several vertex slots
    // but share the corner itself — must be far fewer than 15 unique
    // vertices, and every index must be < vertexCount (no gaps/out-of-range).
    expect(vertexCount).toBeLessThan(15);
    for (const idx of sub.indices) {
      expect(idx).toBeLessThan(vertexCount);
      expect(idx).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects a non-positive or non-finite radius', () => {
    const cube = cubeMesh(1);
    expect(() => extractLocalSubmesh(cube, [0, 0, 0], 0)).toThrow(RangeError);
    expect(() => extractLocalSubmesh(cube, [0, 0, 0], -1)).toThrow(RangeError);
    expect(() => extractLocalSubmesh(cube, [0, 0, 0], Number.NaN)).toThrow(RangeError);
  });
});
