// packages/kernel/src/halfedge/build.test.ts
//
// Correctness tests for `buildHalfedge` (construction) and
// `findNonManifoldVertices` (bowtie detection) — per this task's brief
// items 1 and 4.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import {
  NonManifoldEdgeError,
  buildHalfedge,
  findNonManifoldVertices,
  prevHalfedge,
} from './build.ts';
import { assertValidTopology } from './validate.ts';
import { cubeMesh, octahedronMesh, openGridPatchMesh } from './halfedge.test-fixtures.ts';

function mesh(
  positions: readonly (readonly [number, number, number])[],
  triangles: readonly (readonly [number, number, number])[],
): IndexedMesh {
  const flatPositions = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => flatPositions.set(p, i * 3));
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  return { positions: flatPositions, indices };
}

describe('prevHalfedge', () => {
  it('is the arithmetic inverse of the fixed 3-cycle next()', () => {
    for (let he = 0; he < 30; he++) {
      const base = he - (he % 3);
      const nextOf = base + (((he % 3) + 1) % 3);
      expect(prevHalfedge(nextOf)).toBe(he);
    }
  });
});

describe('buildHalfedge — single triangle (all-boundary)', () => {
  const m = mesh(
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [[0, 1, 2]],
  );
  const hm = buildHalfedge(m);

  it('has 3 halfedges, all boundary (twin -1)', () => {
    expect(hm.halfedgeCount).toBe(3);
    expect(Array.from(hm.twin)).toEqual([-1, -1, -1]);
  });

  it('next forms a single 3-cycle, vertex/face are as expected', () => {
    expect(Array.from(hm.next)).toEqual([1, 2, 0]);
    expect(Array.from(hm.vertex)).toEqual([0, 1, 2]);
    expect(Array.from(hm.face)).toEqual([0, 0, 0]);
  });

  it('vertexHalfedge anchors each vertex to its own outgoing halfedge', () => {
    expect(hm.vertex[hm.vertexHalfedge[0]!]).toBe(0);
    expect(hm.vertex[hm.vertexHalfedge[1]!]).toBe(1);
    expect(hm.vertex[hm.vertexHalfedge[2]!]).toBe(2);
  });

  it('passes assertValidTopology', () => {
    expect(() => assertValidTopology(hm)).not.toThrow();
  });
});

describe('buildHalfedge — two triangles sharing an edge (one interior edge, 4 boundary)', () => {
  // Quad (0,1,2,3) split along the (0,2) diagonal, consistently wound.
  const m = mesh(
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
    [
      [0, 1, 2],
      [0, 2, 3],
    ],
  );
  const hm = buildHalfedge(m);

  it('twins the shared diagonal edge, leaves the other 4 as boundary', () => {
    const boundaryCount = Array.from(hm.twin).filter((t) => t === -1).length;
    expect(boundaryCount).toBe(4);
    const interiorCount = Array.from(hm.twin).filter((t) => t !== -1).length;
    expect(interiorCount).toBe(2); // the two halfedges of the shared diagonal
  });

  it('passes assertValidTopology', () => {
    expect(() => assertValidTopology(hm)).not.toThrow();
  });

  it('cube and octahedron fixtures also build and validate cleanly', () => {
    for (const fixture of [cubeMesh(), octahedronMesh()]) {
      const built = buildHalfedge(fixture);
      expect(() => assertValidTopology(built)).not.toThrow();
      expect(Array.from(built.twin).every((t) => t !== -1)).toBe(true); // closed, no boundary
    }
  });
});

