// packages/kernel/src/bvh/bvh.build.test.ts
//
// Direct unit coverage for buildBvh's structural invariants and edge cases
// not naturally exercised by the property/analytic tests (bvh.property.test.ts /
// bvh.analytic.test.ts): empty mesh, invalid options, every triangle
// appearing in exactly one leaf, leaf-size bound, and closestPoint/raycast's
// mesh/BVH mismatch guard.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh, DEFAULT_MAX_LEAF_TRIANGLES } from './build.ts';
import { closestPoint } from './closestPoint.ts';
import { raycast } from './raycast.ts';

function gridMesh(triangleCount: number): IndexedMesh {
  // `triangleCount` disjoint unit-right-triangles laid out along +x — cheap
  // to generate, non-degenerate, and spatially spread so a median-split
  // build actually has to split more than once.
  const positions = new Float64Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    positions.set([t, 0, 0, t + 1, 0, 0, t, 1, 0], t * 9);
  }
  const indices = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
  }
  return { positions, indices };
}

describe('buildBvh — empty mesh', () => {
  it('builds a degenerate BVH with triangleCount 0, never queried by closestPoint/raycast without throwing', () => {
    const mesh: IndexedMesh = { positions: new Float64Array(0), indices: new Uint32Array(0) };
    const bvh = buildBvh(mesh);
    expect(bvh.triangleCount).toBe(0);
    expect(() => closestPoint(mesh, bvh, [0, 0, 0])).toThrow(RangeError);
    expect(raycast(mesh, bvh, [0, 0, 0], [1, 0, 0])).toBeNull();
  });
});

describe('buildBvh — option validation', () => {
  it('rejects a non-integer triangle count (malformed indices length)', () => {
    const mesh: IndexedMesh = { positions: new Float64Array(9), indices: new Uint32Array(4) };
    expect(() => buildBvh(mesh)).toThrow(TypeError);
  });

  it('rejects maxLeafTriangles < 1', () => {
    const mesh = gridMesh(3);
    expect(() => buildBvh(mesh, { maxLeafTriangles: 0 })).toThrow(TypeError);
  });
});

describe('buildBvh — structural invariants', () => {
  it.each([1, 2, 4, 5, 17, 200])('every triangle appears in exactly one leaf, leaves respect maxLeafTriangles (n=%i)', (n) => {
    const mesh = gridMesh(n);
    const maxLeafTriangles = 3;
    const bvh = buildBvh(mesh, { maxLeafTriangles });

    const seen = new Uint8Array(n);
    let leafCount = 0;
    let internalCount = 0;
    const visit = (node: number): void => {
      const left = bvh.nodeLeft[node]!;
      if (left === -1) {
        leafCount++;
        const count = bvh.nodeLeafCount[node]!;
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(maxLeafTriangles);
        const start = bvh.nodeLeafStart[node]!;
        for (let i = start; i < start + count; i++) {
          const t = bvh.triangleIndices[i]!;
          expect(seen[t]).toBe(0);
          seen[t] = 1;
        }
        return;
      }
      internalCount++;
      visit(left);
      visit(bvh.nodeRight[node]!);
    };
    visit(bvh.rootNode);

    expect(Array.from(seen).every((v) => v === 1)).toBe(true);
    expect(internalCount).toBe(leafCount - 1); // full binary tree
  });

  it('uses the documented default leaf size when maxLeafTriangles is omitted', () => {
    const mesh = gridMesh(37);
    const implicit = buildBvh(mesh);
    const explicit = buildBvh(mesh, { maxLeafTriangles: DEFAULT_MAX_LEAF_TRIANGLES });
    // Omitting the option must be byte-identical to passing the documented
    // default explicitly — proves the default is actually wired through
    // (rather than e.g. some other hardcoded value that happens to also
    // satisfy the "leaves respect maxLeafTriangles" structural test above).
    expect(Array.from(implicit.nodeLeafCount)).toEqual(Array.from(explicit.nodeLeafCount));
    expect(Array.from(implicit.triangleIndices)).toEqual(Array.from(explicit.triangleIndices));
  });

  it('progress callback reports monotonically increasing counts ending at the full triangle count', () => {
    const n = 500;
    const mesh = gridMesh(n);
    const calls: Array<[number, number]> = [];
    buildBvh(mesh, { maxLeafTriangles: 2, progressLeafInterval: 8, onProgress: (done, total) => calls.push([done, total]) });

    expect(calls.length).toBeGreaterThan(0);
    for (const [, total] of calls) expect(total).toBe(n);
    for (let i = 1; i < calls.length; i++) expect(calls[i]![0]).toBeGreaterThanOrEqual(calls[i - 1]![0]);
    expect(calls[calls.length - 1]![0]).toBe(n);
  });
});

describe('closestPoint/raycast — mesh/BVH mismatch guard', () => {
  it('throws if the mesh triangle count no longer matches the BVH it was built from', () => {
    const mesh = gridMesh(5);
    const bvh = buildBvh(mesh);
    const otherMesh = gridMesh(6);
    expect(() => closestPoint(otherMesh, bvh, [0, 0, 0])).toThrow(RangeError);
    expect(() => raycast(otherMesh, bvh, [0, 0, 0], [1, 0, 0])).toThrow(RangeError);
  });
});
