// packages/kernel/src/halfedge/iterate.test.ts
//
// Traversal correctness: one-ring vs brute-force adjacency, face loops,
// boundary loops on an open patch, and analytic Euler characteristic/genus
// (icosphere genus 0, torus genus 1) — per this task's brief item 7.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildHalfedge } from './build.ts';
import {
  computeEulerCharacteristic,
  computeGenus,
  faceNeighbors,
  faceVertices,
  findBoundaryLoops,
  oneRingFaces,
  oneRingVertices,
} from './iterate.ts';
import {
  cubeMesh,
  icosahedronMesh,
  icosphereMesh,
  octahedronMesh,
  openGridPatchMesh,
  torusMesh,
  twoDisjointOpenPatchesMesh,
} from './halfedge.test-fixtures.ts';

/** Brute-force one-ring neighbor set for `v`: every OTHER vertex sharing a
 * triangle with `v`, deduplicated. Independent of the halfedge structure —
 * a direct scan of `mesh.indices` — the oracle `oneRingVertices` is checked
 * against. */
function bruteForceOneRingVertices(mesh: IndexedMesh, v: number): Set<number> {
  const out = new Set<number>();
  const triangleCount = mesh.indices.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const a = mesh.indices[t * 3]!;
    const b = mesh.indices[t * 3 + 1]!;
    const c = mesh.indices[t * 3 + 2]!;
    if (a !== v && b !== v && c !== v) continue;
    if (a !== v) out.add(a);
    if (b !== v) out.add(b);
    if (c !== v) out.add(c);
  }
  return out;
}

function bruteForceIncidentFaces(mesh: IndexedMesh, v: number): Set<number> {
  const out = new Set<number>();
  const triangleCount = mesh.indices.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const a = mesh.indices[t * 3]!;
    const b = mesh.indices[t * 3 + 1]!;
    const c = mesh.indices[t * 3 + 2]!;
    if (a === v || b === v || c === v) out.add(t);
  }
  return out;
}

describe('one-ring vs brute-force adjacency', () => {
  for (const [name, mesh] of [
    ['cube', cubeMesh()],
    ['octahedron', octahedronMesh()],
    ['icosahedron', icosahedronMesh()],
    ['icosphere(2)', icosphereMesh(5, 2)],
    ['torus(8,6)', torusMesh(3, 1, 8, 6)],
    ['open grid patch(4,5)', openGridPatchMesh(4, 5)],
  ] as const) {
    it(`${name}: oneRingVertices/oneRingFaces match brute force for every vertex`, () => {
      const hm = buildHalfedge(mesh);
      const vertexCount = mesh.positions.length / 3;
      for (let v = 0; v < vertexCount; v++) {
        const actualVertices = oneRingVertices(hm, v);
        expect(new Set(actualVertices)).toEqual(bruteForceOneRingVertices(mesh, v));
        expect(actualVertices.length).toBe(new Set(actualVertices).size); // no duplicates

        const actualFaces = oneRingFaces(hm, v);
        expect(new Set(actualFaces)).toEqual(bruteForceIncidentFaces(mesh, v));
        expect(actualFaces.length).toBe(new Set(actualFaces).size);
      }
    });
  }
});

describe('face loop iteration', () => {
  it('faceVertices/faceNeighbors match raw mesh.indices and twin faces for every face (cube)', () => {
    const mesh = cubeMesh();
    const hm = buildHalfedge(mesh);
    const faceCount = mesh.indices.length / 3;
    for (let f = 0; f < faceCount; f++) {
      expect(faceVertices(hm, f)).toEqual([
        mesh.indices[f * 3]!,
        mesh.indices[f * 3 + 1]!,
        mesh.indices[f * 3 + 2]!,
      ]);
      const neighbors = faceNeighbors(hm, f);
      expect(neighbors).toHaveLength(3);
      expect(neighbors.every((n) => n !== -1)).toBe(true); // cube is closed, no boundary
      expect(neighbors.every((n) => n !== f)).toBe(true); // never self-adjacent
    }
  });

  it('boundary faces report -1 neighbor across a boundary edge (open grid patch)', () => {
    const mesh = openGridPatchMesh(2, 2);
    const hm = buildHalfedge(mesh);
    const faceCount = mesh.indices.length / 3;
    let sawBoundaryNeighbor = false;
    for (let f = 0; f < faceCount; f++) {
      if (faceNeighbors(hm, f).some((n) => n === -1)) sawBoundaryNeighbor = true;
    }
    expect(sawBoundaryNeighbor).toBe(true);
  });
});

