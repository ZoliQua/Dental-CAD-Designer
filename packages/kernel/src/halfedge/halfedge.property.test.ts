// packages/kernel/src/halfedge/halfedge.property.test.ts
//
// Property-based tests (fast-check) per this task's brief item 7:
// "property (build->assertValidTopology on random manifold meshes from a
// seeded generator; one-ring completeness vs brute-force adjacency)" plus
// "determinism hashes". The "seeded generator" is
// halfedge.test-fixtures.ts's shape builders (tetrahedron/cube/octahedron/
// icosahedron/icosphere/torus/openGridPatch, all manifold BY CONSTRUCTION),
// driven by fast-check `fc.oneof` + small integer parameter arbitraries —
// fast-check supplies all the randomness (seeded, reproducible), the
// builders themselves stay pure/deterministic (no internal RNG), matching
// this project's determinism invariant (CLAUDE.md #2) and
// bvh.property.test.ts's identical convention.
//
// Seeded explicitly (not fast-check's auto-random seed) for CI
// reproducibility — see intake/weld.property.test.ts's identical rationale.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildHalfedge } from './build.ts';
import { assertValidTopology } from './validate.ts';
import {
  destinationVertex,
  forEachOutgoingHalfedge,
  oneRingFaces,
  oneRingVertices,
} from './iterate.ts';
import {
  cubeMesh,
  icosahedronMesh,
  icosphereMesh,
  octahedronMesh,
  openGridPatchMesh,
  tetrahedronMesh,
  torusMesh,
} from './halfedge.test-fixtures.ts';

const PROPERTY_SEED = 20260712;
const NUM_RUNS = 200;

/** One arbitrary shape descriptor -> a manifold `IndexedMesh`, built from
 * small bounded integer parameters fast-check shrinks over. Every branch
 * calls a pure builder from halfedge.test-fixtures.ts — no internal
 * randomness, so the SAME descriptor always yields the SAME mesh (required
 * for the determinism property below to be meaningful). */
type ShapeDescriptor =
  | { kind: 'tetrahedron' }
  | { kind: 'cube' }
  | { kind: 'octahedron' }
  | { kind: 'icosahedron' }
  | { kind: 'icosphere'; subdivisions: number }
  | { kind: 'torus'; majorSegments: number; minorSegments: number }
  | { kind: 'openGrid'; rows: number; cols: number };

const shapeArb: fc.Arbitrary<ShapeDescriptor> = fc.oneof(
  fc.constant({ kind: 'tetrahedron' as const }),
  fc.constant({ kind: 'cube' as const }),
  fc.constant({ kind: 'octahedron' as const }),
  fc.constant({ kind: 'icosahedron' as const }),
  fc.record({
    kind: fc.constant('icosphere' as const),
    subdivisions: fc.integer({ min: 0, max: 2 }),
  }),
  fc.record({
    kind: fc.constant('torus' as const),
    majorSegments: fc.integer({ min: 3, max: 10 }),
    minorSegments: fc.integer({ min: 3, max: 8 }),
  }),
  fc.record({
    kind: fc.constant('openGrid' as const),
    rows: fc.integer({ min: 1, max: 6 }),
    cols: fc.integer({ min: 1, max: 6 }),
  }),
);

function buildShape(desc: ShapeDescriptor): IndexedMesh {
  switch (desc.kind) {
    case 'tetrahedron':
      return tetrahedronMesh();
    case 'cube':
      return cubeMesh();
    case 'octahedron':
      return octahedronMesh();
    case 'icosahedron':
      return icosahedronMesh();
    case 'icosphere':
      return icosphereMesh(5, desc.subdivisions);
    case 'torus':
      return torusMesh(3, 1, desc.majorSegments, desc.minorSegments);
    case 'openGrid':
      return openGridPatchMesh(desc.rows, desc.cols);
  }
}

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

describe('property: buildHalfedge -> assertValidTopology never throws on a manifold mesh', () => {
  it('holds for every generated shape', () => {
    fc.assert(
      fc.property(shapeArb, (desc) => {
        const mesh = buildShape(desc);
        const hm = buildHalfedge(mesh);
        assertValidTopology(hm);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('property: one-ring iteration matches brute-force adjacency', () => {
  it('oneRingVertices/oneRingFaces agree with a brute-force scan for every vertex of every generated shape', () => {
    fc.assert(
      fc.property(shapeArb, (desc) => {
        const mesh = buildShape(desc);
        const hm = buildHalfedge(mesh);
        const vertexCount = mesh.positions.length / 3;
        for (let v = 0; v < vertexCount; v++) {
          const actualVertices = new Set(oneRingVertices(hm, v));
          expect(actualVertices).toEqual(bruteForceOneRingVertices(mesh, v));
          const actualFaces = new Set(oneRingFaces(hm, v));
          expect(actualFaces).toEqual(bruteForceIncidentFaces(mesh, v));
        }
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it('every outgoing halfedge from v really does originate at v, and its destination is a genuine mesh edge', () => {
    fc.assert(
      fc.property(shapeArb, (desc) => {
        const mesh = buildShape(desc);
        const hm = buildHalfedge(mesh);
        const vertexCount = mesh.positions.length / 3;
        for (let v = 0; v < vertexCount; v++) {
          forEachOutgoingHalfedge(hm, v, (he) => {
            expect(hm.vertex[he]).toBe(v);
            expect(bruteForceOneRingVertices(mesh, v).has(destinationVertex(hm, he))).toBe(true);
          });
        }
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

/** sha256 over every one of a `HalfedgeMesh`'s typed arrays, concatenated —
 * the "determinism hash" this task's brief asks for (mirrors
 * test/golden/intake.test.ts's `hashIntakeResult` convention). */
function hashHalfedgeMesh(hm: ReturnType<typeof buildHalfedge>): string {
  const hash = createHash('sha256');
  for (const arr of [hm.twin, hm.next, hm.vertex, hm.face, hm.vertexHalfedge]) {
    hash.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  return hash.digest('hex');
}

describe('property: determinism (build hashes)', () => {
  it('building the same mesh twice produces a byte-identical HalfedgeMesh (same hash)', () => {
    fc.assert(
      fc.property(shapeArb, (desc) => {
        const mesh = buildShape(desc);
        const first = hashHalfedgeMesh(buildHalfedge(mesh));
        const second = hashHalfedgeMesh(buildHalfedge(mesh));
        expect(second).toBe(first);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});
