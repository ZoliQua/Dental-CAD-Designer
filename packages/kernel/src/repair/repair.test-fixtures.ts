// TEST-ONLY mesh fixtures for the repair/ test suite — mirrors
// packages/kernel/src/boolean/manifold.test-fixtures.ts's convention (not
// exported from packages/kernel/src/index.ts).
import type { IndexedMesh } from '../mesh/types.ts';
import { edgeKey } from '../mesh/edgeKey.ts';
import { buildEdgeMap } from '../intake/topology.ts';

type Vec3 = readonly [number, number, number];

/** Unit cube (edge length 1), corner at `offset`, 8 vertices / 12 triangles,
 * CCW-from-outside winding — same construction as kernel-workers/src/jobs/misc.ts's
 * `unitCubeMesh` test fixture, duplicated here (rather than imported) since
 * that one lives in a different package with no shared TEST-ONLY fixture
 * module between them. */
export function unitCubeMesh(offset: readonly [number, number, number] = [0, 0, 0]): IndexedMesh {
  const [ox, oy, oz] = offset;
  const positions = new Float64Array([
    ox, oy, oz,
    ox + 1, oy, oz,
    ox + 1, oy + 1, oz,
    ox, oy + 1, oz,
    ox, oy, oz + 1,
    ox + 1, oy, oz + 1,
    ox + 1, oy + 1, oz + 1,
    ox, oy + 1, oz + 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // front (-y)
    1, 2, 6, 1, 6, 5, // right (+x)
    2, 3, 7, 2, 7, 6, // back (+y)
    0, 4, 7, 0, 7, 3, // left (-x)
  ]);
  return { positions, indices };
}

/**
 * Deletes `seedTriangle` and every triangle edge-adjacent to it (its "1-ring"
 * of face neighbors) — for a regular (valence-6) region of a subdivided
 * icosphere this carves out a small hexagonal hole with a single, simple
 * boundary loop, the shape `fillSmallHoles`'s tests exercise ("sphere with N
 * deleted triangles"). Leaves `positions` untouched (any vertex left
 * unreferenced by the deletion is simply inert — see
 * intake/degenerate.ts's identical convention).
 */
export function removeTriangleNeighborhood(mesh: IndexedMesh, seedTriangle: number): IndexedMesh {
  const edges = buildEdgeMap(mesh);
  const vertexCount = mesh.positions.length / 3;
  const toRemove = new Set<number>([seedTriangle]);
  const base = seedTriangle * 3;
  const corners = [mesh.indices[base]!, mesh.indices[base + 1]!, mesh.indices[base + 2]!];
  for (let i = 0; i < 3; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 3]!;
    const key = a < b ? edgeKey(a, b, vertexCount) : edgeKey(b, a, vertexCount);
    const entry = edges.get(key);
    if (!entry) continue;
    for (const inc of entry.incidences) {
      if (inc.triangle !== seedTriangle) toRemove.add(inc.triangle);
    }
  }
  const triangleCount = mesh.indices.length / 3;
  const kept: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    if (toRemove.has(t)) continue;
    const b = t * 3;
    kept.push(mesh.indices[b]!, mesh.indices[b + 1]!, mesh.indices[b + 2]!);
  }
  return { positions: mesh.positions, indices: Uint32Array.from(kept) };
}

/**
 * One closed "fan" — a small tetrahedron-like shell around `apex` (3 side
 * triangles + a base cap) built from 3 FRESH base positions appended to
 * `positions` — the winding (side faces `[apex,b0,b1]`, `[apex,b2,b0]`,
 * `[apex,b1,b2]`, base `[b0,b2,b1]`) is the SAME verified CCW-from-outside
 * pattern `halfedge/halfedge.test-fixtures.ts`'s `tetrahedronMesh` uses
 * (that file's doc: "FIXED ... signedVolumeMm3 > 0"), reused here purely
 * for its known-correct per-edge winding consistency (this fixture doesn't
 * care about the resulting solid's actual volume/sign). Gluing 2+ fans at
 * the SAME `apex` vertex index (with otherwise-disjoint base vertices) is
 * this file's `singleBowtieMesh`/`doubleBowtieMesh` construction — TEST-ONLY
 * fixtures for `splitNonManifoldVertices.test.ts` (and mirrored, per this
 * module's own convention, into `scripts/kernel-ops-lib.ts` for the golden
 * suite). */
function apexFan(positions: number[], apex: number, base: readonly [Vec3, Vec3, Vec3]): number[] {
  const baseIndex = positions.length / 3;
  for (const p of base) positions.push(p[0], p[1], p[2]);
  const b0 = baseIndex;
  const b1 = baseIndex + 1;
  const b2 = baseIndex + 2;
  return [apex, b0, b1, apex, b2, b0, apex, b1, b2, b0, b2, b1];
}

/** A single bowtie vertex (index 0): 2 closed fans (see `apexFan`) sharing
 * ONLY their apex — `findNonManifoldVertices` reports vertex 0 with
 * `fanCount: 2`. Every edge in this mesh has degree <= 2 (each fan is its
 * own small closed, oriented manifold shell); only the VERTEX is
 * non-manifold. */
export function singleBowtieMesh(): IndexedMesh {
  const positions: number[] = [0, 0, 0]; // apex = vertex 0
  const indices: number[] = [
    ...apexFan(positions, 0, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]),
    ...apexFan(positions, 0, [
      [-1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ]),
  ];
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A "double" bowtie vertex (index 0): 3 closed fans sharing ONLY their
 * apex — `findNonManifoldVertices` reports vertex 0 with `fanCount: 3`,
 * exercising `splitNonManifoldVertices`' multi-fan (not just the binary
 * 2-fan case) duplicate-per-extra-fan logic: TWO new vertices should be
 * created (one per non-first fan), not one. */
export function doubleBowtieMesh(): IndexedMesh {
  const positions: number[] = [0, 0, 0];
  const indices: number[] = [
    ...apexFan(positions, 0, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]),
    ...apexFan(positions, 0, [
      [-1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ]),
    ...apexFan(positions, 0, [
      [2, 0, 0],
      [0, 2, 0],
      [0, 0, 2],
    ]),
  ];
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Concatenates two independent `IndexedMesh`es into one (vertex indices of
 * `b` offset past `a`'s) — a simple two-component fixture. */
export function concatMeshes(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  const vertexCountA = a.positions.length / 3;
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i]! + vertexCountA;
  }
  return { positions, indices };
}