describe('findBoundaryLoops', () => {
  it('a closed mesh has zero boundary loops', () => {
    expect(findBoundaryLoops(buildHalfedge(cubeMesh()))).toHaveLength(0);
    expect(findBoundaryLoops(buildHalfedge(octahedronMesh()))).toHaveLength(0);
  });

  it('an open rectangular patch has exactly one boundary loop, of perimeter length', () => {
    for (const [rows, cols] of [
      [1, 1],
      [3, 4],
      [5, 2],
    ] as const) {
      const mesh = openGridPatchMesh(rows, cols);
      const hm = buildHalfedge(mesh);
      const loops = findBoundaryLoops(hm);
      expect(loops).toHaveLength(1);
      expect(loops[0]!.length).toBe(2 * rows + 2 * cols);
    }
  });

  it("a boundary loop forms a genuine closed walk (each halfedge's destination is the next one's origin)", () => {
    const mesh = openGridPatchMesh(3, 3);
    const hm = buildHalfedge(mesh);
    const [loop] = findBoundaryLoops(hm);
    for (let i = 0; i < loop!.length; i++) {
      const he = loop![i]!;
      const nextHe = loop![(i + 1) % loop!.length]!;
      const dest = hm.vertex[hm.next[he]!]!;
      expect(dest).toBe(hm.vertex[nextHe]!);
    }
  });

  it('two disjoint open patches produce exactly 2 independent boundary loops, each a closed walk of the expected perimeter length', () => {
    const rows1 = 3;
    const cols1 = 4;
    const rows2 = 2;
    const cols2 = 5;
    const mesh = twoDisjointOpenPatchesMesh(rows1, cols1, rows2, cols2);
    const hm = buildHalfedge(mesh);
    const loops = findBoundaryLoops(hm);
    expect(loops).toHaveLength(2);

    const expectedLengths = [2 * rows1 + 2 * cols1, 2 * rows2 + 2 * cols2].sort((a, b) => a - b);
    const actualLengths = loops.map((loop) => loop.length).sort((a, b) => a - b);
    expect(actualLengths).toEqual(expectedLengths);

    // Each loop is closed under this module's boundary-walk convention:
    // consecutive entries chain destination(loop[i]) === origin(loop[i+1]),
    // wrapping back to loop[0] at the end.
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const he = loop[i]!;
        const nextHe = loop[(i + 1) % loop.length]!;
        expect(hm.vertex[hm.next[he]!]!).toBe(hm.vertex[nextHe]!);
      }
    }

    // Genuinely independent: no halfedge is shared between the two loops.
    const allHalfedges = new Set([...loops[0]!, ...loops[1]!]);
    expect(allHalfedges.size).toBe(loops[0]!.length + loops[1]!.length);
  });
});

describe('Euler characteristic + genus — analytic cases', () => {
  it('icosphere (subdivisions 0-2): V-E+F = 2, genus 0', () => {
    for (const subdivisions of [0, 1, 2]) {
      const hm = buildHalfedge(icosphereMesh(5, subdivisions));
      expect(computeEulerCharacteristic(hm).eulerCharacteristic).toBe(2);
      expect(computeGenus(hm)).toBe(0);
    }
  });

  it('torus (varying segment counts): V-E+F = 0, genus 1', () => {
    for (const [major, minor] of [
      [8, 6],
      [12, 8],
      [5, 3],
    ] as const) {
      const hm = buildHalfedge(torusMesh(3, 1, major, minor));
      expect(computeEulerCharacteristic(hm).eulerCharacteristic).toBe(0);
      expect(computeGenus(hm)).toBe(1);
    }
  });

  it('computeGenus throws on an open (boundary-having) mesh', () => {
    const hm = buildHalfedge(openGridPatchMesh(2, 2));
    expect(() => computeGenus(hm)).toThrow(/boundary/);
  });

  it('open grid patch Euler characteristic matches V-E+F for a topological disk (=1)', () => {
    const hm = buildHalfedge(openGridPatchMesh(3, 4));
    expect(computeEulerCharacteristic(hm).eulerCharacteristic).toBe(1);
  });
});
