// TEST-ONLY mesh fixtures for manifold.test.ts. Not exported from
// packages/kernel/src/index.ts (see the task brief: "Icosphere generator
// utility allowed in TEST code" — kept out of the shipped kernel API, since
// nothing in the kernel itself needs a sphere primitive yet).
import type { IndexedMesh } from '../mesh/types.ts';

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

/** Base icosahedron vertices (unit-radius direction vectors) and its 20
 * triangular faces, wound CCW as seen from outside — the standard
 * "golden rectangle" icosahedron construction. Verified against manifold-3d
 * directly (status 'NoError', volume converging to (4/3)πr³ as subdivisions
 * increase) before being folded into this fixture. */
const ICOSAHEDRON_VERTICES: ReadonlyArray<readonly [number, number, number]> = [
  [-1, GOLDEN_RATIO, 0],
  [1, GOLDEN_RATIO, 0],
  [-1, -GOLDEN_RATIO, 0],
  [1, -GOLDEN_RATIO, 0],
  [0, -1, GOLDEN_RATIO],
  [0, 1, GOLDEN_RATIO],
  [0, -1, -GOLDEN_RATIO],
  [0, 1, -GOLDEN_RATIO],
  [GOLDEN_RATIO, 0, -1],
  [GOLDEN_RATIO, 0, 1],
  [-GOLDEN_RATIO, 0, -1],
  [-GOLDEN_RATIO, 0, 1],
];

const ICOSAHEDRON_FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];

function normalizeTo(radius: number, x: number, y: number, z: number): [number, number, number] {
  const length = Math.sqrt(x * x + y * y + z * z);
  return [(x / length) * radius, (y / length) * radius, (z / length) * radius];
}

/**
 * Deterministic geodesic-sphere (icosphere) mesh generator: a subdivided
 * icosahedron with all vertices projected onto the sphere of the given
 * radius, centered at `center`. Purely a test fixture (no unseeded
 * randomness — every call with the same arguments produces byte-identical
 * output, satisfying the kernel's determinism constraint even for test
 * code).
 *
 * Approximation error vs. the analytic sphere volume shrinks with
 * `subdivisions`: 0 => ~39%, 1 => ~13%, 2 => ~3.4%, 3 => ~0.86% (measured
 * against manifold-3d directly). Tests should pick `subdivisions` and an
 * assertion tolerance together.
 */
export function icosphereMesh(
  radius: number,
  subdivisions: number,
  center: readonly [number, number, number] = [0, 0, 0],
): IndexedMesh {
  let vertices = ICOSAHEDRON_VERTICES.map(([x, y, z]) => normalizeTo(radius, x, y, z));
  let faces = ICOSAHEDRON_FACES.map((face) => [...face]);

  for (let level = 0; level < subdivisions; level += 1) {
    const midpointCache = new Map<string, number>();
    const nextVertices = [...vertices];

    function midpoint(indexA: number, indexB: number): number {
      const key = indexA < indexB ? `${indexA}_${indexB}` : `${indexB}_${indexA}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const a = vertices[indexA]!;
      const b = vertices[indexB]!;
      const mid = normalizeTo(radius, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      const newIndex = nextVertices.length;
      nextVertices.push(mid);
      midpointCache.set(key, newIndex);
      return newIndex;
    }

    const nextFaces: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a!, b!);
      const bc = midpoint(b!, c!);
      const ca = midpoint(c!, a!);
      nextFaces.push([a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]);
    }

    vertices = nextVertices;
    faces = nextFaces;
  }

  const positions = new Float64Array(vertices.length * 3);
  vertices.forEach(([x, y, z], i) => {
    positions[i * 3] = x + center[0];
    positions[i * 3 + 1] = y + center[1];
    positions[i * 3 + 2] = z + center[2];
  });
  const indices = new Uint32Array(faces.flat());
  return { positions, indices };
}