describe('buildHalfedge — rejects non-manifold edges', () => {
  it('rejects a degree-3 edge (3 triangles sharing one edge) with reason "degree"', () => {
    // Three triangles fanned around the shared edge {0, 1}.
    const m = mesh(
      [
        [0, 0, 0],
        [0, 0, 1],
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 1, 2],
        [1, 0, 3],
        [0, 1, 4],
      ],
    );
    expect(() => buildHalfedge(m)).toThrow(NonManifoldEdgeError);
    try {
      buildHalfedge(m);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NonManifoldEdgeError);
      const e = err as NonManifoldEdgeError;
      expect(e.edges).toHaveLength(1);
      expect(e.edges[0]!.a).toBe(0);
      expect(e.edges[0]!.b).toBe(1);
      expect(e.edges[0]!.degree).toBe(3);
      expect(e.edges[0]!.reason).toBe('degree');
    }
  });

  it('rejects a degree-2 edge traversed in the SAME direction by both triangles, reason "orientation"', () => {
    // Two triangles both winding 0 -> 1 across the shared edge (inconsistent
    // orientation) rather than opposite directions.
    const m = mesh(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
      ],
      [
        [0, 1, 2],
        [0, 1, 3], // also traverses 0->1, not 1->0 — same direction as triangle 0
      ],
    );
    try {
      buildHalfedge(m);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NonManifoldEdgeError);
      const e = err as NonManifoldEdgeError;
      expect(e.edges).toHaveLength(1);
      expect(e.edges[0]!.reason).toBe('orientation');
      expect(e.edges[0]!.degree).toBe(2);
    }
  });

  it('rejects a mesh.indices.length not a multiple of 3', () => {
    const bad: IndexedMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0]),
      indices: new Uint32Array([0, 1]),
    };
    expect(() => buildHalfedge(bad)).toThrow(TypeError);
  });

  it('error message names the first offending edge', () => {
    const m = mesh(
      [
        [0, 0, 0],
        [0, 0, 1],
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 1, 2],
        [1, 0, 3],
        [0, 1, 4],
      ],
    );
    expect(() => buildHalfedge(m)).toThrow(/non-manifold edge/);
  });
});

describe('buildHalfedge — isolated/unreferenced vertex', () => {
  it('a vertex present in positions but referenced by no triangle gets vertexHalfedge -1, and the mesh still validates', () => {
    // cubeMesh's 8 vertices, plus one extra position no triangle indexes.
    const base = cubeMesh();
    const positions = new Float64Array(base.positions.length + 3);
    positions.set(base.positions);
    positions.set([5, 5, 5], base.positions.length); // isolated vertex
    const m: IndexedMesh = { positions, indices: base.indices };

    const hm = buildHalfedge(m);
    const isolatedVertex = base.positions.length / 3; // last index (8)
    expect(hm.vertexCount).toBe(base.positions.length / 3 + 1);
    // Per types.ts:55-57's doc: an unreferenced vertex's vertexHalfedge is -1.
    expect(hm.vertexHalfedge[isolatedVertex]).toBe(-1);
    expect(() => assertValidTopology(hm)).not.toThrow();
  });
});

/** Two closed 4-triangle "umbrella" fans sharing a single apex vertex (0)
 * with disjoint ring vertices — every edge stays degree <= 2 (buildHalfedge
 * succeeds) but vertex 0's local neighborhood is two disconnected fans (a
 * bowtie) — see build.ts's `findNonManifoldVertices` doc. */
function bowtieMesh(): IndexedMesh {
  const positions: [number, number, number][] = [
    [0, 0, 0], // 0: shared apex
    [1, 0, 1],
    [0, 1, 1],
    [-1, 0, 1],
    [0, -1, 1], // 1-4: fan A ring
    [1, 0, -1],
    [0, 1, -1],
    [-1, 0, -1],
    [0, -1, -1], // 5-8: fan B ring
  ];
  const triangles: [number, number, number][] = [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 4],
    [0, 4, 1], // fan A
    [0, 5, 6],
    [0, 6, 7],
    [0, 7, 8],
    [0, 8, 5], // fan B
  ];
  return mesh(positions, triangles);
}

describe('findNonManifoldVertices — bowtie detection', () => {
  it('flags no vertices on a proper closed manifold (cube, octahedron)', () => {
    expect(findNonManifoldVertices(cubeMesh())).toEqual([]);
    expect(findNonManifoldVertices(octahedronMesh())).toEqual([]);
  });

  it('flags the shared apex of two disjoint triangle fans as a 2-fan bowtie', () => {
    const m = bowtieMesh();
    const reports = findNonManifoldVertices(m);
    expect(reports).toEqual([{ vertex: 0, fanCount: 2 }]);
  });

  it('does NOT flag a legitimate boundary vertex as a bowtie (open patch — boundary vertices are not bowties)', () => {
    // Contrast with the bowtie assertion above: an open patch's boundary
    // vertices each have exactly one (open, not closed) link-edge chain —
    // one connected fan, same as an interior vertex — so none should report.
    const m = openGridPatchMesh(3, 4);
    expect(findNonManifoldVertices(m)).toEqual([]);
  });

  it('buildHalfedge SUCCEEDS on a bowtie mesh (only edges are rejected, not vertices)', () => {
    const m = bowtieMesh();
    const hm = buildHalfedge(m);
    expect(() => assertValidTopology(hm)).not.toThrow();
  });

  it('skips degenerate (repeated-index) triangles rather than throwing', () => {
    const m = mesh(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, 0],
        [0, 1, 2],
      ],
    );
    expect(() => findNonManifoldVertices(m)).not.toThrow();
  });
});
