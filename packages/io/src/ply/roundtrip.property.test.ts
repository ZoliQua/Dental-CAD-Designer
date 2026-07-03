// packages/io/src/ply/roundtrip.property.test.ts
//
// Property-based round-trip test (fast-check): writePlyBinaryLE ->
// parsePly must preserve triangle positions bit-exactly. Unlike STL's
// binary format (inherently float32, see stl/roundtrip.property.test.ts),
// PLY's writer emits `float64` position/normal properties (see
// binary.ts's module doc) and this package is Float64-everywhere in
// memory to begin with, so this property is scoped to the FULL float64
// domain (`fc.double()`), not narrowed to float32-representable values —
// a strictly stronger round-trip claim than STL's.
//
// Seeded explicitly (not fast-check's auto-random seed) for reproducible
// CI runs — see docs/plans/phase-1-import-viewer.md's determinism
// constraint and this task's "pristine, seeded" guardrail.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { writePlyBinaryLE } from './binary.ts';
import type { WritablePlyMesh } from './binary.ts';
import { parsePly } from './parse.ts';

const PROPERTY_SEED = 987654321;

const finiteDouble = fc.double({ noNaN: true, noDefaultInfinity: true });
const vec3Arb = fc.tuple(finiteDouble, finiteDouble, finiteDouble);
const triangleArb = fc.record({ v0: vec3Arb, v1: vec3Arb, v2: vec3Arb });

interface Triangle {
  v0: readonly [number, number, number];
  v1: readonly [number, number, number];
  v2: readonly [number, number, number];
}

/** Builds an unwelded triangle soup as an indexed `WritablePlyMesh` —
 * each triangle owns 3 fresh vertices (indices are simply sequential),
 * matching this package's other roundtrip test's "independent triangles"
 * shape while staying representable as PLY's indexed-vertex format. */
function meshFromTriangles(triangles: readonly Triangle[]): WritablePlyMesh {
  const vertexCount = triangles.length * 3;
  const positions = new Float64Array(vertexCount * 3);
  const indices = new Uint32Array(vertexCount);
  triangles.forEach((t, i) => {
    positions.set([...t.v0, ...t.v1, ...t.v2], i * 9);
    indices[i * 3] = i * 3;
    indices[i * 3 + 1] = i * 3 + 1;
    indices[i * 3 + 2] = i * 3 + 2;
  });
  return {
    positions,
    normals: null,
    colors: null,
    indices,
    vertexCount,
    faceCount: triangles.length,
  };
}

describe('writePlyBinaryLE -> parsePly round trip (property)', () => {
  it('preserves vertex positions bit-exactly for arbitrary finite float64 coordinates', () => {
    fc.assert(
      fc.property(fc.array(triangleArb, { maxLength: 30 }), (triangles) => {
        const mesh = meshFromTriangles(triangles);
        const bytes = writePlyBinaryLE(mesh);
        const parsed = parsePly(bytes);

        expect(parsed.vertexCount).toBe(mesh.vertexCount);
        expect(parsed.faceCount).toBe(mesh.faceCount);
        expect(Array.from(parsed.positions)).toEqual(Array.from(mesh.positions));
        expect(Array.from(parsed.indices)).toEqual(Array.from(mesh.indices));
      }),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });

  it('preserves per-vertex normals bit-exactly when present', () => {
    fc.assert(
      fc.property(fc.array(triangleArb, { minLength: 1, maxLength: 30 }), (triangles) => {
        const base = meshFromTriangles(triangles);
        const normals = new Float64Array(base.vertexCount * 3);
        // Reuse the same generated coordinates as stand-in normal values —
        // only their bit pattern matters for this property, not their
        // geometric meaning as unit vectors.
        normals.set(base.positions);
        const mesh: WritablePlyMesh = { ...base, normals };

        const bytes = writePlyBinaryLE(mesh);
        const parsed = parsePly(bytes);

        expect(parsed.normals).not.toBeNull();
        expect(Array.from(parsed.normals!)).toEqual(Array.from(normals));
      }),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });
});
